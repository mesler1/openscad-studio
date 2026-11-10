/** @jest-environment jsdom */

import { jest } from '@jest/globals';
import {
  AgentBridge,
  __resetAgentBridgeForTests,
  getAgentBridgeStore,
  isLocalWsUrl,
  parseBridgeParams,
  sendAgentApproval,
  startAgentBridgeFromUrl,
  type BridgeHost,
  type RenderSummary,
  type StudioState,
} from '../agentBridge';

interface Frame {
  t: string;
  name?: string;
  id?: string;
  ok?: boolean;
  error?: string;
  result: { replacedEditedSource?: boolean } & Record<string, unknown>;
  data: { source?: string | null } & Record<string, unknown>;
}

class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: Frame[] = [];
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  frames(t: string, name?: string) {
    return this.sent.filter((f) => f.t === t && (name === undefined || f.name === name));
  }
}

const RENDER_OK: RenderSummary = { ok: true, diagnostics: [], error: '', createdAt: 5 };

/** A stand-in for Studio: a text buffer the "user" can type into. */
function makeHost() {
  let source: string | null = 'cube(1);';
  let version = 1;
  let dirty = false;
  const contentListeners = new Set<() => void>();
  const renderListeners = new Set<(e: { path: string | null; render: RenderSummary }) => void>();
  const host = {
    getState: jest.fn(
      (): StudioState => ({
        path: 'main.scad',
        source,
        dirty,
        files: ['main.scad'],
        contentVersion: version,
        render: RENDER_OK,
      })
    ),
    setSource: jest.fn(async (next: string) => {
      source = next;
      version += 1;
      // The editor reports its own change, just as Studio's stores would.
      contentListeners.forEach((l) => l());
      return { path: 'main.scad', render: RENDER_OK };
    }),
    triggerRender: jest.fn(async () => ({ path: 'main.scad', render: RENDER_OK })),
    screenshot: jest.fn(async (args: { view?: string }) => ({
      view: args.view ?? 'isometric',
      pngBase64: 'UE5H',
    })),
    onContentChanged: jest.fn((l: () => void) => {
      contentListeners.add(l);
      return () => contentListeners.delete(l);
    }),
    onRenderSettled: jest.fn((l: (e: { path: string | null; render: RenderSummary }) => void) => {
      renderListeners.add(l);
      return () => renderListeners.delete(l);
    }),
  };
  return {
    host: host as unknown as BridgeHost & typeof host,
    type(next: string) {
      source = next;
      dirty = true;
      version += 1;
      contentListeners.forEach((l) => l());
    },
    settle(render: RenderSummary) {
      renderListeners.forEach((l) => l({ path: 'main.scad', render }));
    },
  };
}

function start(overrides: Record<string, unknown> = {}) {
  const fake = makeHost();
  const bridge = new AgentBridge({
    url: 'ws://127.0.0.1:4321/agent?project=p1',
    host: fake.host,
    WebSocketImpl: FakeSocket,
    sourceDebounceMs: 100,
    reconnectBaseMs: 1000,
    reconnectMaxMs: 4000,
    ...overrides,
  });
  bridge.start();
  const socket = FakeSocket.instances.at(-1)!;
  socket.open();
  return { ...fake, bridge, socket };
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('URL gating', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    FakeSocket.instances = [];
    __resetAgentBridgeForTests();
  });
  afterEach(() => {
    __resetAgentBridgeForTests();
    jest.useRealTimers();
  });

  it('accepts only plain local ws:// addresses', () => {
    for (const ok of [
      'ws://127.0.0.1:1/agent',
      'ws://localhost:9/agent?project=p',
      'ws://[::1]:5/agent',
    ]) {
      expect(isLocalWsUrl(ok)).toBe(true);
    }
    for (const bad of [
      'wss://127.0.0.1:1/agent',
      'ws://evil.example:1/agent',
      'ws://127.0.0.1.evil.example/agent',
      'ws://user:pw@127.0.0.1:1/agent',
      'http://127.0.0.1:1/agent',
      'ws://192.168.1.5:1/agent',
      'not a url',
    ]) {
      expect(isLocalWsUrl(bad)).toBe(false);
    }
  });

  it('needs the agentBridge parameter, and ignores the retired agentToken', () => {
    expect(parseBridgeParams('')).toBeNull();
    expect(parseBridgeParams('?agentToken=t')).toBeNull();
    expect(parseBridgeParams('?agentBridge=ws%3A%2F%2F127.0.0.1%3A1%2Fagent')).toEqual({
      url: 'ws://127.0.0.1:1/agent',
    });
    expect(parseBridgeParams('?agentBridge=ws%3A%2F%2F127.0.0.1%3A1%2Fagent&agentToken=t')).toEqual(
      { url: 'ws://127.0.0.1:1/agent' }
    );
  });

  it('refuses a non-local URL: no socket is opened, yet the parameters are still removed', () => {
    window.history.replaceState(
      null,
      '',
      '/?keep=1&agentBridge=ws%3A%2F%2Fevil.example%3A1%2Fagent&agentToken=leaked#h'
    );
    const bridge = startAgentBridgeFromUrl(makeHost().host, window, {
      WebSocketImpl: FakeSocket,
    });
    expect(bridge).toBeNull();
    expect(FakeSocket.instances).toHaveLength(0);
    expect(window.location.search).toBe('?keep=1');
    expect(window.location.hash).toBe('#h');
  });

  it('starts for a local URL, connects to exactly that URL with no token, and strips the parameter', () => {
    window.history.replaceState(
      null,
      '',
      '/?agentBridge=ws%3A%2F%2F127.0.0.1%3A4321%2F__studio%2Fagent%3Fproject%3Dp1'
    );
    const bridge = startAgentBridgeFromUrl(makeHost().host, window, {
      WebSocketImpl: FakeSocket,
    });
    expect(bridge).not.toBeNull();
    expect(window.location.search).toBe('');
    expect(window.location.href).not.toContain('agentBridge');
    const socket = FakeSocket.instances[0];
    expect(socket.url).toBe('ws://127.0.0.1:4321/__studio/agent?project=p1');
    expect(socket.url).not.toMatch(/token/i);
  });

  it('remembers the URL for this tab so a reload reconnects, and forgets a non-local one', () => {
    window.history.replaceState(
      null,
      '',
      '/?agentBridge=ws%3A%2F%2F127.0.0.1%3A4321%2F__studio%2Fagent%3Fproject%3Dp1'
    );
    startAgentBridgeFromUrl(makeHost().host, window, { WebSocketImpl: FakeSocket });
    expect(window.location.search).toBe('');
    // A reload: the page parameter is gone and the module state is fresh.
    FakeSocket.instances = [];
    const stored = window.sessionStorage.getItem('agentBridgeUrl');
    __resetAgentBridgeForTests(); // clears storage as part of a test reset
    window.sessionStorage.setItem('agentBridgeUrl', stored!);
    window.history.replaceState(null, '', '/');
    expect(
      startAgentBridgeFromUrl(makeHost().host, window, { WebSocketImpl: FakeSocket })
    ).not.toBeNull();
    expect(FakeSocket.instances[0].url).toBe('ws://127.0.0.1:4321/__studio/agent?project=p1');

    __resetAgentBridgeForTests();
    FakeSocket.instances = [];
    window.sessionStorage.setItem('agentBridgeUrl', 'ws://evil.example:1/agent');
    expect(
      startAgentBridgeFromUrl(makeHost().host, window, { WebSocketImpl: FakeSocket })
    ).toBeNull();
    expect(FakeSocket.instances).toHaveLength(0);
  });

  it('uses the secret path segment from the URL as given, and removes it from the address bar', () => {
    const seg = 'ab'.repeat(24);
    const ws = `ws://127.0.0.1:4321/__studio/${seg}/agent?project=p1`;
    window.history.replaceState(null, '', `/?agentBridge=${encodeURIComponent(ws)}`);
    const bridge = startAgentBridgeFromUrl(makeHost().host, window, {
      WebSocketImpl: FakeSocket,
    });
    expect(bridge).not.toBeNull();
    expect(FakeSocket.instances[0].url).toBe(ws);
    expect(window.location.href).not.toContain(seg);
    expect(window.location.search).toBe('');
    // Never rendered: nothing in the document holds it.
    expect(document.documentElement.outerHTML).not.toContain(seg);
  });

  it('refuses to start inside a frame: no socket, no panel, nothing remembered, URL still stripped', () => {
    const ws = 'ws://127.0.0.1:4321/__studio/' + 'cd'.repeat(24) + '/agent?project=p1';
    window.history.replaceState(null, '', `/?agentBridge=${encodeURIComponent(ws)}`);
    const framed = {
      location: window.location,
      history: window.history,
      top: {} as Window, // a different window than `self`: we are in a frame
      self: window,
    };
    const bridge = startAgentBridgeFromUrl(makeHost().host, framed, {
      WebSocketImpl: FakeSocket,
    });
    expect(bridge).toBeNull();
    expect(FakeSocket.instances).toHaveLength(0);
    expect(getAgentBridgeStore().getState().status).toBe('off'); // the panel renders nothing when off
    expect(window.sessionStorage.getItem('agentBridgeUrl')).toBeNull();
    expect(window.location.search).toBe('');
    // A stored link from before is not used inside a frame either.
    window.sessionStorage.setItem('agentBridgeUrl', ws);
    expect(
      startAgentBridgeFromUrl(makeHost().host, framed, { WebSocketImpl: FakeSocket })
    ).toBeNull();
    expect(FakeSocket.instances).toHaveLength(0);
    expect(window.sessionStorage.getItem('agentBridgeUrl')).toBeNull();
    // The same page not in a frame starts normally.
    window.history.replaceState(null, '', `/?agentBridge=${encodeURIComponent(ws)}`);
    expect(
      startAgentBridgeFromUrl(makeHost().host, window, { WebSocketImpl: FakeSocket })
    ).not.toBeNull();
  });

  it('does nothing without the parameters', () => {
    window.history.replaceState(null, '', '/');
    expect(startAgentBridgeFromUrl(makeHost().host, window)).toBeNull();
    expect(getAgentBridgeStore().getState().status).toBe('off');
  });

  it('never logs the bridge URL', () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      jest.spyOn(console, m).mockImplementation(() => undefined)
    );
    const { socket } = start();
    socket.drop();
    jest.advanceTimersByTime(1000);
    for (const spy of spies) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain('127.0.0.1');
      spy.mockRestore();
    }
  });
});

describe('connection', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    FakeSocket.instances = [];
    __resetAgentBridgeForTests();
  });
  afterEach(() => {
    __resetAgentBridgeForTests();
    jest.useRealTimers();
  });

  it('says hello on open (protocol 2), then reports its state', () => {
    const { socket } = start();
    expect(socket.sent[0]).toEqual({ t: 'hello', v: 2, app: 'openscad-studio-web' });
    const state = socket.frames('event', 'state')[0];
    expect(state.data).toMatchObject({ path: 'main.scad', source: 'cube(1);', dirty: false });
  });

  it('stops with a clear status when the server refuses the protocol version (old server or old tab)', () => {
    const { socket } = start();
    socket.drop(4001);
    expect(getAgentBridgeStore().getState().status).toBe('outdated');
    jest.advanceTimersByTime(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('reconnects with growing backoff, and stops when replaced by a newer tab', () => {
    const { socket } = start();
    socket.drop();
    expect(FakeSocket.instances).toHaveLength(1);
    jest.advanceTimersByTime(999);
    expect(FakeSocket.instances).toHaveLength(1);
    jest.advanceTimersByTime(1);
    expect(FakeSocket.instances).toHaveLength(2);
    FakeSocket.instances[1].drop(); // never opened: next wait is 2s
    jest.advanceTimersByTime(1999);
    expect(FakeSocket.instances).toHaveLength(2);
    jest.advanceTimersByTime(1);
    expect(FakeSocket.instances).toHaveLength(3);
    FakeSocket.instances[2].drop(4000);
    jest.advanceTimersByTime(60_000);
    expect(FakeSocket.instances).toHaveLength(3);
    expect(getAgentBridgeStore().getState().status).toBe('replaced');
  });
});

describe('refused because another tab is connected', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    FakeSocket.instances = [];
    __resetAgentBridgeForTests();
  });

  it('shows a refused status and never retries', () => {
    const { socket } = start();
    socket.drop(4002);
    jest.advanceTimersByTime(120_000);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(getAgentBridgeStore().getState().status).toBe('refused');
  });
});

describe('request tools', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    FakeSocket.instances = [];
    __resetAgentBridgeForTests();
  });
  afterEach(() => {
    __resetAgentBridgeForTests();
    jest.useRealTimers();
  });

  const ask = async (socket: FakeSocket, tool: string, args: unknown = {}) => {
    const id = `id-${socket.sent.length}`;
    socket.receive({ t: 'req', id, tool, args });
    await flush();
    return socket.frames('res').find((f) => f.id === id)!;
  };

  it('get_state answers with the StateSchema shape', async () => {
    const { socket } = start();
    const res = await ask(socket, 'get_state');
    expect(res).toMatchObject({ ok: true });
    expect(res.result).toEqual({
      path: 'main.scad',
      source: 'cube(1);',
      dirty: false,
      files: ['main.scad'],
      contentVersion: 1,
      render: RENDER_OK,
    });
  });

  it('set_source applies the source and returns path, replacedEditedSource and the render', async () => {
    const { socket, host } = start();
    const res = await ask(socket, 'set_source', { source: 'cube(2);' });
    expect(host.setSource).toHaveBeenCalledWith('cube(2);');
    expect(res).toMatchObject({
      ok: true,
      result: { path: 'main.scad', replacedEditedSource: false, render: RENDER_OK },
    });
  });

  it('set_source rejects a missing source without touching the editor', async () => {
    const { socket, host } = start();
    const res = await ask(socket, 'set_source', { source: 42 });
    expect(res.ok).toBe(false);
    expect(host.setSource).not.toHaveBeenCalled();
  });

  it('set_source says so when the user had edited the text the agent last wrote', async () => {
    const { socket, type } = start();
    await ask(socket, 'set_source', { source: 'cube(2);' });
    expect(
      (await ask(socket, 'set_source', { source: 'cube(3);' })).result.replacedEditedSource
    ).toBe(false);
    type('cube(3); // mine');
    const res = await ask(socket, 'set_source', { source: 'cube(4);' });
    expect(res.result.replacedEditedSource).toBe(true);
  });

  it('set_source on a tab holding unsaved user text that was never presented counts as replacing it', async () => {
    const { socket, type } = start();
    type('cube(9);');
    const res = await ask(socket, 'set_source', { source: 'cube(2);' });
    expect(res.result.replacedEditedSource).toBe(true);
  });

  it('set_source reports a failed apply as an error res', async () => {
    const { socket, host } = start();
    host.setSource.mockRejectedValueOnce(
      new Error('Timed out waiting for Studio to finish rendering.')
    );
    const res = await ask(socket, 'set_source', { source: 'cube(2);' });
    expect(res).toMatchObject({ ok: false, error: expect.stringMatching(/Timed out/) });
  });

  it('trigger_render resolves with the settled render', async () => {
    const { socket, host } = start();
    const res = await ask(socket, 'trigger_render');
    expect(host.triggerRender).toHaveBeenCalled();
    expect(res).toMatchObject({ ok: true, result: { render: RENDER_OK } });
  });

  it('screenshot passes the view through and returns raw base64', async () => {
    const { socket, host } = start();
    const res = await ask(socket, 'screenshot', { view: 'front' });
    expect(host.screenshot).toHaveBeenCalledWith({ view: 'front' });
    expect(res.result).toEqual({ view: 'front', pngBase64: 'UE5H' });
    await ask(socket, 'screenshot', {});
    expect(host.screenshot).toHaveBeenLastCalledWith({});
    await ask(socket, 'screenshot', { azimuth: 30, elevation: 10 });
    expect(host.screenshot).toHaveBeenLastCalledWith({ azimuth: 30, elevation: 10 });
  });

  it('screenshot refuses an unknown view or a non-numeric angle', async () => {
    const { socket, host } = start();
    expect((await ask(socket, 'screenshot', { view: 'sideways' })).ok).toBe(false);
    expect((await ask(socket, 'screenshot', { azimuth: 'left' })).ok).toBe(false);
    expect(host.screenshot).not.toHaveBeenCalled();
  });

  it('passes a Studio failure such as nothing rendered yet on as the error text', async () => {
    const { socket, host } = start();
    host.screenshot.mockRejectedValueOnce(new Error('No successful 3D render to capture yet.'));
    const res = await ask(socket, 'screenshot');
    expect(res).toMatchObject({ ok: false, error: 'No successful 3D render to capture yet.' });
  });

  it('refuses every other tool with an error res and does nothing', async () => {
    const { socket, host } = start();
    for (const tool of ['export', 'save_file', 'write_file', 'get_diagnostics', 'eval', '']) {
      const res = await ask(socket, tool, { path: '/etc/passwd' });
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/not allowed/);
    }
    expect(host.setSource).not.toHaveBeenCalled();
    expect(host.triggerRender).not.toHaveBeenCalled();
    expect(host.screenshot).not.toHaveBeenCalled();
  });

  it('ignores garbage frames', async () => {
    const { socket } = start();
    const before = socket.sent.length;
    socket.onmessage?.({ data: 'not json' });
    socket.receive({ t: 'req' });
    socket.receive(['x']);
    await flush();
    expect(socket.sent).toHaveLength(before);
  });
});

describe('events to the server', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    FakeSocket.instances = [];
    __resetAgentBridgeForTests();
  });
  afterEach(() => {
    __resetAgentBridgeForTests();
    jest.useRealTimers();
  });

  it('sends source_changed once, after typing pauses, with the full state', () => {
    const { socket, type } = start();
    type('cube(5);');
    jest.advanceTimersByTime(60);
    type('cube(55);');
    jest.advanceTimersByTime(99);
    expect(socket.frames('event', 'source_changed')).toHaveLength(0);
    jest.advanceTimersByTime(1);
    const sent = socket.frames('event', 'source_changed');
    expect(sent).toHaveLength(1);
    expect(sent[0].data).toMatchObject({ source: 'cube(55);', dirty: true });
  });

  it("does not report the agent's own set_source as a user edit", async () => {
    const { socket, host } = start();
    socket.receive({ t: 'req', id: 'a', tool: 'set_source', args: { source: 'cube(2);' } });
    await flush();
    jest.advanceTimersByTime(1000);
    expect(host.setSource).toHaveBeenCalled();
    expect(socket.frames('event', 'source_changed')).toHaveLength(0);
    // The agent's text is known to the server through a plain state event instead.
    const states = socket.frames('event', 'state');
    expect(states.at(-1)!.data.source).toBe('cube(2);');
    expect(socket.frames('res')[0]).toMatchObject({ ok: true });
  });

  it("a user edit right after the agent's write is reported, and editing back to it is too", async () => {
    const { socket, type } = start();
    socket.receive({ t: 'req', id: 'a', tool: 'set_source', args: { source: 'cube(2);' } });
    await flush();
    type('cube(2); // x');
    jest.advanceTimersByTime(100);
    expect(socket.frames('event', 'source_changed')).toHaveLength(1);
    type('cube(2);');
    jest.advanceTimersByTime(100);
    expect(socket.frames('event', 'source_changed')).toHaveLength(2);
  });

  it('drops a pending user-edit report if the agent has since written that same text', async () => {
    const { socket, type } = start();
    type('cube(7);');
    socket.receive({ t: 'req', id: 'a', tool: 'set_source', args: { source: 'cube(7);' } });
    await flush();
    jest.advanceTimersByTime(500);
    expect(socket.frames('event', 'source_changed')).toHaveLength(0);
  });

  it('forwards every settled render as render_settled', () => {
    const { socket, settle } = start();
    const failed: RenderSummary = {
      ok: false,
      diagnostics: [{ severity: 'error', message: 'syntax error', line: 3, col: 1 }],
      error: 'syntax error',
      createdAt: 9,
    };
    settle(failed);
    expect(socket.frames('event', 'render_settled')[0].data).toEqual({
      path: 'main.scad',
      render: failed,
    });
  });

  it('stops listening to the editor once the socket drops', () => {
    const { socket, type } = start();
    socket.drop();
    type('cube(5);');
    jest.advanceTimersByTime(1000);
    expect(socket.frames('event', 'source_changed')).toHaveLength(0);
  });
});

describe('what the server pushes', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    FakeSocket.instances = [];
    __resetAgentBridgeForTests();
  });
  afterEach(() => {
    __resetAgentBridgeForTests();
    jest.useRealTimers();
  });

  const pushed = {
    status: { phase: 'plan', next: 'implement', blockedBecause: 'x', pendingApproval: 'plan' },
    brief: null,
    planSteps: [],
    planStepStatuses: [],
    principles: [],
    estimate: null,
  };

  it('keeps project_state and notices for the panel, and ignores malformed state', () => {
    const { socket } = start();
    socket.receive({ t: 'event', name: 'project_state', data: { nonsense: true } });
    expect(getAgentBridgeStore().getState().projectState).toBeNull();
    socket.receive({ t: 'event', name: 'project_state', data: pushed });
    expect(getAgentBridgeStore().getState().projectState).toEqual(pushed);
    socket.receive({ t: 'event', name: 'notice', data: { text: 'Hello' } });
    expect(getAgentBridgeStore().getState().notice).toBe('Hello');
  });

  it('sends an approval in the shape the server accepts, only while connected', () => {
    const { socket, bridge } = start();
    expect(sendAgentApproval({ what: 'plan' })).toBe(false); // not the registered bridge
    expect(bridge.sendApproval({ what: 'design' })).toBe(true);
    expect(bridge.sendApproval({ what: 'gcode', revisionId: 'r1', requestedAt: 'T1' })).toBe(true);
    expect(socket.frames('event', 'approve').map((f) => f.data)).toEqual([
      { what: 'design' },
      { what: 'gcode', revisionId: 'r1', requestedAt: 'T1' },
    ]);
    socket.drop();
    expect(bridge.sendApproval({ what: 'brief' })).toBe(false);
  });
});
