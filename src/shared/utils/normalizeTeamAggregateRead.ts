import type {
  TeamAggregateRead,
  TeamAggregateReadResult,
  TeamReadUnavailable,
} from '@shared/types';

/** Legacy and complete Host reads keep their original arrays. */
export function normalizeTeamAggregateRead<T>(
  value: TeamAggregateReadResult<T>
): TeamAggregateRead<T> {
  return Array.isArray(value) ? { items: value, unavailable: [] } : value;
}

/** Display membership only; an unavailable owner reference grants no dispatch authority. */
export function isTeamReadUnavailable(
  unavailable: readonly TeamReadUnavailable[],
  resource: { teamName: string; ownerResourceRef?: string }
): boolean {
  return unavailable.some((row) =>
    row.kind === 'team'
      ? row.teamName === resource.teamName
      : resource.ownerResourceRef !== undefined && row.ownerResourceRef === resource.ownerResourceRef
  );
}
