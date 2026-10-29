/* eslint-disable @typescript-eslint/naming-convention -- Preserve the existing component export in the isolated hook fixture. */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { useGraphCreateTaskDialog } from '@features/agent-graph/renderer/hooks/useGraphCreateTaskDialog';
import {
  __resetRetainedCreateTaskSubmissionForTests,
  submitRetainedTaskCreate,
} from '@renderer/components/team/dialogs/retainedCreateTaskSubmission';
import { expect, it, vi } from 'vitest';

import type { CreateTaskRequest } from '@shared/types';

const { state } = vi.hoisted(() => ({
  state: { activeContextId: 'TEST-local', isContextSwitching: false, createTeamTask: vi.fn() },
}));
vi.mock('@renderer/store', () => ({
  useStore: Object.assign((selector: (value: unknown) => unknown) => selector(state), {
    getState: () => state,
  }),
}));
vi.mock('@renderer/store/slices/teamSlice', () => ({
  selectTeamDataForName: () => null,
  selectResolvedMembersForTeamName: () => [],
  isTeamProvisioningActive: () => false,
}));
vi.mock('@renderer/api', () => ({ api: { teams: { processSend: vi.fn() } } }));
vi.mock('@renderer/components/team/dialogs/CreateTaskDialog', () => ({
  CreateTaskDialog: () => null,
}));
vi.mock('@features/agent-backend/renderer', () => ({ acknowledgeHostTaskSubmission: vi.fn() }));

it('propagates the actual graph callback lost ACK so remount retries retain the original Task command', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  __resetRetainedCreateTaskSubmissionForTests();
  state.createTeamTask.mockRejectedValue(new Error('TEST committed Task, lost ACK'));
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let graph!: ReturnType<typeof useGraphCreateTaskDialog>;
  function View() {
    graph = useGraphCreateTaskDialog('host-team:TEST-original');
    return null;
  }
  const callback = () =>
    (
      graph.dialog as React.ReactElement<{
        onSubmit(request: CreateTaskRequest): Promise<void>;
        open: boolean;
        submitting: boolean;
      }>
    ).props;
  const request = { subject: 'ORIGINAL' };
  const draft = {
    subject: 'ORIGINAL',
    description: '',
    prompt: '',
    chips: [],
    owner: '',
    groupChatId: null,
    blockedBy: [],
    related: [],
    startImmediately: false,
  };
  try {
    await act(async () => {
      root.render(<View />);
    });
    await act(async () => {
      graph.openCreateTaskDialog();
    });
    await act(async () => {
      await expect(
        submitRetainedTaskCreate(
          'host-team:TEST-original',
          request,
          draft,
          callback().onSubmit,
          () => true
        )
      ).rejects.toThrow('lost ACK');
    });
    expect(callback().open).toBe(true);
    expect(callback().submitting).toBe(false);
    await expect(
      submitRetainedTaskCreate(
        'host-team:TEST-original',
        { subject: 'CHANGED' },
        { ...draft, subject: 'CHANGED' },
        callback().onSubmit,
        () => true
      )
    ).rejects.toThrow('unchanged original draft');
    expect(state.createTeamTask).toHaveBeenCalledTimes(1);
    await act(async () => {
      root.render(null);
    });
    await act(async () => {
      root.render(<View />);
    });
    await act(async () => {
      await expect(
        submitRetainedTaskCreate(
          'host-team:TEST-original',
          request,
          draft,
          callback().onSubmit,
          () => true
        )
      ).rejects.toThrow('lost ACK');
    });
    expect(state.createTeamTask).toHaveBeenCalledTimes(2);
    expect(state.createTeamTask.mock.calls[1]![1]).toEqual(state.createTeamTask.mock.calls[0]![1]);
  } finally {
    act(() => {
      root.unmount();
    });
    host.remove();
    __resetRetainedCreateTaskSubmissionForTests();
    vi.unstubAllGlobals();
  }
});
