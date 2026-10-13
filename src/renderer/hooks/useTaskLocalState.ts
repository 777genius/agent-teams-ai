import { useSyncExternalStore } from 'react';

const PINNED_KEY = 'taskPinnedIds';
const PINNED_PROJECT_KEY = 'taskPinnedProjectKeys';
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
  pinnedProjectKeys: Set<string>;
  archivedIds: Set<string>;
  renamedSubjects: Map<string, string>;

  isPinned: (teamName: string, taskId: string) => boolean;
  isProjectPinned: (projectKey: string) => boolean;
  isArchived: (teamName: string, taskId: string) => boolean;
  getRenamedSubject: (teamName: string, taskId: string) => string | undefined;

  togglePin: (teamName: string, taskId: string) => void;
  toggleProjectPin: (projectKey: string) => void;
  toggleArchive: (teamName: string, taskId: string) => void;
  renameTask: (teamName: string, taskId: string, newSubject: string) => void;
}

const listeners = new Set<() => void>();
let shared: TaskLocalState | undefined;
function readState(): TaskLocalState {
  const pinnedIds = loadSet(PINNED_KEY);
  const pinnedProjectKeys = loadSet(PINNED_PROJECT_KEY);
  const archivedIds = loadSet(ARCHIVED_KEY);
  const renamedSubjects = loadMap(RENAMED_KEY);
  return makeState(pinnedIds, pinnedProjectKeys, archivedIds, renamedSubjects);
}
function makeState(
  pinnedIds: Set<string>,
  pinnedProjectKeys: Set<string>,
  archivedIds: Set<string>,
  renamedSubjects: Map<string, string>
): TaskLocalState {
  return {
    pinnedIds,
    pinnedProjectKeys,
    archivedIds,
    renamedSubjects,
    isPinned: (team, id) => pinnedIds.has(makeCompositeKey(team, id)),
    isProjectPinned: (key) => pinnedProjectKeys.has(key),
    isArchived: (team, id) => archivedIds.has(makeCompositeKey(team, id)),
    getRenamedSubject: (team, id) => renamedSubjects.get(makeCompositeKey(team, id)),
    togglePin: (team, id) => toggle('pinnedIds', PINNED_KEY, makeCompositeKey(team, id)),
    toggleProjectPin: (key) => {
      if (key) toggle('pinnedProjectKeys', PINNED_PROJECT_KEY, key);
    },
    toggleArchive: (team, id) => toggle('archivedIds', ARCHIVED_KEY, makeCompositeKey(team, id)),
    renameTask: (team, id, subject) => {
      const state = getSnapshot();
      const next = new Map(state.renamedSubjects);
      const trimmed = subject.trim();
      if (trimmed) next.set(makeCompositeKey(team, id), trimmed);
      else next.delete(makeCompositeKey(team, id));
      saveMap(RENAMED_KEY, next);
      publish(makeState(state.pinnedIds, state.pinnedProjectKeys, state.archivedIds, next));
    },
  };
}
function publish(next: TaskLocalState): void {
  shared = next;
  listeners.forEach((listener) => listener());
}
function toggle(
  field: 'pinnedIds' | 'pinnedProjectKeys' | 'archivedIds',
  storageKey: string,
  key: string
): void {
  const state = getSnapshot();
  const next = new Set(state[field]);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  saveSet(storageKey, next);
  const values = { ...state, [field]: next };
  publish(
    makeState(
      values.pinnedIds,
      values.pinnedProjectKeys,
      values.archivedIds,
      values.renamedSubjects
    )
  );
}
function getSnapshot(): TaskLocalState {
  shared ??= readState();
  return shared;
}
function storageChanged(event: StorageEvent): void {
  if (
    event.key === null ||
    [PINNED_KEY, PINNED_PROJECT_KEY, ARCHIVED_KEY, RENAMED_KEY].includes(event.key)
  )
    publish(readState());
}
function subscribe(listener: () => void): () => void {
  if (!listeners.size) {
    shared = readState();
    window.addEventListener('storage', storageChanged);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) window.removeEventListener('storage', storageChanged);
  };
}
export function useTaskLocalState(): TaskLocalState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
