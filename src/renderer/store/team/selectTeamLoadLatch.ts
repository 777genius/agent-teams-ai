import { createLogger } from '@shared/utils/logger';

import { isContextScopedRequestEpochCurrent } from '../utils/contextScopedRequestEpoch';

import type { AppState } from '../types';

const logger = createLogger('selectTeamLoadLatch');

// selectTeam() owns selectedTeamLoading, and its duplicate guard blocks re-entry while
// the flag is set. A load whose result is discarded as stale (for example a team change
// event invalidated the snapshot mid-read) must therefore retry, or the team view
// latches on the loading skeleton with nothing left to clear it.
export const SELECT_TEAM_STALE_RETRY_LIMIT = 3;
export const SELECT_TEAM_STALE_RETRY_BASE_DELAY_MS = 250;

const staleRetriesByTeam = new Map<string, number>();
const provisioningHolds = new Map<string, number>();

export interface SelectTeamLoadOptions {
  skipProjectAutoSelect?: boolean;
  allowReloadWhileProvisioning?: boolean;
  /** Internal: set by the bounded stale-read retry so it keeps its budget. */
  staleReadRetry?: boolean;
}

type SelectTeamLoadState = Pick<
  AppState,
  'activeContextId' | 'selectedTeamName' | 'selectedTeamLoading' | 'selectedTeamLoadNonce'
>;

interface SelectTeamLoadContext {
  contextId: string;
  contextEpoch: number;
}

type SelectTeamLoadSetter = (partial: {
  selectedTeamLoading: boolean;
  selectedTeamData?: AppState['selectedTeamData'];
  selectedTeamError?: string | null;
}) => void;

// A state reset (context switch, reconnect) clears the selection and puts
// selectedTeamLoadNonce back to 0, so a team plus nonce is not a usable identity
// across contexts. Every key carries the context that owned the attempt.
function attemptKey(state: SelectTeamLoadState, teamName: string): string {
  return `${state.activeContextId}\u0000${teamName}`;
}

export function isSelectTeamLoadInFlight(state: SelectTeamLoadState, teamName: string): boolean {
  return state.selectedTeamLoading && state.selectedTeamName === teamName;
}

function isLoadStillOwned(
  state: SelectTeamLoadState,
  context: SelectTeamLoadContext,
  teamName: string,
  nonce: number
): boolean {
  return (
    state.activeContextId === context.contextId &&
    isContextScopedRequestEpochCurrent(context.contextEpoch) &&
    state.selectedTeamName === teamName &&
    state.selectedTeamLoadNonce === nonce
  );
}

/**
 * Parks the selection on an intentional "team is provisioning" hold. The provisioning
 * progress callback, not the stale-read retry, is what finishes this load, and the
 * renderer's provisioning maps can still be empty when the IPC signal arrives, so the
 * hold has to be recorded explicitly for the attempt that took it.
 */
export function holdSelectTeamLoadForProvisioning(
  get: () => AppState,
  set: SelectTeamLoadSetter,
  teamName: string,
  requestNonce: number
): void {
  provisioningHolds.set(attemptKey(get(), teamName), requestNonce);
  set({ selectedTeamLoading: true, selectedTeamData: null, selectedTeamError: null });
}

/**
 * Called when a selectTeam() attempt finishes. If that attempt still owns the selection
 * and left it loading without an intentional provisioning hold, schedule a bounded retry;
 * after the retry budget is spent, release the loading flag instead of latching.
 */
export function settleLatchedSelectTeamLoad(
  get: () => AppState,
  set: SelectTeamLoadSetter,
  teamName: string,
  requestNonce: number,
  opts: SelectTeamLoadOptions | undefined,
  isProvisioning: (state: AppState, teamName: string) => boolean,
  context: SelectTeamLoadContext
): void {
  const state = get();
  // Both settlement and its timer belong to the context captured before the read.
  // A late finally must not consume a new context's budget after nonce reuse; an
  // epoch also distinguishes reconnects and switching away and back to the same ID.
  if (!isLoadStillOwned(state, context, teamName, requestNonce)) return;
  const key = attemptKey(state, teamName);
  const heldNonce = provisioningHolds.get(key);
  if (heldNonce !== undefined && heldNonce !== state.selectedTeamLoadNonce) {
    provisioningHolds.delete(key);
  }
  if (!state.selectedTeamLoading) {
    staleRetriesByTeam.delete(key);
    return;
  }
  // An attempt that parked on the explicit provisioning signal is finished by the
  // provisioning progress callback, so it is neither a stale read nor a latch. The entry
  // is single-use: it belongs to this attempt and must not outlive it.
  if (heldNonce === requestNonce) {
    provisioningHolds.delete(key);
    return;
  }
  if (isProvisioning(state, teamName)) return;

  // A fresh (user-initiated) selection starts a new stale-read budget, so a budget left
  // behind by an abandoned load can never leak into it. Only retries carry the flag.
  if (!opts?.staleReadRetry) staleRetriesByTeam.delete(key);
  const attempt = (staleRetriesByTeam.get(key) ?? 0) + 1;
  if (attempt > SELECT_TEAM_STALE_RETRY_LIMIT) {
    staleRetriesByTeam.delete(key);
    logger.warn(
      `selectTeam(${teamName}) discarded ${attempt - 1} stale reads; releasing loading state`
    );
    // Releasing the latch must not leave a silent empty view: surface a
    // retriable load error instead.
    set({
      selectedTeamLoading: false,
      selectedTeamError:
        state.selectedTeamError ??
        `Failed to load team "${teamName}" after ${SELECT_TEAM_STALE_RETRY_LIMIT} stale reads`,
    });
    return;
  }
  staleRetriesByTeam.set(key, attempt);
  setTimeout(() => {
    // The retry belongs to the context that scheduled it: a reset can put the store nonce
    // back to a value this attempt used, so team plus nonce alone is not enough to own it.
    if (!isLoadStillOwned(get(), context, teamName, requestNonce) || !get().selectedTeamLoading) {
      return;
    }
    // A provisioning hold started during the backoff must win over the retry.
    if (isProvisioning(get(), teamName)) return;
    void get().selectTeam(teamName, {
      ...opts,
      allowReloadWhileProvisioning: true,
      staleReadRetry: true,
    });
  }, SELECT_TEAM_STALE_RETRY_BASE_DELAY_MS * attempt);
}

export function resetSelectTeamLoadLatchForTests(): void {
  staleRetriesByTeam.clear();
  provisioningHolds.clear();
}
