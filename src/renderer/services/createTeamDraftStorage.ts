/**
 * Atomic draft storage for CreateTeamDialog form snapshots.
 *
 * Stores the full form state (team name, members, paths, flags) under a single
 * IndexedDB key so that navigating away from the Teams tab and back preserves
 * user input.  No TTL — drafts persist until explicitly cleared on successful
 * team creation.
 *
 * Pattern mirrors `composerDraftStorage.ts`.
 */

import { del, get, set } from 'idb-keyval';

import { isTeamEffortLevel } from '@shared/utils/effortLevels';

import type { EffortLevel } from '@shared/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Current snapshot schema version. Bump when shape changes. */
const SNAPSHOT_VERSION = 1;

/** Serializable subset of MemberDraft — excludes transient `workflowChips`. */
export interface SerializedMemberDraft {
  id: string;
  name: string;
  roleSelection: string;
  customRole: string;
  workflow?: string;
  providerId?: 'anthropic' | 'codex' | 'gemini';
  model?: string;
  effort?: EffortLevel;
}

export interface CreateTeamDraftSnapshot {
  version: number;
  teamName: string;
  members: SerializedMemberDraft[];
  syncModelsWithLead?: boolean;
  cwdMode: 'project' | 'custom';
  selectedProjectPath: string;
  customCwd: string;
  soloTeam: boolean;
  launchTeam: boolean;
  teamColor: string;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Key
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'createTeamDraft:form';

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isValidMember(m: unknown): m is SerializedMemberDraft {
  if (typeof m !== 'object' || m === null) return false;
  const obj = m as Record<string, unknown>;
  return (
    typeof obj.id === 'string' &&
    typeof obj.name === 'string' &&
    typeof obj.roleSelection === 'string' &&
    typeof obj.customRole === 'string' &&
    (obj.providerId === undefined ||
      obj.providerId === 'anthropic' ||
      obj.providerId === 'codex' ||
      obj.providerId === 'gemini') &&
    (obj.model === undefined || typeof obj.model === 'string') &&
    (obj.effort === undefined || isTeamEffortLevel(obj.effort))
  );
}

function isValidSnapshot(data: unknown): data is CreateTeamDraftSnapshot {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  return (
    typeof obj.version === 'number' &&
    obj.version === SNAPSHOT_VERSION &&
    typeof obj.teamName === 'string' &&
    Array.isArray(obj.members) &&
    obj.members.every(isValidMember) &&
    (obj.syncModelsWithLead === undefined || typeof obj.syncModelsWithLead === 'boolean') &&
    (obj.cwdMode === 'project' || obj.cwdMode === 'custom') &&
    typeof obj.selectedProjectPath === 'string' &&
    typeof obj.customCwd === 'string' &&
    typeof obj.soloTeam === 'boolean' &&
    typeof obj.launchTeam === 'boolean' &&
    typeof obj.teamColor === 'string' &&
    typeof obj.updatedAt === 'number'
  );
}

// ---------------------------------------------------------------------------
// IDB availability tracking
// ---------------------------------------------------------------------------

let idbUnavailable = false;
let idbUnavailableLogged = false;
const fallbackStore = new Map<string, CreateTeamDraftSnapshot>();

function markIdbUnavailable(): void {
  if (!idbUnavailableLogged) {
    idbUnavailableLogged = true;
    console.warn(
      '[createTeamDraftStorage] IndexedDB unavailable, using in-memory storage for this session.'
    );
  }
  idbUnavailable = true;
}

// ---------------------------------------------------------------------------
// Core API
// ---------------------------------------------------------------------------

async function saveSnapshot(snapshot: CreateTeamDraftSnapshot): Promise<void> {
  if (idbUnavailable) {
    fallbackStore.set(STORAGE_KEY, snapshot);
    return;
  }
  try {
    await set(STORAGE_KEY, snapshot);
  } catch {
    markIdbUnavailable();
    fallbackStore.set(STORAGE_KEY, snapshot);
  }
}

async function loadSnapshot(): Promise<CreateTeamDraftSnapshot | null> {
  if (idbUnavailable) {
    return fallbackStore.get(STORAGE_KEY) ?? null;
  }
  try {
    const data = await get<unknown>(STORAGE_KEY);
    if (data == null) return null;
    if (isValidSnapshot(data)) return data;
    // Invalid shape — discard silently
    void del(STORAGE_KEY);
    return null;
  } catch {
    markIdbUnavailable();
    return fallbackStore.get(STORAGE_KEY) ?? null;
  }
}

async function deleteSnapshot(): Promise<void> {
  if (idbUnavailable) {
    fallbackStore.delete(STORAGE_KEY);
    return;
  }
  try {
    await del(STORAGE_KEY);
  } catch {
    markIdbUnavailable();
    fallbackStore.delete(STORAGE_KEY);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

function emptySnapshot(): CreateTeamDraftSnapshot {
  return {
    version: SNAPSHOT_VERSION,
    teamName: '',
    members: [],
    syncModelsWithLead: true,
    cwdMode: 'project',
    selectedProjectPath: '',
    customCwd: '',
    soloTeam: false,
    launchTeam: true,
    teamColor: '',
    updatedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const createTeamDraftStorage = {
  saveSnapshot,
  loadSnapshot,
  deleteSnapshot,
  emptySnapshot,
};
