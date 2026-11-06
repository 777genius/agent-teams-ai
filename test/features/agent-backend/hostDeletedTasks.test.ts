// @vitest-environment node
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFilesystemTeamOwner } from '@agent-teams/legacy-agent-host/team/filesystem';
import { afterEach, expect, it, vi } from 'vitest';
import { create } from 'zustand';

import { BackendOperationsFacade } from '../../../src/features/agent-backend/main/adapters/input/BackendOperationsFacade';
import { parseBackendOperation } from '../../../src/features/agent-backend/main/adapters/input/validateBackendOperation';
import { projectDeletedTasks } from '../../../src/features/agent-backend/main/adapters/output/projectDeletedTasks';
import {
  createHostTeamsApi,
  hostTeamSelectionKey,
} from '../../../src/features/agent-backend/renderer/createHostTeamsApi';
import { __resetRetainedTaskSubmissionsForTests } from '../../../src/features/agent-backend/renderer/retainedTaskSubmissions';
import { createDeletedTaskFeed } from '../../../src/renderer/store/slices/deletedTaskFeed';

import type { AgentBackendApi } from '../../../src/features/agent-backend/contracts/operations';
import type { BackendOwnerRouter } from '../../../src/features/agent-backend/main/application/BackendOwnerRouter';
import type { DeletedTaskFeed } from '../../../src/renderer/store/slices/deletedTaskFeed';
import type { AppState } from '../../../src/renderer/store/types';
import type { TeamsAPI } from '../../../src/shared/types/api';
import type { JsonValue } from '@agent-teams/legacy-agent-host/contracts';
import type { TeamCommand } from '@agent-teams/legacy-agent-host/team/contracts';

const { getDeletedTasks } = vi.hoisted(() => ({ getDeletedTasks: vi.fn() }));
vi.mock('@renderer/api', () => ({ api: { teams: { getDeletedTasks } } }));
const roots: string[] = [];
afterEach(() => {
  getDeletedTasks.mockReset();
  __resetRetainedTaskSubmissionsForTests();
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-host-trash-')));
  roots.push(root);
  const binding = { backendId: 'TEST-backend', teamId: 'TEST-trash-team', teamName: 'test-trash' };
  const owner = createFilesystemTeamOwner({
    root,
    binding,
    members: [{ memberId: 'lead', name: 'team-lead', role: 'lead' }],
    grants: [
      { principalId: 'human', memberName: 'user', permissions: ['read', 'task.write', 'admin'] },
    ],
  });
  const human = owner.connect('human');
  const handle = { handleId: 'TEST-trash-owner' };
  const success = (value: unknown): JsonValue => JSON.parse(JSON.stringify({ ok: true, value }));
  const router = {
    lookup: vi.fn<BackendOwnerRouter['lookup']>(),
    request: vi.fn<BackendOwnerRouter['request']>(async (captured, request) => {
      expect(captured).toEqual(handle);
      const payload = request.payload as Record<string, unknown>;
      switch (request.method) {
        case 'team.execute':
          return success(
            human.execute({ ...payload, commandId: request.commandId } as TeamCommand)
          );
        case 'team.snapshot':
          return success(human.readSnapshot());
        case 'team.tasks.list':
          return success(payload.deleted ? human.readDeletedTasks() : human.listTasks());
        case 'team.task.get':
          return success(human.getTask(payload.taskId as string));
        case 'team.roster.read':
          return success(human.readRoster());
        case 'team.process.list':
          return success([]);
        case 'team.launch.read':
          return success(null);
        default:
          throw new Error(`Unexpected TEST method ${request.method}`);
      }
    }),
  };
  const facade = new BackendOperationsFacade(router);
  const backend: AgentBackendApi = {
    getConnections: vi.fn().mockResolvedValue({
      state: 'ready',
      bindings: [{ handle, label: 'TEST Host', members: [] }],
    }),
    invoke: vi.fn((request) => facade.invoke(request)),
  };
  const legacy = {
    getDeletedTasks: vi.fn().mockResolvedValue([]),
    getTask: vi.fn(),
    getData: vi.fn(),
    createTask: vi.fn(),
    addTaskComment: vi.fn(),
    softDeleteTask: vi.fn(),
    restoreTask: vi.fn(),
    list: vi.fn().mockResolvedValue([]),
    getAllTasks: vi.fn().mockResolvedValue([]),
  } as unknown as TeamsAPI;
  let current = true;
  const teams = createHostTeamsApi(legacy, backend, () => () => current);
  return {
    root,
    binding,
    owner,
    human,
    backend,
    router,
    legacy,
    teams,
    handle,
    key: hostTeamSelectionKey(handle.handleId),
    revokeContext: () => {
      current = false;
    },
  };
}

async function deletedTask(f: ReturnType<typeof fixture>) {
  const created = await f.teams.createTask(f.key, {
    subject: 'TEST recoverable Task',
    owner: 'team-lead',
    description: 'TEST original description',
    command: { commandId: 'TEST-create-trash', idempotencyKey: 'TEST-create-trash' },
  });
  const ref = { taskId: created.id, displayId: created.displayId ?? created.id, teamName: f.key };
  await f.teams.addTaskComment(f.key, created.id, {
    text: 'TEST retained comment',
    taskRefs: [ref],
    command: { commandId: 'TEST-comment-trash', idempotencyKey: 'TEST-comment-trash' },
  });
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  await f.teams.softDeleteTask(f.key, created.id);
  expect(warning).toHaveBeenCalledExactlyOnceWith(
    `[tasks] retracted 2 queued notification(s) for deleted task ${created.id}`
  );
  warning.mockClear();
  return { created, ref };
}

it('restores a real canonical deleted Task through selected and global Trash without adding it to active boards', async () => {
  const f = fixture();
  const { created, ref } = await deletedTask(f);
  const path = join(f.root, 'tasks', f.binding.teamName, `${created.id}.json`);
  const originalBytes = readFileSync(path, 'utf8');
  const canonical = JSON.parse(originalBytes);
  expect((f.human.readSnapshot() as { tasks: unknown[] }).tasks).toEqual([]);
  const trash = await f.teams.getDeletedTasks(f.key);
  expect(trash).toHaveLength(1);
  expect(trash[0]).toMatchObject({
    id: created.id,
    subject: created.subject,
    owner: 'team-lead',
    status: 'deleted',
    deletedAt: canonical.deletedAt,
    createdAt: canonical.createdAt,
    description: 'TEST original description',
  });
  expect(trash[0].comments?.[0]).toMatchObject({ text: 'TEST retained comment', taskRefs: [ref] });
  expect(await f.teams.getAllTasks()).toEqual([]);
  expect((await f.teams.getData(f.key)).tasks).toEqual([]);
  getDeletedTasks.mockImplementation((key: string) => f.teams.getDeletedTasks(key));
  interface Feed extends DeletedTaskFeed {
    teams: AppState['teams'];
    activeContextId: string;
  }
  const store = create<Feed>()((set, get, api) => ({
    ...createDeletedTaskFeed(set as never, get as never, api as never),
    teams: [{ teamName: f.key, displayName: 'TEST Host' } as AppState['teams'][number]],
    activeContextId: 'TEST-context',
  }));
  await store.getState().fetchAllDeletedTasks();
  expect(store.getState().globalDeletedTasks).toEqual([
    {
      ...trash[0],
      teamName: f.key,
      teamDisplayName: 'TEST Host',
      teamDeleted: undefined,
      projectPath: undefined,
    },
  ]);
  expect(readFileSync(path, 'utf8')).toBe(originalBytes);
  await f.teams.restoreTask(f.key, created.id);
  expect(await f.teams.getDeletedTasks(f.key)).toEqual([]);
  expect((await f.teams.getData(f.key)).tasks.map((task) => task.id)).toEqual([created.id]);
  expect(await f.teams.getTask(f.key, created.id)).toMatchObject({
    id: created.id,
    description: canonical.description,
    comments: trash[0].comments,
  });
  expect(f.legacy.getDeletedTasks).not.toHaveBeenCalled();
  expect(f.legacy.restoreTask).not.toHaveBeenCalled();
  expect(f.router.request).toHaveBeenCalledWith(
    f.handle,
    expect.objectContaining({ method: 'team.tasks.list', payload: { deleted: true } })
  );
});

it.each(['context', 'mutation'] as const)(
  'refuses a held Trash response after the original %s boundary changes',
  async (boundary) => {
    const f = fixture();
    const { created } = await deletedTask(f);
    const invoke = f.backend.invoke;
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.backend.invoke = vi.fn<AgentBackendApi['invoke']>(async (request) => {
      const result = await invoke(request);
      if (request.operation === 'tasks.list' && request.payload.deleted) {
        entered();
        await held;
      }
      return result;
    });
    const read = f.teams.getDeletedTasks(f.key);
    const rejection = expect(read).rejects.toThrow(
      boundary === 'context' ? 'context changed' : 'mutation boundary'
    );
    await started;
    if (boundary === 'context') f.revokeContext();
    else await f.teams.restoreTask(f.key, created.id);
    release();
    await rejection;
    expect(f.legacy.getDeletedTasks).not.toHaveBeenCalled();
  }
);

it('keeps legacy Trash reads unchanged and refuses a missing Host binding without legacy fallback', async () => {
  const f = fixture();
  await expect(f.teams.getDeletedTasks('legacy-team')).resolves.toEqual([]);
  expect(f.legacy.getDeletedTasks).toHaveBeenCalledExactlyOnceWith('legacy-team');
  vi.mocked(f.legacy.getDeletedTasks).mockClear();
  vi.mocked(f.backend.getConnections).mockResolvedValue({ state: 'ready', bindings: [] });
  await expect(f.teams.getDeletedTasks(f.key)).rejects.toThrow('Host team unavailable');
  expect(f.legacy.getDeletedTasks).not.toHaveBeenCalled();
});

it.each([
  { deleted: false },
  { deleted: 'true' },
  { deleted: {} },
  { deleted: true, root: '/TEST' },
])('rejects any nonfinite Trash query %j before transport', (value) => {
  expect(() =>
    parseBackendOperation({
      handle: { handleId: 'TEST' },
      commandId: 'TEST-read',
      operation: 'tasks.list',
      payload: value,
    })
  ).toThrow();
});

it('strictly projects Trash metadata and rejects active rows or private/malformed response shapes', () => {
  const task = {
    id: 'TEST',
    subject: 'TEST',
    status: 'deleted',
    deletedAt: '2026-10-27T00:00:00.000Z',
    privateToken: 'TEST-secret',
  };
  expect(
    projectDeletedTasks({ kind: 'deleted-tasks', teamName: 'TEST', tasks: [task] }).tasks[0]
  ).toEqual({ id: 'TEST', subject: 'TEST', status: 'deleted', deletedAt: task.deletedAt });
  expect(() =>
    projectDeletedTasks({
      kind: 'deleted-tasks',
      teamName: 'TEST',
      tasks: [{ ...task, status: 'pending' }],
    })
  ).toThrow('deleted task');
  expect(() => projectDeletedTasks([])).toThrow('deleted tasks');
});

it.each(['foreign-owner', 'old-active-shape', 'unavailable'] as const)(
  'refuses %s Trash results instead of presenting an empty list or falling back',
  async (failure) => {
    const f = fixture();
    const invoke = f.backend.invoke;
    f.backend.invoke = vi.fn<AgentBackendApi['invoke']>(async (request) => {
      if (request.operation !== 'tasks.list') return invoke(request);
      if (failure === 'unavailable')
        return { ok: false, code: 'unavailable', outcome: 'not-dispatched' };
      if (failure === 'old-active-shape') return { ok: true, value: [] };
      return {
        ok: true,
        value: { kind: 'deleted-tasks', teamName: 'different-canonical-team', tasks: [] },
      };
    });
    await expect(f.teams.getDeletedTasks(f.key)).rejects.toThrow('Host team operation');
    expect(f.legacy.getDeletedTasks).not.toHaveBeenCalled();
  }
);

it('checks original read authority on the canonical Trash port after revocation', () => {
  const f = fixture();
  f.human.revoke('human');
  expect(() => f.human.readDeletedTasks()).toThrow();
});
