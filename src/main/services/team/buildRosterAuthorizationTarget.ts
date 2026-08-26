import type { ReplaceMembersRequest, TeamMember } from '@shared/types';

export interface RosterAuthorizationTargetDependencies {
  teamName: string;
  requested: ReplaceMembersRequest['members'];
  getMembers(teamName: string): Promise<TeamMember[]>;
  buildReplacement(
    existing: readonly TeamMember[],
    requested: ReplaceMembersRequest['members']
  ): TeamMember[];
  assertAllowed(members: readonly TeamMember[]): Promise<void>;
  canonicalRaw(
    priorRaw: string | null,
    existing: readonly TeamMember[],
    requested: ReplaceMembersRequest['members'],
    replacement: readonly TeamMember[]
  ): string;
}

/** Builds the lock-scoped target callback consumed by the roster transaction service. */
export function buildRosterAuthorizationTarget(
  dependencies: RosterAuthorizationTargetDependencies
): (priorRaw: string | null) => Promise<string> {
  return async (priorRaw) => {
    const existing = await dependencies.getMembers(dependencies.teamName);
    const output = dependencies.buildReplacement(existing, dependencies.requested);
    await dependencies.assertAllowed(output);
    return dependencies.canonicalRaw(
      priorRaw,
      existing,
      dependencies.requested,
      output
    );
  };
}
