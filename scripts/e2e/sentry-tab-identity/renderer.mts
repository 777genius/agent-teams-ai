import type { ElectronAPI } from '../../../src/shared/types/api.ts';
import type { ClaudeMdStats } from '../../../src/renderer/types/claudeMd.ts';
import type { ContextStats } from '../../../src/renderer/types/contextInjection.ts';
import type { OpenTabOptions, Tab, TabInput } from '../../../src/renderer/types/tabs.ts';

type Detail = Awaited<ReturnType<ElectronAPI['getSessionDetail']>>;
interface SessionData {
  sessionDetail: Detail;
  sessionDetailLoading: boolean;
  sessionDetailError: string | null;
  conversationLoading: boolean;
  sessionClaudeMdStats: Map<string, ClaudeMdStats> | null;
  sessionContextStats: Map<string, ContextStats> | null;
}
interface State extends SessionData {
  activeTabId: string | null;
  selectedProjectId: string | null;
  selectedSessionId: string | null;
  projects: Awaited<ReturnType<ElectronAPI['getProjects']>>;
  projectsLoading: boolean;
  appConfig: unknown;
  openTabs: Tab[];
  tabSessionData: Record<string, SessionData>;
  fetchProjects(): Promise<void>;
  selectProject(project: string): void;
  closeAllTabs(): void;
  openTab(input: TabInput, options?: OpenTabOptions): void;
  setActiveTab(id: string): void;
}
export type Boundary = 'getSessionDetail' | 'readDirectoryClaudeMd' | 'readMentionedFile';
interface Gate {
  originalGet: typeof Reflect.get;
  release(): void;
  waiting: number;
  pending: number;
  calls: { method: Boundary | 'readClaudeMdFiles'; args: unknown[]; fulfilled: boolean }[];
}
interface HarnessWindow {
  electronAPI: ElectronAPI;
  __agentTeamsDevStore: { getState(): State };
  __sentryIdentityGate?: Gate;
}
export interface RendererInput {
  project: string;
  session: string;
  directory: string;
  mentioned: string;
  boundary: Boundary;
  tab?: string;
}

// Serialized into the owned renderer. It uses real preload APIs; only delivery
// timing of a fulfilled test-session response changes. No production hooks.
export async function renderer(action: string, input: RendererInput) {
  const w = window as unknown as HarnessWindow;
  const store = w.__agentTeamsDevStore;
  if (action === 'ready') return Boolean(store?.getState().appConfig && w.electronAPI && navigator.userAgent.includes('Electron/'));
  if (action === 'reset') {
    w.__sentryIdentityGate?.release();
    if (w.__sentryIdentityGate) Reflect.get = w.__sentryIdentityGate.originalGet;
    delete w.__sentryIdentityGate;
    store.getState().closeAllTabs();
    await store.getState().fetchProjects();
    const deadline = Date.now() + 10_000;
    while (store.getState().projectsLoading) {
      if (Date.now() > deadline) throw new Error('Synthetic project discovery did not finish');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!store.getState().projects.some(project => project.id === input.project)) throw new Error('Synthetic project missing from actual IPC');
    store.getState().selectProject(input.project);
    return true;
  }
  if (action === 'install') {
    if (w.__sentryIdentityGate) throw new Error('Previous gate was not restored');
    const originalGet = Reflect.get;
    let release = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    const gate: Gate = { originalGet, release, waiting: 0, pending: 0, calls: [] };
    w.__sentryIdentityGate = gate;
    const intercept = function(target: object, prop: PropertyKey, receiver?: unknown): unknown {
      const value: unknown = originalGet(target, prop, receiver);
      if (target !== w.electronAPI || typeof value !== 'function' ||
          !['getSessionDetail', 'readClaudeMdFiles', 'readDirectoryClaudeMd', 'readMentionedFile'].includes(String(prop))) return value;
      return async (...args: unknown[]) => {
        const method = prop as Boundary | 'readClaudeMdFiles';
        const call = { method, args, fulfilled: false };
        gate.calls.push(call);
        gate.pending++;
        try {
          const result: unknown = await (value as (...args: unknown[]) => Promise<unknown>).apply(w.electronAPI, args);
          call.fulfilled = true;
          const matches = method === input.boundary && (
            method === 'getSessionDetail' ? args[1] === input.session :
            method === 'readDirectoryClaudeMd' ? args[0] === input.directory : args[0] === input.mentioned
          );
          if (matches) { gate.waiting++; await held; gate.waiting--; }
          return result;
        } finally { gate.pending--; }
      };
    };
    Reflect.get = intercept as typeof Reflect.get;
    return true;
  }
  if (action === 'open' || action === 'replace') {
    store.getState().openTab({ type: 'session', label: `Synthetic ${input.session}`, projectId: input.project, sessionId: input.session }, action === 'replace' ? { replaceActiveTab: true } : undefined);
    const id = store.getState().activeTabId;
    if (!id) throw new Error('No session tab opened');
    store.getState().setActiveTab(id);
    return id;
  }
  if (action === 'release') { w.__sentryIdentityGate?.release(); return true; }
  if (action === 'settled') {
    const gate = w.__sentryIdentityGate;
    if (!gate || gate.pending || gate.waiting) return false;
    // Drain continuations after the last actual IPC reply. A continuation either
    // commits synchronously or starts the next observed IPC before this task.
    await new Promise(resolve => setTimeout(resolve, 0));
    return gate.pending === 0 && gate.waiting === 0;
  }
  if (action === 'restore') {
    const gate = w.__sentryIdentityGate;
    if (gate) { gate.release(); Reflect.get = gate.originalGet; delete w.__sentryIdentityGate; }
    return true;
  }
  if (action !== 'snapshot') throw new Error(`Unknown renderer action: ${action}`);
  const state = store.getState();
  const summarise = (data: SessionData | undefined) => ({
    session: data?.sessionDetail?.session.id ?? null,
    chunks: data?.sessionDetail?.chunks.length ?? 0,
    loading: data?.sessionDetailLoading ?? null,
    conversationLoading: data?.conversationLoading ?? null,
    error: data?.sessionDetailError ?? null,
    claudeStats: data?.sessionClaudeMdStats?.size ?? 0,
    contextStats: data?.sessionContextStats?.size ?? 0,
    claudeInjections: [...(data?.sessionClaudeMdStats?.values() ?? [])].flatMap(s => s.accumulatedInjections),
    contextInjections: [...(data?.sessionContextStats?.values() ?? [])].flatMap(s => s.accumulatedInjections),
  });
  return {
    active: state.activeTabId, selected: state.selectedSessionId, project: state.selectedProjectId,
    global: summarise(state), tab: summarise(input.tab ? state.tabSessionData[input.tab] : undefined),
    tabs: state.openTabs.map(tab => ({ id: tab.id, session: tab.sessionId, label: tab.label })),
    gate: w.__sentryIdentityGate ? { waiting: w.__sentryIdentityGate.waiting, pending: w.__sentryIdentityGate.pending, calls: w.__sentryIdentityGate.calls } : null,
    visibleText: document.body.innerText,
    selectedTabs: [...document.querySelectorAll('[role="tab"][aria-selected="true"]')].map(el => el.textContent),
  };
}
export type Snapshot = Exclude<Awaited<ReturnType<typeof renderer>>, boolean | string>;
