import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { taskDetailKey } from '@features/team-task-detail/core';
import { GlobalTaskDetailDialog } from '@renderer/components/team/dialogs/GlobalTaskDetailDialog';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

const captured = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  taskDetail: vi.fn((_props: Record<string, unknown>) => null),
  surfaceInterest: vi.fn(),
  ensureTaskDetail: vi.fn(),
  originCurrent: true,
}));
vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@features/team-task-detail/renderer', async () => {
  const core = await vi.importActual<typeof import('@features/team-task-detail/core')>(
    '@features/team-task-detail/core'
  );
  return {
    taskDetailKey: core.taskDetailKey,
    useTaskDetailSession: () => ({
      isOriginCurrent: () => captured.originCurrent,
      openInTaskTab: () => false,
    }),
  };
});
vi.mock('@renderer/store', () => ({
  useStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector(captured.state),
    { getState: () => captured.state }
  ),
}));
vi.mock('@renderer/store/slices/teamSlice', () => ({
  selectTeamDataForName: (state: { teamDataCacheByName: Record<string, unknown> }, owner: string) =>
    state.teamDataCacheByName[owner] ?? null,
  selectResolvedMembersForTeamName: () => [],
}));
vi.mock('@renderer/components/team/dialogs/TaskDetailDialog', () => ({
  TaskDetailDialog: captured.taskDetail,
}));

const importedOwner = 'host-team:TEST-imported-owner';
const archiveOwner = importedOwner + ':source-archive:legacy-archive%3A' + 'a'.repeat(64);
const gapOwner = importedOwner + ':source-gap:legacy-gap%3A' + 'b'.repeat(64);

describe('GlobalTaskDetailDialog unavailable captured source', () => {
  let root: ReturnType<typeof createRoot>;
  const render = async () => {
    await act(async () => root.render(React.createElement(GlobalTaskDetailDialog)));
  };
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.clearAllMocks();
    captured.originCurrent = true;
    const localTask = {
      id: 'TEST-external-task',
      subject: 'Same-id local Task',
      status: 'pending',
    };
    captured.state = {
      activeContextId: 'TEST-local',
      globalTaskDetail: null,
      taskDetailById: {},
      selectedTeamData: { teamName: importedOwner, tasks: [localTask] },
      teamDataCacheByName: { [importedOwner]: { teamName: importedOwner, tasks: [localTask] } },
      globalTasks: [{ ...localTask, teamName: importedOwner }],
      closeGlobalTaskDetail: vi.fn(),
      setTaskDetailSurfaceInterest: captured.surfaceInterest,
      ensureTaskDetail: captured.ensureTaskDetail,
      openTeamTab: vi.fn(),
      openTaskDetailReview: vi.fn(),
    };
    root = createRoot(document.createElement('div'));
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  });

  it.each([archiveOwner, gapOwner])(
    'settles unavailable at the original owner without a same-id local fallback or automatic retry (%s)',
    async (teamName) => {
      const target = { contextId: 'TEST-local', teamName, taskId: 'TEST-external-task' };
      captured.state.globalTaskDetail = target;
      captured.state.taskDetailById = {
        [taskDetailKey(target)]: makeTaskDetail({
          identity: target,
          phase: 'unavailable',
          loading: false,
          error: 'Host team unavailable',
        }),
      };
      await render();
      await render();
      expect(captured.taskDetail.mock.lastCall?.[0]).toMatchObject({
        teamName,
        task: null,
        loading: false,
        readPhase: 'unavailable',
        readError: 'Host team unavailable',
      });
      expect(captured.taskDetail.mock.lastCall?.[0].taskMap).toEqual(new Map());
      expect(captured.surfaceInterest).toHaveBeenCalledExactlyOnceWith(expect.any(String), target);
      expect(captured.ensureTaskDetail).not.toHaveBeenCalled();
      const retry = captured.taskDetail.mock.lastCall?.[0].onRetryRead;
      expect(typeof retry).toBe('function');
      if (typeof retry === 'function') retry(target);
      expect(captured.ensureTaskDetail).toHaveBeenCalledExactlyOnceWith(target);
      captured.originCurrent = false;
      if (typeof retry === 'function') retry(target);
      expect(captured.ensureTaskDetail).toHaveBeenCalledTimes(1);
    }
  );

  it('does not expose an old-context captured owner after the frontend context changes', async () => {
    captured.state.globalTaskDetail = {
      contextId: 'TEST-old-context',
      teamName: archiveOwner,
      taskId: 'TEST-external-task',
    };
    await render();
    expect(captured.taskDetail).not.toHaveBeenCalled();
    expect(captured.surfaceInterest).toHaveBeenCalledExactlyOnceWith(expect.any(String), null);
    expect(captured.ensureTaskDetail).not.toHaveBeenCalled();
  });
});
