/** @jest-environment jsdom */

import { jest } from '@jest/globals';

const mockCaptureOffscreen = jest
  .fn<(url: string, options?: object) => Promise<string>>()
  .mockResolvedValue('data:image/png;base64,UE5H');
const offscreenRendererModule = new URL('../offscreenRenderer.ts', import.meta.url).pathname;
jest.unstable_mockModule(offscreenRendererModule, () => ({
  captureOffscreen: mockCaptureOffscreen,
}));

const { createStudioHost } = await import('../agentBridgeHost');
const { getProjectStore } = await import('../../stores/projectStore');
const { getRenderRequestStore } = await import('../../stores/renderRequestStore');
const { __resetRenderArtifactStoreForTests, createSourceHash, getRenderArtifactState } =
  await import('../../stores/renderArtifactStore');
const { getWorkspaceState, resetWorkspaceStore, workspaceStore } =
  await import('../../stores/workspaceStore');
const { FALLBACK_PREVIEW_SCENE_STYLE } = await import('../previewSceneConfig');

type Diagnostic = { severity: 'error' | 'warning' | 'info'; message: string; line?: number };

function publish(
  source: string,
  over: { error?: string; diagnostics?: Diagnostic[]; previewKind?: 'mesh' | 'svg' } = {}
) {
  const project = getProjectStore().getState();
  getRenderArtifactState().publishSettledArtifact({
    requestId: 1,
    renderTargetPath: project.renderTargetPath ?? 'main.scad',
    workspaceRoot: project.projectRoot,
    sourceHash: createSourceHash(source),
    previewKind: over.previewKind ?? 'mesh',
    previewSrc: over.error ? '' : 'blob:mesh',
    diagnostics: over.diagnostics ?? [],
    error: over.error ?? '',
    dimensionMode: '3d',
    sceneStyle: FALLBACK_PREVIEW_SCENE_STYLE,
    useModelColors: true,
    createdAt: Date.now(),
  });
}

const tick = () => new Promise((r) => setTimeout(r, 0));

function reset() {
  getProjectStore().getState().resetProject();
  resetWorkspaceStore();
  __resetRenderArtifactStoreForTests();
  getRenderRequestStore().setState({ pendingRequest: null, nextId: 1 });
  mockCaptureOffscreen.mockClear();
}

describe('agent bridge host (real Studio stores)', () => {
  beforeEach(reset);

  describe('get_state', () => {
    it('is empty on a fresh tab', () => {
      expect(createStudioHost().getState()).toEqual({
        path: null,
        source: null,
        dirty: false,
        files: [],
        contentVersion: 0,
        render: null,
      });
    });

    it('reports the render target, dirtiness, files, version and last render with line/col', () => {
      const store = getProjectStore().getState();
      store.openProject(null, { 'main.scad': 'cube(1);', 'lib.scad': 'x=1;' }, 'main.scad');
      store.updateFileContent('main.scad', 'cube(2);');
      publish('cube(2);', {
        diagnostics: [{ severity: 'warning', message: 'meh', line: 3 }],
      });
      const state = createStudioHost().getState();
      expect(state).toMatchObject({
        path: 'main.scad',
        source: 'cube(2);',
        dirty: true,
        files: ['lib.scad', 'main.scad'],
        contentVersion: 2,
        render: {
          ok: true,
          diagnostics: [{ severity: 'warning', message: 'meh', line: 3 }],
          error: '',
        },
      });
      expect(typeof state.render?.createdAt).toBe('number');
    });

    it('marks a render with an error diagnostic as not ok', () => {
      getProjectStore().getState().openProject(null, { 'main.scad': 'x' }, 'main.scad');
      publish('x', {
        error: 'syntax error',
        diagnostics: [{ severity: 'error', message: 'syntax error', line: 1 }],
      });
      expect(createStudioHost().getState().render).toMatchObject({
        ok: false,
        error: 'syntax error',
      });
    });
  });

  describe('set_source', () => {
    it('on a fresh start opens a project and tab (leaving the welcome screen), then renders', async () => {
      expect(getWorkspaceState().showWelcome).toBe(true);
      const host = createStudioHost();
      const done = host.setSource('cube(5);');
      await tick();

      // The app's open path ran: project, tab, welcome gone, render requested.
      const project = getProjectStore().getState();
      expect(project.files['main.scad']?.content).toBe('cube(5);');
      expect(project.renderTargetPath).toBe('main.scad');
      expect(project.projectRoot).toBeNull(); // virtual: nothing on disk
      expect(getWorkspaceState().showWelcome).toBe(false);
      expect(getWorkspaceState().tabs.map((t) => t.projectPath)).toEqual(['main.scad']);
      expect(getWorkspaceState().tabs[0].filePath).toBeNull();
      expect(getRenderRequestStore().getState().pendingRequest).toMatchObject({
        trigger: 'file_open',
        immediate: true,
      });

      publish('cube(5);');
      await expect(done).resolves.toMatchObject({
        path: 'main.scad',
        render: { ok: true, diagnostics: [], error: '' },
      });
    });

    it('with a project open, replaces the render target text and renders it', async () => {
      workspaceStore.getState().hideWelcomeScreen();
      getProjectStore()
        .getState()
        .openProject(null, { 'main.scad': 'cube(1);', 'other.scad': 'z=1;' }, 'main.scad');
      const host = createStudioHost();
      const done = host.setSource('cube(9);');
      await tick();
      const project = getProjectStore().getState();
      expect(project.files['main.scad'].content).toBe('cube(9);');
      expect(project.files['other.scad'].content).toBe('z=1;');
      expect(getRenderRequestStore().getState().pendingRequest).toMatchObject({
        trigger: 'code_update',
        immediate: true,
        code: 'cube(9);',
      });
      publish('cube(9);');
      await expect(done).resolves.toMatchObject({ render: { ok: true } });
    });

    it('is not answered by a render of older text that happened to settle first', async () => {
      workspaceStore.getState().hideWelcomeScreen();
      getProjectStore().getState().openProject(null, { 'main.scad': 'cube(1);' }, 'main.scad');
      const done = createStudioHost().setSource('cube(9);');
      let settled = false;
      void done.then(() => (settled = true));
      publish('cube(1);'); // an in-flight render of the previous text
      await tick();
      expect(settled).toBe(false);
      publish('cube(9);', {
        error: 'boom',
        diagnostics: [{ severity: 'error', message: 'boom', line: 1 }],
      });
      await expect(done).resolves.toMatchObject({ render: { ok: false, error: 'boom' } });
    });

    it('fails with a clear message if Studio never settles', async () => {
      workspaceStore.getState().hideWelcomeScreen();
      getProjectStore().getState().openProject(null, { 'main.scad': 'a' }, 'main.scad');
      await expect(createStudioHost({ renderTimeoutMs: 20 }).setSource('b')).rejects.toThrow(
        'Timed out waiting for Studio to finish rendering.'
      );
    });
  });

  describe('trigger_render', () => {
    it('renders the current text and resolves with the summary', async () => {
      workspaceStore.getState().hideWelcomeScreen();
      getProjectStore().getState().openProject(null, { 'main.scad': 'cube(3);' }, 'main.scad');
      const done = createStudioHost().triggerRender();
      await tick();
      expect(getRenderRequestStore().getState().pendingRequest).toMatchObject({
        trigger: 'manual',
        immediate: true,
        code: 'cube(3);',
      });
      publish('cube(3);');
      await expect(done).resolves.toMatchObject({ path: 'main.scad', render: { ok: true } });
    });

    it('says so when nothing is open', async () => {
      await expect(createStudioHost().triggerRender()).rejects.toThrow(/No file is open/);
    });
  });

  describe('screenshot', () => {
    beforeEach(() => {
      workspaceStore.getState().hideWelcomeScreen();
      getProjectStore().getState().openProject(null, { 'main.scad': 'cube(3);' }, 'main.scad');
    });

    it('captures the rendered mesh from the requested view and returns raw base64', async () => {
      publish('cube(3);');
      const shot = await createStudioHost().screenshot({ view: 'front' });
      expect(shot).toEqual({ view: 'front', pngBase64: 'UE5H' });
      expect(mockCaptureOffscreen).toHaveBeenCalledWith(
        'blob:mesh',
        expect.objectContaining({ view: 'front' })
      );
    });

    it('defaults to isometric and supports a custom angle', async () => {
      publish('cube(3);');
      const host = createStudioHost();
      expect((await host.screenshot({})).view).toBe('isometric');
      const custom = await host.screenshot({ azimuth: 30, elevation: 10 });
      expect(custom.view).toMatch(/azimuth 30, elevation 10/);
      expect(mockCaptureOffscreen).toHaveBeenLastCalledWith(
        'blob:mesh',
        expect.objectContaining({ azimuth: 30, elevation: 10 })
      );
    });

    it('explains when nothing has rendered, the render failed, or the preview is 2D', async () => {
      const host = createStudioHost();
      await expect(host.screenshot({})).rejects.toThrow('No successful 3D render to capture yet.');
      publish('cube(3);', { error: 'bad', diagnostics: [{ severity: 'error', message: 'bad' }] });
      await expect(host.screenshot({})).rejects.toThrow(/last render failed/);
      publish('cube(3);', { previewKind: 'svg' });
      await expect(host.screenshot({})).rejects.toThrow(/not a 3D model/);
      expect(mockCaptureOffscreen).not.toHaveBeenCalled();
    });
  });

  describe('subscriptions', () => {
    it('onContentChanged fires on edits and customizer-style rewrites, and stops after unsubscribe', () => {
      getProjectStore().getState().openProject(null, { 'main.scad': 'a' }, 'main.scad');
      const listener = jest.fn();
      const off = createStudioHost().onContentChanged(listener);
      getProjectStore().getState().updateFileContent('main.scad', 'b');
      expect(listener).toHaveBeenCalledTimes(1);
      getProjectStore().getState().setCustomizerBase('main.scad', 'b');
      expect(listener).toHaveBeenCalledTimes(2); // files object changed too; the bridge filters equal text
      off();
      getProjectStore().getState().updateFileContent('main.scad', 'c');
      expect(listener).toHaveBeenCalledTimes(2);
    });

    it("onRenderSettled reports each settled artifact with Studio's diagnostics", () => {
      getProjectStore().getState().openProject(null, { 'main.scad': 'a' }, 'main.scad');
      const listener = jest.fn();
      const off = createStudioHost().onRenderSettled(listener);
      publish('a', { diagnostics: [{ severity: 'warning', message: 'w', line: 2 }] });
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith({
        path: 'main.scad',
        render: expect.objectContaining({
          ok: true,
          diagnostics: [{ severity: 'warning', message: 'w', line: 2 }],
        }),
      });
      off();
      publish('a');
      expect(listener).toHaveBeenCalledTimes(1);
    });
  });
});
