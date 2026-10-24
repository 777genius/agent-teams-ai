import { namedTeamId, teamIdForName, validateTeamIds } from '../../contracts';

import type { TokenUsageSnapshotRequest } from '../../contracts';

export function buildTeamFilter(
  request: TokenUsageSnapshotRequest | undefined
): ReadonlySet<string> | undefined {
  validateTeamIds(request?.teamIds);
  if (request?.teamIds !== undefined)
    return request.teamIds.length > 0 ? new Set(request.teamIds) : undefined;
  const names = (request?.teamNames ?? [])
    .map((teamName) => teamName.trim())
    .filter((teamName, index, items) => teamName.length > 0 && items.indexOf(teamName) === index);
  if (names.length > 0) return new Set(names.map(namedTeamId));
  return request?.teamName ? new Set([namedTeamId(request.teamName)]) : undefined;
}

export function matchesTeamFilter(
  teamName: string | undefined,
  filter: ReadonlySet<string>
): boolean {
  return filter.has(teamIdForName(teamName));
}
