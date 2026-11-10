/** Identity encoding is explicit: a real team's entire raw name follows `team:`. */
export const ANONYMOUS_TEAM_ID = 'anonymous';
export const LEGACY_COMBINED_TEAM_ID = 'legacy:unassigned';
export const TEAM_IDENTITY_VERSION = 1 as const;

export function namedTeamId(teamName: string): string {
  return `team:${teamName}`;
}

export function teamIdForName(teamName: string | undefined): string {
  return teamName === undefined ? ANONYMOUS_TEAM_ID : namedTeamId(teamName);
}

export function rawTeamName(teamId: string): string | undefined {
  return teamId.startsWith('team:') && teamId.length > 5 ? teamId.slice(5) : undefined;
}

export function isCanonicalTeamId(value: unknown): value is string {
  if (value === ANONYMOUS_TEAM_ID || value === LEGACY_COMBINED_TEAM_ID) return true;
  if (typeof value !== 'string') return false;
  const name = rawTeamName(value);
  return name !== undefined && name.trim().length > 0 && name === name.trim();
}

/** v1/v2 always stored raw names, including names that resemble v3 identifiers. */
export function migrateRawTeamId(rawName: string): string {
  return rawName === 'unassigned' ? LEGACY_COMBINED_TEAM_ID : namedTeamId(rawName);
}

export function teamIdentityLabel(teamId: string): string {
  if (teamId === ANONYMOUS_TEAM_ID) return 'Anonymous runs';
  if (teamId === LEGACY_COMBINED_TEAM_ID) return 'Legacy combined: anonymous + unassigned';
  return rawTeamName(teamId) ?? teamId;
}

export class SnapshotFilterValidationError extends Error {
  readonly code = 'SNAPSHOT_FILTER_VALIDATION';
}

export function validateTeamIds(teamIds: unknown): asserts teamIds is string[] | undefined {
  if (teamIds === undefined) return;
  if (
    !Array.isArray(teamIds) ||
    teamIds.some((id) => !isCanonicalTeamId(id) || id === LEGACY_COMBINED_TEAM_ID)
  )
    throw new SnapshotFilterValidationError('Invalid canonical team filter');
}
