import { runtimeDigest } from '../runtime/identity.js';
import { validateMemberActions } from './memberActions.js';
import { liveRosterSelectionEdges, validateLiveRosterLaunch } from './liveRosterMembership.js';
import { TeamLaunchError } from './contracts.js';
import type { TeamLaunchRecord } from './contracts.js';
/** Same original immutable selections/preparations projection, extracted to preserve owner cohesion. */
export function projectLaunchRestorations(record: TeamLaunchRecord) {
  return structuredClone({
    launchId: record.definition.launchId,
    rosterRevision: record.definition.rosterRevision,
    preparations: (record.resumePreparations ?? []).map(
      ({ fingerprint: _fingerprint, ...group }) => group
    ),
    restorations: (record.restorations ?? []).map(({ commandId, member }) => ({
      commandId,
      member,
      current:
        runtimeDigest(
          record.definition.members.find((row) => row.memberId === member.memberId)?.binding
        ) === runtimeDigest(member.binding),
    })),
  });
}

/** One original validated record supplies read-only lineage and allocation witnesses. */
export function projectLaunchActivityLineage(record: TeamLaunchRecord, memberId: string) {
  validateMemberActions(record);
  validateLiveRosterLaunch(record);
  const member = record.definition.members.find(row => row.memberId === memberId);
  const state = record.members.find(row => row.memberId === memberId);
  const attempt = state?.attempts.find(row => row.attemptId === state.currentAttemptId);
  if (!member || !state || !attempt) throw new TeamLaunchError('hold', 'member-action-source');
  const liveSelections = liveRosterSelectionEdges(record).filter(row => row.member.memberId === memberId)
    .map(row => {
      const target = state.attempts.findIndex(item => item.attemptId === `live-${runtimeDigest(row.commandId)}`);
      const sourceAttempt = state.attempts[target - 1];
      // Membership publication appends its new attempt. The preceding attempt
      // belongs to the retained source, including any original no-allocation retry.
      if (!sourceAttempt) throw new TeamLaunchError('hold', 'live-roster-original-attempt');
      return { ...row, sourceRecordRequired: sourceAttempt.everReady };
    });
  return structuredClone({
    launchId: record.definition.launchId, member, recordRequired: attempt.everReady,
    liveSelections,
    actions: (record.memberActions ?? []).filter(row => row.input.memberId === memberId),
    restorations: (record.restorations ?? []).filter(row => row.member.memberId === memberId),
  });
}
