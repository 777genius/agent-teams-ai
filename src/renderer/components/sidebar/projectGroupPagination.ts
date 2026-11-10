export const PROJECT_GROUP_PAGE_SIZE = 5;

export interface ProjectGroupVisibilityDescriptor {
  projectKey: string;
  taskCount: number;
}

export function getProjectGroupVisibleCount(
  visibleCount: number | undefined,
  taskCount: number
): number {
  if (taskCount <= 0) {
    return 0;
  }

  const minimumVisibleCount = Math.min(PROJECT_GROUP_PAGE_SIZE, taskCount);
  if (visibleCount == null || !Number.isFinite(visibleCount)) {
    return minimumVisibleCount;
  }

  const normalizedVisibleCount = Math.floor(visibleCount);
  return Math.min(taskCount, Math.max(minimumVisibleCount, normalizedVisibleCount));
}

export function getNextProjectGroupVisibleCount(
  visibleCount: number | undefined,
  taskCount: number
): number {
  const currentVisibleCount = getProjectGroupVisibleCount(visibleCount, taskCount);
  if (currentVisibleCount >= taskCount) {
    return currentVisibleCount;
  }
  return Math.min(taskCount, currentVisibleCount + PROJECT_GROUP_PAGE_SIZE);
}

export function getPreviousProjectGroupVisibleCount(
  visibleCount: number | undefined,
  taskCount: number
): number {
  const currentVisibleCount = getProjectGroupVisibleCount(visibleCount, taskCount);
  const minimumVisibleCount = Math.min(PROJECT_GROUP_PAGE_SIZE, taskCount);
  return Math.max(minimumVisibleCount, currentVisibleCount - PROJECT_GROUP_PAGE_SIZE);
}

export function canProjectGroupShowMore(
  visibleCount: number | undefined,
  taskCount: number
): boolean {
  return getProjectGroupVisibleCount(visibleCount, taskCount) < taskCount;
}

export function canProjectGroupShowLess(
  visibleCount: number | undefined,
  taskCount: number
): boolean {
  if (taskCount <= PROJECT_GROUP_PAGE_SIZE) {
    return false;
  }
  return getProjectGroupVisibleCount(visibleCount, taskCount) > PROJECT_GROUP_PAGE_SIZE;
}

export function syncProjectGroupVisibleCountByKey(
  previousVisibleCountByKey: Record<string, number>,
  groups: readonly ProjectGroupVisibilityDescriptor[]
): Record<string, number> {
  let changed = false;
  const nextVisibleCountByKey: Record<string, number> = {};

  for (const group of groups) {
    const nextVisibleCount = getProjectGroupVisibleCount(
      previousVisibleCountByKey[group.projectKey],
      group.taskCount
    );

    if (nextVisibleCount > 0) {
      nextVisibleCountByKey[group.projectKey] = nextVisibleCount;
    }

    if (previousVisibleCountByKey[group.projectKey] !== nextVisibleCount) {
      changed = true;
    }
  }

  if (Object.keys(previousVisibleCountByKey).length !== Object.keys(nextVisibleCountByKey).length) {
    changed = true;
  }

  return changed ? nextVisibleCountByKey : previousVisibleCountByKey;
}
