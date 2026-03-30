import {
  type PersistedTaskChangePresence,
  type PersistedTaskChangePresenceEntry,
  type PersistedTaskChangePresenceIndex,
  TASK_CHANGE_PRESENCE_CACHE_SCHEMA_VERSION,
} from './taskChangePresenceCacheTypes';

function isIsoString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && Number.isFinite(Date.parse(value));
}

function normalizePresence(value: unknown): PersistedTaskChangePresence | null {
  return value === 'has_changes' || value === 'no_changes' ? value : null;
}

function normalizeEntry(taskId: string, value: unknown): PersistedTaskChangePresenceEntry | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const raw = value as Record<string, unknown>;
  const normalizedPresence = normalizePresence(raw.presence);
  if (
    typeof raw.taskSignature !== 'string' ||
    !normalizedPresence ||
    !isIsoString(raw.writtenAt) ||
    typeof raw.logSourceGeneration !== 'string' ||
    raw.logSourceGeneration.length === 0
  ) {
    return null;
  }

  return {
    taskId,
    taskSignature: raw.taskSignature,
    presence: normalizedPresence,
    writtenAt: raw.writtenAt,
    logSourceGeneration: raw.logSourceGeneration,
  };
}

export function normalizePersistedTaskChangePresenceIndex(
  value: unknown
): PersistedTaskChangePresenceIndex | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const raw = value as Record<string, unknown>;
  if (
    raw.version !== TASK_CHANGE_PRESENCE_CACHE_SCHEMA_VERSION ||
    typeof raw.teamName !== 'string' ||
    typeof raw.projectFingerprint !== 'string' ||
    raw.projectFingerprint.length === 0 ||
    typeof raw.logSourceGeneration !== 'string' ||
    raw.logSourceGeneration.length === 0 ||
    !isIsoString(raw.writtenAt) ||
    !raw.entries ||
    typeof raw.entries !== 'object'
  ) {
    return null;
  }

  const normalizedEntries: Record<string, PersistedTaskChangePresenceEntry> = {};
  for (const [taskId, entryValue] of Object.entries(raw.entries as Record<string, unknown>)) {
    if (typeof taskId !== 'string' || taskId.length === 0) {
      continue;
    }
    const normalized = normalizeEntry(taskId, entryValue);
    if (normalized) {
      normalizedEntries[taskId] = normalized;
    }
  }

  return {
    version: TASK_CHANGE_PRESENCE_CACHE_SCHEMA_VERSION,
    teamName: raw.teamName,
    projectFingerprint: raw.projectFingerprint,
    logSourceGeneration: raw.logSourceGeneration,
    writtenAt: raw.writtenAt,
    entries: normalizedEntries,
  };
}

export function toPersistedTaskChangePresenceIndex(
  value: PersistedTaskChangePresenceIndex
): PersistedTaskChangePresenceIndex {
  return {
    version: TASK_CHANGE_PRESENCE_CACHE_SCHEMA_VERSION,
    teamName: value.teamName,
    projectFingerprint: value.projectFingerprint,
    logSourceGeneration: value.logSourceGeneration,
    writtenAt: value.writtenAt,
    entries: Object.fromEntries(
      Object.entries(value.entries).map(([taskId, entry]) => [
        taskId,
        {
          taskId,
          taskSignature: entry.taskSignature,
          presence: entry.presence,
          writtenAt: entry.writtenAt,
          logSourceGeneration: entry.logSourceGeneration,
        },
      ])
    ),
  };
}
