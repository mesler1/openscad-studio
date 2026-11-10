/**
 * Studio-side implementation of the agent bridge's tools (see agentBridge.ts).
 *
 * It reuses what the app already has rather than adding paths of its own:
 *  - state comes from the project store and the render artifact store;
 *  - putting source in the editor is the app's own open/edit path (windowOpenService
 *    for a fresh tab, the project store plus the render request store otherwise);
 *  - screenshots go through studioTooling's capturePreviewScreenshot, the same
 *    offscreen capture the AI copilot uses.
 * Nothing here writes to disk or exports.
 */
import type {
  BridgeHost,
  RenderSummary,
  ScreenshotArgs,
  ScreenshotResult,
  StudioState,
} from './agentBridge';
import { capturePreviewScreenshot } from './studioTooling';
import { openFileInWindow } from './windowOpenService';
import {
  getLatestArtifactForTarget,
  getRenderArtifactState,
  createSourceHash,
  subscribeRenderArtifacts,
  type RenderArtifact,
} from '../stores/renderArtifactStore';
import { getProjectState, getProjectStore, listProjectFiles } from '../stores/projectStore';
import { requestRender } from '../stores/renderRequestStore';
import { DEFAULT_TAB_NAME } from '../stores/workspaceFactories';
import { getWorkspaceState } from '../stores/workspaceStore';

const RENDER_TIMEOUT_MS = 30_000;

export function summarizeArtifact(artifact: RenderArtifact): RenderSummary {
  return {
    ok: !artifact.error && artifact.diagnostics.every((d) => d.severity !== 'error'),
    diagnostics: artifact.diagnostics.map((d) => ({
      severity: d.severity,
      message: d.message,
      ...(d.line !== undefined ? { line: d.line } : {}),
      ...(d.col !== undefined ? { col: d.col } : {}),
    })),
    error: artifact.error,
    createdAt: artifact.createdAt,
  };
}

function currentState(): StudioState {
  const project = getProjectState();
  const path = project.renderTargetPath;
  const file = path ? project.files[path] : undefined;
  const artifact = getLatestArtifactForTarget(path);
  return {
    path,
    source: file ? file.content : null,
    dirty: Object.values(project.files).some((f) => f.isDirty),
    files: listProjectFiles(project),
    contentVersion: project.contentVersion,
    render: artifact ? summarizeArtifact(artifact) : null,
  };
}

/**
 * Resolves with the first render that settles after `since` for exactly `source`, so a
 * render that was already in flight for older text cannot answer for this one.
 */
function waitForRender(source: string, since: number, timeoutMs: number): Promise<RenderArtifact> {
  const hash = createSourceHash(source);
  const match = () =>
    Object.values(getRenderArtifactState().artifactsByTarget).find(
      (a) => a.sourceHash === hash && a.createdAt >= since
    );
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error('Timed out waiting for Studio to finish rendering.'));
    }, timeoutMs);
    const off = subscribeRenderArtifacts(() => {
      const found = match();
      if (!found) return;
      clearTimeout(timer);
      off();
      resolve(found);
    });
  });
}

/** A new tab is on the welcome screen with no project; renders are suppressed there. */
function isFreshStart(): boolean {
  const workspace = getWorkspaceState();
  const project = getProjectState();
  return (
    workspace.showWelcome ||
    workspace.tabs.length === 0 ||
    project.renderTargetPath === null ||
    !(project.renderTargetPath in project.files)
  );
}

export function createStudioHost(options: { renderTimeoutMs?: number } = {}): BridgeHost {
  const timeoutMs = options.renderTimeoutMs ?? RENDER_TIMEOUT_MS;

  return {
    getState: currentState,

    async setSource(source) {
      const since = Date.now();
      const settled = waitForRender(source, since, timeoutMs);
      // Do not leave a rejected promise unhandled if applying the source throws first.
      settled.catch(() => undefined);
      if (isFreshStart()) {
        // Same steps as opening a file by URL: create the project and its tab, leave the
        // welcome screen, and request a render. Nothing is written to disk.
        await openFileInWindow(
          { path: null, name: DEFAULT_TAB_NAME, content: source },
          { trackRecent: false }
        );
      } else {
        const store = getProjectStore().getState();
        const target = getProjectState().renderTargetPath as string;
        store.updateFileContent(target, source);
        store.setCustomizerBase(target, source);
        requestRender('code_update', { immediate: true, code: source });
      }
      const artifact = await settled;
      return { path: getProjectState().renderTargetPath, render: summarizeArtifact(artifact) };
    },

    async triggerRender() {
      const state = currentState();
      if (state.path === null || state.source === null) {
        throw new Error('No file is open in Studio yet.');
      }
      const settled = waitForRender(state.source, Date.now(), timeoutMs);
      settled.catch(() => undefined);
      requestRender('manual', { immediate: true, code: state.source });
      const artifact = await settled;
      return { path: state.path, render: summarizeArtifact(artifact) };
    },

    async screenshot(args: ScreenshotArgs): Promise<ScreenshotResult> {
      const artifact = getLatestArtifactForTarget(getProjectState().renderTargetPath);
      if (!artifact) throw new Error('No successful 3D render to capture yet.');
      if (!summarizeArtifact(artifact).ok) {
        throw new Error(
          `The last render failed, so there is no model to capture: ${artifact.error || 'see diagnostics'}`
        );
      }
      if (artifact.previewKind !== 'mesh' || !artifact.previewSrc) {
        throw new Error('The current render is not a 3D model, so there is nothing to capture.');
      }
      const custom = args.azimuth !== undefined || args.elevation !== undefined;
      const view = custom ? undefined : (args.view ?? 'isometric');
      const shot = await capturePreviewScreenshot({
        captureCurrentView: async () => null,
        get3dPreviewUrl: () => artifact.previewSrc,
        getPreviewSceneStyle: () => artifact.sceneStyle,
        getUseModelColors: () => artifact.useModelColors,
        view,
        azimuth: args.azimuth,
        elevation: args.elevation,
      });
      if (!shot.image_data_url) throw new Error(shot.error ?? 'Could not capture the 3D view.');
      return {
        view: custom
          ? `custom (azimuth ${args.azimuth ?? 45}, elevation ${args.elevation ?? 30})`
          : (view as string),
        pngBase64: shot.image_data_url.replace(/^data:image\/png;base64,/, ''),
      };
    },

    onContentChanged(listener) {
      return getProjectStore().subscribe((state, previous) => {
        if (
          state.files !== previous.files ||
          state.renderTargetPath !== previous.renderTargetPath
        ) {
          listener();
        }
      });
    },

    onRenderSettled(listener) {
      return subscribeRenderArtifacts((state, previous) => {
        for (const [path, artifact] of Object.entries(state.artifactsByTarget)) {
          if (previous.artifactsByTarget[path] !== artifact) {
            listener({ path, render: summarizeArtifact(artifact) });
          }
        }
      });
    },
  };
}
