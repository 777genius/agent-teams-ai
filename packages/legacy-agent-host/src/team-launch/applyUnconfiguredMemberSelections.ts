import { runtimeDigest } from '../runtime/identity.js';
import { TeamLaunchError } from './contracts.js';
import type { TeamLaunchDefinition } from './contracts.js';
import { validateRestoreJournal } from './validateRestoreJournal.js';
import type { ActionLaunchRecord } from './memberActions.js';
/** Cold reconstruction of an SDK-free unconfigured skip only. Configured selections use the normal private binding reader. */
export function applyUnconfiguredMemberSelections(
  definition: TeamLaunchDefinition,
  record: ActionLaunchRecord | undefined
): TeamLaunchDefinition {
  if (!record) return definition;
  if (
    record.schemaVersion !== 1 ||
    record.definition.launchId !== definition.launchId ||
    record.fingerprint !== runtimeDigest(record.definition)
  )
    throw new TeamLaunchError('hold', 'member-action-record');
  validateRestoreJournal(record);
  const members = definition.members.map((member) => {
    if (member.configurationDigest !== null) return member;
    const skip = record.memberActions
      ?.filter(
        (a) =>
          a.phase === 'selected' &&
          a.noAllocation &&
          a.input.action === 'skip' &&
          a.input.memberId === member.memberId
      )
      .at(-1);
    if (!skip) return member;
    if (
      runtimeDigest(skip.source) !== runtimeDigest(member) ||
      runtimeDigest(skip.selected) !==
        runtimeDigest(record.definition.members.find((m) => m.memberId === member.memberId))
    )
      throw new TeamLaunchError('hold', 'member-action-source');
    return structuredClone(skip.selected);
  });
  return {
    ...definition,
    members,
    rosterRevision: runtimeDigest({
      scope: definition.rosterScope ?? definition.launchId,
      members,
    }),
  };
}
