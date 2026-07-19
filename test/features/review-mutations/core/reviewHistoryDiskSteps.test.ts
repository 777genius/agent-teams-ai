import {
  buildReviewHistoryRestoreDiskImpact,
  buildReviewHistoryRestoreDiskSteps,
} from '@features/review-mutations';
import { describe, expect, it } from 'vitest';

import type { ReviewUndoAction } from '@shared/types';

function diskAction(
  id: string,
  beforeContent: string,
  afterContent: string | null,
  filePath = '/repo/file.ts',
  restoreMode?: 'create-file' | 'delete-file'
): ReviewUndoAction {
  return {
    id,
    createdAt: '2026-07-18T08:00:00.000Z',
    kind: 'disk',
    action: {
      snapshot: { filePath, beforeContent, afterContent, restoreMode },
    },
  };
}

describe('buildReviewHistoryRestoreDiskSteps', () => {
  it('coalesces consecutive same-file Undo transitions into one current-to-target CAS', () => {
    expect(
      buildReviewHistoryRestoreDiskSteps([
        { direction: 'undo', action: diskAction('newest', 'state-2', 'state-3') },
        { direction: 'undo', action: diskAction('older', 'state-1', 'state-2') },
      ])
    ).toEqual([
      {
        id: 'history-restore:0',
        type: 'write',
        filePath: '/repo/file.ts',
        expectedContent: 'state-3',
        content: 'state-1',
      },
    ]);
  });

  it('coalesces Redo in forward order and removes a net no-op', () => {
    expect(
      buildReviewHistoryRestoreDiskSteps([
        { direction: 'redo', action: diskAction('older', 'state-1', 'state-2') },
        { direction: 'redo', action: diskAction('newest', 'state-2', 'state-3') },
      ])
    ).toEqual([expect.objectContaining({ expectedContent: 'state-1', content: 'state-3' })]);
    expect(
      buildReviewHistoryRestoreDiskSteps([
        { direction: 'undo', action: diskAction('undo', 'same', 'changed') },
        { direction: 'redo', action: diskAction('redo', 'same', 'changed') },
      ])
    ).toEqual([]);

    expect(
      buildReviewHistoryRestoreDiskImpact([
        {
          direction: 'redo',
          action: diskAction('older', 'a\nb\nc\n', 'a\ny\nc\n'),
        },
        {
          direction: 'redo',
          action: diskAction('newest', 'a\ny\nc\n', 'a\nx\n'),
        },
      ])
    ).toEqual([
      expect.objectContaining({
        lineStatsStatus: 'exact',
        linesAdded: 1,
        linesRemoved: 2,
      }),
    ]);
  });

  it('fails closed for a broken chain and for Rename combined with another disk action', () => {
    expect(() =>
      buildReviewHistoryRestoreDiskSteps([
        { direction: 'undo', action: diskAction('newest', 'state-2', 'state-3') },
        { direction: 'undo', action: diskAction('broken', 'state-0', 'state-1') },
      ])
    ).toThrow('do not form one continuous transition');
    const rename: ReviewUndoAction = {
      id: 'rename',
      createdAt: '2026-07-18T08:00:00.000Z',
      kind: 'disk',
      action: {
        snapshot: {
          filePath: '/repo/renamed.ts',
          beforeContent: '',
          afterContent: null,
          restoreMode: 'restore-rejected-rename',
          renameExpectation: {
            eventId: 'event',
            beforeHash: null,
            afterHash: 'after',
            relation: { kind: 'rename', oldPath: '/repo/original.ts', newPath: '/repo/renamed.ts' },
          },
        },
      },
    };
    expect(() =>
      buildReviewHistoryRestoreDiskSteps([
        { direction: 'undo', action: rename },
        { direction: 'undo', action: diskAction('other', 'a', 'b', '/repo/other.ts') },
      ])
    ).toThrow('combine Rename with other disk changes');
  });

  it('summarizes the exact coalesced create, update, delete, and rename impact', () => {
    expect(
      buildReviewHistoryRestoreDiskImpact([
        { direction: 'undo', action: diskAction('update', 'before', 'after') },
        {
          direction: 'undo',
          action: diskAction('create', 'created', null, '/repo/new.ts', 'create-file'),
        },
        {
          direction: 'redo',
          action: diskAction('delete', 'removed', null, '/repo/old.ts', 'create-file'),
        },
      ])
    ).toEqual([
      {
        filePath: '/repo/file.ts',
        kind: 'update',
        lineStatsStatus: 'exact',
        linesAdded: 1,
        linesRemoved: 1,
      },
      {
        filePath: '/repo/new.ts',
        kind: 'create',
        lineStatsStatus: 'exact',
        linesAdded: 1,
        linesRemoved: 0,
      },
      {
        filePath: '/repo/old.ts',
        kind: 'delete',
        lineStatsStatus: 'exact',
        linesAdded: 0,
        linesRemoved: 1,
      },
    ]);

    const rename: ReviewUndoAction = {
      id: 'rename',
      createdAt: '2026-07-18T08:00:00.000Z',
      kind: 'disk',
      action: {
        snapshot: {
          filePath: '/repo/renamed.ts',
          beforeContent: '',
          afterContent: null,
          restoreMode: 'restore-rejected-rename',
          renameExpectation: {
            eventId: 'event',
            beforeHash: null,
            afterHash: 'after',
            relation: {
              kind: 'rename',
              oldPath: '/repo/original.ts',
              newPath: '/repo/renamed.ts',
            },
          },
        },
      },
    };
    expect(buildReviewHistoryRestoreDiskImpact([{ direction: 'undo', action: rename }])).toEqual([
      {
        filePath: '/repo/renamed.ts',
        kind: 'rename',
        lineStatsStatus: 'unavailable-rename',
      },
    ]);
  });

  it('bounds synchronous line stats without approximating large or hidden transitions', () => {
    const transitions = buildReviewHistoryRestoreDiskImpact(
      Array.from({ length: 6 }, (_, index) => ({
        direction: 'undo' as const,
        action: diskAction(
          `action-${index}`,
          `before-${index}`,
          `after-${index}`,
          `/repo/${index}.ts`
        ),
      }))
    );
    expect(
      transitions.slice(0, 5).every((transition) => transition.lineStatsStatus === 'exact')
    ).toBe(true);
    expect(transitions[5]).toEqual(
      expect.objectContaining({ lineStatsStatus: 'omitted-display-limit' })
    );

    const halfMegabyte = 'a'.repeat(256 * 1024 + 1);
    const largeImpact = buildReviewHistoryRestoreDiskImpact([
      {
        direction: 'undo',
        action: diskAction('large', halfMegabyte, `b${halfMegabyte}`),
      },
    ]);
    expect(largeImpact).toEqual([
      expect.objectContaining({
        kind: 'update',
        lineStatsStatus: 'omitted-large-update',
      }),
    ]);
    expect(largeImpact[0]).not.toHaveProperty('linesAdded');
    expect(largeImpact[0]).not.toHaveProperty('linesRemoved');
  });
});
