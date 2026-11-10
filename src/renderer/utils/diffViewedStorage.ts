/**
 * localStorage-based tracking of "viewed" files in diff review.
 * Pattern follows teamMessageReadStorage.ts.
 */

const STORAGE_PREFIX = 'diff-viewed';
const MAX_TOTAL_ENTRIES = 50;

interface ViewedStorageEntry {
  files: string[];
  updatedAt: string;
}

function getStorageKey(teamName: string, scopeKey: string): string {
  return `${STORAGE_PREFIX}:${teamName}:${scopeKey}`;
}

function parseEntry(raw: string | null): ViewedStorageEntry | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    // Migration from old format (plain string[]) → new format
    if (Array.isArray(parsed)) {
      return { files: parsed as string[], updatedAt: new Date(0).toISOString() };
    }
    if (
      parsed &&
      typeof parsed === 'object' &&
      'files' in parsed &&
      Array.isArray((parsed as ViewedStorageEntry).files)
    ) {
      return parsed as ViewedStorageEntry;
    }
    return null;
  } catch {
    return null;
  }
}

function saveEntry(teamName: string, scopeKey: string, entry: ViewedStorageEntry): void {
  try {
    localStorage.setItem(getStorageKey(teamName, scopeKey), JSON.stringify(entry));
  } catch (error) {
    console.warn('[diffViewedStorage] localStorage write failed:', error);
    try {
      cleanupOldViewedEntries();
      localStorage.setItem(getStorageKey(teamName, scopeKey), JSON.stringify(entry));
    } catch {
      // Full failure — silently ignore, viewed state is not critical
    }
  }
}

/** Cleanup old entries when localStorage is full */
export function cleanupOldViewedEntries(): void {
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith(STORAGE_PREFIX)) keys.push(key);
  }
  if (keys.length > MAX_TOTAL_ENTRIES) {
    const sorted = keys
      .map((k) => ({ key: k, entry: parseEntry(localStorage.getItem(k)) }))
      .sort((a, b) => (a.entry?.updatedAt ?? '').localeCompare(b.entry?.updatedAt ?? ''));
    for (let i = 0; i < sorted.length - MAX_TOTAL_ENTRIES; i++) {
      localStorage.removeItem(sorted[i].key);
    }
  }
}

/** Get set of viewed file paths */
export function getViewedFiles(teamName: string, scopeKey: string): Set<string> {
  const entry = parseEntry(localStorage.getItem(getStorageKey(teamName, scopeKey)));
  return entry ? new Set(entry.files) : new Set();
}

/** Mark a file as viewed */
export function markFileViewed(teamName: string, scopeKey: string, filePath: string): void {
  const set = getViewedFiles(teamName, scopeKey);
  set.add(filePath);
  saveEntry(teamName, scopeKey, {
    files: [...set],
    updatedAt: new Date().toISOString(),
  });
}

/** Unmark a file as viewed */
export function unmarkFileViewed(teamName: string, scopeKey: string, filePath: string): void {
  const set = getViewedFiles(teamName, scopeKey);
  set.delete(filePath);
  if (set.size === 0) {
    try {
      localStorage.removeItem(getStorageKey(teamName, scopeKey));
    } catch {
      // ignore
    }
    return;
  }
  saveEntry(teamName, scopeKey, {
    files: [...set],
    updatedAt: new Date().toISOString(),
  });
}

/** Mark all files as viewed */
export function markAllViewed(teamName: string, scopeKey: string, filePaths: string[]): void {
  saveEntry(teamName, scopeKey, {
    files: filePaths,
    updatedAt: new Date().toISOString(),
  });
}

/** Clear all viewed marks */
export function clearViewed(teamName: string, scopeKey: string): void {
  try {
    localStorage.removeItem(getStorageKey(teamName, scopeKey));
  } catch {
    // ignore
  }
}
