import { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useGraphCreateTaskDialog } from './useGraphCreateTaskDialog';

import type { TeamGraphTaskNotificationPort } from '../ports/TeamGraphTaskNotificationPort';
import type { CreateTaskRequest } from '@shared/types';
import type { ReactElement, ReactNode } from 'react';
import type { Root } from 'react-dom/client';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const mocks = vi.hoisted(() => ({
  createTeamTask: vi.fn(),
  storeState: {
    createTeamTask: vi.fn(),
    isTeamProvisioning: false,
    members: [],
    teamData: {
      isAlive: true,
      tasks: [],
    },
  },
}));

vi.mock('@renderer/components/team/dialogs/CreateTaskDialog', () => ({
  CreateTaskDialog: () => null,
}));

vi.mock('@renderer/store', () => ({
  useStore: (selector: (state: typeof mocks.storeState) => unknown) => selector(mocks.storeState),
}));

vi.mock('@renderer/store/slices/teamSlice', () => ({
  isTeamProvisioningActive: (state: typeof mocks.storeState) => state.isTeamProvisioning,
  selectResolvedMembersForTeamName: (state: typeof mocks.storeState) => state.members,
  selectTeamDataForName: (state: typeof mocks.storeState) => state.teamData,
}));

vi.mock('zustand/react/shallow', () => ({
  useShallow: (selector: unknown) => selector,
}));

interface CreateTaskDialogProps {
  open: boolean;
  onSubmit: (request: CreateTaskRequest) => Promise<void>;
  submitting: boolean;
}

const request: CreateTaskRequest = {
  subject: 'Fix the graph',
  description: 'Make it reliable',
  owner: 'alice',
  prompt: 'Preserve every ordering guarantee.',
  startImmediately: true,
};

function getDialogProps(dialog: ReactNode): CreateTaskDialogProps {
  return (dialog as ReactElement<CreateTaskDialogProps>).props;
}

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

function renderCreateTaskHook(notificationPort: TeamGraphTaskNotificationPort) {
  return renderTestHook(function useSubject() {
    return useGraphCreateTaskDialog('alpha', notificationPort);
  });
}

describe('useGraphCreateTaskDialog', () => {
  let notifyTeam: ReturnType<typeof vi.fn>;
  let notificationPort: TeamGraphTaskNotificationPort;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.storeState.createTeamTask = mocks.createTeamTask;
    mocks.storeState.isTeamProvisioning = false;
    mocks.storeState.teamData = { isAlive: true, tasks: [] };
    mocks.createTeamTask.mockResolvedValue(undefined);
    notifyTeam = vi.fn().mockResolvedValue(undefined);
    notificationPort = { notifyTeam };
  });

  afterEach(() => {
    for (const root of mountedRoots.splice(0)) {
      act(() => root.unmount());
    }
  });

  it('creates before notifying, preserves the exact message, and closes after success', async () => {
    const result = renderCreateTaskHook(notificationPort);

    act(() => result.current.openCreateTaskDialog('alice'));
    expect(getDialogProps(result.current.dialog).open).toBe(true);

    await act(async () => getDialogProps(result.current.dialog).onSubmit(request));

    expect(mocks.createTeamTask).toHaveBeenCalledWith('alpha', request);
    expect(notifyTeam).toHaveBeenCalledWith(
      'alpha',
      'New task assigned to alice: "Fix the graph". Instructions:\nPreserve every ordering guarantee.'
    );
    expect(mocks.createTeamTask.mock.invocationCallOrder[0]).toBeLessThan(
      notifyTeam.mock.invocationCallOrder[0]
    );
    expect(getDialogProps(result.current.dialog)).toMatchObject({ open: false, submitting: false });
  });

  it('stays open and submitting until the ordered notification attempt settles', async () => {
    let resolveNotification: (() => void) | undefined;
    notifyTeam.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveNotification = resolve;
        })
    );
    const result = renderCreateTaskHook(notificationPort);

    act(() => result.current.openCreateTaskDialog('alice'));
    let submission: Promise<void> | undefined;
    act(() => {
      submission = getDialogProps(result.current.dialog).onSubmit(request);
    });
    await act(async () => Promise.resolve());

    expect(notifyTeam).toHaveBeenCalled();
    expect(getDialogProps(result.current.dialog)).toMatchObject({ open: true, submitting: true });

    await act(async () => {
      resolveNotification?.();
      await submission;
    });
    expect(getDialogProps(result.current.dialog)).toMatchObject({ open: false, submitting: false });
  });

  it('swallows notification failures and still closes the successful create dialog', async () => {
    notifyTeam.mockRejectedValueOnce(new Error('offline'));
    const result = renderCreateTaskHook(notificationPort);

    act(() => result.current.openCreateTaskDialog('alice'));
    await act(async () => getDialogProps(result.current.dialog).onSubmit(request));

    expect(getDialogProps(result.current.dialog)).toMatchObject({ open: false, submitting: false });
  });

  it('leaves the dialog open when task creation fails and clears submitting', async () => {
    mocks.createTeamTask.mockRejectedValueOnce(new Error('create failed'));
    const result = renderCreateTaskHook(notificationPort);

    act(() => result.current.openCreateTaskDialog('alice'));
    await act(async () => getDialogProps(result.current.dialog).onSubmit(request));

    expect(notifyTeam).not.toHaveBeenCalled();
    expect(getDialogProps(result.current.dialog)).toMatchObject({ open: true, submitting: false });
  });

  it.each([
    ['missing prompt', { ...request, prompt: '' }, true, false],
    ['missing owner', { ...request, owner: '' }, true, false],
    ['team not alive', request, false, false],
    ['provisioning active', request, true, true],
    ['startImmediately false', { ...request, startImmediately: false }, true, false],
  ])(
    'does not notify when the %s guard blocks it',
    async (_label, guardedRequest, isAlive, provisioning) => {
      mocks.storeState.teamData = { isAlive, tasks: [] };
      mocks.storeState.isTeamProvisioning = provisioning;
      const result = renderCreateTaskHook(notificationPort);

      await act(async () => getDialogProps(result.current.dialog).onSubmit(guardedRequest));

      expect(mocks.createTeamTask).toHaveBeenCalledWith('alpha', guardedRequest);
      expect(notifyTeam).not.toHaveBeenCalled();
      expect(getDialogProps(result.current.dialog).submitting).toBe(false);
    }
  );
});
