/**
 * Agent bridge: a live two-way WebSocket link between this Studio tab and a local
 * agent server (an MCP server on this computer, wire protocol version 1).
 *
 * Started only when the page is opened with `?agentBridge=<ws url>&agentToken=<token>`.
 * The URL must be a loopback `ws://` address; both parameters are removed from the
 * address bar as soon as they are read, and the token is never logged.
 *
 * Frames (JSON text):
 *   tab -> server  { t:'hello', v:1, app }
 *   tab -> server  { t:'event', name:'state'|'source_changed'|'render_settled'|'approve', data }
 *   tab -> server  { t:'res', id, ok, result?, error? }
 *   server -> tab  { t:'req', id, tool, args }   tool is one of ALLOWED_TOOLS, nothing else
 *   server -> tab  { t:'event', name:'project_state'|'notice', data }
 *
 * This file is transport and policy only. What the tools do inside Studio lives in
 * `agentBridgeHost.ts`, so everything here can be tested against a fake host.
 */
import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';

export const AGENT_BRIDGE_PROTOCOL_VERSION = 1;
export const AGENT_BRIDGE_APP_NAME = 'openscad-studio-web';

/** The only requests the tab will answer. Nothing here writes to disk or exports. */
export const ALLOWED_TOOLS = ['get_state', 'set_source', 'trigger_render', 'screenshot'] as const;
export type AllowedTool = (typeof ALLOWED_TOOLS)[number];

export const SCREENSHOT_VIEWS = [
  'front',
  'back',
  'top',
  'bottom',
  'left',
  'right',
  'isometric',
] as const;

// ---- shapes shared with the server (agent-link.ts) --------------------------

export interface BridgeDiagnostic {
  severity: 'error' | 'warning' | 'info';
  message: string;
  line?: number;
  col?: number;
}

export interface RenderSummary {
  ok: boolean;
  diagnostics: BridgeDiagnostic[];
  error: string;
  createdAt: number;
}

export interface StudioState {
  path: string | null;
  source: string | null;
  dirty: boolean;
  files: string[];
  contentVersion: number;
  render: RenderSummary | null;
}

export interface SetSourceResult {
  path: string | null;
  replacedEditedSource: boolean;
  render: RenderSummary | null;
}

export interface ScreenshotArgs {
  view?: (typeof SCREENSHOT_VIEWS)[number];
  azimuth?: number;
  elevation?: number;
}

export interface ScreenshotResult {
  view: string;
  /** Raw base64 PNG, no `data:` prefix. */
  pngBase64: string;
}

/** What the panel's buttons can approve. `gcode` is the wire name for "send the print". */
export interface Approval {
  what: 'brief' | 'plan' | 'design' | 'gcode';
  revisionId?: string;
}

// ---- project_state, as pushed by the server (core.ts canvasState) -----------

export interface PrintRequestInfo {
  revisionId: string;
  revisionNumber: number;
  fileName: string;
  estimate: SliceEstimateInfo;
  requestedAt: string;
}

export interface PrintJobInfo {
  state: 'uploading' | 'starting' | 'sent' | 'failed';
  message: string;
  at: string;
}

export interface SliceEstimateInfo {
  printTimeMinutes: number;
  filamentGrams: number;
  filamentMeters: number;
  layerCount: number;
  layerHeightMm: number;
  nozzleTempC: number;
  bedTempC: number;
}

export interface ProjectState {
  status: {
    phase: string;
    next: string | null;
    blockedBecause: string | null;
    pendingApproval: 'brief' | 'plan' | 'design' | 'print' | null;
    unresolvedPrincipleConflict?: boolean;
    guidance?: string;
  };
  brief: {
    summary: string;
    function: string;
    environment: string;
    fitConstraints?: string[];
    materials?: string[];
  } | null;
  planSteps: { id: string; description: string; acceptance: string }[];
  planStepStatuses: { stepId: string; state: string }[];
  principles: { id: string; kind: string; statement: string; rationale?: string }[];
  estimate: SliceEstimateInfo | null;
  /** Absent on a server without printing: treated as "no print request". */
  printRequest?: PrintRequestInfo | null;
  printJob?: PrintJobInfo | null;
}

// ---- what the bridge needs from Studio --------------------------------------

export interface BridgeHost {
  getState(): StudioState;
  /** Puts `source` in the editor and renders it; resolves when that render settles. */
  setSource(source: string): Promise<{ path: string | null; render: RenderSummary | null }>;
  /** Renders the current source; resolves when the render settles. */
  triggerRender(): Promise<{ path: string | null; render: RenderSummary }>;
  screenshot(args: ScreenshotArgs): Promise<ScreenshotResult>;
  /** Called on any change to the project's content. Returns an unsubscribe function. */
  onContentChanged(listener: () => void): () => void;
  /** Called after every render settles. Returns an unsubscribe function. */
  onRenderSettled(
    listener: (event: { path: string | null; render: RenderSummary }) => void
  ): () => void;
}

// ---- panel store -------------------------------------------------------------

export type BridgeStatus = 'off' | 'connecting' | 'open' | 'closed' | 'replaced';

export interface AgentBridgeStoreState {
  status: BridgeStatus;
  projectState: ProjectState | null;
  notice: string | null;
}

const agentBridgeStore = createStore<AgentBridgeStoreState>(() => ({
  status: 'off',
  projectState: null,
  notice: null,
}));

export function getAgentBridgeStore() {
  return agentBridgeStore;
}

export function useAgentBridgeStore<T>(selector: (state: AgentBridgeStoreState) => T): T {
  return useStore(agentBridgeStore, selector);
}

let activeBridge: AgentBridge | null = null;

/** Sends an approval over the live link. False if there is no open link. */
export function sendAgentApproval(approval: Approval): boolean {
  return activeBridge?.sendApproval(approval) ?? false;
}

// ---- URL handling ------------------------------------------------------------

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** True only for a plain `ws://` URL on this machine (no credentials). */
export function isLocalWsUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === 'ws:' &&
    LOCAL_HOSTS.has(url.hostname) &&
    url.username === '' &&
    url.password === ''
  );
}

export interface BridgeParams {
  url: string;
  token: string;
}

/** Reads the two page parameters; null unless both are present and the URL is local. */
export function parseBridgeParams(search: string): BridgeParams | null {
  const params = new URLSearchParams(search);
  const url = params.get('agentBridge');
  const token = params.get('agentToken');
  if (!url || !token || !isLocalWsUrl(url)) return null;
  return { url, token };
}

/** Removes the bridge parameters (and so the token) from the address bar. */
export function stripBridgeParams(win: Pick<Window, 'location' | 'history'>): void {
  const url = new URL(win.location.href);
  if (!url.searchParams.has('agentBridge') && !url.searchParams.has('agentToken')) return;
  url.searchParams.delete('agentBridge');
  url.searchParams.delete('agentToken');
  win.history.replaceState(win.history.state, '', `${url.pathname}${url.search}${url.hash}`);
}

// ---- the bridge --------------------------------------------------------------

interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}
type SocketCtor = new (url: string) => SocketLike;

export interface AgentBridgeOptions {
  url: string;
  token: string;
  host: BridgeHost;
  WebSocketImpl?: SocketCtor;
  /** Quiet time after the last keystroke before `source_changed` is sent. */
  sourceDebounceMs?: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
}

const WS_OPEN = 1;
/** The server closes with these when it will never accept this tab: do not retry. */
const CLOSE_REPLACED = 4000;
const CLOSE_BAD_VERSION = 4001;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class AgentBridge {
  private socket: SocketLike | null = null;
  private stopped = true;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribers: (() => void)[] = [];
  /** The source the server last knew: from our state events, or from the agent's own set_source. */
  private lastReported: string | null = null;
  /** The source the agent last wrote, to tell whether the user edited it since. */
  private lastApplied: string | null = null;

  constructor(private readonly options: AgentBridgeOptions) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.detach();
    this.socket?.close();
    this.socket = null;
    agentBridgeStore.setState({ status: 'off', projectState: null, notice: null });
  }

  sendApproval(approval: Approval): boolean {
    return this.sendFrame({
      t: 'event',
      name: 'approve',
      data: {
        what: approval.what,
        ...(approval.revisionId !== undefined ? { revisionId: approval.revisionId } : {}),
      },
    });
  }

  // ---- connection ----

  private connect(): void {
    const Ctor = this.options.WebSocketImpl ?? (WebSocket as unknown as SocketCtor);
    const target = new URL(this.options.url);
    target.searchParams.set('token', this.options.token);
    agentBridgeStore.setState({ status: 'connecting' });
    let socket: SocketLike;
    try {
      socket = new Ctor(target.toString());
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.attempt = 0;
      agentBridgeStore.setState({ status: 'open' });
      this.sendFrame({
        t: 'hello',
        v: AGENT_BRIDGE_PROTOCOL_VERSION,
        app: AGENT_BRIDGE_APP_NAME,
      });
      this.attach();
      const state = this.options.host.getState();
      this.lastReported = state.source;
      this.sendFrame({ t: 'event', name: 'state', data: state });
    };
    socket.onmessage = (event) => {
      if (this.socket === socket && typeof event.data === 'string') this.onMessage(event.data);
    };
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.detach();
      if (this.stopped) return;
      if (event.code === CLOSE_REPLACED || event.code === CLOSE_BAD_VERSION) {
        this.stopped = true;
        agentBridgeStore.setState({
          status: event.code === CLOSE_REPLACED ? 'replaced' : 'closed',
        });
        return;
      }
      agentBridgeStore.setState({ status: 'closed' });
      this.scheduleReconnect();
    };
    socket.onerror = () => {
      // A close event always follows; reconnecting is handled there.
    };
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const base = this.options.reconnectBaseMs ?? 1000;
    const max = this.options.reconnectMaxMs ?? 15000;
    const delay = Math.min(max, base * 2 ** this.attempt);
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped) this.connect();
    }, delay);
  }

  private sendFrame(frame: unknown): boolean {
    const socket = this.socket;
    if (!socket || socket.readyState !== WS_OPEN) return false;
    socket.send(JSON.stringify(frame));
    return true;
  }

  // ---- events to the server ----

  private attach(): void {
    const { host } = this.options;
    this.unsubscribers.push(
      host.onContentChanged(() => this.onContentChanged()),
      host.onRenderSettled((event) =>
        this.sendFrame({ t: 'event', name: 'render_settled', data: event })
      )
    );
  }

  private detach(): void {
    for (const off of this.unsubscribers) off();
    this.unsubscribers = [];
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
  }

  /**
   * Typing and customizer changes arrive here. Anything that leaves the source equal
   * to what the server already knows (including the agent's own set_source landing in
   * the editor) is not a user edit and is never reported as one.
   */
  private onContentChanged(): void {
    if (this.options.host.getState().source === this.lastReported) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      const state = this.options.host.getState();
      if (state.source === this.lastReported) return;
      this.lastReported = state.source;
      this.sendFrame({ t: 'event', name: 'source_changed', data: state });
    }, this.options.sourceDebounceMs ?? 400);
  }

  // ---- frames from the server ----

  private onMessage(raw: string): void {
    let frame: unknown;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof frame !== 'object' || frame === null) return;
    const f = frame as Record<string, unknown>;
    if (f.t === 'req' && typeof f.id === 'string' && typeof f.tool === 'string') {
      void this.onRequest(f.id, f.tool, f.args);
    } else if (f.t === 'event') {
      this.onServerEvent(f.name, f.data);
    }
  }

  private onServerEvent(name: unknown, data: unknown): void {
    if (name === 'project_state') {
      if (isProjectState(data)) agentBridgeStore.setState({ projectState: data });
    } else if (name === 'notice') {
      const text = (data as { text?: unknown } | null)?.text;
      if (typeof text === 'string') agentBridgeStore.setState({ notice: text });
    }
  }

  private async onRequest(id: string, tool: string, args: unknown): Promise<void> {
    if (!(ALLOWED_TOOLS as readonly string[]).includes(tool)) {
      this.sendFrame({
        t: 'res',
        id,
        ok: false,
        error: `Tool "${tool}" is not allowed over the agent link.`,
      });
      return;
    }
    try {
      const result = await this.runTool(tool as AllowedTool, asRecord(args));
      this.sendFrame({ t: 'res', id, ok: true, result });
    } catch (err) {
      this.sendFrame({ t: 'res', id, ok: false, error: errorMessage(err) });
    }
  }

  private async runTool(tool: AllowedTool, args: Record<string, unknown>): Promise<unknown> {
    const { host } = this.options;
    switch (tool) {
      case 'get_state':
        return host.getState();
      case 'set_source': {
        if (typeof args.source !== 'string') throw new Error('set_source needs a string "source".');
        const source = args.source;
        const before = host.getState();
        const replacedEditedSource =
          this.lastApplied !== null
            ? before.source !== this.lastApplied
            : before.dirty && before.source !== source;
        // Mark the new text as already known before it reaches the editor, so the
        // editor's own change notifications are not mistaken for the user typing.
        const previousReported = this.lastReported;
        const previousApplied = this.lastApplied;
        this.lastReported = source;
        this.lastApplied = source;
        try {
          const out = await host.setSource(source);
          this.sendFrame({ t: 'event', name: 'state', data: host.getState() });
          const result: SetSourceResult = {
            path: out.path,
            replacedEditedSource,
            render: out.render,
          };
          return result;
        } catch (err) {
          this.lastReported = previousReported;
          this.lastApplied = previousApplied;
          throw err;
        }
      }
      case 'trigger_render':
        return host.triggerRender();
      case 'screenshot':
        return host.screenshot(parseScreenshotArgs(args));
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parseScreenshotArgs(args: Record<string, unknown>): ScreenshotArgs {
  const out: ScreenshotArgs = {};
  if (args.view !== undefined) {
    if (!(SCREENSHOT_VIEWS as readonly unknown[]).includes(args.view)) {
      throw new Error(`Unknown view "${String(args.view)}". Use ${SCREENSHOT_VIEWS.join(', ')}.`);
    }
    out.view = args.view as ScreenshotArgs['view'];
  }
  for (const key of ['azimuth', 'elevation'] as const) {
    const value = args[key];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`"${key}" must be a number.`);
    }
    out[key] = value;
  }
  return out;
}

function isProjectState(value: unknown): value is ProjectState {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<ProjectState>;
  return (
    typeof v.status === 'object' &&
    v.status !== null &&
    typeof v.status.phase === 'string' &&
    Array.isArray(v.planSteps) &&
    Array.isArray(v.planStepStatuses) &&
    Array.isArray(v.principles)
  );
}

// ---- entry point -------------------------------------------------------------

/**
 * Reads the page URL once. If it carries a valid local bridge link, starts the bridge;
 * in every case the bridge parameters are removed from the address bar. Returns the
 * running bridge, or null when there is nothing to start.
 */
export function startAgentBridgeFromUrl(
  host: BridgeHost,
  win: Pick<Window, 'location' | 'history'> = window,
  overrides: Partial<AgentBridgeOptions> = {}
): AgentBridge | null {
  const params = parseBridgeParams(win.location.search);
  stripBridgeParams(win);
  if (!params || activeBridge) return null;
  const bridge = new AgentBridge({ ...params, host, ...overrides });
  activeBridge = bridge;
  bridge.start();
  return bridge;
}

export function __resetAgentBridgeForTests() {
  activeBridge?.stop();
  activeBridge = null;
  agentBridgeStore.setState({ status: 'off', projectState: null, notice: null });
}
