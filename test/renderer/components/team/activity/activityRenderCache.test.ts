import { describe, expect, it } from 'vitest';

import {
  encodeCacheParts,
  stringArrayCacheSignature,
  stringMapCacheSignature,
  taskRefsCacheSignature,
} from '../../../../../src/renderer/components/team/activity/activityRenderCache';

import type { TaskRef } from '../../../../../src/shared/types';

describe('activityRenderCache', () => {
  it('encodes cache parts with length prefixes', () => {
    expect(encodeCacheParts(['a', 'bb', ''])).toBe('1:a|2:bb|0:');
  });

  it('builds stable task reference signatures', () => {
    const refs: TaskRef[] = [
      { taskId: 'task-1', displayId: '#1', teamName: 'team-a' },
      { taskId: 'task-2', displayId: '#2', teamName: '' },
    ];

    expect(taskRefsCacheSignature(refs)).toBe('6:task-1|2:#1|6:team-a|6:task-2|2:#2|0:');
    expect(taskRefsCacheSignature(refs)).toBe(taskRefsCacheSignature(refs));
  });

  it('builds stable string array signatures', () => {
    const values = ['alice', 'bob'];

    expect(stringArrayCacheSignature(values)).toBe('5:alice|3:bob');
    expect(stringArrayCacheSignature(values)).toBe(stringArrayCacheSignature(values));
  });

  it('sorts string map signatures by key', () => {
    const map = new Map([
      ['bob', 'blue'],
      ['alice', 'red'],
    ]);

    expect(stringMapCacheSignature(map)).toBe('5:alice|3:red|3:bob|4:blue');
    expect(stringMapCacheSignature(map)).toBe(stringMapCacheSignature(map));
  });
});
