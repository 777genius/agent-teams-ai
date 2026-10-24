import { runtimeDigest } from '../runtime/identity.js';
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
