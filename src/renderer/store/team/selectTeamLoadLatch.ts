import { createLogger } from '@shared/utils/logger';

import type { AppState } from '../types';

const logger = createLogger('selectTeamLoadLatch');

// selectTeam() owns selectedTeamLoading, and its duplicate guard blocks re-entry while
// the flag is set. A load whose result is discarded as stale (for example a team change
// event invalidated the snapshot mid-read) must therefore retry, or the team view
// latches on the loading skeleton with nothing left to clear it.
export const SELECT_TEAM_STALE_RETRY_LIMIT = 3;
export const SELECT_TEAM_STALE_RETRY_BASE_DELAY_MS = 250;

const staleRetriesByTeam = new Map<string, number>();
const provisioningHoldsByTeam = new Map<string, number>();

export interface SelectTeamLoadOptions {
  skipProjectAutoSelect?: boolean;
  allowReloadWhileProvisioning?: boolean;
  /** Internal: set by the bounded stale-read retry so it keeps its budget. */
  staleReadRetry?: boolean;
}

type SelectTeamLoadState = Pick<
  AppState,
  'selectedTeamName' | 'selectedTeamLoading' | 'selectedTeamLoadNonce'
>;

type SelectTeamLoadSetter = (partial: {
  selectedTeamLoading: boolean;
  selectedTeamData?: AppState['selectedTeamData'];
  selectedTeamError?: string | null;
}) => void;

export function isSelectTeamLoadInFlight(state: SelectTeamLoadState, teamName: string): boolean {
  return state.selectedTeamLoading && state.selectedTeamName === teamName;
}

function isLoadStillOwned(state: SelectTeamLoadState, teamName: string, nonce: number): boolean {
  return isSelectTeamLoadInFlight(state, teamName) && state.selectedTeamLoadNonce === nonce;
}

/**
 * Parks the selection on an intentional "team is provisioning" hold. The provisioning
 * progress callback, not the stale-read retry, is what finishes this load, and the
 * renderer's provisioning maps can still be empty when the IPC signal arrives, so the
 * hold has to be recorded explicitly for the attempt that took it.
 */
export function holdSelectTeamLoadForProvisioning(
  set: SelectTeamLoadSetter,
  teamName: string,
  requestNonce: number
): void {
  provisioningHoldsByTeam.set(teamName, requestNonce);
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
  isProvisioning: (state: AppState, teamName: string) => boolean
): void {
  const state = get();
  if (state.selectedTeamName !== teamName || state.selectedTeamLoadNonce !== requestNonce) {
    return;
  }
  if (!state.selectedTeamLoading) {
    staleRetriesByTeam.delete(teamName);
    provisioningHoldsByTeam.delete(teamName);
    return;
  }
  // An attempt that parked on the explicit provisioning signal is finished by the
  // provisioning progress callback, so it is neither a stale read nor a latch.
  if (provisioningHoldsByTeam.get(teamName) === requestNonce) return;
  if (isProvisioning(state, teamName)) return;

  // A fresh (user-initiated) selection starts a new stale-read budget, so a budget left
  // behind by an abandoned load can never leak into it. Only retries carry the flag.
  if (!opts?.staleReadRetry) {
    staleRetriesByTeam.delete(teamName);
    provisioningHoldsByTeam.delete(teamName);
  }
  const attempt = (staleRetriesByTeam.get(teamName) ?? 0) + 1;
  if (attempt > SELECT_TEAM_STALE_RETRY_LIMIT) {
    staleRetriesByTeam.delete(teamName);
    provisioningHoldsByTeam.delete(teamName);
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
  staleRetriesByTeam.set(teamName, attempt);
  setTimeout(() => {
    if (!isLoadStillOwned(get(), teamName, requestNonce)) return;
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
  provisioningHoldsByTeam.clear();
}
