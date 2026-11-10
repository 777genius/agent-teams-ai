import type { TeamTaskChangeSummaryItem } from '@shared/types';

function normalizeTeamChangeSummaryItem(item: unknown): TeamTaskChangeSummaryItem | null {
  if (!item || typeof item !== 'object') {
    return null;
  }

  const candidate = item as Partial<TeamTaskChangeSummaryItem>;
  const taskId = typeof candidate.taskId === 'string' ? candidate.taskId.trim() : '';
  if (!taskId) {
    return null;
  }

  const changeSet =
    candidate.changeSet &&
    typeof candidate.changeSet === 'object' &&
    !Array.isArray(candidate.changeSet)
      ? candidate.changeSet
      : null;
  const error = typeof candidate.error === 'string' ? candidate.error : undefined;
  return {
    taskId,
    changeSet,
    ...(error ? { error } : {}),
  };
}

export function getSafeTeamChangeResponseItems(response: unknown): TeamTaskChangeSummaryItem[] {
  if (
    !response ||
    typeof response !== 'object' ||
    !Array.isArray((response as { items?: unknown }).items)
  ) {
    throw new Error('Team changes response was malformed.');
  }
  return (response as { items: unknown[] }).items
    .map(normalizeTeamChangeSummaryItem)
    .filter((item): item is TeamTaskChangeSummaryItem => item !== null);
}
