import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { createFilesystemTeamOwner } from '@agent-teams/legacy-agent-host/team/filesystem';
import { useGraphCreateTaskDialog } from '@features/agent-graph/renderer/hooks/useGraphCreateTaskDialog';
import { useGraphTaskActions } from '@features/agent-graph/renderer/hooks/useGraphTaskActions';
import { afterEach, expect, it, vi } from 'vitest';

import { parseBackendOperation } from '../../../src/features/agent-backend/main/adapters/input/validateBackendOperation';
import { projectBackendResult } from '../../../src/features/agent-backend/main/adapters/output/projectBackendResult';
import { projectTeamSnapshot } from '../../../src/features/agent-backend/main/adapters/output/projectTeamSnapshot';
import { createHostTeamMutations } from '../../../src/features/agent-backend/renderer/createHostTeamMutations';
import { __resetRetainedTaskSubmissionsForTests } from '../../../src/features/agent-backend/renderer/retainedTaskSubmissions';

import type { AgentBackendApi } from '../../../src/features/agent-backend/contracts/operations';
import type { CreateTaskRequest } from '../../../src/shared/types/team';
import type { TeamCommand } from '@agent-teams/legacy-agent-host/team/contracts';

const { state, processSend } = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  processSend: vi.fn(),
}));
vi.mock('@renderer/api', () => ({ api: { teams: { processSend } } }));
vi.mock('@renderer/store', () => ({
  useStore: (selector: (value: unknown) => unknown) => selector(state),
}));
vi.mock('@renderer/store/slices/teamSlice', () => ({
  selectTeamDataForName: () => state.teamData,
  selectResolvedMembersForTeamName: () => [],
  isTeamProvisioningActive: () => false,
}));
vi.mock('@renderer/components/team/dialogs/ReviewDialog', () => ({ ReviewDialog: () => null }));
vi.mock('@renderer/components/team/dialogs/CreateTaskDialog', () => ({
  CreateTaskDialog: () => null,
}));
vi.mock('@renderer/components/common/ConfirmDialog', () => ({ confirm: async () => true }));
const roots: string[] = [];
afterEach(() => {
  processSend.mockReset();
  __resetRetainedTaskSubmissionsForTests();
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  vi.unstubAllGlobals();
});
function fixture() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-lead-coordination-')));
  roots.push(root);
  const teamName = 'test-lead-coordination';
  const owner = createFilesystemTeamOwner({
    root,
    binding: { backendId: 'TEST', teamId: 'TEST-team', teamName },
    members: [
      {
        memberId: 'lead',
        name: 'captured-lead',
        role: 'lead',
        delivery: {
          backendId: 'TEST',
          teamId: 'TEST-team',
          teamName,
          runId: 'TEST-captured-run',
          memberId: 'lead',
          generation: '1',
        },
      },
    ],
    grants: [
      {
        principalId: 'human',
        memberName: 'user',
        permissions: ['read', 'task.write', 'message.write', 'admin'],
      },
    ],
  });
  const human = owner.connect('human');
  const handle = { handleId: 'TEST-original-lead' },
    key = 'host-team:TEST-original-lead';
  const invoke = vi.fn<AgentBackendApi['invoke']>(async (raw) => {
    const request = parseBackendOperation(raw);
    expect(request.handle).toEqual(handle);
    return projectBackendResult(request, {
      ok: true,
      value: human.execute({
        commandId: request.commandId,
        operation: request.operation,
        payload: request.payload,
      } as TeamCommand),
    });
  });
  const backend: AgentBackendApi = { invoke, getConnections: vi.fn() };
  let current = true;
  const resolve = vi.fn(async () => {
    const snapshot = projectTeamSnapshot(human.readSnapshot());
    return { handle, teamName: snapshot.teamName, members: snapshot.members };
  });
  const adapter = createHostTeamMutations({ backend, resolve, captureScope: () => () => current });
  processSend.mockImplementation((target: string, text: string) =>
    adapter.processSend(target, text)
  );
  const inbox = () => {
    try {
      return JSON.parse(
        readFileSync(join(root, 'teams', teamName, 'inboxes/captured-lead.json'), 'utf8')
      ) as { from: string; text: string }[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  };
  const seed = (assigned: boolean) => {
    const receipt = human.execute({
      commandId: 'TEST-seed',
      operation: 'task.create',
      payload: { subject: 'TEST original', ...(assigned ? { owner: 'captured-lead' } : {}) },
    });
    return receipt.effects.taskId;
  };
  return {
    root,
    owner,
    human,
    key,
    handle,
    backend,
    invoke,
    resolve,
    adapter,
    inbox,
    seed,
    revoke: () => {
      current = false;
    },
  };
}

async function graph(f: ReturnType<typeof fixture>, key = f.key) {
  state.teamData = { ...projectTeamSnapshot(f.human.readSnapshot()), isAlive: true };
  state.startTaskByUser = vi.fn((team: string, taskId: string) =>
    f.adapter.startTaskByUser(team, taskId)
  );
  state.updateTaskStatus = vi.fn((team: string, taskId: string, status: 'pending') =>
    f.adapter.updateTaskStatus(team, taskId, status)
  );
  state.sendTeamMessage = vi.fn(
    (team: string, input: Parameters<typeof f.adapter.sendMessage>[1]) =>
      f.adapter.sendMessage(team, input)
  );
  state.createTeamTask = vi.fn((team: string, input: CreateTaskRequest) =>
    f.adapter.createTask(team, input)
  );
  const host = document.createElement('div');
  document.body.append(host);
  const renderer = createRoot(host);
  let actions!: ReturnType<typeof useGraphTaskActions>,
    createDialog!: ReturnType<typeof useGraphCreateTaskDialog>;
  function View() {
    actions = useGraphTaskActions(key);
    createDialog = useGraphCreateTaskDialog(key);
    return null;
  }
  await act(async () => {
    renderer.render(<View />);
  });
  return {
    actions,
    createDialog,
    close: () => {
      act(() => renderer.unmount());
      host.remove();
    },
  };
}

it.each([false, true])(
  'actual graph Start coordinates the lead once only when canonical notifiedOwner is false (assigned=%s)',
  async (assigned) => {
    const f = fixture(),
      taskId = f.seed(assigned),
      before = f.inbox();
    const ui = await graph(f);
    try {
      await act(async () => {
        ui.actions.onStartTask(taskId);
      });
      expect(f.human.getTask(taskId).status).toBe('in_progress');
      expect(f.inbox().length - before.length).toBe(1);
      expect(processSend).toHaveBeenCalledTimes(assigned ? 0 : 1);
      expect(
        f.invoke.mock.calls.filter(([request]) => request.operation === 'message.send')
      ).toHaveLength(assigned ? 0 : 1);
      if (!assigned) {
        const message = f.invoke.mock.calls.find(
          ([request]) => request.operation === 'message.send'
        )![0];
        expect(message.payload).toMatchObject({ to: 'captured-lead' });
        expect(f.inbox().at(-1)?.text).toContain('has no assignee');
      }
      expect(f.resolve).toHaveBeenCalledTimes(assigned ? 1 : 2);
    } finally {
      ui.close();
    }
  }
);

it('keeps Host Cancel direct-owner input and immediate Create work without a second lead stdin echo', async () => {
  const f = fixture(),
    taskId = f.seed(true);
  const ui = await graph(f);
  try {
    await act(async () => {
      ui.actions.onCancelTask(taskId);
    });
    expect(f.human.getTask(taskId).status).toBe('pending');
    expect(
      f.invoke.mock.calls.filter(([request]) => request.operation === 'message.send')
    ).toHaveLength(1);
    expect(processSend).not.toHaveBeenCalled();
    await act(async () => {
      await (
        ui.createDialog.dialog as React.ReactElement<{
          onSubmit(input: CreateTaskRequest): Promise<void>;
        }>
      ).props.onSubmit({
        subject: 'TEST immediate',
        owner: 'captured-lead',
        prompt: 'TEST instructions',
      });
    });
    expect(f.human.listTasks()).toHaveLength(2);
    expect(processSend).not.toHaveBeenCalled();
  } finally {
    ui.close();
  }
});

it('preserves existing assigned Start, Cancel and prompted Create stdin coordination for legacy Teams', async () => {
  const f = fixture();
  f.seed(true);
  const ui = await graph(f, 'legacy-team');
  processSend.mockResolvedValue(undefined);
  (state.startTaskByUser as ReturnType<typeof vi.fn>).mockResolvedValue({ notifiedOwner: true });
  (state.updateTaskStatus as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  (state.sendTeamMessage as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  (state.createTeamTask as ReturnType<typeof vi.fn>).mockResolvedValue({});
  try {
    await act(async () => {
      ui.actions.onStartTask(f.human.listTasks()[0]!.id);
    });
    await act(async () => {
      ui.actions.onCancelTask(f.human.listTasks()[0]!.id);
    });
    await act(async () => {
      await (
        ui.createDialog.dialog as React.ReactElement<{
          onSubmit(input: CreateTaskRequest): Promise<void>;
        }>
      ).props.onSubmit({ subject: 'TEST', owner: 'captured-lead', prompt: 'TEST prompt' });
    });
    expect(processSend).toHaveBeenCalledTimes(3);
    expect(processSend.mock.calls.every(([key]) => key === 'legacy-team')).toBe(true);
    expect(f.invoke).not.toHaveBeenCalled();
  } finally {
    ui.close();
  }
});

it.each([
  { members: [] },
  {
    members: [
      { name: 'one', role: 'lead' },
      { name: 'two', role: 'lead' },
    ],
  },
] as const)(
  'refuses missing or ambiguous captured lead before any dispatch',
  async ({ members }) => {
    const f = fixture();
    f.resolve.mockResolvedValue({
      handle: f.handle,
      teamName: 'test-lead-coordination',
      members: [...members],
    });
    await expect(f.adapter.processSend(f.key, 'TEST original')).rejects.toMatchObject({
      outcome: 'not-dispatched',
    });
    expect(f.resolve).toHaveBeenCalledTimes(1);
    expect(f.invoke).not.toHaveBeenCalled();
  }
);

it('blocks slash input before resolve, and a revoked original scope after await without recapturing', async () => {
  const f = fixture();
  await expect(f.adapter.processSend(f.key, '/compact')).rejects.toMatchObject({
    outcome: 'not-dispatched',
  });
  expect(f.resolve).not.toHaveBeenCalled();
  f.resolve.mockImplementation(async () => {
    await Promise.resolve();
    f.revoke();
    return {
      handle: f.handle,
      teamName: 'test-lead-coordination',
      members: [{ name: 'captured-lead', role: 'lead' }],
    };
  });
  await expect(f.adapter.processSend(f.key, 'TEST original')).rejects.toMatchObject({
    code: 'context-changed',
    outcome: 'not-dispatched',
  });
  expect(f.resolve).toHaveBeenCalledTimes(1);
  expect(f.invoke).not.toHaveBeenCalled();
});

it('reports the original uncertain message command after lost ACK, with one captured resolve and no retry', async () => {
  const f = fixture();
  const original = f.invoke.getMockImplementation()!;
  f.invoke.mockImplementation(async (request) => {
    await original(request);
    throw new Error('TEST lost ACK');
  });
  await expect(f.adapter.processSend(f.key, 'TEST original')).rejects.toMatchObject({
    code: 'transport-unavailable',
    outcome: 'unknown',
    commandId: expect.any(String),
  });
  expect(f.resolve).toHaveBeenCalledTimes(1);
  expect(f.invoke).toHaveBeenCalledTimes(1);
  expect(f.inbox()).toHaveLength(1);
});
