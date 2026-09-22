import { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useGraphTaskActions } from './useGraphTaskActions';

import type { TeamGraphTaskNotificationPort } from '../ports/TeamGraphTaskNotificationPort';
import type { Root } from 'react-dom/client';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const mocks = vi.hoisted(() => ({
  requestReview: vi.fn(),
  sendTeamMessage: vi.fn(),
  softDeleteTask: vi.fn(),
  startTaskByUser: vi.fn(),
  updateKanban: vi.fn(),
  updateTaskStatus: vi.fn(),
  storeState: {
    members: [],
    requestReview: vi.fn(),
    sendTeamMessage: vi.fn(),
    softDeleteTask: vi.fn(),
    startTaskByUser: vi.fn(),
    teamData: {
      isAlive: true,
      tasks: [
        {
          id: 'task-7',
          subject: 'Fix the graph',
          description: '  Preserve ordering.  ',
          owner: 'alice',
        },
      ],
    },
    updateKanban: vi.fn(),
    updateTaskStatus: vi.fn(),
  },
}));

vi.mock('@renderer/components/common/ConfirmDialog', () => ({
  confirm: vi.fn(),
}));

vi.mock('@renderer/components/team/dialogs/ReviewDialog', () => ({
  ReviewDialog: () => null,
}));

vi.mock('@renderer/store', () => ({
  useStore: (selector: (state: typeof mocks.storeState) => unknown) => selector(mocks.storeState),
}));

vi.mock('@renderer/store/slices/teamSlice', () => ({
  selectResolvedMembersForTeamName: (state: typeof mocks.storeState) => state.members,
  selectTeamDataForName: (state: typeof mocks.storeState) => state.teamData,
}));

vi.mock('@shared/utils/taskIdentity', () => ({
  deriveTaskDisplayId: () => '7',
  formatTaskDisplayLabel: () => '#7',
}));

vi.mock('zustand/react/shallow', () => ({
  useShallow: (selector: unknown) => selector,
}));

const mountedRoots: Root[] = [];

function renderTestHook<Result>(useHook: () => Result): { readonly current: Result } {
  const container = document.createElement('div');
  const root = createRoot(container);
  let current: Result | undefined;

  const HookHost = (): null => {
    current = useHook();
    return null;
  };

  act(() => root.render(<HookHost />));
  mountedRoots.push(root);

  return {
    get current(): Result {
      if (current === undefined) throw new Error('Hook did not render');
      return current;
    },
  };
}

function renderTaskActionsHook(notificationPort: TeamGraphTaskNotificationPort) {
  return renderTestHook(function useSubject() {
    return useGraphTaskActions('alpha', notificationPort);
  });
}

async function runAction(action: () => void): Promise<void> {
  await act(async () => {
    action();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('useGraphTaskActions', () => {
  let notifyTeam: ReturnType<typeof vi.fn>;
  let notificationPort: TeamGraphTaskNotificationPort;

  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(mocks.storeState, {
      requestReview: mocks.requestReview,
      sendTeamMessage: mocks.sendTeamMessage,
      softDeleteTask: mocks.softDeleteTask,
      startTaskByUser: mocks.startTaskByUser,
      updateKanban: mocks.updateKanban,
      updateTaskStatus: mocks.updateTaskStatus,
    });
    mocks.storeState.teamData = {
      isAlive: true,
      tasks: [
        {
          id: 'task-7',
          subject: 'Fix the graph',
          description: '  Preserve ordering.  ',
          owner: 'alice',
        },
      ],
    };
    mocks.startTaskByUser.mockResolvedValue({ notifiedOwner: true });
    mocks.sendTeamMessage.mockResolvedValue(undefined);
    mocks.updateTaskStatus.mockResolvedValue(undefined);
    notifyTeam = vi.fn().mockResolvedValue(undefined);
    notificationPort = { notifyTeam };
  });

  afterEach(() => {
    for (const root of mountedRoots.splice(0)) {
      act(() => root.unmount());
    }
  });

  it('starts before sending the exact assigned-owner notification', async () => {
    const result = renderTaskActionsHook(notificationPort);

    await runAction(() => result.current.onStartTask('task-7'));

    expect(notifyTeam).toHaveBeenCalledWith(
      'alpha',
      'Task #7 "Fix the graph" has started. Please begin working on it.'
    );
    expect(mocks.startTaskByUser).toHaveBeenCalledWith('alpha', 'task-7');
    expect(mocks.startTaskByUser.mock.invocationCallOrder[0]).toBeLessThan(
      notifyTeam.mock.invocationCallOrder[0]
    );
  });

  it('sends the exact unassigned start notification with the trimmed description', async () => {
    mocks.startTaskByUser.mockResolvedValueOnce({ notifiedOwner: false });
    mocks.storeState.teamData.tasks[0].owner = '';
    const result = renderTaskActionsHook(notificationPort);

    await runAction(() => result.current.onStartTask('task-7'));

    expect(notifyTeam).toHaveBeenCalledWith(
      'alpha',
      'Task #7 "Fix the graph" has been moved to IN PROGRESS but has no assignee.\nDescription: Preserve ordering.\nPlease assign it to an available team member, or take it yourself if everyone is busy.'
    );
  });

  it('does not send a start notification when the team is not alive', async () => {
    mocks.storeState.teamData.isAlive = false;
    const result = renderTaskActionsHook(notificationPort);

    await runAction(() => result.current.onStartTask('task-7'));

    expect(mocks.startTaskByUser).toHaveBeenCalled();
    expect(notifyTeam).not.toHaveBeenCalled();
  });

  it('swallows start notification failures', async () => {
    notifyTeam.mockRejectedValueOnce(new Error('offline'));
    const result = renderTaskActionsHook(notificationPort);

    await runAction(() => result.current.onStartTask('task-7'));

    expect(notifyTeam).toHaveBeenCalled();
  });

  it('cancels, direct-messages the owner, then sends the exact team notification', async () => {
    const result = renderTaskActionsHook(notificationPort);

    await runAction(() => result.current.onCancelTask('task-7'));

    expect(notifyTeam).toHaveBeenCalledWith(
      'alpha',
      'Task #7 "Fix the graph" has been cancelled and moved back to TODO. alice has been notified to stop.'
    );
    expect(mocks.updateTaskStatus).toHaveBeenCalledWith('alpha', 'task-7', 'pending');
    expect(mocks.sendTeamMessage).toHaveBeenCalledWith('alpha', {
      member: 'alice',
      text: 'Task #7 "Fix the graph" has been CANCELLED by the user and moved back to TODO. Stop working on it immediately.',
      summary: 'Task #7 cancelled',
    });
    expect(mocks.updateTaskStatus.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.sendTeamMessage.mock.invocationCallOrder[0]
    );
    expect(mocks.sendTeamMessage.mock.invocationCallOrder[0]).toBeLessThan(
      notifyTeam.mock.invocationCallOrder[0]
    );
  });

  it('still notifies the alive team when the best-effort owner message fails', async () => {
    mocks.sendTeamMessage.mockRejectedValueOnce(new Error('owner offline'));
    const result = renderTaskActionsHook(notificationPort);

    await runAction(() => result.current.onCancelTask('task-7'));

    expect(notifyTeam).toHaveBeenCalled();
    expect(mocks.sendTeamMessage.mock.invocationCallOrder[0]).toBeLessThan(
      notifyTeam.mock.invocationCallOrder[0]
    );
  });

  it('swallows cancellation team-notification failures', async () => {
    notifyTeam.mockRejectedValueOnce(new Error('team offline'));
    const result = renderTaskActionsHook(notificationPort);

    await runAction(() => result.current.onCancelTask('task-7'));

    expect(mocks.updateTaskStatus).toHaveBeenCalled();
    expect(mocks.sendTeamMessage).toHaveBeenCalled();
    expect(notifyTeam).toHaveBeenCalled();
  });

  it('direct-messages the owner but does not notify a team that is not alive', async () => {
    mocks.storeState.teamData.isAlive = false;
    const result = renderTaskActionsHook(notificationPort);

    await runAction(() => result.current.onCancelTask('task-7'));

    expect(mocks.sendTeamMessage).toHaveBeenCalled();
    expect(notifyTeam).not.toHaveBeenCalled();
  });

  it('stops cancellation notifications when the status update fails', async () => {
    mocks.updateTaskStatus.mockRejectedValueOnce(new Error('update failed'));
    const result = renderTaskActionsHook(notificationPort);

    await runAction(() => result.current.onCancelTask('task-7'));

    expect(mocks.updateTaskStatus).toHaveBeenCalled();
    expect(mocks.sendTeamMessage).not.toHaveBeenCalled();
    expect(notifyTeam).not.toHaveBeenCalled();
  });
});
