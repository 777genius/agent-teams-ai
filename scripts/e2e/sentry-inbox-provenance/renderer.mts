import type { ElectronAPI } from '../../../src/shared/types/api.ts';
import type { IpcResult } from '../../../src/shared/types/ipc.ts';
import type { InboxMessage, MessagesPage, TeamChangeEvent, TeamViewSnapshot } from '../../../src/shared/types/team.ts';
import type { TeamMessagesCacheEntry } from '../../../src/renderer/store/team/teamMessagesCache.ts';

interface State {
  appConfig: unknown;
  selectedTeamName: string | null;
  selectedTeamData: TeamViewSnapshot | null;
  selectedTeamLoading: boolean;
  selectedTeamError: string | null;
  teamMessagesByName: Record<string, TeamMessagesCacheEntry>;
  openTeamTab(team: string, project?: string): void;
  selectTeam(team: string): Promise<void>;
  setMessagesPanelMode(mode: 'sidebar'): void;
  refreshTeamMessagesHead(team: string): Promise<unknown>;
  openMemberProfile(member: string, team: string, focus: 'messages'): void;
}
export interface PageCall {
  cursor: string | null;
  transport: 'legacy' | 'readRecovery';
  limit: number;
  fulfilled: boolean;
  page?: MessagesPage;
  error?: string;
  sourceFailurePhase?: 'head-malformed' | 'older-nonarray';
}
interface InboxChange { detail: string; receivedAt: number; sourceFailurePhase?: PageCall['sourceFailurePhase']; }
interface Gate {
  originalGet: typeof Reflect.get;
  calls: PageCall[];
  droppedCalls: number;
  inboxChanges: InboxChange[];
  inboxChangeCount: number;
  droppedInboxChanges: number;
  unsubscribeInbox(): void;
  holdNextOlder: boolean;
  waiting: number;
  pending: number;
  release(): void;
  refresh?: Promise<unknown>;
  sourceFailurePhase?: PageCall['sourceFailurePhase'];
}
interface HarnessWindow {
  electronAPI: ElectronAPI;
  __agentTeamsDevStore: { getState(): State };
  __sentryInboxGate?: Gate;
}
export interface RendererInput { team: string; project: string; inboxDetail: string; label?: string; sourceFailurePhase?: PageCall['sourceFailurePhase'] | null; }
export interface RefreshObservation { kind: 'refresh-observation'; rejected: boolean; error: string | null; }

// Serialized into the actual Electron renderer. All page payloads below come
// from the frozen contextBridge API; the facade only observes/delays real IPC.
export async function renderer(action: string, input: RendererInput) {
  const w = window as unknown as HarnessWindow;
  const store = w.__agentTeamsDevStore;
  if (action === 'ready') return Boolean(store?.getState().appConfig && w.electronAPI && navigator.userAgent.includes('Electron/'));
  if (action === 'warm') {
    // Read-only cold-dev preparation. Discover this scenario's real lazy UI
    // module graph before installing an observer or staging team navigation.
    // electron-vite serves src/renderer as its renderer root (index.html imports
    // ./main.tsx), so URLs here are relative to that root, not the repository.
    const urls = ['/components/team/TeamDetailView.tsx',
      '/components/team/messages/MessagesPanel.tsx',
      '/components/team/members/MemberDetailDialog.tsx'];
    await Promise.all(urls.map(url => import(url)));
    return true;
  }
  if (!store || !w.electronAPI) throw new Error('Owned DEV renderer is unavailable; refusing scenario operation');
  if (action === 'install') {
    if (w.__sentryInboxGate) throw new Error('Previous IPC observer was not restored');
    const originalGet = Reflect.get;
    const gate: Gate = { originalGet, calls: [], droppedCalls: 0, inboxChanges: [], inboxChangeCount: 0, droppedInboxChanges: 0, unsubscribeInbox: () => {}, holdNextOlder: false, waiting: 0, pending: 0, release: () => {} };
    w.__sentryInboxGate = gate;
    const teams = w.electronAPI.teams;
    gate.unsubscribeInbox = teams.onTeamChange((_event: unknown, event: TeamChangeEvent) => {
      if (event.teamName !== input.team || event.type !== 'inbox' || event.detail !== input.inboxDetail) return;
      gate.inboxChangeCount++;
      gate.inboxChanges.push({ detail: event.detail, receivedAt: Date.now(),
        ...(gate.sourceFailurePhase ? { sourceFailurePhase: gate.sourceFailurePhase } : {}) });
      if (gate.inboxChanges.length > 120) { gate.inboxChanges.shift(); gate.droppedInboxChanges++; }
    });
    // Proxy empty facades, never the frozen bridge objects: overridden
    // nonconfigurable methods on the original targets violate Proxy invariants.
    const observePage = (owner: object, value: unknown, raw: boolean) => {
      return async (team: string, options?: { cursor?: string | null; limit?: number }) => {
        if (team !== input.team) throw new Error('IPC observer rejected a non-fixture team');
        const call: PageCall = { cursor: options?.cursor ?? null, transport: raw ? 'readRecovery' : 'legacy', limit: options?.limit ?? 50, fulfilled: false,
          ...(gate.sourceFailurePhase ? { sourceFailurePhase: gate.sourceFailurePhase } : {}) };
        const hold = Boolean(call.cursor && gate.holdNextOlder);
        if (hold) gate.holdNextOlder = false;
        gate.calls.push(call);
        if (gate.calls.length > 120) { gate.calls.shift(); gate.droppedCalls++; }
        gate.pending++;
        try {
          const read = value as (team: string, options?: { cursor?: string | null; limit?: number }) => Promise<MessagesPage | IpcResult<MessagesPage>>;
          const result = await read.call(owner, team, options);
          if (raw) {
            const envelope = result as IpcResult<MessagesPage>;
            if (envelope.success) { call.fulfilled = true; call.page = envelope.data; }
            // Match legacy observation text without changing the raw envelope.
            else call.error = String(new Error(envelope.error ?? 'Unknown error'));
          } else { call.fulfilled = true; call.page = result as MessagesPage; }
          if (hold && call.fulfilled) {
            gate.waiting++;
            await new Promise<void>(resolve => { gate.release = resolve; });
            gate.waiting--;
          }
          // Preserve the exact raw success/failure envelope, including metadata.
          // The application transport alone owns unwrapping and error handling.
          return result;
        } catch (error) { call.error = String(error); throw error; }
        finally { gate.pending--; }
      };
    };
    const recovery = teams.readRecovery;
    const recoveryFacade = recovery ? new Proxy({}, {
      get(_target, prop) {
        const value: unknown = originalGet(recovery, prop);
        return prop === 'getMessagesPage' && typeof value === 'function'
          ? observePage(recovery, value, true) : value;
      },
    }) : undefined;
    const facade = new Proxy({}, {
      get(_target, prop) {
        if (prop === 'readRecovery') return recoveryFacade;
        const value: unknown = originalGet(teams, prop);
        return prop === 'getMessagesPage' && typeof value === 'function'
          ? observePage(teams, value, false) : value;
      },
    });
    Reflect.get = function(target: object, prop: PropertyKey, receiver?: unknown): unknown {
      if (target === w.electronAPI && prop === 'teams') return facade;
      return originalGet(target, prop, receiver);
    } as typeof Reflect.get;
    return true;
  }
  if (action === 'restore') {
    const gate = w.__sentryInboxGate;
    if (gate) { gate.release(); gate.unsubscribeInbox(); Reflect.get = gate.originalGet; delete w.__sentryInboxGate; }
    return true;
  }
  if (action === 'open') {
    store.getState().setMessagesPanelMode('sidebar');
    store.getState().openTeamTab(input.team, input.project);
    await store.getState().selectTeam(input.team);
    await store.getState().refreshTeamMessagesHead(input.team);
    return true;
  }
  if (action === 'refresh') { await store.getState().refreshTeamMessagesHead(input.team); return true; }
  if (action === 'sourcePhase') {
    const gate = w.__sentryInboxGate;
    if (!gate) throw new Error('Missing actual IPC observer');
    gate.sourceFailurePhase = input.sourceFailurePhase ?? undefined;
    return true;
  }
  if (action === 'observeRefresh') {
    // This observes a real action's rejection only. Independent store/DOM
    // assertions in the runner must prove failure visibility and retention.
    let observation: RefreshObservation;
    try {
      await store.getState().refreshTeamMessagesHead(input.team);
      observation = { kind: 'refresh-observation', rejected: false, error: null };
    } catch (error) { observation = { kind: 'refresh-observation', rejected: true, error: String(error) }; }
    return observation;
  }
  if (action === 'startRefresh') {
    const gate = w.__sentryInboxGate;
    if (!gate) throw new Error('Missing real IPC observer');
    gate.refresh = store.getState().refreshTeamMessagesHead(input.team);
    // Rejection stays attached until awaitRefresh; no unhandled rejection.
    void gate.refresh.catch(() => {});
    return true;
  }
  if (action === 'awaitRefresh') { await w.__sentryInboxGate?.refresh; return true; }
  if (action === 'holdOlder') {
    if (!w.__sentryInboxGate) throw new Error('Missing observer');
    w.__sentryInboxGate.holdNextOlder = true;
    return true;
  }
  if (action === 'release') { w.__sentryInboxGate?.release(); return true; }
  if (action === 'member') { store.getState().openMemberProfile('alice', input.team, 'messages'); return true; }
  if (action === 'click') {
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('button')].filter(el =>
      el.getClientRects().length > 0 && !el.disabled &&
      (el.textContent?.trim() === input.label || el.getAttribute('aria-label') === input.label ||
        (input.label === 'alice' && /^alice, \d+ unread,/.test(el.getAttribute('aria-label') ?? '')) ||
        (input.label === 'Group chat' && /^Group chat, \d+ unread,/.test(el.getAttribute('aria-label') ?? '')))
    );
    if (buttons.length !== 1) throw new Error(`Expected one visible ${input.label} button, found ${buttons.length}`);
    const button = buttons[0];
    if (!button) throw new Error('Actual UI button disappeared');
    button.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    button.click();
    return true;
  }
  if (action !== 'snapshot') throw new Error(`Unknown renderer action: ${action}`);
  const state = store.getState(), entry = state.teamMessagesByName[input.team];
  const summarise = (message: InboxMessage) => ({ id: message.messageId, from: message.from, to: message.to, text: message.text, timestamp: message.timestamp, source: message.source, taskRefs: message.taskRefs });
  return {
    selected: state.selectedTeamName, teamLoaded: state.selectedTeamData?.teamName,
    teamLoading: state.selectedTeamLoading, teamError: state.selectedTeamError,
    head: (entry?.provenance?.head ?? []).map(summarise),
    canonical: (entry?.canonicalMessages ?? []).map(summarise),
    optimistic: (entry?.optimisticMessages ?? []).map(summarise),
    pages: entry?.provenance?.pages.map(page => ({ ...page, messages: page.messages.map(summarise) })) ?? [],
    provenanceScope: entry?.provenance?.requestScope ?? null, headHydrated: entry?.headHydrated,
    revision: entry?.feedRevision, nextCursor: entry?.nextCursor, hasMore: entry?.hasMore,
    loadingHead: entry?.loadingHead, loadingOlder: entry?.loadingOlder,
    historyReloadRequired: entry?.historyReloadRequired ?? false, error: entry?.messagesError,
    gate: w.__sentryInboxGate ? { calls: w.__sentryInboxGate.calls, pending: w.__sentryInboxGate.pending, waiting: w.__sentryInboxGate.waiting, droppedCalls: w.__sentryInboxGate.droppedCalls, inboxChangeCount: w.__sentryInboxGate.inboxChangeCount, inboxChanges: w.__sentryInboxGate.inboxChanges, droppedInboxChanges: w.__sentryInboxGate.droppedInboxChanges } : null,
    visibleText: document.body.innerText.slice(-50_000),
    notices: [...document.querySelectorAll('[role="status"]')].map(el => el.textContent),
    dialogs: [...document.querySelectorAll('[role="dialog"]')].map(el => el.textContent?.slice(0, 20_000)),
    historyControls: [...document.querySelectorAll<HTMLElement>('[data-conversation-history]')]
      .filter(el => el.getClientRects().length > 0).map(el => el.textContent ?? ''),
    buttons: [...document.querySelectorAll('button')].filter(el => el.getClientRects().length > 0).map(el => ({ text: el.textContent?.trim(), label: el.getAttribute('aria-label'), disabled: el.disabled })),
  };
}
export type Snapshot = Exclude<Awaited<ReturnType<typeof renderer>>, boolean | RefreshObservation>;
