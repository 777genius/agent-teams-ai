import { get, set } from 'idb-keyval';

const IDB_KEY = 'comment-read-state';
const SAVE_DEBOUNCE_MS = 300;
const STALE_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

type ReadState = Record<string, number>; // key = "teamName/taskId", value = timestamp

let cache: ReadState = {};
let loaded = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

// --- useSyncExternalStore API ---
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!loaded) void loadFromIdb();
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
    void saveToIdb();
  }, SAVE_DEBOUNCE_MS);
}

async function loadFromIdb(): Promise<void> {
  if (loaded) return;
  if (!hasIndexedDB()) {
    loaded = true;
    return;
  }
  try {
    const stored = await get<ReadState>(IDB_KEY);
    if (stored && typeof stored === 'object') {
      cache = { ...stored, ...cache }; // merge: in-memory wins over stale IDB
      notify();
    }
  } catch (e) {
    console.error('[commentReadStorage] load failed:', e);
  }
  loaded = true;
}

async function saveToIdb(): Promise<void> {
  if (!hasIndexedDB()) return;
  try {
    await set(IDB_KEY, cache);
  } catch (e) {
    console.error('[commentReadStorage] save failed:', e);
  }
}

export async function cleanupStale(): Promise<void> {
  if (!hasIndexedDB()) return;
  try {
    const stored = await get<ReadState>(IDB_KEY);
    if (!stored) return;
    const now = Date.now();
    const cleaned: ReadState = {};
    let changed = false;
    for (const [k, v] of Object.entries(stored)) {
      if (now - v < STALE_THRESHOLD_MS) {
        cleaned[k] = v;
      } else {
        changed = true;
      }
    }
    if (changed) await set(IDB_KEY, cleaned);
  } catch (e) {
    console.error('[commentReadStorage] cleanup failed:', e);
  }
}
