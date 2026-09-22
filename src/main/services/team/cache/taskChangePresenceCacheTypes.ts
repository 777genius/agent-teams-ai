import type { TaskChangePresenceState } from '@shared/types/team';

export const LEGACY_TASK_CHANGE_PRESENCE_CACHE_SCHEMA_VERSION = 1;
export const TASK_CHANGE_PRESENCE_CACHE_SCHEMA_VERSION = 2;

export type PersistedTaskChangePresence = Exclude<TaskChangePresenceState, 'unknown'>;

export interface PersistedTaskChangePresenceEntry {
  taskId: string;
  taskSignature: string;
  presence: PersistedTaskChangePresence;
  writtenAt: string;
  logSourceGeneration: string;
}

export interface PersistedTaskChangePresenceIndex {
  version: typeof TASK_CHANGE_PRESENCE_CACHE_SCHEMA_VERSION;
  teamName: string;
  projectFingerprint: string;
  logSourceGeneration: string;
  writtenAt: string;
  entries: Record<string, PersistedTaskChangePresenceEntry>;
}
