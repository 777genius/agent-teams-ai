import type { HostedTeam, MemberEntry } from './MemberEntry.js';
/** Saved original members plus explicitly joined same-run native additions. No current mutable-roster adoption. */
export function runtimeLaunchMembers(team: HostedTeam, entries: readonly MemberEntry[]) {
  const members = [...team.definition.members];
  for (const entry of entries) {
    if (
      entry.team.owner !== team.owner ||
      entry.binding.runId !== (team.launchId ?? team.definition.scope.runId)
    )
      continue;
    const member = entry.team.definition.members.find(
      (row) => row.memberId === entry.binding.memberId
    );
    if (member && !members.some((row) => row.memberId === member.memberId)) members.push(member);
  }
  return members;
}
