import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import type { Diagnostic } from '../services/renderService';
import type { PreviewSceneStyle } from '../services/previewSceneConfig';

export type RenderArtifactKind = 'mesh' | 'svg';

export interface RenderArtifact {
  artifactId: string;
  requestId: number;
  renderTargetPath: string;
  workspaceRoot: string | null;
  sourceHash: string;
  previewKind: RenderArtifactKind;
  previewSrc: string;
  diagnostics: Diagnostic[];
  error: string;
  dimensionMode: '2d' | '3d';
  sceneStyle: PreviewSceneStyle;
  useModelColors: boolean;
  createdAt: number;
}

export interface RenderArtifactStoreState {
  activeRenderTargetPath: string | null;
  workspaceRoot: string | null;
  artifactsByTarget: Record<string, RenderArtifact>;
  latestSuccessfulByTarget: Record<string, RenderArtifact>;
  latestByRequestId: Record<number, RenderArtifact>;
  inFlightRequestIdByTarget: Record<string, number>;
}

interface RenderArtifactStoreActions {
  setActiveRenderTarget: (path: string | null, workspaceRoot: string | null) => void;
  markRenderStarted: (renderTargetPath: string, requestId: number) => void;
  publishSettledArtifact: (artifact: Omit<RenderArtifact, 'artifactId'>) => void;
  clearArtifactsForWorkspace: (workspaceRoot: string | null) => void;
  clearArtifactsForTarget: (renderTargetPath: string) => void;
  reset: () => void;
}

export type RenderArtifactStore = RenderArtifactStoreState & RenderArtifactStoreActions;

function createInitialRenderArtifactState(): RenderArtifactStoreState {
  return {
    activeRenderTargetPath: null,
    workspaceRoot: null,
    artifactsByTarget: {},
    latestSuccessfulByTarget: {},
    latestByRequestId: {},
    inFlightRequestIdByTarget: {},
  };
}

function isArtifactSuccessful(artifact: RenderArtifact): boolean {
  return !artifact.error && artifact.diagnostics.every((entry) => entry.severity !== 'error');
}

export function createSourceHash(source: string): string {
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function createArtifactId(artifact: Omit<RenderArtifact, 'artifactId'>): string {
  return [
    artifact.renderTargetPath,
    artifact.requestId,
    artifact.sourceHash,
    artifact.createdAt,
  ].join(':');
}

function buildEmptyRequestMap(
  requestIdMap: Record<string, number>,
  renderTargetPath: string
): Record<string, number> {
  const next = { ...requestIdMap };
  delete next[renderTargetPath];
  return next;
}

export function createRenderArtifactStore(
  initialState: RenderArtifactStoreState = createInitialRenderArtifactState()
) {
  return createStore<RenderArtifactStore>()((set, get) => ({
    ...initialState,

    setActiveRenderTarget: (path, workspaceRoot) => {
      set((state) => {
        const workspaceChanged = state.workspaceRoot !== workspaceRoot;
        if (!workspaceChanged) {
          return {
            ...state,
            activeRenderTargetPath: path,
            workspaceRoot,
          };
        }

        return {
          ...createInitialRenderArtifactState(),
          activeRenderTargetPath: path,
          workspaceRoot,
        };
      });
    },

    markRenderStarted: (renderTargetPath, requestId) => {
      set((state) => ({
        ...state,
        activeRenderTargetPath: renderTargetPath,
        inFlightRequestIdByTarget: {
          ...state.inFlightRequestIdByTarget,
          [renderTargetPath]: requestId,
        },
      }));
    },

    publishSettledArtifact: (artifactInput) => {
      const artifact = {
        ...artifactInput,
        artifactId: createArtifactId(artifactInput),
      };

      set((state) => ({
        ...state,
        activeRenderTargetPath: artifact.renderTargetPath,
        workspaceRoot: artifact.workspaceRoot,
        artifactsByTarget: {
          ...state.artifactsByTarget,
          [artifact.renderTargetPath]: artifact,
        },
        latestSuccessfulByTarget: isArtifactSuccessful(artifact)
          ? {
              ...state.latestSuccessfulByTarget,
              [artifact.renderTargetPath]: artifact,
            }
          : state.latestSuccessfulByTarget,
        latestByRequestId: {
          ...state.latestByRequestId,
          [artifact.requestId]: artifact,
        },
        inFlightRequestIdByTarget: buildEmptyRequestMap(
          state.inFlightRequestIdByTarget,
          artifact.renderTargetPath
        ),
      }));
    },

    clearArtifactsForWorkspace: (workspaceRoot) => {
      if (get().workspaceRoot !== workspaceRoot) {
        return;
      }
      set({
        ...createInitialRenderArtifactState(),
        workspaceRoot,
      });
    },

    clearArtifactsForTarget: (renderTargetPath) => {
      set((state) => {
        const artifactsByTarget = { ...state.artifactsByTarget };
        const latestSuccessfulByTarget = { ...state.latestSuccessfulByTarget };
        const inFlightRequestIdByTarget = { ...state.inFlightRequestIdByTarget };
        delete artifactsByTarget[renderTargetPath];
        delete latestSuccessfulByTarget[renderTargetPath];
        delete inFlightRequestIdByTarget[renderTargetPath];

        const latestByRequestId = Object.fromEntries(
          Object.entries(state.latestByRequestId).filter(
            ([, artifact]) => artifact.renderTargetPath !== renderTargetPath
          )
        ) as Record<number, RenderArtifact>;

        return {
          ...state,
          artifactsByTarget,
          latestSuccessfulByTarget,
          latestByRequestId,
          inFlightRequestIdByTarget,
        };
      });
    },

    reset: () => {
      set(createInitialRenderArtifactState());
    },
  }));
}

const renderArtifactStore = createRenderArtifactStore();

export function useRenderArtifactStore<T>(selector: (state: RenderArtifactStore) => T): T {
  return useStore(renderArtifactStore, selector);
}

export function getRenderArtifactState(): RenderArtifactStore {
  return renderArtifactStore.getState();
}

/** Calls `listener` on every store change; returns an unsubscribe function. */
export function subscribeRenderArtifacts(
  listener: (state: RenderArtifactStore, previous: RenderArtifactStore) => void
): () => void {
  return renderArtifactStore.subscribe(listener);
}

export function getLatestArtifactForTarget(renderTargetPath: string | null): RenderArtifact | null {
  if (!renderTargetPath) {
    return null;
  }
  return getRenderArtifactState().artifactsByTarget[renderTargetPath] ?? null;
}

export function getLatestSuccessfulArtifactForTarget(
  renderTargetPath: string | null
): RenderArtifact | null {
  if (!renderTargetPath) {
    return null;
  }
  return getRenderArtifactState().latestSuccessfulByTarget[renderTargetPath] ?? null;
}

export function getArtifactByRequestId(requestId: number): RenderArtifact | null {
  return getRenderArtifactState().latestByRequestId[requestId] ?? null;
}

export function getRenderArtifactDebugState() {
  return renderArtifactStore.getState();
}

export function __resetRenderArtifactStoreForTests() {
  renderArtifactStore.getState().reset();
}
