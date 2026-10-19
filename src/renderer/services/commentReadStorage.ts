import {
  isValidTaskDetailIdentity,
  normalizeTaskDetailIdentity,
  taskDetailKey,
} from '@features/team-task-detail/core';
import { get, set } from 'idb-keyval';

import type { TaskDetailIdentity } from '@features/team-task-detail/core';

const IDB_KEY = 'comment-read-state-v2';
const LS_KEY = 'comment-read-state-v2';
const LEGACY_IDB_KEY = 'comment-read-state';
const LEGACY_LS_KEY = 'comment-read-state';
const SAVE_DEBOUNCE_MS = 300;
const STALE_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Per-task read state: tracks individual comment IDs that have been seen.
 * `lastUpdated` is used for stale cleanup (prune entries older than 30 days).
 */
interface TaskReadEntry {
  readIds: string[];
  lastUpdated: number;
  manualUnread?: boolean;
}

type ReadState = Record<string, TaskReadEntry>; // key = taskDetailKey(identity)

// Legacy format for migration (v1 stored a single timestamp per task)
type LegacyReadState = Record<string, number>;

// --- localStorage helpers ---
function lsLoad(): ReadState | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as ReadState;
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

function lsLoadLegacy(): LegacyReadState | null {
  try {
    const raw = localStorage.getItem(LEGACY_LS_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    // Verify it's the old format (values are numbers, not objects)
    const entries = Object.entries(parsed as Record<string, unknown>);
    if (entries.length > 0 && typeof entries[0][1] === 'number') {
      return parsed as LegacyReadState;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Migrate legacy per-task timestamp to per-comment ID format.
 * Since we don't have comment IDs from the old format, we treat all
 * comments with timestamps <= the old lastRead as "read" by storing
 * a sentinel marker. The actual per-comment tracking starts fresh.
 */
function migrateLegacy(legacy: LegacyReadState): ReadState {
  const migrated: ReadState = {};
  for (const [key, timestamp] of Object.entries(legacy)) {
    if (typeof timestamp === 'number' && timestamp > 0) {
      const separator = key.lastIndexOf('/');
      if (separator <= 0 || separator === key.length - 1) continue;
      const identity = normalizeTaskDetailIdentity({
        contextId: 'local',
        teamName: key.slice(0, separator),
        taskId: key.slice(separator + 1),
      });
      if (!isValidTaskDetailIdentity(identity)) continue;
      // Store legacy timestamp as a sentinel — getUnreadCount will use it
      // for comments older than migration, and per-ID for newer ones.
      migrated[taskDetailKey(identity)] = {
        readIds: [],
        lastUpdated: timestamp,
      };
    }
  }
  return migrated;
}

/** Canonicalize old contextless v2 keys before revision-guarded hydration. */
function normalizeStoredState(state: ReadState): ReadState {
  const result: ReadState = {};
  for (const [key, entry] of Object.entries(state)) {
    if (!entry || !Array.isArray(entry.readIds) || !Number.isFinite(entry.lastUpdated)) continue;
    let canonicalKey: string;
    try {
      const parts: unknown = JSON.parse(key);
      if (
        !Array.isArray(parts) ||
        parts.length !== 3 ||
        !parts.every((part) => typeof part === 'string')
      )
        continue;
      const identity = normalizeTaskDetailIdentity({
        contextId: parts[0],
        teamName: parts[1],
        taskId: parts[2],
      });
      if (!isValidTaskDetailIdentity(identity)) continue;
      canonicalKey = taskDetailKey(identity);
    } catch {
      const separator = key.lastIndexOf('/');
      if (separator <= 0 || separator === key.length - 1) continue;
      const identity = normalizeTaskDetailIdentity({
        contextId: 'local',
        teamName: key.slice(0, separator),
        taskId: key.slice(separator + 1),
      });
      if (!isValidTaskDetailIdentity(identity)) continue;
      canonicalKey = taskDetailKey(identity);
    }
    // Explicit canonical entries take precedence over their legacy fallback.
    if (!result[canonicalKey] || canonicalKey === key) result[canonicalKey] = entry;
  }
  return result;
}

// Synchronous init from localStorage — guarantees first render sees read state
let cache: ReadState = {};
const v2Data = lsLoad();
if (v2Data && Object.keys(v2Data).length > 0) {
  cache = normalizeStoredState(v2Data);
} else {
  const legacyData = lsLoadLegacy();
  if (legacyData && Object.keys(legacyData).length > 0) {
    cache = migrateLegacy(legacyData);
  }
}

let loaded = Object.keys(cache).length > 0;
let loading = false;
let idbAvailable = true; // flips to false on first IndexedDB failure
let saveTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();
const mutationRevisionByKey = new Map<string, number>();

function getMutationRevision(key: string): number {
  return mutationRevisionByKey.get(key) ?? 0;
}

function noteMutation(key: string): void {
  mutationRevisionByKey.set(key, getMutationRevision(key) + 1);
}

function readKey(identity: TaskDetailIdentity): string | null {
  const normalized = normalizeTaskDetailIdentity(identity);
  return isValidTaskDetailIdentity(normalized) ? taskDetailKey(normalized) : null;
}

function localLegacyKey(identity: TaskDetailIdentity): string | null {
  const normalized = normalizeTaskDetailIdentity(identity);
  if (normalized.contextId !== 'local') return null;
  return `${normalized.teamName}/${normalized.taskId}`;
}

function getEffectiveEntry(
  state: ReadState,
  identity: TaskDetailIdentity
): TaskReadEntry | undefined {
  const key = readKey(identity);
  if (!key) return undefined;
  const legacyKey = localLegacyKey(identity);
  return state[key] ?? (legacyKey ? state[legacyKey] : undefined);
}

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

/**
 * Mark specific comment IDs as read for a given team/task.
 */
export function markCommentsRead(
  identity: TaskDetailIdentity,
  commentIds: readonly string[]
): void {
  const key = readKey(identity);
  if (!key) return;
  const prev = getEffectiveEntry(cache, identity);
  if (commentIds.length === 0) {
    if (prev?.manualUnread) clearTaskManualUnread(identity);
    return;
  }
  const prevSet = new Set(prev?.readIds ?? []);
  let changed = false;
  for (const id of commentIds) {
    if (!prevSet.has(id)) {
      prevSet.add(id);
      changed = true;
    }
  }
  if (!changed && !prev?.manualUnread) return;
  noteMutation(key);
  cache = {
    ...cache,
    [key]: {
      readIds: Array.from(prevSet),
      lastUpdated: Date.now(),
    },
  };
  notify();
  scheduleSave();
}

/**
 * @deprecated Use markCommentsRead() instead. Kept for backward compatibility
 * with code that hasn't migrated yet (e.g. flush fallback).
 */
export function markAsRead(identity: TaskDetailIdentity, latestTimestamp: number): void {
  const key = readKey(identity);
  if (!key) return;
  const prev = getEffectiveEntry(cache, identity);
  // Update lastUpdated to at least this timestamp (for legacy migration support)
  const prevLastUpdated = prev?.lastUpdated ?? 0;
  if (latestTimestamp <= prevLastUpdated && prev && !prev.manualUnread) return;
  noteMutation(key);
  cache = {
    ...cache,
    [key]: {
      readIds: prev?.readIds ?? [],
      lastUpdated: Math.max(prevLastUpdated, latestTimestamp),
    },
  };
  notify();
  scheduleSave();
}

/**
 * Manually mark a task as unread even when it has no unread comments.
 */
export function markTaskUnread(identity: TaskDetailIdentity): void {
  const key = readKey(identity);
  if (!key) return;
  const prev = getEffectiveEntry(cache, identity);
  if (prev?.manualUnread) return;
  noteMutation(key);
  cache = {
    ...cache,
    [key]: {
      readIds: prev?.readIds ?? [],
      lastUpdated: Date.now(),
      manualUnread: true,
    },
  };
  notify();
  scheduleSave();
}

/**
 * Clear only the manual unread marker. Comment read state is preserved.
 */
export function clearTaskManualUnread(identity: TaskDetailIdentity): void {
  const key = readKey(identity);
  if (!key) return;
  const prev = getEffectiveEntry(cache, identity);
  if (!prev?.manualUnread) return;
  noteMutation(key);
  cache = {
    ...cache,
    [key]: {
      readIds: prev.readIds,
      lastUpdated: Date.now(),
    },
  };
  notify();
  scheduleSave();
}

/**
 * Count unread comments for a task.
 * A comment is unread if its ID is NOT in the readIds set.
 *
 * Legacy migration: when readIds is empty (data migrated from v1 timestamp
 * format), comments created at or before the legacy cutoff are treated as read.
 * Once any per-ID tracking starts (readIds non-empty), the cutoff is ignored
 * — only explicit IDs determine read state. This prevents `lastUpdated`
 * (which is refreshed by markCommentsRead on every save for stale-cleanup
 * purposes) from accidentally marking ALL comments as read.
 */
export function getUnreadCount(
  readState: ReadState,
  identity: TaskDetailIdentity,
  comments: { id?: string; createdAt: string }[]
): number {
  const entry = getEffectiveEntry(readState, identity);
  if (!comments || comments.length === 0) return entry?.manualUnread ? 1 : 0;
  if (!entry) return comments.length;

  const readSet = new Set(entry.readIds);
  // Only use the timestamp cutoff for pure-legacy entries (no per-ID tracking yet).
  // Once readIds is non-empty, per-ID tracking is authoritative and the timestamp
  // must NOT be used — it gets refreshed to Date.now() on every save.
  const legacyCutoff = readSet.size === 0 ? entry.lastUpdated : 0;

  let count = 0;
  for (const c of comments) {
    // If comment has an ID and it's in the read set → read
    if (c.id && readSet.has(c.id)) continue;
    // Legacy-only: comment created before/at the migration cutoff → read
    if (legacyCutoff > 0) {
      const ts = new Date(c.createdAt).getTime();
      if (ts <= legacyCutoff) continue;
    }
    // Otherwise → unread
    count++;
  }
  return entry.manualUnread && count === 0 ? 1 : count;
}

/**
 * Get the set of read comment IDs for a team/task pair.
 */
export function getReadCommentIds(identity: TaskDetailIdentity): Set<string> {
  const entry = getEffectiveEntry(cache, identity);
  return new Set(entry?.readIds ?? []);
}

/**
 * Get the legacy migration cutoff timestamp for a team/task pair (0 if none).
 * Returns non-zero only for pure-legacy entries where readIds is empty.
 * Once per-ID tracking has started (readIds non-empty), the cutoff is 0
 * because lastUpdated gets refreshed to Date.now() on every save and
 * would incorrectly mark all comments as read.
 */
export function getLegacyCutoff(identity: TaskDetailIdentity): number {
  const entry = getEffectiveEntry(cache, identity);
  if (!entry) return 0;
  // Only honour the timestamp when no per-ID tracking exists (pure legacy data).
  if (entry.readIds.length > 0) return 0;
  return entry.lastUpdated;
}

/** @deprecated Use getReadCommentIds() + getLegacyCutoff() instead. */
export function getLastReadTimestamp(identity: TaskDetailIdentity): number {
  return getEffectiveEntry(cache, identity)?.lastUpdated ?? 0;
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
  if (loaded || loading) return;
  loading = true;
  const loadStartedRevisionByKey = new Map(mutationRevisionByKey);

  if (hasIndexedDB() && idbAvailable) {
    try {
      // Try v2 format first
      const stored = await get<ReadState>(IDB_KEY);
      if (stored && typeof stored === 'object') {
        const merged = { ...cache };
        for (const [k, v] of Object.entries(normalizeStoredState(stored))) {
          if (!v || typeof v !== 'object') continue;
          if (getMutationRevision(k) !== (loadStartedRevisionByKey.get(k) ?? 0)) continue;
          const entry = v;
          const prev = merged[k];
          if (!prev) {
            merged[k] = entry;
          } else {
            // Merge: union of readIds, max lastUpdated
            const mergedIds = new Set([...prev.readIds, ...entry.readIds]);
            merged[k] = {
              readIds: Array.from(mergedIds),
              lastUpdated: Math.max(prev.lastUpdated, entry.lastUpdated),
              ...((prev.manualUnread ?? entry.manualUnread)
                ? { manualUnread: prev.manualUnread ?? entry.manualUnread }
                : {}),
            };
          }
        }
        cache = merged;
        notify();
      } else {
        // Try legacy IDB format
        const legacy = await get<LegacyReadState>(LEGACY_IDB_KEY);
        if (legacy && typeof legacy === 'object') {
          const migrated = migrateLegacy(legacy);
          const merged = { ...cache };
          for (const [k, v] of Object.entries(migrated)) {
            if (getMutationRevision(k) !== (loadStartedRevisionByKey.get(k) ?? 0)) continue;
            if (!merged[k]) {
              merged[k] = v;
            } else {
              merged[k] = {
                readIds: [...new Set([...merged[k].readIds, ...v.readIds])],
                lastUpdated: Math.max(merged[k].lastUpdated, v.lastUpdated),
                ...((merged[k].manualUnread ?? v.manualUnread)
                  ? { manualUnread: merged[k].manualUnread ?? v.manualUnread }
                  : {}),
              };
            }
          }
          cache = merged;
          notify();
        }
      }
    } catch {
      idbAvailable = false;
    }
  }

  loaded = true;
  loading = false;
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
  let changed = false;
  const result: ReadState = {};
  for (const [k, v] of Object.entries(cache)) {
    if (now - v.lastUpdated < STALE_THRESHOLD_MS) {
      result[k] = v;
    } else {
      changed = true;
    }
  }

  if (!changed) return;

  // Update in-memory cache
  cache = result;
  notify();

  // Persist to both storages
  lsSave(result);
  if (idbAvailable && hasIndexedDB()) {
    try {
      await set(IDB_KEY, result);
    } catch {
      idbAvailable = false;
    }
  }
}
