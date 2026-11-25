// @vitest-environment node
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { createHostServer } from '@agent-teams/legacy-agent-host';
import { DEFAULT_HOST_LIMITS, HOST_PROTOCOL_VERSION } from '@agent-teams/legacy-agent-host/contracts';
import { createFilesystemTeamOwner } from '@agent-teams/legacy-agent-host/team/filesystem';
import { afterEach, expect, it, vi } from 'vitest';

import { BackendOperationsFacade } from '../../../src/features/agent-backend/main/adapters/input/BackendOperationsFacade';
import {
  createHostTeamsApi,
  hostTeamSelectionKey,
} from '../../../src/features/agent-backend/renderer/createHostTeamsApi';
import { TeamProductReadOrder } from '../../../src/features/agent-backend/renderer/TeamProductReadOrder';

import type { AgentBackendApi } from '../../../src/features/agent-backend/contracts/operations';
import type { BackendOwnerRouter } from '../../../src/features/agent-backend/main/application/BackendOwnerRouter';
import type { TeamsAPI } from '../../../src/shared/types/api';
import type { HostTaskActivityView } from '../../../src/shared/types/teamActivity';
import type { HostMethod } from '@agent-teams/legacy-agent-host';
import type { JsonValue } from '@agent-teams/legacy-agent-host/contracts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
});

async function fixture(deleted = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-host-task-activity-')));
  const binding = { backendId: 'TEST-backend', teamId: 'TEST-team', teamName: 'test-activity' };
  const owner = createFilesystemTeamOwner({
    root,
    binding,
    members: [{ memberId: 'lead', name: 'team-lead', role: 'lead' }],
    grants: [{ principalId: 'human', memberName: 'user', permissions: ['read', 'task.write', 'admin'] }],
  });
  const human = owner.connect('human');
  const taskId = human.execute({
    commandId: 'TEST-create',
    operation: 'task.create',
    payload: { subject: 'TEST retained Activity', owner: 'team-lead' },
  }).effects.taskId;
  if (deleted) {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      human.execute({
        commandId: 'TEST-delete', operation: 'task.lifecycle', payload: { taskId, action: 'delete' },
      });
    } finally { warning.mockRestore(); }
  }
  const path = join(root, 'tasks', binding.teamName, `${taskId}.json`);
  const canonical = JSON.parse(readFileSync(path, 'utf8'));
  // Seed retained TEST storage directly; the read uses the real canonical Owner and wire pager.
  canonical.comments = Array.from({ length: 180 }, (_, index) => ({
    id: `TEST-comment-${index}`, author: 'user', text: `TEST-${index}-` + 'x'.repeat(6000),
    createdAt: '2026-11-25T00:00:00.000Z', type: 'regular',
  }));
  canonical.historyEvents = [...(canonical.historyEvents ?? []), ...Array.from({ length: 180 }, (_, index) => ({
    id: `TEST-history-${index}`, timestamp: '2026-11-25T00:00:00.000Z', actor: 'user',
    type: 'status_changed', from: 'pending', to: 'in_progress',
  }))];
  writeFileSync(path, JSON.stringify(canonical));
  expect(Buffer.byteLength(JSON.stringify(human.getTask(taskId))))
    .toBeGreaterThan(DEFAULT_HOST_LIMITS.maxFrameBytes);

  const input = new PassThrough(), output = new PassThrough();
  const frameBytes: number[] = [];
  const pending = new Map<number, { resolve(value: JsonValue): void; reject(error: Error): void }>();
  let tail = '', nextId = 0, closeReason: string | undefined;
  output.on('data', (chunk: Buffer) => {
    tail += chunk.toString('utf8');
    let newline: number;
    while ((newline = tail.indexOf('\n')) >= 0) {
      const frame = tail.slice(0, newline);
      tail = tail.slice(newline + 1);
      frameBytes.push(Buffer.byteLength(frame));
      const row = JSON.parse(frame);
      const request = pending.get(row.id);
      if (!request) continue;
      pending.delete(row.id);
      if (row.error) request.reject(new Error(`TEST Host RPC ${row.error.code}`));
      else request.resolve(row.result);
    }
  });
  const success = (value: unknown): JsonValue => JSON.parse(JSON.stringify({ ok: true, value }));
  const method = (read: (payload: Record<string, JsonValue>) => unknown): HostMethod => ({
    lane: 'work', handle: (payload) => success(read(payload as Record<string, JsonValue>)),
  });
  const server = createHostServer({
    input, output, buildId: 'TEST-task-activity-paging',
    methods: {
      'team.snapshot': method((payload) => human.readSnapshot(payload.cursor ? { cursor: payload.cursor as string } : {})),
      'team.tasks.list': method((payload) => human.readDeletedTasks(payload.cursor ? { cursor: payload.cursor as string } : {})),
      'team.task.get': method((payload) => human.getTask(payload.taskId as string)),
      'team.activity.logs.read': method(() => ({ kind: 'team-activity-logs', logs: [] })),
    },
  });
  void server.closed.then(({ reason }) => {
    closeReason = reason;
    for (const request of pending.values()) request.reject(new Error(`TEST Host closed: ${reason}`));
    pending.clear();
  });
  cleanup.push(async () => {
    await server.dispose();
    input.destroy();
    output.destroy();
    rmSync(root, { recursive: true, force: true });
  });
  function request(method: string, params: JsonValue): Promise<JsonValue> {
    if (closeReason) return Promise.reject(new Error(`TEST Host closed: ${closeReason}`));
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  await request('host.handshake', { protocolVersion: HOST_PROTOCOL_VERSION });
  const handle = { handleId: 'TEST-original-owner' };
  const router = {
    lookup: vi.fn<BackendOwnerRouter['lookup']>(),
    request: vi.fn<BackendOwnerRouter['request']>(async (captured, value) => {
      expect(captured).toEqual(handle);
      return request(value.method, value.payload);
    }),
  };
  const facade = new BackendOperationsFacade(router);
  const backend: AgentBackendApi = {
    getConnections: vi.fn().mockResolvedValue({
      state: 'ready', bindings: [{ handle, label: 'TEST Host', members: [] }],
    }),
    invoke: vi.fn((request) => facade.invoke(request)),
  };
  const legacy = { getTask: vi.fn(), getTaskActivity: vi.fn() } as unknown as TeamsAPI;
  let current = true;
  const captureScope = vi.fn(() => () => current);
  const readOrder = new TeamProductReadOrder();
  const teams = createHostTeamsApi(legacy, backend, captureScope, readOrder);
  return {
    backend, canonical, captureScope, handle, legacy, path, readOrder, request, router, server,
    taskId, teams, frameBytes, key: hostTeamSelectionKey(handle.handleId),
    closed: () => closeReason,
    revoke: () => { current = false; },
  };
}

it('negative control: the same retained task closes the actual Host on an unpaged task.get', async () => {
  const f = await fixture();
  await expect(f.request('team.task.get', { taskId: f.taskId })).rejects.toThrow('priority_overflow');
  expect((await f.server.closed).reason).toBe('priority_overflow');
});

it.each([false, true])('retains all canonical Activity history for an oversized task (deleted=%s) through bounded pages', async (deleted) => {
  const f = await fixture(deleted);
  const activity = await f.teams.getTaskActivity(f.key, f.taskId) as HostTaskActivityView;
  expect(activity.kind).toBe('host_task_activity');
  expect(activity.historyEvents).toEqual(f.canonical.historyEvents);
  expect(activity.items).toEqual([]);
  expect(activity.gaps).toEqual([]);
  const operation = deleted ? 'tasks.list' : 'team.snapshot';
  const pages = vi.mocked(f.backend.invoke).mock.calls.filter(([read]) => read.operation === operation);
  expect(pages.length).toBeGreaterThan(1);
  expect(pages[0]![0].payload).not.toHaveProperty('cursor');
  expect(pages.at(-1)![0].payload).toHaveProperty('cursor');
  expect(f.frameBytes.every((bytes) => bytes <= DEFAULT_HOST_LIMITS.maxFrameBytes)).toBe(true);
  expect(f.closed()).toBeUndefined();
  expect(f.captureScope).toHaveBeenCalledTimes(1);
  expect(f.router.request).not.toHaveBeenCalledWith(f.handle, expect.objectContaining({ method: 'team.task.get' }));
  expect(f.legacy.getTaskActivity).not.toHaveBeenCalled();
});

it.each(['context', 'mutation'] as const)('rejects delayed Activity continuation across the original %s boundary', async (boundary) => {
  const f = await fixture();
  const invoke = vi.mocked(f.backend.invoke).getMockImplementation()!;
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  vi.mocked(f.backend.invoke).mockImplementation(async (request) => {
    const result = await invoke(request);
    if (request.operation === 'team.snapshot' && request.payload.cursor) {
      entered();
      await held;
    }
    return result;
  });
  const read = f.teams.getTaskActivity(f.key, f.taskId);
  const rejection = expect(read).rejects.toThrow(boundary === 'context' ? 'context changed' : 'mutation boundary');
  await started;
  if (boundary === 'context') f.revoke();
  else f.readOrder.invalidateReads(f.handle.handleId);
  release();
  await rejection;
  expect(vi.mocked(f.backend.invoke).mock.calls.filter(([request]) => request.operation === 'team.snapshot')).toHaveLength(2);
  expect(f.captureScope).toHaveBeenCalledTimes(1);
  expect(f.closed()).toBeUndefined();
  expect(f.legacy.getTaskActivity).not.toHaveBeenCalled();
  if (boundary === 'mutation') {
    // An original mutation fence must never be retained as the global context predicate.
    vi.mocked(f.backend.invoke).mockImplementation(invoke);
    const fresh = await f.teams.getTaskActivity(f.key, f.taskId) as HostTaskActivityView;
    expect(fresh.historyEvents).toEqual(f.canonical.historyEvents);
    expect(f.captureScope).toHaveBeenCalledTimes(2);
  }
});

it('rejects a changed canonical revision between Activity pages without publishing partial history', async () => {
  const f = await fixture();
  const invoke = vi.mocked(f.backend.invoke).getMockImplementation()!;
  vi.mocked(f.backend.invoke).mockImplementation(async (request) => {
    const result = await invoke(request);
    if (request.operation === 'team.snapshot' && !request.payload.cursor)
      writeFileSync(f.path, JSON.stringify({ ...f.canonical, subject: 'TEST changed revision' }));
    return result;
  });
  await expect(f.teams.getTaskActivity(f.key, f.taskId)).rejects.toThrow();
  expect(vi.mocked(f.backend.invoke).mock.calls.filter(([request]) => request.operation === 'team.snapshot')).toHaveLength(2);
  expect(f.closed()).toBeUndefined();
  expect(f.legacy.getTaskActivity).not.toHaveBeenCalled();
});
