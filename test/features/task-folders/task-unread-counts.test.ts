import { describe, expect, it } from 'vitest';

import {
  append,
  applyCommand,
  emptySnapshot,
} from '../../../src/features/task-folders/core/domain/folders';
import {
  projectFolders,
  ROOT,
  UNFILED,
} from '../../../src/features/task-folders/renderer/view-models/projection';
import { applyVisibleTaskChildren } from '../../../src/features/task-folders/renderer/view-models/projectionView';
import { countUnreadTasksByNode } from '../../../src/features/task-folders/renderer/view-models/taskUnreadCounts';
import { taskDetailKey } from '../../../src/features/team-task-detail/core';
import { getTaskUnreadCount } from '../../../src/renderer/components/sidebar/taskFiltersState';

import type { getSnapshot } from '../../../src/renderer/services/commentReadStorage';
import type { GlobalTask, TaskComment } from '../../../src/shared/types';

const contextId = 'unread-rollup-test';
const task = (id: string, comments: GlobalTask['comments'] = []): GlobalTask => ({
  id,
  teamName: 'team',
  teamDisplayName: 'Team',
  subject: id,
  status: 'pending',
  comments,
});
const key = (id: string, context = contextId) =>
  taskDetailKey({
    contextId: context,
    teamName: 'team',
    taskId: id,
  });
const comment = (id: string): TaskComment => ({
  id,
  author: 'agent',
  type: 'regular',
  text: id,
  createdAt: '2026-10-16T00:00:00.000Z',
});

function nestedProjection(tasks: GlobalTask[], showDeleted = true) {
  let snapshot = emptySnapshot();
  for (const [id, parent] of [
    ['outer', null],
    ['inner', 'outer'],
    ['deep', 'inner'],
  ] as const) {
    snapshot = applyCommand(snapshot, { type: 'create', id, name: id, parent });
  }
  for (const candidate of tasks.filter((candidate) => candidate.id !== 'unfiled')) {
    snapshot = applyCommand(snapshot, {
      type: 'moveTask',
      identity: { teamName: candidate.teamName, taskId: candidate.id },
      parent: 'deep',
      anchor: append,
    });
  }
  return projectFolders(
    snapshot,
    tasks,
    () => false,
    () => undefined,
    true,
    showDeleted
  );
}

const countsFor = (
  projection: ReturnType<typeof projectFolders>,
  state: ReturnType<typeof getSnapshot>
) =>
  countUnreadTasksByNode(
    projection,
    (candidate) =>
      getTaskUnreadCount(
        state,
        { contextId, teamName: candidate.teamName, taskId: candidate.id },
        candidate.comments
      ) > 0
  );

describe('folder unread task rollup', () => {
  it('counts each unread task once through deep ancestors even when task rows are filtered out', () => {
    const projection = nestedProjection([
      task('many-comments', [comment('a'), comment('b'), comment('c')]),
      task('manual'),
      task('read', [comment('seen')]),
      task('unfiled', [comment('other')]),
    ]);
    const state = {
      [key('manual')]: { readIds: [], lastUpdated: 0, manualUnread: true },
      [key('read')]: { readIds: ['seen'], lastUpdated: 0 },
    };
    const hidden = applyVisibleTaskChildren(
      projection,
      [],
      () => false,
      (siblings) => siblings
    );
    expect(hidden.nodes.get('folder:deep')!.children).toEqual([]);
    const counts = countsFor(hidden, state);
    for (const id of ['outer', 'inner', 'deep']) expect(counts.get(`folder:${id}`)).toBe(2);
    expect(counts.get(UNFILED)).toBe(1);
    expect(counts.get(ROOT)).toBe(3);
    expect(
      projection.snapshot.folders.find((folder) => folder.id === 'deep')!.children
    ).toHaveLength(3);
  });

  it('leaves hidden deleted tasks out of the rollup until the deleted filter is on', () => {
    const tasks = [task('live'), { ...task('gone', [comment('x')]), status: 'deleted' }] as [
      GlobalTask,
      GlobalTask,
    ];
    const state = { [key('gone')]: { readIds: [], lastUpdated: 0, manualUnread: true } };

    expect(countsFor(nestedProjection(tasks, false), state).get('folder:deep')).toBe(0);
    expect(countsFor(nestedProjection(tasks, true), state).get('folder:deep')).toBe(1);
  });

  it('recomputes from the same read semantics on view, manual-unread and fresh-comment changes', () => {
    const original = nestedProjection([task('tracked', [comment('first')])]);
    expect(countsFor(original, {}).get('folder:outer')).toBe(1);
    const read = { [key('tracked')]: { readIds: ['first'], lastUpdated: 0 } };
    expect(countsFor(original, read).get('folder:outer')).toBe(0);
    const manual = { [key('tracked')]: { ...read[key('tracked')], manualUnread: true } };
    expect(countsFor(original, manual).get('folder:outer')).toBe(1);
    expect(countsFor(original, read).get('folder:outer')).toBe(0);
    const fresh = nestedProjection([task('tracked', [comment('first'), comment('second')])]);
    expect(countsFor(fresh, read).get('folder:outer')).toBe(1);
    const otherContext = { [key('tracked', 'another-context')]: read[key('tracked')] };
    expect(countsFor(original, otherContext).get('folder:outer')).toBe(1);
  });

  it('does not count duplicate catalog entries twice or unavailable stored tasks', () => {
    const duplicate = task('unfiled', [comment('one'), comment('two')]);
    const stored = nestedProjection([task('missing'), duplicate]);
    const projection = projectFolders(
      stored.snapshot,
      [duplicate, duplicate],
      () => false,
      () => undefined,
      true
    );
    expect(projection.nodes.get('folder:deep')!.unavailable).toBe(1);
    const counts = countsFor(projection, {});
    expect(counts.get(UNFILED)).toBe(1);
    expect(counts.get('folder:outer')).toBe(0);
    expect(counts.get(ROOT)).toBe(1);
  });
});
