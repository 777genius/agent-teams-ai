import type { MemberWorkSyncFeatureFacade } from '@features/member-work-sync/main';
import type { TeamTaskStallObservationPort } from '@main/services/team/stallMonitor/TeamTaskStallNotifier';
import type { TeamBackupService } from '@main/services/team/TeamBackupService';

export function createDeferredWorkSyncStallObservation(): TeamTaskStallObservationPort & {
  attach(feature: MemberWorkSyncFeatureFacade | null): void;
} {
  let feature: MemberWorkSyncFeatureFacade | null = null;
  return {
    record: (input) => feature?.recordStallObservation(input) ?? Promise.resolve(),
    attach(next) {
      feature = next;
    },
  };
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
