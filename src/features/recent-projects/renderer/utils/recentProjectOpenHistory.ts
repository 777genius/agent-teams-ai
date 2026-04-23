import { isEphemeralProjectPath } from '@shared/utils/ephemeralProjectPath';

import type { DashboardRecentProject } from '@features/recent-projects/contracts';

const RECENT_PROJECT_OPEN_HISTORY_KEY = 'recent-projects:open-history';
const RECENT_PROJECT_OPEN_HISTORY_EVENT = 'recent-projects:open-history-changed';
const OPEN_PRIORITY_WINDOW_MS = 1000 * 60 * 60 * 48;
const MAX_HISTORY_ENTRIES = 120;

interface RecentProjectOpenHistoryEntry {
  path: string;
  openedAt: number;
}

interface RecentProjectOpenHistoryState {
  version: 1;
  entries: RecentProjectOpenHistoryEntry[];
}

function canUseLocalStorage(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function normalizeHistoryPath(projectPath: string): string | null {
  let normalizedPath = projectPath.trim().replace(/\\/g, '/');
  if (!normalizedPath) {
    return null;
  }
  if (isEphemeralProjectPath(normalizedPath)) {
    return null;
  }
  if (normalizedPath !== '/' && !/^[A-Za-z]:\/$/.test(normalizedPath)) {
    while (normalizedPath.endsWith('/')) {
      normalizedPath = normalizedPath.slice(0, -1);
    }
  }
  return normalizedPath;
}

function foldHistoryPath(projectPath: string): string {
  return projectPath.toLowerCase();
}

function readHistoryState(): RecentProjectOpenHistoryState {
  if (!canUseLocalStorage()) {
    return { version: 1, entries: [] };
  }

  try {
    const raw = window.localStorage.getItem(RECENT_PROJECT_OPEN_HISTORY_KEY);
    if (!raw) {
      return { version: 1, entries: [] };
    }

    const parsed = JSON.parse(raw) as Partial<RecentProjectOpenHistoryState>;
    const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
    return {
      version: 1,
      entries: entries
        .filter(
          (entry): entry is RecentProjectOpenHistoryEntry =>
            !!entry &&
            typeof entry.path === 'string' &&
            typeof entry.openedAt === 'number' &&
            Number.isFinite(entry.openedAt)
        )
        .map((entry) => ({
          path: entry.path,
          openedAt: entry.openedAt,
        })),
    };
  } catch {
    return { version: 1, entries: [] };
  }
}

function pruneEntries(
  entries: readonly RecentProjectOpenHistoryEntry[]
): RecentProjectOpenHistoryEntry[] {
  const byPath = new Map<string, number>();

  for (const entry of entries) {
    const normalizedPath = normalizeHistoryPath(entry.path);
    if (!normalizedPath) {
      continue;
    }
    byPath.set(normalizedPath, Math.max(byPath.get(normalizedPath) ?? 0, entry.openedAt));
  }

  return Array.from(byPath.entries())
    .map(([historyPath, openedAt]) => ({ path: historyPath, openedAt }))
    .sort((left, right) => right.openedAt - left.openedAt)
    .slice(0, MAX_HISTORY_ENTRIES);
}

function writeHistoryEntries(entries: readonly RecentProjectOpenHistoryEntry[]): void {
  if (!canUseLocalStorage()) {
    return;
  }

  const nextState: RecentProjectOpenHistoryState = {
    version: 1,
    entries: pruneEntries(entries),
  };

  try {
    window.localStorage.setItem(RECENT_PROJECT_OPEN_HISTORY_KEY, JSON.stringify(nextState));
    window.dispatchEvent(new CustomEvent(RECENT_PROJECT_OPEN_HISTORY_EVENT));
  } catch {
    // Best-effort persistence only.
  }
}

interface HistoryLookup {
  exact: Map<string, number>;
  folded: Map<
    string,
    {
      openedAt: number;
      exactPaths: Set<string>;
    }
  >;
}

function createHistoryLookup(): HistoryLookup {
  const exact = new Map<string, number>();
  const folded = new Map<string, { openedAt: number; exactPaths: Set<string> }>();

  for (const entry of readHistoryState().entries) {
    const normalizedPath = normalizeHistoryPath(entry.path);
    if (!normalizedPath) {
      continue;
    }

    exact.set(normalizedPath, Math.max(exact.get(normalizedPath) ?? 0, entry.openedAt));

    const foldedKey = foldHistoryPath(normalizedPath);
    const existingFolded = folded.get(foldedKey);
    if (existingFolded) {
      existingFolded.openedAt = Math.max(existingFolded.openedAt, entry.openedAt);
      existingFolded.exactPaths.add(normalizedPath);
    } else {
      folded.set(foldedKey, {
        openedAt: entry.openedAt,
        exactPaths: new Set([normalizedPath]),
      });
    }
  }

  return { exact, folded };
}

function resolveHistoryOpenedAt(lookup: HistoryLookup, projectPath: string): number {
  const normalizedPath = normalizeHistoryPath(projectPath);
  if (!normalizedPath) {
    return 0;
  }

  const exactMatch = lookup.exact.get(normalizedPath);
  if (exactMatch != null) {
    return exactMatch;
  }

  const foldedMatch = lookup.folded.get(foldHistoryPath(normalizedPath));
  if (foldedMatch?.exactPaths.size !== 1) {
    return 0;
  }

  return foldedMatch.openedAt;
}

function getProjectLastOpenedAtFromLookup(
  lookup: HistoryLookup,
  project: Pick<DashboardRecentProject, 'primaryPath' | 'associatedPaths'>
): number {
  return [project.primaryPath, ...project.associatedPaths].reduce(
    (latest, projectPath) => Math.max(latest, resolveHistoryOpenedAt(lookup, projectPath)),
    0
  );
}

export function recordRecentProjectOpenPaths(
  projectPaths: readonly string[],
  openedAt: number = Date.now()
): void {
  const normalizedPaths = Array.from(
    new Set(
      projectPaths
        .map((projectPath) => normalizeHistoryPath(projectPath))
        .filter((projectPath): projectPath is string => Boolean(projectPath))
    )
  );

  if (normalizedPaths.length === 0) {
    return;
  }

  const existing = readHistoryState().entries;
  writeHistoryEntries([
    ...existing,
    ...normalizedPaths.map((projectPath) => ({
      path: projectPath,
      openedAt,
    })),
  ]);
}

export function getRecentProjectLastOpenedAt(
  project: Pick<DashboardRecentProject, 'primaryPath' | 'associatedPaths'>
): number {
  const historyLookup = createHistoryLookup();
  return getProjectLastOpenedAtFromLookup(historyLookup, project);
}

export function sortRecentProjectsByDisplayPriority(
  projects: readonly DashboardRecentProject[],
  now: number = Date.now()
): DashboardRecentProject[] {
  const historyLookup = createHistoryLookup();

  const isPriorityOpen = (openedAt: number): boolean =>
    openedAt > 0 && now - openedAt <= OPEN_PRIORITY_WINDOW_MS;

  return [...projects].sort((left, right) => {
    const leftOpenedAt = getProjectLastOpenedAtFromLookup(historyLookup, left);
    const rightOpenedAt = getProjectLastOpenedAtFromLookup(historyLookup, right);
    const leftPriority = isPriorityOpen(leftOpenedAt);
    const rightPriority = isPriorityOpen(rightOpenedAt);

    if (leftPriority !== rightPriority) {
      return leftPriority ? -1 : 1;
    }

    if (leftPriority && rightPriority && leftOpenedAt !== rightOpenedAt) {
      return rightOpenedAt - leftOpenedAt;
    }

    if (left.mostRecentActivity !== right.mostRecentActivity) {
      return right.mostRecentActivity - left.mostRecentActivity;
    }

    if (leftOpenedAt !== rightOpenedAt) {
      return rightOpenedAt - leftOpenedAt;
    }

    return left.name.localeCompare(right.name);
  });
}

export function subscribeRecentProjectOpenHistory(listener: () => void): () => void {
  if (typeof window === 'undefined') {
    return () => undefined;
  }

  const handleChange = (): void => listener();
  window.addEventListener(RECENT_PROJECT_OPEN_HISTORY_EVENT, handleChange);
  return () => {
    window.removeEventListener(RECENT_PROJECT_OPEN_HISTORY_EVENT, handleChange);
  };
}

export function resetRecentProjectOpenHistoryForTests(): void {
  if (!canUseLocalStorage()) {
    return;
  }

  window.localStorage.removeItem(RECENT_PROJECT_OPEN_HISTORY_KEY);
}
