import { get, set } from 'idb-keyval';

const IDB_KEY = 'comment-read-state';
const LS_KEY = 'comment-read-state';
const SAVE_DEBOUNCE_MS = 300;
const STALE_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

type ReadState = Record<string, number>; // key = "teamName/taskId", value = timestamp

// --- localStorage fallback ---
function lsLoad(): ReadState | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as ReadState)
      : null;
  } catch {
    return null;
  }
}

function lsSave(state: ReadState): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(state));
  } catch {
    // localStorage full or unavailable — silently ignore
  }
}

// Synchronous init from localStorage — guarantees first render sees read state
const lsInitial = lsLoad();
let cache: ReadState = lsInitial ?? {};
let loaded = lsInitial !== null && Object.keys(lsInitial).length > 0;
let idbAvailable = true; // flips to false on first IndexedDB failure
let saveTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

// --- useSyncExternalStore API ---
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!loaded) void load();
  return () => {
    listeners.delete(listener);
  };
}

export function getSnapshot(): ReadState {
  return cache;
}

// --- Mutations ---
export function markAsRead(teamName: string, taskId: string, latestTimestamp: number): void {
  const key = `${teamName}/${taskId}`;
  const prev = cache[key] ?? 0;
  if (latestTimestamp <= prev) return;
  cache = { ...cache, [key]: latestTimestamp };
  notify();
  scheduleSave();
}

export function getUnreadCount(
  readState: ReadState,
  teamName: string,
  taskId: string,
  comments: { createdAt: string }[]
): number {
  if (!comments || comments.length === 0) return 0;
  const key = `${teamName}/${taskId}`;
  const lastRead = readState[key] ?? 0;
  return comments.filter((c) => new Date(c.createdAt).getTime() > lastRead).length;
}

/** Return the last-read timestamp for a team/task pair (0 if never read). */
export function getLastReadTimestamp(teamName: string, taskId: string): number {
  const key = `${teamName}/${taskId}`;
  return cache[key] ?? 0;
}

// --- Internal ---
function hasIndexedDB(): boolean {
  return typeof indexedDB !== 'undefined';
}

function notify(): void {
  listeners.forEach((l) => l());
}

function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void save();
  }, SAVE_DEBOUNCE_MS);
}

async function load(): Promise<void> {
  if (loaded) return;

  // IDB may have fresher data — merge with max timestamp per key
  if (hasIndexedDB() && idbAvailable) {
    try {
      const stored = await get<ReadState>(IDB_KEY);
      if (stored && typeof stored === 'object') {
        const merged = { ...cache };
        for (const [k, v] of Object.entries(stored)) {
          merged[k] = Math.max(merged[k] ?? 0, v);
        }
        cache = merged;
        notify();
      }
    } catch {
      idbAvailable = false;
    }
  }

  loaded = true;
}

async function save(): Promise<void> {
  // Always write to localStorage (sync, reliable)
  lsSave(cache);

  // Also write to IndexedDB (async, primary)
  if (idbAvailable && hasIndexedDB()) {
    try {
      await set(IDB_KEY, cache);
    } catch {
      idbAvailable = false;
    }
  }
}

export async function cleanupStale(): Promise<void> {
  const now = Date.now();
  const clean = (state: ReadState): { cleaned: ReadState; changed: boolean } => {
    const result: ReadState = {};
    let changed = false;
    for (const [k, v] of Object.entries(state)) {
      if (now - v < STALE_THRESHOLD_MS) {
        result[k] = v;
      } else {
        changed = true;
      }
    }
    return { cleaned: result, changed };
  };

  const { cleaned, changed } = clean(cache);
  if (!changed) return;

  // Update in-memory cache
  cache = cleaned;
  notify();

  // Persist to both storages
  lsSave(cleaned);
  if (idbAvailable && hasIndexedDB()) {
    try {
      await set(IDB_KEY, cleaned);
    } catch {
      idbAvailable = false;
    }
  }
}
