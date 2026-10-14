import { describe, expect, it } from 'vitest';

import {
  hasSelectedTargetTeamData,
  shouldKeepGlobalTaskDialogLoading,
} from '../../../../../src/renderer/components/team/dialogs/globalTaskDetailDialogLoading';

import type { TaskDetailReadEntry } from '../../../../../src/features/team-task-detail/core';

type TaskDetailReadState = Pick<
  TaskDetailReadEntry,
  'identity' | 'phase' | 'full' | 'error' | 'loading' | 'refreshPending'
>;

const identity = {
  contextId: 'context-a',
  teamName: 'alpha',
  taskId: 'task-1',
};

function makeTaskDetail(overrides: Partial<TaskDetailReadState> = {}): TaskDetailReadState {
  return {
    identity,
    phase: 'hydrating',
    full: null,
    error: null,
    loading: true,
    refreshPending: false,
    ...overrides,
  };
}

describe('shouldKeepGlobalTaskDialogLoading', () => {
  it('treats stale selectedTeamData from another team as not loaded', () => {
    expect(hasSelectedTargetTeamData('alpha', 'alpha', 'beta')).toBe(false);
    expect(hasSelectedTargetTeamData('alpha', 'alpha', 'alpha')).toBe(true);
  });

  it('keeps loading while task detail identity has not reached the target context', () => {
    expect(
      shouldKeepGlobalTaskDialogLoading({
        identity,
        taskDetail: makeTaskDetail({
          identity: { ...identity, contextId: 'context-b' },
        }),
      })
    ).toBe(true);
  });

  it('keeps loading when the task detail read is still absent', () => {
    expect(
      shouldKeepGlobalTaskDialogLoading({
        identity,
        taskDetail: null,
      })
    ).toBe(true);
  });

  it('keeps the full task loading despite an already cached team snapshot', () => {
    expect(
      shouldKeepGlobalTaskDialogLoading({
        identity,
        taskDetail: makeTaskDetail(),
      })
    ).toBe(true);
  });

  it('keeps loading through provisioning without turning a compact preview into authority', () => {
    expect(
      shouldKeepGlobalTaskDialogLoading({
        identity,
        taskDetail: makeTaskDetail({ phase: 'provisioning', loading: false }),
      })
    ).toBe(true);
  });

  it('stops loading once an accepted full task remains available during refresh', () => {
    expect(
      shouldKeepGlobalTaskDialogLoading({
        identity,
        taskDetail: makeTaskDetail({
          phase: 'ready',
          loading: true,
          full: { id: identity.taskId, subject: 'Task', status: 'pending' },
        }),
      })
    ).toBe(false);
  });

  it('stops loading after terminal missing and unavailable results', () => {
    expect(
      shouldKeepGlobalTaskDialogLoading({
        identity,
        taskDetail: makeTaskDetail({ phase: 'missing', loading: false }),
      })
    ).toBe(false);
    expect(
      shouldKeepGlobalTaskDialogLoading({
        identity,
        taskDetail: makeTaskDetail({
          phase: 'unavailable',
          loading: false,
          error: 'boom',
        }),
      })
    ).toBe(false);
  });
});
