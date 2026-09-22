import { useCallback, useMemo, useState } from 'react';

const PINNED_KEY = 'taskPinnedIds';
const ARCHIVED_KEY = 'taskArchivedIds';
const RENAMED_KEY = 'taskRenamedSubjects';

function makeCompositeKey(teamName: string, taskId: string): string {
  return `${teamName}:${taskId}`;
}

function loadSet(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return new Set();
    const arr: unknown = JSON.parse(raw);
    if (Array.isArray(arr)) return new Set(arr.filter((v): v is string => typeof v === 'string'));
  } catch {
    /* ignore */
  }
  return new Set();
}

function saveSet(key: string, set: Set<string>): void {
  try {
    localStorage.setItem(key, JSON.stringify([...set]));
  } catch {
    /* ignore */
  }
}

function loadMap(key: string): Map<string, string> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return new Map();
    const obj: unknown = JSON.parse(raw);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      return new Map(
        Object.entries(obj as Record<string, unknown>).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string'
        )
      );
    }
  } catch {
    /* ignore */
  }
  return new Map();
}

function saveMap(key: string, map: Map<string, string>): void {
  try {
    localStorage.setItem(key, JSON.stringify(Object.fromEntries(map)));
  } catch {
    /* ignore */
  }
}

export interface TaskLocalState {
  pinnedIds: Set<string>;
  archivedIds: Set<string>;
  renamedSubjects: Map<string, string>;

  isPinned: (teamName: string, taskId: string) => boolean;
  isArchived: (teamName: string, taskId: string) => boolean;
  getRenamedSubject: (teamName: string, taskId: string) => string | undefined;

  togglePin: (teamName: string, taskId: string) => void;
  toggleArchive: (teamName: string, taskId: string) => void;
  renameTask: (teamName: string, taskId: string, newSubject: string) => void;
}

export function useTaskLocalState(): TaskLocalState {
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(() => loadSet(PINNED_KEY));
  const [archivedIds, setArchivedIds] = useState<Set<string>>(() => loadSet(ARCHIVED_KEY));
  const [renamedSubjects, setRenamedSubjects] = useState<Map<string, string>>(() =>
    loadMap(RENAMED_KEY)
  );

  const isPinned = useCallback(
    (teamName: string, taskId: string): boolean =>
      pinnedIds.has(makeCompositeKey(teamName, taskId)),
    [pinnedIds]
  );

  const isArchived = useCallback(
    (teamName: string, taskId: string): boolean =>
      archivedIds.has(makeCompositeKey(teamName, taskId)),
    [archivedIds]
  );

  const getRenamedSubject = useCallback(
    (teamName: string, taskId: string): string | undefined =>
      renamedSubjects.get(makeCompositeKey(teamName, taskId)),
    [renamedSubjects]
  );

  const togglePin = useCallback((teamName: string, taskId: string): void => {
    const key = makeCompositeKey(teamName, taskId);
    setPinnedIds((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      saveSet(PINNED_KEY, next);
      return next;
    });
  }, []);

  const toggleArchive = useCallback((teamName: string, taskId: string): void => {
    const key = makeCompositeKey(teamName, taskId);
    setArchivedIds((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      saveSet(ARCHIVED_KEY, next);
      return next;
    });
  }, []);

  const renameTask = useCallback((teamName: string, taskId: string, newSubject: string): void => {
    const key = makeCompositeKey(teamName, taskId);
    setRenamedSubjects((prev) => {
      const next = new Map(prev);
      const trimmed = newSubject.trim();
      if (trimmed) {
        next.set(key, trimmed);
      } else {
        next.delete(key);
      }
      saveMap(RENAMED_KEY, next);
      return next;
    });
  }, []);

  return useMemo(
    () => ({
      pinnedIds,
      archivedIds,
      renamedSubjects,
      isPinned,
      isArchived,
      getRenamedSubject,
      togglePin,
      toggleArchive,
      renameTask,
    }),
    [
      pinnedIds,
      archivedIds,
      renamedSubjects,
      isPinned,
      isArchived,
      getRenamedSubject,
      togglePin,
      toggleArchive,
      renameTask,
    ]
  );
}
