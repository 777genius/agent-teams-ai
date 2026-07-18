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
      { filePath: '/repo/file.ts', kind: 'update' },
      { filePath: '/repo/new.ts', kind: 'create' },
      { filePath: '/repo/old.ts', kind: 'delete' },
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
      { filePath: '/repo/renamed.ts', kind: 'rename' },
    ]);
  });
});
