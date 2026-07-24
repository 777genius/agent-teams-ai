import { api } from '@renderer/api';
import { createLogger } from '@shared/utils/logger';

import {
  saveLegacyToolApprovalSettings,
  saveToolApprovalSettingsForTeam,
} from './teamToolApprovalSettings';

import type { ToolApprovalSettings } from '@shared/types';

const DEFAULT_RETRY_DELAYS_MS = [100, 500, 2_000, 5_000, 15_000, 30_000] as const;
const logger = createLogger('ToolApprovalSettingsSync');

type ToolApprovalSettingsUpdater = (
  teamName: string,
  settings: ToolApprovalSettings
) => Promise<void>;

interface ToolApprovalSettingsSyncRetry {
  teamName: string;
  revision: number;
  attempt: number;
  delayMs: number;
  error: unknown;
}

interface ToolApprovalSettingsSynchronizerOptions {
  retryDelaysMs?: readonly number[];
  update: ToolApprovalSettingsUpdater;
  onRetry?: (retry: ToolApprovalSettingsSyncRetry) => void;
}

interface RevisionWaiter {
  revision: number;
  resolve: () => void;
}

interface TeamSyncState {
  desired: ToolApprovalSettings;
  revision: number;
  acknowledgedRevision: number;
  running: boolean;
  failureCount: number;
  retryAbort: AbortController | null;
  waiters: RevisionWaiter[];
}

function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || delayMs <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const timer = setTimeout(finish, delayMs);
    signal.addEventListener('abort', finish, { once: true });

    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    }
  });
}

/**
 * Serial latest-wins synchronizer for renderer-owned approval preferences.
 *
 * A team has at most one IPC update in flight. Failures retry for the lifetime
 * of the renderer, while a newer revision interrupts backoff and replaces the
 * stale desired value. This keeps localStorage as the durable desired state and
 * prevents rollback to an optimistic value that main never acknowledged.
 */
export class ToolApprovalSettingsSynchronizer {
  private readonly states = new Map<string, TeamSyncState>();
  private readonly retryDelaysMs: readonly number[];
  private disposed = false;

  constructor(private readonly options: ToolApprovalSettingsSynchronizerOptions) {
    this.retryDelaysMs =
      options.retryDelaysMs && options.retryDelaysMs.length > 0
        ? options.retryDelaysMs
        : DEFAULT_RETRY_DELAYS_MS;
  }

  schedule(teamName: string, settings: ToolApprovalSettings): number {
    if (this.disposed) {
      throw new Error('Tool approval settings synchronizer is disposed');
    }

    const existing = this.states.get(teamName);
    const state: TeamSyncState = existing ?? {
      desired: settings,
      revision: 0,
      acknowledgedRevision: 0,
      running: false,
      failureCount: 0,
      retryAbort: null,
      waiters: [],
    };
    state.desired = settings;
    state.revision += 1;
    state.failureCount = 0;
    state.retryAbort?.abort();
    this.states.set(teamName, state);

    if (!state.running) {
      state.running = true;
      void this.synchronize(teamName, state);
    }

    return state.revision;
  }

  waitForAcknowledgement(teamName: string, revision?: number): Promise<void> {
    const state = this.states.get(teamName);
    if (!state) {
      return Promise.resolve();
    }
    const targetRevision = revision ?? state.revision;
    if (state.acknowledgedRevision >= targetRevision) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      state.waiters.push({ revision: targetRevision, resolve });
    });
  }

  dispose(): void {
    this.disposed = true;
    for (const state of this.states.values()) {
      state.retryAbort?.abort();
    }
    this.states.clear();
  }

  private async synchronize(teamName: string, state: TeamSyncState): Promise<void> {
    while (!this.disposed && this.states.get(teamName) === state) {
      const revision = state.revision;
      const desired = state.desired;

      try {
        await this.options.update(teamName, desired);
      } catch (error) {
        if (this.disposed || this.states.get(teamName) !== state) {
          return;
        }
        if (state.revision !== revision) {
          continue;
        }

        state.failureCount += 1;
        const delayMs =
          this.retryDelaysMs[Math.min(state.failureCount - 1, this.retryDelaysMs.length - 1)];
        this.options.onRetry?.({
          teamName,
          revision,
          attempt: state.failureCount,
          delayMs,
          error,
        });
        const retryAbort = new AbortController();
        state.retryAbort = retryAbort;
        await waitForRetry(delayMs, retryAbort.signal);
        if (state.retryAbort === retryAbort) {
          state.retryAbort = null;
        }
        continue;
      }

      state.failureCount = 0;
      state.acknowledgedRevision = Math.max(state.acknowledgedRevision, revision);
      this.resolveAcknowledgedWaiters(state);
      if (state.revision === revision) {
        state.running = false;
        return;
      }
    }
  }

  private resolveAcknowledgedWaiters(state: TeamSyncState): void {
    const remaining: RevisionWaiter[] = [];
    for (const waiter of state.waiters) {
      if (waiter.revision <= state.acknowledgedRevision) {
        waiter.resolve();
      } else {
        remaining.push(waiter);
      }
    }
    state.waiters = remaining;
  }
}

let defaultSynchronizer: ToolApprovalSettingsSynchronizer | null = null;

function getDefaultSynchronizer(): ToolApprovalSettingsSynchronizer {
  defaultSynchronizer ??= new ToolApprovalSettingsSynchronizer({
    update: (teamName, settings) => api.teams.updateToolApprovalSettings(teamName, settings),
    onRetry: ({ teamName, attempt, delayMs, error }) => {
      if (attempt === 1 || attempt % 10 === 0) {
        logger.warn(
          `Tool approval settings sync retry team=${teamName} attempt=${attempt} delayMs=${delayMs}:`,
          error
        );
      }
    },
  });
  return defaultSynchronizer;
}

export function scheduleToolApprovalSettingsSync(
  teamName: string,
  settings: ToolApprovalSettings
): number {
  return getDefaultSynchronizer().schedule(teamName, settings);
}

export function scheduleAllToolApprovalSettingsSync(
  settingsByTeam: Record<string, ToolApprovalSettings>
): void {
  for (const [teamName, settings] of Object.entries(settingsByTeam)) {
    scheduleToolApprovalSettingsSync(teamName, settings);
  }
}

export function persistAndScheduleToolApprovalSettingsSync(
  teamName: string | null,
  settings: ToolApprovalSettings
): void {
  if (teamName) {
    saveToolApprovalSettingsForTeam(teamName, settings);
  } else {
    saveLegacyToolApprovalSettings(settings);
  }
  scheduleToolApprovalSettingsSync(teamName ?? '__global__', settings);
}

export function resetToolApprovalSettingsSync(): void {
  defaultSynchronizer?.dispose();
  defaultSynchronizer = null;
}
