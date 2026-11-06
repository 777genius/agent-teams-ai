// @vitest-environment node
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFilesystemTeamOwner } from '@agent-teams/legacy-agent-host/team/filesystem';
import { afterEach, expect, it, vi } from 'vitest';

import { parseBackendOperation } from '../../../src/features/agent-backend/main/adapters/input/validateBackendOperation';
import { projectBackendResult } from '../../../src/features/agent-backend/main/adapters/output/projectBackendResult';
import { projectTeamSnapshot } from '../../../src/features/agent-backend/main/adapters/output/projectTeamSnapshot';
import {
  createHostTeamsApi,
  hostTeamSelectionKey,
} from '../../../src/features/agent-backend/renderer/createHostTeamsApi';
import {
  buildTaskGroupOptions,
  projectTeamTasks,
} from '../../../src/renderer/components/team/kanban/teamTaskProjection';

import type { AgentBackendApi } from '../../../src/features/agent-backend/contracts/operations';
import type { TeamsAPI } from '../../../src/shared/types/api';

const groupId = '10000000-0000-4000-8000-000000000001';
const handle = { handleId: 'TEST-group-task-owner' };
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
const request = (groupChatId?: unknown) => ({
  handle,
  commandId: 'TEST-create',
  operation: 'task.create',
  payload: {
    subject: 'TEST group-origin task',
    ...(groupChatId === undefined ? {} : { groupChatId }),
  },
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-facade-task-group-')));
  roots.push(root);
  const binding = { backendId: 'TEST-backend', teamId: 'TEST-team', teamName: 'test-team' };
  const owner = createFilesystemTeamOwner({
    root,
    binding,
    members: [{ memberId: 'lead', name: 'lead', role: 'lead' }],
    grants: [
      { principalId: 'human', memberName: 'user', permissions: ['read', 'task.write', 'admin'] },
    ],
  });
  const group = {
    id: groupId,
    name: 'TEST origin group',
    createdAt: '2026-10-27T00:00:00.000Z',
    archivedAt: null,
    membership: { kind: 'auto' as const, excludedMemberNames: [] },
  };
  writeFileSync(
    join(root, 'teams', binding.teamName, 'group-chats.json'),
    JSON.stringify({ version: 1, groups: [group] })
  );
  const human = owner.connect('human');
  const backend: AgentBackendApi = {
    getConnections: async () => ({
      state: 'ready',
      bindings: [{ handle, label: 'TEST Team', members: [] }],
    }),
    invoke: vi.fn<AgentBackendApi['invoke']>(async (raw) => {
      const parsed = parseBackendOperation(raw);
      if (parsed.operation === 'team.snapshot')
        return projectBackendResult(parsed, { ok: true, value: human.readSnapshot() });
      if (parsed.operation === 'task.create')
        return projectBackendResult(parsed, {
          ok: true,
          value: human.execute({
            commandId: parsed.commandId,
            operation: parsed.operation,
            payload: parsed.payload,
          }),
        });
      if (parsed.operation === 'task.get')
        return projectBackendResult(parsed, {
          ok: true,
          value: human.getTask(parsed.payload.taskId),
        });
      if (parsed.operation === 'team.roster.read')
        return projectBackendResult(parsed, { ok: true, value: human.readRoster() });
      if (parsed.operation === 'team.launch.read') return { ok: true, value: null };
      if (parsed.operation === 'process.list') return { ok: true, value: [] };
      return { ok: false, code: 'hold', outcome: 'unknown' };
    }),
  };
  const legacy = { createTask: vi.fn(), getData: vi.fn(), getTask: vi.fn() } as unknown as TeamsAPI;
  return {
    root,
    binding,
    group,
    human,
    backend,
    legacy,
    teams: createHostTeamsApi(legacy, backend),
    key: hostTeamSelectionKey(handle.handleId),
  };
}

it('round trips original group-origin CreateTask input through facade, strict Main, canonical owner and existing board projection', async () => {
  const f = fixture();
  const linked = await f.teams.createTask(f.key, {
    subject: 'TEST linked task',
    groupChatId: groupId,
    command: { commandId: 'TEST-linked', idempotencyKey: 'TEST-linked' },
  });
  const unlinked = await f.teams.createTask(f.key, {
    subject: 'TEST ordinary task',
    command: { commandId: 'TEST-unlinked', idempotencyKey: 'TEST-unlinked' },
  });
  expect(linked.groupChatId).toBe(groupId);
  expect(unlinked).not.toHaveProperty('groupChatId');
  expect(f.backend.invoke).toHaveBeenCalledWith(
    expect.objectContaining({
      operation: 'task.create',
      payload: { subject: 'TEST linked task', groupChatId: groupId },
    })
  );
  const persisted = JSON.parse(
    readFileSync(join(f.root, 'tasks', f.binding.teamName, `${linked.id}.json`), 'utf8')
  );
  expect(persisted.groupChatId).toBe(groupId);
  expect(await f.teams.getTask(f.key, linked.id)).toMatchObject({
    id: linked.id,
    groupChatId: groupId,
  });
  const data = await f.teams.getData(f.key);
  expect(data.tasks.find((task) => task.id === linked.id)?.groupChatId).toBe(groupId);
  const visible = projectTeamTasks(
    data.tasks,
    { sessionId: null, selectedOwners: new Set(), columns: new Set(), groupChatId: groupId },
    null
  );
  expect(visible.map((task) => task.id)).toEqual([linked.id]);
  expect(
    buildTaskGroupOptions(
      data.tasks,
      [{ ...f.group, memberNames: ['lead'], availableRecipientNames: [], canSend: false }],
      true,
      groupId
    )
  ).toEqual([{ id: groupId, name: f.group.name, archived: false, unavailable: false, count: 1 }]);
  for (const method of ['createTask', 'getTask', 'getData'] as const)
    expect(f.legacy[method]).not.toHaveBeenCalled();
});

it('admits an optional UUID without coercion and leaves original requests without it unchanged', () => {
  expect(parseBackendOperation(request())).toEqual(request());
  expect(parseBackendOperation(request(groupId))).toEqual(request(groupId));
  const coercion = vi.fn(() => groupId);
  for (const value of [null, '', 1, {}, [], { toString: coercion }, '../other', 'not-a-uuid'])
    expect(() => parseBackendOperation(request(value))).toThrow();
  expect(coercion).not.toHaveBeenCalled();
  expect(() =>
    parseBackendOperation({
      ...request(groupId),
      payload: { ...request(groupId).payload, groupTeamName: 'foreign-team' },
    })
  ).toThrow();
});

it('retains validated association on receipt, Task reads and snapshot but refuses malformed result fields', () => {
  const f = fixture();
  const parsed = parseBackendOperation(request(groupId));
  const receipt = f.human.execute({
    commandId: parsed.commandId,
    operation: 'task.create',
    payload: { subject: 'TEST group-origin task', groupChatId: groupId },
  });
  expect(projectBackendResult(parsed, { ok: true, value: receipt })).toMatchObject({
    ok: true,
    value: { task: { groupChatId: groupId } },
  });
  const snapshot = f.human.readSnapshot();
  expect(projectTeamSnapshot(snapshot).tasks[0]?.groupChatId).toBe(groupId);
  for (const groupChatId of [null, 1, {}, '', 'not-a-uuid']) {
    expect(() =>
      projectBackendResult(parsed, {
        ok: true,
        value: {
          ...receipt,
          result: {
            id: receipt.effects.taskId,
            subject: 'TEST task',
            status: 'pending',
            groupChatId,
          },
        },
      })
    ).toThrow();
    expect(() =>
      projectTeamSnapshot({
        ...(snapshot as object),
        tasks: [
          { id: receipt.effects.taskId, subject: 'TEST task', status: 'pending', groupChatId },
        ],
      })
    ).toThrow();
  }
});
