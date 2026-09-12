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
  dispose(): void;
} {
  let feature: MemberWorkSyncFeatureFacade | null = null;
  let disposed = false;
  const pendingByTeam = new Map<string, StallObservation[]>();
  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const retryDelayMs = options?.retryDelayMs ?? DEFAULT_STALL_RETRY_MS;
  const pendingFor = (teamName: string): StallObservation[] => {
    const current = pendingByTeam.get(teamName);
    if (current) {
      return current;
    }
    const next: StallObservation[] = [];
    pendingByTeam.set(teamName, next);
    return next;
  };
  const clearRetry = (teamName: string): void => {
    const timer = retryTimers.get(teamName);
    if (!timer) {
      return;
    }
    clearTimeout(timer);
    retryTimers.delete(teamName);
  };
  const clearAllRetries = (): void => {
    for (const teamName of [...retryTimers.keys()]) {
      clearRetry(teamName);
    }
  };
  const flushTeam = async (teamName: string): Promise<void> => {
    const current = feature;
    if (disposed || !current) {
      return;
    }
    clearRetry(teamName);
    const pending = pendingFor(teamName);
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
        if (!disposed && !retryTimers.has(teamName) && feature && pending.length > 0) {
          retryTimers.set(
            teamName,
            setTimeout(() => {
              retryTimers.delete(teamName);
              void flushTeam(teamName);
            }, retryDelayMs)
          );
        }
        return;
      }
    }
    if (pending.length === 0) {
      pendingByTeam.delete(teamName);
    }
  };
  return {
    record: async (input) => {
      if (disposed) {
        return;
      }
      pendingFor(input.teamName).push(input);
      if (!feature) {
        return;
      }
      await flushTeam(input.teamName);
    },
    attach(next) {
      if (disposed) {
        return;
      }
      feature = next;
      if (!next) {
        clearAllRetries();
        return;
      }
      void Promise.all([...pendingByTeam.keys()].map((teamName) => flushTeam(teamName)));
    },
    dispose() {
      disposed = true;
      feature = null;
      clearAllRetries();
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

export async function runShutdownBackupAfterWorkSyncDrain(input: {
  closeIngress?: () => void | Promise<void>;
  drainWorkSync: () => Promise<void>;
  backup?: { runShutdownBackupSync(): void } | null;
}): Promise<void> {
  await input.closeIngress?.();
  await input.drainWorkSync();
  input.backup?.runShutdownBackupSync();
}
