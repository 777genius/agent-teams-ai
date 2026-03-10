import { describe, expect, it } from 'vitest';

import { taskMatchesStatus } from '../../../../src/renderer/components/sidebar/taskFiltersState';

describe('taskFiltersState', () => {
  it('treats needsFix as distinct from normal todo/done buckets', () => {
    const pendingNeedsFixTask = { status: 'pending', reviewState: 'needsFix' as const };
    const completedNeedsFixTask = { status: 'completed', reviewState: 'needsFix' as const };
    const normalPendingTask = { status: 'pending', reviewState: 'none' as const };

    expect(taskMatchesStatus(pendingNeedsFixTask, new Set(['needs_fix']))).toBe(true);
    expect(taskMatchesStatus(completedNeedsFixTask, new Set(['needs_fix']))).toBe(true);
    expect(taskMatchesStatus(pendingNeedsFixTask, new Set(['todo']))).toBe(false);
    expect(taskMatchesStatus(completedNeedsFixTask, new Set(['done']))).toBe(false);
    expect(taskMatchesStatus(normalPendingTask, new Set(['todo']))).toBe(true);
  });
});
