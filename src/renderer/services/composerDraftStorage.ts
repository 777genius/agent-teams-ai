/**
 * Atomic draft storage for MessageComposer snapshots.
 *
 * Unlike `draftStorage.ts` (text-only with TTL), this stores a unified
 * snapshot of text + chips + attachments under a single key — no TTL.
 * Drafts persist until explicitly cleared (on send or manual action).
 */

import { del, get, set } from 'idb-keyval';

import type { InlineChip } from '@renderer/types/inlineChip';
import type { AgentActionMode, AttachmentPayload } from '@shared/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Current snapshot schema version. Bump when shape changes. */
const SNAPSHOT_VERSION = 1;

export interface ComposerDraftSnapshot {
  version: number;
  teamName: string;
  text: string;
  chips: InlineChip[];
  attachments: AttachmentPayload[];
  actionMode?: AgentActionMode;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Key helpers
// ---------------------------------------------------------------------------

const KEY_PREFIX = 'composer:';

function storageKey(teamName: string): string {
  return `${KEY_PREFIX}${teamName}`;
}

/** Legacy keys used by the old three-key approach. */
function legacyKeys(teamName: string): { text: string; chips: string; attachments: string } {
  return {
    text: `draft:compose:${teamName}`,
    chips: `draft:compose:${teamName}:chips`,
    attachments: `draft:compose:${teamName}:attachments`,
  } as const;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isValidSnapshot(data: unknown): data is ComposerDraftSnapshot {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  return (
    typeof obj.version === 'number' &&
    typeof obj.teamName === 'string' &&
    typeof obj.text === 'string' &&
    Array.isArray(obj.chips) &&
    Array.isArray(obj.attachments) &&
    typeof obj.updatedAt === 'number'
  );
}

// ---------------------------------------------------------------------------
// IDB availability tracking (same pattern as draftStorage.ts)
// ---------------------------------------------------------------------------

let idbUnavailable = false;
let idbUnavailableLogged = false;
const fallbackStore = new Map<string, ComposerDraftSnapshot>();

function markIdbUnavailable(): void {
  if (!idbUnavailableLogged) {
    idbUnavailableLogged = true;
    console.warn(
      '[composerDraftStorage] IndexedDB unavailable, using in-memory storage for this session.'
    );
  }
  idbUnavailable = true;
}

// ---------------------------------------------------------------------------
// Core API
// ---------------------------------------------------------------------------

async function saveSnapshot(teamName: string, snapshot: ComposerDraftSnapshot): Promise<void> {
  const key = storageKey(teamName);
  if (idbUnavailable) {
    fallbackStore.set(key, snapshot);
    return;
  }
  try {
    await set(key, snapshot);
  } catch {
    markIdbUnavailable();
    fallbackStore.set(key, snapshot);
  }
}

async function loadSnapshot(teamName: string): Promise<ComposerDraftSnapshot | null> {
  const key = storageKey(teamName);
  if (idbUnavailable) {
    return fallbackStore.get(key) ?? null;
  }
  try {
    const data = await get<unknown>(key);
    if (data == null) return null;
    if (isValidSnapshot(data)) return data;
    // Invalid shape — discard silently
    void del(key);
    return null;
  } catch {
    markIdbUnavailable();
    return fallbackStore.get(key) ?? null;
  }
}

async function deleteSnapshot(teamName: string): Promise<void> {
  const key = storageKey(teamName);
  if (idbUnavailable) {
    fallbackStore.delete(key);
    return;
  }
  try {
    await del(key);
  } catch {
    markIdbUnavailable();
    fallbackStore.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Legacy migration
// ---------------------------------------------------------------------------

interface LegacyTextDraft {
  value: string;
  timestamp: number;
}

function isLegacyTextDraft(d: unknown): d is LegacyTextDraft {
  if (typeof d !== 'object' || d === null) return false;
  const obj = d as Record<string, unknown>;
  return typeof obj.value === 'string' && typeof obj.timestamp === 'number';
}

function isValidChipArray(data: unknown): data is InlineChip[] {
  if (!Array.isArray(data)) return false;
  return data.every((raw) => {
    if (typeof raw !== 'object' || raw === null) return false;
    const item = raw as Record<string, unknown>;
    return typeof item.id === 'string' && typeof item.filePath === 'string';
  });
}

function isValidAttachmentArray(data: unknown): data is AttachmentPayload[] {
  if (!Array.isArray(data)) return false;
  return data.every((raw) => {
    if (typeof raw !== 'object' || raw === null) return false;
    const item = raw as Record<string, unknown>;
    return (
      typeof item.id === 'string' &&
      typeof item.filename === 'string' &&
      typeof item.data === 'string'
    );
  });
}

/**
 * Attempts to migrate legacy three-key drafts into a unified snapshot.
 * Returns the migrated snapshot or null if no legacy data found.
 * Deletes legacy keys on success.
 */
async function migrateLegacy(teamName: string): Promise<ComposerDraftSnapshot | null> {
  if (idbUnavailable) return null;

  const keys = legacyKeys(teamName);

  try {
    const [rawText, rawChips, rawAttachments] = await Promise.all([
      get<unknown>(keys.text),
      get<unknown>(keys.chips),
      get<unknown>(keys.attachments),
    ]);

    // Nothing to migrate
    if (rawText == null && rawChips == null && rawAttachments == null) return null;

    let text = '';
    if (isLegacyTextDraft(rawText)) {
      text = rawText.value;
    }

    let chips: InlineChip[] = [];
    if (rawChips != null) {
      const chipsData = typeof rawChips === 'string' ? (JSON.parse(rawChips) as unknown) : rawChips;
      // Legacy text draft wraps value in {value, timestamp}
      const unwrapped = isLegacyTextDraft(chipsData) ? chipsData.value : chipsData;
      const toParse =
        typeof unwrapped === 'string' ? (JSON.parse(unwrapped) as unknown) : unwrapped;
      if (isValidChipArray(toParse)) chips = toParse;
    }

    let attachments: AttachmentPayload[] = [];
    if (rawAttachments != null) {
      const attData =
        typeof rawAttachments === 'string'
          ? (JSON.parse(rawAttachments) as unknown)
          : rawAttachments;
      const unwrapped = isLegacyTextDraft(attData) ? attData.value : attData;
      const toParse =
        typeof unwrapped === 'string' ? (JSON.parse(unwrapped) as unknown) : unwrapped;
      if (isValidAttachmentArray(toParse)) attachments = toParse;
    }

    // Only create snapshot if there's actual content
    if (text.length === 0 && chips.length === 0 && attachments.length === 0) {
      // Clean up empty legacy keys
      await Promise.all([del(keys.text), del(keys.chips), del(keys.attachments)]);
      return null;
    }

    const snapshot: ComposerDraftSnapshot = {
      version: SNAPSHOT_VERSION,
      teamName,
      text,
      chips,
      attachments,
      updatedAt: Date.now(),
    };

    // Save new snapshot and delete legacy keys atomically-ish
    await saveSnapshot(teamName, snapshot);
    await Promise.all([del(keys.text), del(keys.chips), del(keys.attachments)]);

    return snapshot;
  } catch {
    // Migration is best-effort — don't block the composer
    return null;
  }
}

// ---------------------------------------------------------------------------
// Factory for empty snapshot
// ---------------------------------------------------------------------------

function emptySnapshot(teamName: string): ComposerDraftSnapshot {
  return {
    version: SNAPSHOT_VERSION,
    teamName,
    text: '',
    chips: [],
    attachments: [],
    updatedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const composerDraftStorage = {
  saveSnapshot,
  loadSnapshot,
  deleteSnapshot,
  migrateLegacy,
  emptySnapshot,
};
