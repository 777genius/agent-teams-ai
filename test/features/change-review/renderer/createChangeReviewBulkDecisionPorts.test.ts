import {
  createChangeReviewBulkDecisionCommandPort,
  createChangeReviewBulkDecisionStatePort,
} from '@features/change-review/renderer';
import { describe, expect, it, vi } from 'vitest';

import type { ApplyReviewResult, ReviewDecisionSnapshot } from '@shared/types';

function createStore() {
  return {
    editedContents: {},
    hunkDecisions: {},
    fileDecisions: {},
    changeSetEpoch: 1,
    acceptAllFile: vi.fn(() => true),
    rejectAllFile: vi.fn(),
    invalidateResolvedFileContent: vi.fn(),
    applyReview: vi.fn().mockResolvedValue({
      applied: 1,
      skipped: 0,
      conflicts: 0,
      errors: [],
    } satisfies ApplyReviewResult),
    fetchFileContent: vi.fn().mockResolvedValue(undefined),
  };
}

describe('change-review bulk decision ports', () => {
  it('maps state mutations without exposing the whole store to the controller', () => {
    const store = createStore();
    const restoreDecisionSnapshot = vi.fn<(snapshot: ReviewDecisionSnapshot) => void>();
    const port = createChangeReviewBulkDecisionStatePort({
      getStore: () => store,
      restoreDecisionSnapshot,
    });

    expect(port.acceptAllFile('/repo/file.ts')).toBe(true);
    port.rejectAllFile('/repo/file.ts');
    port.invalidateResolvedFileContent('/repo/file.ts');
    port.restoreDecisionSnapshot({ hunkDecisions: {}, fileDecisions: {} });

    expect(store.acceptAllFile).toHaveBeenCalledWith('/repo/file.ts');
    expect(store.rejectAllFile).toHaveBeenCalledWith('/repo/file.ts');
    expect(store.invalidateResolvedFileContent).toHaveBeenCalledWith('/repo/file.ts');
    expect(restoreDecisionSnapshot).toHaveBeenCalledTimes(1);
  });

  it('maps store commands and the injected disk reader', async () => {
    const store = createStore();
    const readCurrentDiskContent = vi.fn().mockResolvedValue('disk');
    const port = createChangeReviewBulkDecisionCommandPort({
      getStore: () => store,
      readCurrentDiskContent,
    });

    await expect(port.applyReview('team', 'task', undefined)).resolves.toMatchObject({
      applied: 1,
    });
    port.fetchFileContent('team', undefined, '/repo/file.ts');
    await expect(port.readCurrentDiskContent('/repo/file.ts', 'fallback')).resolves.toBe('disk');

    expect(store.applyReview).toHaveBeenCalledWith('team', 'task', undefined);
    expect(store.fetchFileContent).toHaveBeenCalledWith('team', undefined, '/repo/file.ts');
    expect(readCurrentDiskContent).toHaveBeenCalledWith('/repo/file.ts', 'fallback');
  });
});
