import type { RunningTeamViewRow } from '../ui/RunningTeamsSectionView';

/** Search only already loaded, visible display facts. */
export function filterRunningTeamRows<T extends RunningTeamViewRow>(
  rows: readonly T[],
  query: string
): T[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [...rows];
  return rows.filter((row) =>
    [row.displayName, row.projectLabel, row.statusLabel]
      .filter((value): value is string => Boolean(value))
      .some((value) => value.toLocaleLowerCase().includes(needle))
  );
}
