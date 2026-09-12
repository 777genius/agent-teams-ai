import type { MemberWorkSyncFeatureFacade } from '@features/member-work-sync/main';
import type { TeamTaskStallObservationPort } from '@main/services/team/stallMonitor/TeamTaskStallNotifier';
import type { TeamBackupService } from '@main/services/team/TeamBackupService';

type StallObservation = Parameters<TeamTaskStallObservationPort['record']>[0];

const DEFAULT_STALL_RETRY_MS = 2_000;

function isPermanentStallObservationError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'MemberWorkSyncStallEpisodeMissingError' || error.message === 'episode_missing')
  );
}

export function createDeferredWorkSyncStallObservation(options?: {
  retryDelayMs?: number;
}): TeamTaskStallObservationPort & {
  attach(feature: MemberWorkSyncFeatureFacade | null): void;
} {
  let feature: MemberWorkSyncFeatureFacade | null = null;
  const pending: StallObservation[] = [];
  const retryDelayMs = options?.retryDelayMs ?? DEFAULT_STALL_RETRY_MS;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  const clearRetry = (): void => {
    if (!retryTimer) {
      return;
    }
    clearTimeout(retryTimer);
    retryTimer = null;
  };
  const scheduleRetry = (): void => {
    if (retryTimer || !feature || pending.length === 0) {
      return;
    }
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void flush();
    }, retryDelayMs);
  };
  const flush = async (): Promise<void> => {
    const current = feature;
    if (!current) {
      return;
    }
    clearRetry();
    while (pending.length > 0) {
      const observation = pending[0];
      if (!observation) {
        break;
      }
      try {
        await current.recordStallObservation(observation);
        if (pending[0] === observation) {
          pending.shift();
        }
      } catch (error) {
        if (isPermanentStallObservationError(error)) {
          if (pending[0] === observation) {
            pending.shift();
          }
          continue;
        }
        scheduleRetry();
        break;
      }
    }
  };
  return {
    record: async (input) => {
      pending.push(input);
      if (!feature) {
        return;
      }
      await flush();
    },
    attach(next) {
      feature = next;
      if (!next) {
        clearRetry();
        return;
      }
      void flush();
    },
  };
}

export function bindMemberWorkSyncProvisioningRuntime(
  provisioning: {
    setRuntimeTurnSettledHookSettingsProvider(
      provider: MemberWorkSyncFeatureFacade['buildRuntimeTurnSettledHookSettings']
    ): void;
    setRuntimeTurnSettledEnvironmentProvider(
      provider: MemberWorkSyncFeatureFacade['buildRuntimeTurnSettledEnvironment']
    ): void;
    setMemberWorkSyncProofMissingRecoveryScheduler(
      scheduler: MemberWorkSyncFeatureFacade['scheduleProofMissingRecovery']
    ): void;
  },
  getFeature: () => MemberWorkSyncFeatureFacade | null
): void {
  provisioning.setRuntimeTurnSettledHookSettingsProvider((input) => {
    const current = getFeature();
    return current ? current.buildRuntimeTurnSettledHookSettings(input) : Promise.resolve(null);
  });
  provisioning.setRuntimeTurnSettledEnvironmentProvider((input) => {
    const current = getFeature();
    return current ? current.buildRuntimeTurnSettledEnvironment(input) : Promise.resolve(null);
  });
  provisioning.setMemberWorkSyncProofMissingRecoveryScheduler((input) => {
    const current = getFeature();
    return current
      ? current.scheduleProofMissingRecovery(input)
      : Promise.resolve({ scheduled: false, reason: 'invalid' });
  });
}

export async function startPreparedMemberWorkSyncFeature(input: {
  backup: TeamBackupService;
  prepared: MemberWorkSyncFeatureFacade;
  stallObservation: { attach(feature: MemberWorkSyncFeatureFacade): void };
}): Promise<MemberWorkSyncFeatureFacade> {
  try {
    await input.backup.initialize();
  } catch (error) {
    await input.prepared.dispose();
    throw error;
  }
  input.prepared.startBackground();
  input.stallObservation.attach(input.prepared);
  return input.prepared;
}
