import { describe, expect, it } from 'vitest';

import {
  normalizePersistedTaskChangePresenceIndex,
  toPersistedTaskChangePresenceIndex,
} from '../../../../src/main/services/team/cache/taskChangePresenceCacheSchema';
import {
  LEGACY_TASK_CHANGE_PRESENCE_CACHE_SCHEMA_VERSION,
  TASK_CHANGE_PRESENCE_CACHE_SCHEMA_VERSION,
} from '../../../../src/main/services/team/cache/taskChangePresenceCacheTypes';

describe('taskChangePresenceCacheSchema', () => {
  it('dual-reads legacy v1 payloads and normalizes them to the current schema version', () => {
    const normalized = normalizePersistedTaskChangePresenceIndex({
      version: LEGACY_TASK_CHANGE_PRESENCE_CACHE_SCHEMA_VERSION,
      teamName: 'my-team',
      projectFingerprint: 'project-fingerprint',
      logSourceGeneration: 'log-generation',
      writtenAt: '2026-03-01T12:00:00.000Z',
      entries: {
        'task-1': {
          taskId: 'task-1',
          taskSignature: 'sig-1',
          presence: 'has_changes',
          writtenAt: '2026-03-01T12:00:00.000Z',
          logSourceGeneration: 'log-generation',
        },
      },
    });

    expect(normalized).toEqual({
      version: TASK_CHANGE_PRESENCE_CACHE_SCHEMA_VERSION,
      teamName: 'my-team',
      projectFingerprint: 'project-fingerprint',
      logSourceGeneration: 'log-generation',
      writtenAt: '2026-03-01T12:00:00.000Z',
      entries: {
        'task-1': {
          taskId: 'task-1',
          taskSignature: 'sig-1',
          presence: 'has_changes',
          writtenAt: '2026-03-01T12:00:00.000Z',
          logSourceGeneration: 'log-generation',
        },
      },
    });
  });

  it('preserves needs_attention when normalizing the current schema payload', () => {
    const normalized = normalizePersistedTaskChangePresenceIndex({
      version: TASK_CHANGE_PRESENCE_CACHE_SCHEMA_VERSION,
      teamName: 'my-team',
      projectFingerprint: 'project-fingerprint',
      logSourceGeneration: 'log-generation',
      writtenAt: '2026-03-01T12:00:00.000Z',
      entries: {
        'task-1': {
          taskId: 'task-1',
          taskSignature: 'sig-1',
          presence: 'needs_attention',
          writtenAt: '2026-03-01T12:00:00.000Z',
          logSourceGeneration: 'log-generation',
        },
      },
    });

    expect(normalized?.entries['task-1']?.presence).toBe('needs_attention');
  });

  it('serializes all new writes as schema version 2', () => {
    const serialized = toPersistedTaskChangePresenceIndex({
      version: TASK_CHANGE_PRESENCE_CACHE_SCHEMA_VERSION,
      teamName: 'my-team',
      projectFingerprint: 'project-fingerprint',
      logSourceGeneration: 'log-generation',
      writtenAt: '2026-03-01T12:00:00.000Z',
      entries: {
        'task-1': {
          taskId: 'task-1',
          taskSignature: 'sig-1',
          presence: 'needs_attention',
          writtenAt: '2026-03-01T12:00:00.000Z',
          logSourceGeneration: 'log-generation',
        },
      },
    });

    expect(serialized.version).toBe(TASK_CHANGE_PRESENCE_CACHE_SCHEMA_VERSION);
    expect(serialized.entries['task-1']?.presence).toBe('needs_attention');
  });
});
