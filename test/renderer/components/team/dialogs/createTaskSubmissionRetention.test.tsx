/* eslint-disable @typescript-eslint/naming-convention -- Mock component exports preserve existing names. */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { HostTaskSubmissionRefusal } from '@features/agent-backend/contracts';
import { CreateTaskDialog } from '@renderer/components/team/dialogs/CreateTaskDialog';
import { __resetRetainedCreateTaskSubmissionForTests } from '@renderer/components/team/dialogs/retainedCreateTaskSubmission';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { CreateTaskRequest } from '@shared/types';

const { state } = vi.hoisted(() => ({
  state: {
    activeContextId: 'TEST-local',
    isContextSwitching: false,
    teamDataCacheByName: {},
    teamByName: {},
    selectedTeamName: null,
    selectedTeamData: null,
  },
}));
vi.mock('@renderer/store', () => ({
  useStore: Object.assign((selector: (state: unknown) => unknown) => selector(state), {
    getState: () => state,
  }),
}));
vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@features/agent-backend/renderer', () => ({ acknowledgeHostTaskSubmission: vi.fn() }));
vi.mock('@renderer/hooks/useTaskSuggestions', () => ({
  useTaskSuggestions: () => ({ suggestions: [] }),
}));
vi.mock('@renderer/services/draftStorage', () => ({
  draftStorage: {
    loadDraft: async () => null,
    saveDraft: async () => {},
    deleteDraft: async () => {},
  },
}));
vi.mock('@renderer/components/ui/MemberSelect', () => ({ MemberSelect: () => null }));
vi.mock('@renderer/components/ui/MentionableTextarea', () => ({ MentionableTextarea: () => null }));
vi.mock('@renderer/components/ui/tiptap', () => ({ TiptapEditor: () => null }));
vi.mock('@renderer/components/ui/dialog', () => {
  const Box = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  return {
    Dialog: Box,
    DialogContent: Box,
    DialogDescription: Box,
    DialogFooter: Box,
    DialogHeader: Box,
    DialogTitle: Box,
  };
});
let dispose = () => {};
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state.activeContextId = 'TEST-local';
  __resetRetainedCreateTaskSubmissionForTests();
});
afterEach(() => {
  dispose();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});
function mount(
  create = vi.fn().mockRejectedValue(new Error('TEST lost ACK')),
  teamName = 'host-team:TEST-original'
) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = async (open = true) => {
    await act(async () => {
      root.render(
        <CreateTaskDialog
          open={open}
          teamName={teamName}
          members={[]}
          tasks={[]}
          defaultSubject="ORIGINAL"
          defaultDescription="TEST description"
          defaultOwner="alice"
          onClose={() => {}}
          onSubmit={create}
        />
      );
    });
  };
  const unmount = async () => {
    await act(async () => {
      root.render(null);
    });
  };
  dispose = () => {
    act(() => {
      root.unmount();
    });
    host.remove();
  };
  const submit = async () => {
    const button = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === 'tasks.createTask.create'
    )!;
    await act(async () => {
      button.click();
    });
  };
  const edit = async (value: string) => {
    const input = host.querySelector<HTMLInputElement>('#task-subject')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  return { create, host, render, unmount, submit, edit };
}
it('actual CreateTaskDialog unmount/reopen reuses original command and payload; altered draft is held', async () => {
  const f = mount();
  await f.render();
  await f.submit();
  const original = structuredClone(f.create.mock.calls[0]![0]);
  await f.edit('CHANGED');
  await f.submit();
  expect(f.create).toHaveBeenCalledTimes(1);
  expect(f.host.querySelector('[role=alert]')?.textContent).toContain('unchanged original draft');
  await f.unmount();
  await f.render();
  expect(f.host.querySelector<HTMLInputElement>('#task-subject')?.value).toBe('ORIGINAL');
  await f.submit();
  expect(f.create).toHaveBeenCalledTimes(2);
  expect(f.create.mock.calls[1]![0]).toEqual(original);
});
it('retains in-flight obligation and blocks a replacement owner after real remount', async () => {
  let reject!: (reason?: unknown) => void;
  const f = mount(
    vi.fn(
      () =>
        new Promise<void>((_resolve, fail) => {
          reject = fail;
        })
    )
  );
  await f.render();
  await f.submit();
  await f.unmount();
  await f.render();
  await f.submit();
  expect(f.create).toHaveBeenCalledTimes(1);
  expect(f.host.querySelector('[role=alert]')?.textContent).toContain('still pending');
  await act(async () => {
    reject(new Error('TEST lost ACK'));
  });
  state.activeContextId = 'TEST-other';
  await f.unmount();
  await f.render();
  await f.submit();
  expect(f.create).toHaveBeenCalledTimes(1);
  expect(f.host.querySelector('[role=alert]')?.textContent).toContain('original owner');
});
it('permits corrected Create Task only after a matching proven prewriter refusal', async () => {
  const create = vi.fn(async (request: { command?: { commandId: string } }) => {
    throw new HostTaskSubmissionRefusal('invalid', 'not-dispatched', request.command!.commandId);
  });
  const f = mount(create);
  await f.render();
  await f.submit();
  const firstId = create.mock.calls[0]![0].command!.commandId;
  await f.edit('CORRECTED');
  await f.submit();
  expect(create).toHaveBeenCalledTimes(2);
  expect(create.mock.calls[1]![0]).toMatchObject({ subject: 'CORRECTED' });
  expect(create.mock.calls[1]![0].command!.commandId).not.toBe(firstId);
});

it('preserves legacy Create Task correction behavior without Host retention', async () => {
  const create = vi.fn().mockRejectedValue(new Error('TEST legacy validation'));
  const f = mount(create, 'legacy-team');
  await f.render();
  await f.submit();
  const firstId = create.mock.calls[0]![0].command.commandId;
  await f.edit('CORRECTED LEGACY');
  await f.submit();
  expect(create).toHaveBeenCalledTimes(2);
  expect(create.mock.calls[1]![0].subject).toBe('CORRECTED LEGACY');
  expect(create.mock.calls[1]![0].command.commandId).not.toBe(firstId);
});

it('late success after actual remount retains original intent until the replacement form resolves it', async () => {
  let resolve!: () => void;
  const create = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        })
    )
    .mockResolvedValue(undefined);
  const f = mount(create);
  await f.render();
  await f.submit();
  const original = structuredClone(create.mock.calls[0]![0]);
  await f.unmount();
  await f.render();
  await act(async () => {
    resolve();
  });
  expect(f.host.querySelector<HTMLInputElement>('#task-subject')?.value).toBe('ORIGINAL');
  await f.submit();
  expect(create).toHaveBeenCalledTimes(2);
  expect(create.mock.calls[1]![0]).toEqual(original);
  await f.unmount();
  await f.render();
  await f.edit('NEXT');
  await f.submit();
  expect(create.mock.calls[2]![0].command.commandId).not.toBe(original.command.commandId);
});

it('a same-instance close/reopen fences the old success and retains the restored command', async () => {
  let resolve!: () => void;
  const create = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        })
    )
    .mockResolvedValue(undefined);
  const f = mount(create);
  await f.render();
  await f.submit();
  const original = structuredClone(create.mock.calls[0]![0]);
  await f.render(false);
  await f.render(true);
  await act(async () => {
    resolve();
  });
  await f.submit();
  expect(create.mock.calls[1]![0]).toEqual(original);
});
it('ordinary successful parent close may acknowledge without retaining successful history', async () => {
  const create = vi.fn(async (_request: CreateTaskRequest): Promise<void> => {
    await f.unmount();
  });
  const f = mount(create);
  await f.render();
  await f.submit();
  const originalId = create.mock.calls[0]![0].command!.commandId;
  await f.render();
  await f.edit('NEXT TASK');
  await f.submit();
  expect(create).toHaveBeenCalledTimes(2);
  expect(create.mock.calls[1]![0].command!.commandId).not.toBe(originalId);
});
