import { describe, expect, it } from 'vitest';

import { append, applyCommand, childKey, emptySnapshot } from '../../../src/features/task-folders/core/domain/folders';
import { translateTarget } from '../../../src/features/task-folders/renderer/adapters/treeDropAdapter';
import { projectFolders } from '../../../src/features/task-folders/renderer/view-models/projection';
import { applyVisibleTaskChildren } from '../../../src/features/task-folders/renderer/view-models/projectionView';

import type { GlobalTask } from '../../../src/shared/types';

const makeTask = (id: string): GlobalTask => ({
  teamName: 'team',
  teamDisplayName: 'Team',
  id,
  subject: id,
  status: 'pending',
  updatedAt: `2026-01-0${id}T00:00:00.000Z`,
});
const tasks = ['1', '2', '3'].map(makeTask);

describe('canonical task view projection', () => {
  it('filters and sorts visible task slots only while preserving canonical nodes and references', () => {
    let snapshot = applyCommand(emptySnapshot(), {
      type: 'create',
      id: 'folder',
      name: 'Folder',
      parent: null,
    });
    for (const candidate of tasks)
      snapshot = applyCommand(snapshot, {
        type: 'moveTask',
        identity: { teamName: candidate.teamName, taskId: candidate.id },
        parent: 'folder',
        anchor: append,
      });
    const canonical = projectFolders(snapshot, tasks, () => false, () => undefined, true);
    const visible = applyVisibleTaskChildren(
      canonical,
      tasks,
      (candidate) => candidate.id !== '2',
      (siblings: readonly GlobalTask[]): readonly GlobalTask[] => [...siblings].reverse()
    );

    expect(visible.nodes.get('folder:folder')!.children).toEqual([
      'task:["team","3"]',
      'task:["team","1"]',
    ]);
    expect(visible.canonicalChildren.get('folder:folder')).toEqual([
      'task:["team","1"]',
      'task:["team","2"]',
      'task:["team","3"]',
    ]);
    expect(visible.nodes.get('task:["team","2"]')).toBe(canonical.nodes.get('task:["team","2"]'));
  });

  it('maps visible drop indices to canonical anchors without deleting hidden siblings', () => {
    let snapshot = applyCommand(emptySnapshot(), {
      type: 'create',
      id: 'folder',
      name: 'Folder',
      parent: null,
    });
    for (const candidate of tasks)
      snapshot = applyCommand(snapshot, {
        type: 'moveTask',
        identity: { teamName: candidate.teamName, taskId: candidate.id },
        parent: 'folder',
        anchor: append,
      });
    const canonical = projectFolders(snapshot, tasks, () => false, () => undefined, true);
    const visible = applyVisibleTaskChildren(
      canonical,
      tasks,
      (candidate) => candidate.id !== '1',
      (siblings: readonly GlobalTask[]): readonly GlobalTask[] => siblings
    );
    const source = visible.nodes.get('task:["team","3"]')!;
    const translated = translateTarget(visible, 'folder:folder', 0, source);

    expect(translated.anchor).toEqual({
      before: { kind: 'task', identity: { teamName: 'team', taskId: '2' } },
    });
    const moved = applyCommand(snapshot, {
      type: 'moveTask',
      identity: { teamName: 'team', taskId: '3' },
      ...translated,
    });
    expect(moved.folders[0].children.map(childKey)).toEqual([
      'task:["team","1"]',
      'task:["team","3"]',
      'task:["team","2"]',
    ]);
  });

  it('moves a hidden foreign source against the visible sibling canonical anchor', () => {
    let snapshot = applyCommand(emptySnapshot(), {
      type: 'create',
      id: 'folder',
      name: 'Folder',
      parent: null,
    });
    for (const candidate of tasks)
      snapshot = applyCommand(snapshot, {
        type: 'moveTask',
        identity: { teamName: candidate.teamName, taskId: candidate.id },
        parent: 'folder',
        anchor: append,
      });
    const canonical = projectFolders(snapshot, tasks, () => false, () => undefined, true);
    const visible = applyVisibleTaskChildren(
      canonical,
      tasks,
      (candidate) => candidate.id !== '1',
      (siblings: readonly GlobalTask[]): readonly GlobalTask[] => siblings
    );
    const hiddenSource = visible.nodes.get('task:["team","1"]')!;

    const translated = translateTarget(
      visible,
      'folder:folder',
      1,
      hiddenSource,
      true
    );

    expect(translated.anchor).toEqual({
      before: { kind: 'task', identity: { teamName: 'team', taskId: '3' } },
    });
    expect(
      applyCommand(snapshot, {
        type: 'moveTask',
        identity: { teamName: 'team', taskId: '1' },
        ...translated,
      }).folders[0].children.map(childKey)
    ).toEqual(['task:["team","2"]', 'task:["team","1"]', 'task:["team","3"]']);
  });
});
