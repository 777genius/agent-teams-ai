import type { MemberWorkSyncStatus, MemberWorkSyncStatusState } from '../../contracts';

export const MEMBER_WORK_SYNC_RUNTIME_STALL_DIAGNOSTIC =
  'runtime_stall:same_agenda_still_needs_sync';

export const MEMBER_WORK_SYNC_RUNTIME_STALL_TRIGGER_DIAGNOSTIC_PREFIX = 'runtime_stall:trigger=';

const RUNTIME_STALL_TRIGGER_PRIORITY = ['turn_settled', 'tool_finished', 'runtime_activity'];

export interface MemberWorkSyncRuntimeStallObservation {
  stalled: boolean;
  reason?: string;
  diagnostics: string[];
}

function firstRuntimeTrigger(triggerReasons: readonly string[] | undefined): string | undefined {
  if (!triggerReasons?.length) {
    return undefined;
  }
  const normalized = new Set(triggerReasons.map((reason) => reason.trim()).filter(Boolean));
  return RUNTIME_STALL_TRIGGER_PRIORITY.find((reason) => normalized.has(reason));
}

export function observeMemberWorkSyncRuntimeStall(input: {
  currentState: MemberWorkSyncStatusState;
  agendaFingerprint: string;
  actionableCount: number;
  previousStatus: MemberWorkSyncStatus | null;
  triggerReasons?: readonly string[];
}): MemberWorkSyncRuntimeStallObservation {
  const trigger = firstRuntimeTrigger(input.triggerReasons);
  if (
    !trigger ||
    input.currentState !== 'needs_sync' ||
    input.actionableCount <= 0 ||
    input.previousStatus?.state !== 'needs_sync' ||
    input.previousStatus.agenda.fingerprint !== input.agendaFingerprint
  ) {
    return { stalled: false, diagnostics: [] };
  }

  return {
    stalled: true,
    reason: `same_agenda_still_needs_sync_after_${trigger}`,
    diagnostics: [
      MEMBER_WORK_SYNC_RUNTIME_STALL_DIAGNOSTIC,
      `${MEMBER_WORK_SYNC_RUNTIME_STALL_TRIGGER_DIAGNOSTIC_PREFIX}${trigger}`,
    ],
  };
}
