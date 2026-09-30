import {
  createChangeReviewHunkDecisionCommandPort,
  createChangeReviewHunkDecisionStatePort,
} from '@features/change-review/renderer';
import { describe, expect, it, vi } from 'vitest';

function createStore() {
  return {
    hunkDecisions: { '/repo/file.ts:0': 'pending' as const },
    fileDecisions: {},
    fileChunkCounts: { '/repo/file.ts': 1 },
    changeSetEpoch: 3,
    setHunkDecision: vi.fn(() => 4),
    clearHunkDecisionByOriginalIndex: vi.fn(),
    invalidateResolvedFileContent: vi.fn(),
    applySingleFileDecision: vi.fn().mockResolvedValue(null),
    fetchFileContent: vi.fn().mockResolvedValue(undefined),
  };
}

describe('change-review hunk decision ports', () => {
  it('maps only the decision state required by the controller', () => {
    const store = createStore();
    const port = createChangeReviewHunkDecisionStatePort(() => store);

    expect(port.getSnapshot()).toEqual({
      hunkDecisions: { '/repo/file.ts:0': 'pending' },
      fileDecisions: {},
      fileChunkCounts: { '/repo/file.ts': 1 },
      changeSetEpoch: 3,
    });
    expect(port.getSnapshot()).not.toHaveProperty('applySingleFileDecision');

    expect(port.setDecision('/repo/file.ts', 2, 'rejected')).toBe(4);
    port.clearDecision('/repo/file.ts', 4);
    port.invalidateResolvedFileContent('/repo/file.ts');

    expect(store.setHunkDecision).toHaveBeenCalledWith('/repo/file.ts', 2, 'rejected');
    expect(store.clearHunkDecisionByOriginalIndex).toHaveBeenCalledWith('/repo/file.ts', 4);
    expect(store.invalidateResolvedFileContent).toHaveBeenCalledWith('/repo/file.ts');
  });

  it('maps mutation commands without exposing the store', async () => {
    const store = createStore();
    store.applySingleFileDecision
      .mockResolvedValueOnce({
        applied: 1,
        skipped: 0,
        conflicts: 0,
        errors: [],
      })
      .mockResolvedValueOnce({
        applied: 0,
        skipped: 1,
        conflicts: 1,
        errors: [{ filePath: '/repo/old-name.ts', error: 'changed' }],
      });
    const readCurrentDiskContent = vi.fn().mockResolvedValue('disk');
    const port = createChangeReviewHunkDecisionCommandPort({
      getStore: () => store,
      readCurrentDiskContent,
    });

    await expect(
      port.applySingleFileDecision('team', '/repo/file.ts', 'task', 'alice')
    ).resolves.toMatchObject({
      status: 'applied',
      result: { applied: 1 },
    });
    await expect(
      port.applySingleFileDecision('team', '/repo/file.ts', 'task', 'alice')
    ).resolves.toMatchObject({
      status: 'failed',
      result: { conflicts: 1 },
    });
    await expect(
      port.applySingleFileDecision('team', '/repo/file.ts', 'task', 'alice')
    ).resolves.toEqual({
      status: 'failed',
      result: null,
    });
    port.fetchFileContent('team', 'alice', '/repo/file.ts');
    await expect(port.readCurrentDiskContent('/repo/file.ts', 'fallback')).resolves.toBe('disk');

    expect(store.applySingleFileDecision).toHaveBeenNthCalledWith(
      1,
      'team',
      '/repo/file.ts',
      'task',
      'alice'
    );
    expect(store.fetchFileContent).toHaveBeenCalledWith('team', 'alice', '/repo/file.ts');
    expect(readCurrentDiskContent).toHaveBeenCalledWith('/repo/file.ts', 'fallback');
  });
});
