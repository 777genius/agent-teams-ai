import { api } from '@renderer/api';
import { subscribeTeamMessageReadStore } from '@renderer/utils/teamMessageReadStorage';

import type { AttentionSnapshot } from '../../contracts';
import type { TeamChangeEvent } from '@shared/types/team';

export interface AttentionStoreState {
  contextId: string;
  contextEpoch: number;
  snapshot: AttentionSnapshot | null;
  loading: boolean;
  error: string | null;
  version: number;
}

let state: AttentionStoreState = {
  contextId: '',
  contextEpoch: 0,
  snapshot: null,
  loading: false,
  error: null,
  version: 0,
};
let currentContextId = '';
let currentContextEpoch = 0;
let epoch = 0;
let fullLoading = false;
let flushing = false;
let queuedFull = false;
let queuedTeams = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let stopEvents: (() => void) | null = null;
let stopReadState: (() => void) | null = null;
let reconcileTimer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function publish(changes: Partial<AttentionStoreState> = {}): void {
  state = { ...state, ...changes, version: state.version + 1 };
  for (const listener of listeners) listener();
}

function queue(teamName?: string): void {
  if (!teamName) queuedFull = true;
  else if (!queuedFull) queuedTeams.add(teamName);
  if (flushTimer || flushing || listeners.size === 0) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flush();
  }, 250);
}

async function fetchSnapshot(teamName?: string): Promise<void> {
  if (!currentContextId) return;
  const requestContext = currentContextId;
  const requestEpoch = epoch;
  if (!teamName) {
    fullLoading = true;
    publish({ loading: true, error: null });
  }
  try {
    const response = await api.getUserAttentionSnapshot(teamName);
    if (requestEpoch !== epoch || response.contextId !== requestContext) return;
    if (!teamName) {
      publish({ snapshot: response, loading: false, error: null });
    } else {
      const before = state.snapshot;
      if (!before) {
        queue();
        return;
      }
      // A logical team refresh replaces its verified project aliases too.
      const receivedNames = new Set(response.teams.map((team) => team.teamName));
      const teams = before.teams.filter((team) =>
        team.teamName !== teamName &&
        team.logicalTeamName !== teamName &&
        !receivedNames.has(team.teamName)
      );
      teams.push(...response.teams);
      publish({
        snapshot: {
          contextId: requestContext,
          teams,
          complete: teams.every((team) => !team.error),
        },
        error: null,
      });
    }
  } catch {
    if (requestEpoch === epoch) {
      publish({ loading: false, error: 'Unable to load attention status' });
    }
  } finally {
    if (!teamName && requestEpoch === epoch) {
      fullLoading = false;
      if (queuedFull || queuedTeams.size > 0) queue();
    }
  }
}

async function flush(): Promise<void> {
  if (flushing || fullLoading || !currentContextId) return;
  flushing = true;
  try {
    if (queuedFull || !state.snapshot) {
      queuedFull = false;
      queuedTeams.clear();
      await fetchSnapshot();
    } else {
      const startedEpoch = epoch;
      const names = [...queuedTeams];
      queuedTeams.clear();
      // A bounded fan-out; team events cannot start N copies of the global scan.
      for (const name of names) {
        if (!currentContextId || queuedFull || epoch !== startedEpoch) break;
        await fetchSnapshot(name);
      }
    }
  } finally {
    flushing = false;
    // Only one global drain; updates arriving during in-flight reads get a trailing pass.
    if (queuedFull || queuedTeams.size > 0) queue();
  }
}

function onTeamChange(_event: unknown, event: TeamChangeEvent): void {
  if (event.type === 'task' || event.type === 'inbox' ||
      event.type === 'lead-message' || event.type === 'config') {
    queue(event.type === 'config' ? undefined : event.teamName);
  }
}

function connect(): void {
  if (stopEvents) return;
  try {
    stopEvents = api.teams?.onTeamChange?.(onTeamChange) ?? (() => undefined);
  } catch {
    // A temporarily unavailable transport must not crash the entire app shell.
    stopEvents = () => undefined;
  }
  stopReadState = subscribeTeamMessageReadStore(() => publish());
  window.addEventListener('focus', onFocus);
  // One application-wide catch-up, not a timer per team/component.
  reconcileTimer = setInterval(() => {
    if (document.visibilityState === 'visible') queue();
  }, 60_000);
  if (currentContextId) queue();
}

function onFocus(): void {
  queue();
}

function disconnect(): void {
  stopEvents?.();
  stopEvents = null;
  stopReadState?.();
  stopReadState = null;
  window.removeEventListener('focus', onFocus);
  if (reconcileTimer) clearInterval(reconcileTimer);
  reconcileTimer = null;
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  queuedFull = false;
  queuedTeams.clear();
}

export function subscribeAttention(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) connect();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) disconnect();
  };
}

export function getAttentionStoreState(): AttentionStoreState {
  return state;
}

export function setAttentionContext(contextId: string, contextEpoch: number): void {
  if (currentContextId === contextId && currentContextEpoch === contextEpoch) return;
  currentContextId = contextId;
  currentContextEpoch = contextEpoch;
  epoch += 1;
  fullLoading = false;
  queuedFull = false;
  queuedTeams.clear();
  publish({
    contextId,
    contextEpoch,
    snapshot: null,
    loading: Boolean(contextId),
    error: null,
  });
  if (contextId) queue();
}

export function refreshAttention(): void {
  queue();
}
