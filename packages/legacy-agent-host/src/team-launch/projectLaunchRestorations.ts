import { runtimeDigest } from '../runtime/identity.js';
import { validateMemberActions } from './memberActions.js';
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
  const member = record.definition.members.find(row => row.memberId === memberId);
  const state = record.members.find(row => row.memberId === memberId);
  const attempt = state?.attempts.find(row => row.attemptId === state.currentAttemptId);
  if (!member || !attempt) throw new TeamLaunchError('hold', 'member-action-source');
  return structuredClone({
    launchId: record.definition.launchId, member, recordRequired: attempt.everReady,
    actions: (record.memberActions ?? []).filter(row => row.input.memberId === memberId),
    restorations: (record.restorations ?? []).filter(row => row.member.memberId === memberId),
  });
}
