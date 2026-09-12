import type { MemberWorkSyncFeatureFacade } from '@features/member-work-sync/main';
import type { TeamTaskStallObservationPort } from '@main/services/team/stallMonitor/TeamTaskStallNotifier';
import type { TeamBackupService } from '@main/services/team/TeamBackupService';

type StallObservation = Parameters<TeamTaskStallObservationPort['record']>[0];

export function createDeferredWorkSyncStallObservation(): TeamTaskStallObservationPort & {
  attach(feature: MemberWorkSyncFeatureFacade | null): void;
} {
  let feature: MemberWorkSyncFeatureFacade | null = null;
  const pending: StallObservation[] = [];
  const flush = async (): Promise<void> => {
    const current = feature;
    if (!current) {
      return;
    }
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
      } catch {
        break;
      }
    }
  };
  return {
    record: async (input) => {
      if (!feature) {
        pending.push(input);
        return;
      }
      await flush();
      await feature.recordStallObservation(input);
    },
    attach(next) {
      feature = next;
      if (!next || pending.length === 0) {
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
  input.stallObservation.attach(input.prepared);
  input.prepared.startBackground();
  return input.prepared;
}
