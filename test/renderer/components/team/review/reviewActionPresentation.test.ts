import {
  describeReviewAction,
  getReviewActionFilePath,
  takeRecentReviewActions,
} from '@renderer/components/team/review/reviewActionPresentation';
import { describe, expect, it } from 'vitest';

import type { ReviewUndoAction } from '@shared/types';

function hunkAction(id: string, index: number): ReviewUndoAction {
  return {
    id,
    createdAt: `2026-07-18T12:00:${String(index).padStart(2, '0')}.000Z`,
    kind: 'hunk',
    action: { filePath: '/repo/src/file.ts', originalIndex: index },
  };
}

describe('review action presentation', () => {
  it('describes exact persisted hunk, file, and bulk intents', () => {
    expect(
      describeReviewAction({
        ...hunkAction('accept-hunk', 2),
        descriptor: {
          intent: 'accept-hunk',
          filePath: '/repo/src/file.ts',
          hunkIndex: 2,
        },
      })
    ).toEqual({ title: 'Accept hunk', detail: '/repo/src/file.ts · hunk 3', tone: 'accept' });

    expect(
      describeReviewAction({
        id: 'reject-file',
        createdAt: '2026-07-18T12:00:00.000Z',
        kind: 'disk',
        descriptor: { intent: 'reject-file', filePath: 'C:\\repo\\src\\other.ts' },
        action: {
          snapshot: {
            filePath: 'C:\\repo\\src\\other.ts',
            beforeContent: 'agent',
            afterContent: 'original',
          },
        },
      })
    ).toEqual({
      title: 'Reject file',
      detail: 'C:\\repo\\src\\other.ts',
      tone: 'reject',
    });

    expect(
      describeReviewAction({
        id: 'accept-all',
        createdAt: '2026-07-18T12:00:00.000Z',
        kind: 'bulk',
        descriptor: { intent: 'accept-all', fileCount: 4 },
        decisionSnapshot: { hunkDecisions: {}, fileDecisions: {} },
        diskSnapshots: [],
      })
    ).toEqual({ title: 'Accept all', detail: '4 files', tone: 'accept' });
  });

  it('keeps legacy history understandable without claiming an unknown intent', () => {
    expect(describeReviewAction(hunkAction('legacy', 0))).toEqual({
      title: 'Review hunk',
      detail: '/repo/src/file.ts · hunk 1',
      tone: 'neutral',
    });
  });

  it('uses review-relative paths so duplicate basenames stay distinguishable', () => {
    const left: ReviewUndoAction = {
      id: 'left',
      createdAt: '2026-07-18T12:00:00.000Z',
      kind: 'hunk',
      descriptor: {
        intent: 'accept-hunk' as const,
        filePath: '/repo/src/a/index.ts',
        hunkIndex: 0,
      },
      action: { filePath: '/repo/src/a/index.ts', originalIndex: 0 },
    };
    const right: ReviewUndoAction = {
      id: 'right',
      createdAt: '2026-07-18T12:00:00.000Z',
      kind: 'hunk',
      descriptor: {
        intent: 'accept-hunk' as const,
        filePath: '/repo/src/b/index.ts',
        hunkIndex: 0,
      },
      action: { filePath: '/repo/src/b/index.ts', originalIndex: 0 },
    };
    const labels = new Map([
      ['/repo/src/a/index.ts', 'src/a/index.ts'],
      ['/repo/src/b/index.ts', 'src/b/index.ts'],
    ]);
    const resolveLabel = (filePath: string): string => labels.get(filePath) ?? filePath;

    expect(describeReviewAction(left, resolveLabel).detail).toBe('src/a/index.ts · hunk 1');
    expect(describeReviewAction(right, resolveLabel).detail).toBe('src/b/index.ts · hunk 1');
  });

  it('resolves a navigable file for current and legacy actions without guessing bulk targets', () => {
    expect(
      getReviewActionFilePath({
        ...hunkAction('described', 2),
        descriptor: {
          intent: 'accept-hunk',
          filePath: '/repo/described.ts',
          hunkIndex: 2,
        },
      })
    ).toBe('/repo/described.ts');
    expect(getReviewActionFilePath(hunkAction('legacy', 0))).toBe('/repo/src/file.ts');
    expect(
      getReviewActionFilePath({
        id: 'bulk',
        createdAt: '2026-07-18T12:00:00.000Z',
        kind: 'bulk',
        descriptor: { intent: 'reject-all', fileCount: 2 },
        decisionSnapshot: { hunkDecisions: {}, fileDecisions: {} },
        diskSnapshots: [
          { filePath: '/repo/a.ts', beforeContent: 'a', afterContent: 'A' },
          { filePath: '/repo/b.ts', beforeContent: 'b', afterContent: 'B' },
        ],
      })
    ).toBeNull();
  });

  it('returns the stack top first without cloning an unbounded history', () => {
    const actions = Array.from({ length: 100 }, (_, index) => hunkAction(`action-${index}`, index));
    expect(takeRecentReviewActions(actions, 3).map((action) => action.id)).toEqual([
      'action-99',
      'action-98',
      'action-97',
    ]);
    expect(takeRecentReviewActions(actions, 0)).toEqual([]);
  });
});
