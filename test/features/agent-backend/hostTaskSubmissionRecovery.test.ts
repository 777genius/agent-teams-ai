// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFilesystemTeamOwner } from '@agent-teams/legacy-agent-host/team/filesystem';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { HostTaskSubmissionRefusal } from '../../../src/features/agent-backend/contracts/taskSubmission';
import { parseBackendOperation } from '../../../src/features/agent-backend/main/adapters/input/validateBackendOperation';
import { projectBackendResult } from '../../../src/features/agent-backend/main/adapters/output/projectBackendResult';
import { createHostTeamMutations } from '../../../src/features/agent-backend/renderer/createHostTeamMutations';
import {
  __resetRetainedTaskSubmissionsForTests,
  acknowledgeHostTaskSubmission,
} from '../../../src/features/agent-backend/renderer/retainedTaskSubmissions';

import type {
  AgentBackendApi,
  BackendOperationRequest,
  BackendOperationResult,
} from '../../../src/features/agent-backend/contracts/operations';

const roots: string[] = [];
beforeEach(__resetRetainedTaskSubmissionsForTests);
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
const identity = (commandId = 'TEST-comment') => ({ commandId, idempotencyKey: commandId });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-task-submission-')));
  roots.push(root);
  const owner = createFilesystemTeamOwner({
    root,
    binding: { backendId: 'TEST-backend', teamId: 'TEST-team', teamName: 'test-team' },
    members: [{ memberId: 'lead', name: 'lead', role: 'lead' }],
    grants: [
      { principalId: 'human', memberName: 'user', permissions: ['read', 'task.write'] },
      { principalId: 'admin', memberName: 'user', permissions: ['read', 'admin'] },
    ],
  });
  const human = owner.connect('human');
  const seed = human.execute({
    commandId: 'TEST-seed',
    operation: 'task.create',
    payload: { subject: 'TEST seed' },
  });
  const taskId = seed.effects.taskId,
    handle = { handleId: 'TEST-original' };
  let current = true,
    drop = true;
  let intercept:
    | ((request: BackendOperationRequest) => Promise<BackendOperationResult> | undefined)
    | undefined;
  const invoke = vi.fn<AgentBackendApi['invoke']>(async (raw) => {
    const request = parseBackendOperation(raw);
    const intercepted = intercept?.(request);
    if (intercepted) return intercepted;
    if (request.operation === 'command.lookup')
      return projectBackendResult(request, {
        ok: true,
        value: human.lookup(request.commandId) ?? null,
      });
    if (request.operation !== 'task.comment' && request.operation !== 'task.create')
      throw new Error('Unexpected operation');
    const receipt = human.execute({
      commandId: request.commandId,
      operation: request.operation,
      payload: request.payload,
    } as never);
    if (drop) {
      drop = false;
      throw new Error('TEST lost ACK after commit');
    }
    return projectBackendResult(request, { ok: true, value: receipt });
  });
  const backend: AgentBackendApi = { invoke, getConnections: vi.fn() };
  const resolve = vi.fn(async () => ({ handle, teamName: 'test-team' }));
  const adapter = () =>
    createHostTeamMutations({ backend, resolve, captureScope: () => () => current });
  return {
    root,
    owner,
    human,
    taskId,
    handle,
    invoke,
    resolve,
    adapter,
    setCurrent(value: boolean) {
      current = value;
    },
    keepAck() {
      drop = false;
    },
    intercept(fn: typeof intercept) {
      intercept = fn;
    },
  };
}
it('recovers a real filesystem comment after lost ACK by one original lookup, without second command/effect/resolve', async () => {
  const f = fixture(),
    request = { text: 'TEST original', command: identity() };
  await expect(
    f.adapter().addTaskComment('host-team:TEST-original', f.taskId, request)
  ).rejects.toMatchObject({ outcome: 'unknown' });
  expect(f.human.getTask(f.taskId).comments).toHaveLength(1);
  const comment = await f
    .adapter()
    .addTaskComment('host-team:TEST-original', f.taskId, structuredClone(request));
  expect(comment).toMatchObject({
    id: (f.human.getTask(f.taskId) as { comments?: { id: string }[] }).comments?.[0]?.id,
    text: request.text,
  });
  expect(f.invoke.mock.calls.map(([r]) => r.operation)).toEqual(['task.comment', 'command.lookup']);
  expect(f.invoke.mock.calls.every(([r]) => r.handle.handleId === f.handle.handleId)).toBe(true);
  expect(f.resolve).toHaveBeenCalledTimes(1);
  expect(f.human.getTask(f.taskId).comments).toHaveLength(1);
  acknowledgeHostTaskSubmission('host-team:TEST-original', request.command.commandId);
});
it('holds changed payload and changed owner after actual committed lost ACK', async () => {
  const f = fixture(),
    request = { text: 'TEST original', command: identity() };
  await expect(
    f.adapter().addTaskComment('host-team:TEST-original', f.taskId, request)
  ).rejects.toMatchObject({ outcome: 'unknown' });
  await expect(
    f
      .adapter()
      .addTaskComment('host-team:TEST-original', f.taskId, { ...request, text: 'TEST changed' })
  ).rejects.toMatchObject({ code: 'submission-payload-conflict', outcome: 'unknown' });
  f.setCurrent(false);
  await expect(
    f.adapter().addTaskComment('host-team:TEST-original', f.taskId, request)
  ).rejects.toMatchObject({ code: 'context-changed', outcome: 'unknown' });
  expect(f.invoke).toHaveBeenCalledTimes(1);
  expect(f.human.getTask(f.taskId).comments).toHaveLength(1);
});
it('revocation before original lookup remains UNKNOWN despite the original committed effect', async () => {
  const f = fixture(),
    request = { text: 'TEST original', command: identity() };
  await expect(
    f.adapter().addTaskComment('host-team:TEST-original', f.taskId, request)
  ).rejects.toMatchObject({ outcome: 'unknown' });
  f.owner.connect('admin').revoke('human');
  await expect(
    f.adapter().addTaskComment('host-team:TEST-original', f.taskId, request)
  ).rejects.toMatchObject({ code: 'lookup-unavailable', outcome: 'unknown' });
  expect(f.invoke.mock.calls.map(([r]) => r.operation)).toEqual(['task.comment', 'command.lookup']);
});
it.each([
  null,
  { ok: false, code: 'forbidden', outcome: 'rejected' },
  { ok: false, code: 'hold', outcome: 'unknown' },
])('never releases an UNKNOWN obligation on absent or failed lookup %j', async (value) => {
  const f = fixture(),
    request = { text: 'TEST original', command: identity() };
  await expect(
    f.adapter().addTaskComment('host-team:TEST-original', f.taskId, request)
  ).rejects.toMatchObject({ outcome: 'unknown' });
  f.intercept((request) =>
    request.operation === 'command.lookup'
      ? Promise.resolve(
          value === null ? { ok: true, value: null } : (value as BackendOperationResult)
        )
      : undefined
  );
  await expect(
    f.adapter().addTaskComment('host-team:TEST-original', f.taskId, request)
  ).rejects.toMatchObject({ outcome: 'unknown' });
  await expect(
    f.adapter().addTaskComment('host-team:TEST-original', f.taskId, { ...request, text: 'Changed' })
  ).rejects.toMatchObject({ code: 'submission-payload-conflict' });
  expect(f.human.getTask(f.taskId).comments).toHaveLength(1);
});
it('releases only an initial finite rejected result plus authoritative original absence, allowing correction', async () => {
  const f = fixture(),
    request = { text: 'TEST original', command: identity() };
  f.intercept((request) =>
    request.operation === 'task.comment'
      ? Promise.resolve({ ok: false, code: 'invalid', outcome: 'rejected' })
      : undefined
  );
  await expect(
    f.adapter().addTaskComment('host-team:TEST-original', f.taskId, request)
  ).rejects.toBeInstanceOf(HostTaskSubmissionRefusal);
  expect(f.human.getTask(f.taskId).comments ?? []).toHaveLength(0);
  expect(f.invoke.mock.calls.map(([r]) => r.operation)).toEqual(['task.comment', 'command.lookup']);
  f.intercept(undefined);
  f.keepAck();
  await expect(
    f
      .adapter()
      .addTaskComment('host-team:TEST-original', f.taskId, { ...request, text: 'TEST corrected' })
  ).resolves.toMatchObject({ text: 'TEST corrected' });
});
it('holds an initial finite rejection when original lookup proves a published receipt', async () => {
  const f = fixture(),
    request = { text: 'TEST original', command: identity() };
  f.intercept((request) => {
    if (request.operation !== 'task.comment') return undefined;
    f.human.execute({
      commandId: request.commandId,
      operation: 'task.comment',
      payload: request.payload,
    });
    return Promise.resolve({ ok: false, code: 'forbidden', outcome: 'rejected' });
  });
  await expect(
    f.adapter().addTaskComment('host-team:TEST-original', f.taskId, request)
  ).rejects.not.toBeInstanceOf(HostTaskSubmissionRefusal);
  await expect(
    f.adapter().addTaskComment('host-team:TEST-original', f.taskId, { ...request, text: 'Changed' })
  ).rejects.toMatchObject({ code: 'submission-payload-conflict' });
  expect(f.human.getTask(f.taskId).comments).toHaveLength(1);
});
it('rejects malformed actual comment effect/task correlation at the strict Main boundary', () => {
  const f = fixture();
  f.keepAck();
  const request = parseBackendOperation({
    handle: f.handle,
    commandId: 'TEST-comment',
    operation: 'task.comment',
    payload: { taskId: f.taskId, text: 'TEST original' },
  });
  const receipt = f.human.execute({
    commandId: request.commandId,
    operation: 'task.comment',
    payload: { taskId: f.taskId, text: 'TEST original' },
  });
  expect(projectBackendResult(request, { ok: true, value: receipt })).toMatchObject({
    ok: true,
    value: {
      taskSubmission: {
        commandId: request.commandId,
        operation: 'task.comment',
        payload: request.payload,
      },
    },
  });
  const badComment = structuredClone(receipt);
  (badComment.result as { comment: { id: string } }).comment.id = 'WRONG';
  expect(() => projectBackendResult(request, { ok: true, value: badComment })).toThrow();
  const badTask = structuredClone(receipt);
  (badTask.result as { task: { id: string } }).task.id = 'WRONG';
  expect(() => projectBackendResult(request, { ok: true, value: badTask })).toThrow();
});

it('fences simultaneous submissions and retains a completed unacked result for a failed caller workflow', async () => {
  const f = fixture(),
    request = { text: 'TEST original', command: identity() };
  let release!: (result: BackendOperationResult) => void;
  f.intercept((command) =>
    command.operation === 'task.comment'
      ? new Promise((resolve) => {
          release = resolve;
        })
      : undefined
  );
  const pending = f.adapter().addTaskComment('host-team:TEST-original', f.taskId, request);
  await vi.waitFor(() => expect(f.invoke).toHaveBeenCalledTimes(1));
  await expect(
    f.adapter().addTaskComment('host-team:TEST-original', f.taskId, request)
  ).rejects.toMatchObject({ code: 'submission-pending' });
  const raw = f.invoke.mock.calls[0]![0];
  const receipt = f.human.execute({
    commandId: raw.commandId,
    operation: 'task.comment',
    payload: { taskId: f.taskId, text: request.text },
  });
  release(projectBackendResult(raw, { ok: true, value: receipt }));
  await pending;
  await f.adapter().addTaskComment('host-team:TEST-original', f.taskId, request);
  expect(f.invoke.mock.calls.map(([r]) => r.operation)).toEqual(['task.comment', 'command.lookup']);
});
it.each(['prepared', 'applying', 'held', 'rejected'] as const)(
  'keeps original intent for noncompleted original lookup phase %s',
  async (phase) => {
    const f = fixture(),
      request = { text: 'TEST original', command: identity() };
    await expect(
      f.adapter().addTaskComment('host-team:TEST-original', f.taskId, request)
    ).rejects.toMatchObject({ outcome: 'unknown' });
    f.intercept((lookup) =>
      lookup.operation === 'command.lookup'
        ? Promise.resolve({
            ok: true,
            value: { commandId: 'TEST-comment', operation: 'task.comment', phase },
          })
        : undefined
    );
    await expect(
      f.adapter().addTaskComment('host-team:TEST-original', f.taskId, request)
    ).rejects.toMatchObject({ outcome: 'unknown' });
    await expect(
      f
        .adapter()
        .addTaskComment('host-team:TEST-original', f.taskId, { ...request, text: 'CHANGED' })
    ).rejects.toMatchObject({ code: 'submission-payload-conflict' });
  }
);
it('does not re-upload attachments after a lost comment ACK and validates original metadata on lookup', async () => {
  const handle = { handleId: 'TEST-original' },
    data = btoa('TEST attachment'),
    digest = createHash('sha256').update('TEST attachment').digest('hex');
  const reference = { artifactId: 'TEST-artifact', mimeType: 'text/plain', byteLength: 15, digest };
  let receipt: unknown;
  const invoke = vi.fn<AgentBackendApi['invoke']>(async (request) => {
    if (request.operation === 'attachment.upload')
      return { ok: true, value: { nextOffset: null, reference } };
    if (request.operation === 'command.lookup') return { ok: true, value: receipt as never };
    if (request.operation !== 'task.comment') throw new Error('Unexpected operation');
    receipt = {
      commandId: request.commandId,
      operation: request.operation,
      phase: 'completed',
      taskSubmission: {
        commandId: request.commandId,
        operation: request.operation,
        payload: request.payload,
      },
      comment: {
        id: 'TEST-comment',
        text: request.payload.text,
        author: 'user',
        type: 'regular',
        createdAt: '2026-10-27',
        attachments: [{ id: 'TEST-file', filename: 'small.txt', mimeType: 'text/plain', size: 15 }],
      },
    };
    throw new Error('TEST lost ACK');
  });
  const resolve = vi.fn(async () => ({ handle, teamName: 'test-team' }));
  const adapter = createHostTeamMutations({
    backend: { invoke, getConnections: vi.fn() },
    resolve,
    captureScope: () => () => true,
  });
  const request = {
    text: 'TEST with attachment',
    command: identity(),
    attachments: [
      { id: 'TEST-file', filename: 'small.txt', mimeType: 'text/plain', base64Data: data },
    ],
  };
  await expect(
    adapter.addTaskComment('host-team:TEST-original', 'TEST-task', request)
  ).rejects.toMatchObject({ outcome: 'unknown' });
  await expect(
    adapter.addTaskComment('host-team:TEST-original', 'TEST-task', request)
  ).resolves.toMatchObject({ id: 'TEST-comment' });
  expect(invoke.mock.calls.map(([r]) => r.operation)).toEqual([
    'attachment.upload',
    'task.comment',
    'command.lookup',
  ]);
  expect(resolve).toHaveBeenCalledTimes(1);
  (receipt as { comment: { attachments: { size: number }[] } }).comment.attachments[0]!.size = 999;
  await expect(
    adapter.addTaskComment('host-team:TEST-original', 'TEST-task', request)
  ).rejects.toMatchObject({ code: 'invalid-attachments' });
});
it('acknowledges normal completed workflows without a quota on successful history', async () => {
  const handle = { handleId: 'TEST-original' };
  const invoke = vi.fn<AgentBackendApi['invoke']>(async (request) => {
    if (request.operation !== 'task.comment') throw new Error('Unexpected operation');
    return {
      ok: true,
      value: {
        commandId: request.commandId,
        operation: request.operation,
        phase: 'completed',
        taskSubmission: {
          commandId: request.commandId,
          operation: request.operation,
          payload: request.payload,
        },
        comment: {
          id: request.commandId,
          text: request.payload.text,
          author: 'user',
          type: 'regular',
          createdAt: '2026-10-27',
        },
      },
    };
  });
  const adapter = createHostTeamMutations({
    backend: { invoke, getConnections: vi.fn() },
    resolve: async () => ({ handle, teamName: 'test-team' }),
    captureScope: () => () => true,
  });
  for (let index = 0; index < 260; index++) {
    const command = identity(`TEST-success-${index}`);
    await adapter.addTaskComment('host-team:TEST-original', 'TEST-task', {
      text: `TEST ${index}`,
      command,
    });
    acknowledgeHostTaskSubmission('host-team:TEST-original', command.commandId);
  }
  expect(invoke).toHaveBeenCalledTimes(260);
});

it('correlates the raw canonical command while accepting actual trimmed create subjects and unchanged comment whitespace', async () => {
  const f = fixture();
  f.keepAck();
  const created = await f.adapter().createTask('host-team:TEST-original', {
    subject: '  TEST whitespace task  ',
    command: identity('TEST-whitespace-create'),
  });
  expect(created.subject).toBe('TEST whitespace task');
  const comment = await f.adapter().addTaskComment('host-team:TEST-original', created.id, {
    text: '  TEST comment whitespace  ',
    command: identity('TEST-whitespace-comment'),
  });
  expect(comment.text).toBe('  TEST comment whitespace  ');
  expect(
    (f.human.lookup('TEST-whitespace-create')!.command.payload as { subject: string }).subject
  ).toBe('  TEST whitespace task  ');
});
it.each([false, true])(
  'releases only a correlated actual no-effect policy receipt after lost ACK=%s',
  async (lostAck) => {
    const f = fixture();
    if (!lostAck) f.keepAck();
    const request = {
      subject: 'TEST invalid blocker',
      blockedBy: ['TEST-missing'],
      command: identity('TEST-policy-rejection'),
    };
    if (lostAck)
      await expect(
        f.adapter().createTask('host-team:TEST-original', request)
      ).rejects.toMatchObject({ outcome: 'unknown' });
    await expect(f.adapter().createTask('host-team:TEST-original', request)).rejects.toBeInstanceOf(
      HostTaskSubmissionRefusal
    );
    expect(f.human.lookup(request.command.commandId)).toMatchObject({
      phase: 'rejected',
      result: { rejected: true, reason: 'policy' },
    });
    expect(f.human.listTasks()).toHaveLength(1);
    await expect(
      f.adapter().createTask('host-team:TEST-original', {
        subject: 'TEST corrected',
        command: identity('TEST-corrected'),
      })
    ).resolves.toMatchObject({ subject: 'TEST corrected' });
    expect(f.human.listTasks()).toHaveLength(2);
  }
);
it('requires an exact original command and exact no-effect marker at Main and renderer boundaries', async () => {
  const f = fixture();
  f.keepAck();
  const request = parseBackendOperation({
    handle: f.handle,
    commandId: 'TEST-rejected',
    operation: 'task.create',
    payload: { subject: 'TEST invalid blocker', blockedBy: ['TEST-missing'] },
  });
  const receipt = f.human.execute({
    commandId: request.commandId,
    operation: 'task.create',
    payload: { subject: 'TEST invalid blocker', blockedBy: ['TEST-missing'] },
  });
  expect(projectBackendResult(request, { ok: true, value: receipt })).toMatchObject({
    ok: true,
    value: { taskSubmissionNoEffect: true },
  });
  for (const result of [
    { rejected: true, reason: 'policy', extra: true },
    { rejected: true },
    { rejected: false, reason: 'policy' },
    { rejected: true, reason: 'other' },
  ])
    expect(() =>
      projectBackendResult(request, { ok: true, value: { ...receipt, result } })
    ).toThrow();
  expect(() =>
    projectBackendResult(request, {
      ok: true,
      value: { ...receipt, command: { ...receipt.command, commandId: 'WRONG' } },
    })
  ).toThrow();
  expect(() =>
    projectBackendResult(request, {
      ok: true,
      value: { ...receipt, command: { ...receipt.command, unknownField: true } },
    })
  ).toThrow();
  const original = { text: 'TEST original', command: identity() };
  f.intercept((command) =>
    command.operation === 'task.comment'
      ? Promise.resolve({
          ok: true,
          value: {
            commandId: command.commandId,
            operation: command.operation,
            phase: 'rejected',
            taskSubmissionNoEffect: true,
            taskSubmission: {
              commandId: command.commandId,
              operation: command.operation,
              payload: { ...command.payload, text: 'WRONG ORIGINAL' },
            },
          },
        })
      : undefined
  );
  await expect(
    f.adapter().addTaskComment('host-team:TEST-original', f.taskId, original)
  ).rejects.toMatchObject({ code: 'invalid-correlation', outcome: 'unknown' });
  await expect(
    f
      .adapter()
      .addTaskComment('host-team:TEST-original', f.taskId, { ...original, text: 'Changed' })
  ).rejects.toMatchObject({ code: 'submission-payload-conflict' });
});

it('releases a typed initial not-dispatched refusal without treating any lookup failure as proof', async () => {
  const f = fixture(),
    request = { text: 'TEST initial invalid', command: identity() };
  f.intercept((command) =>
    command.operation === 'task.comment'
      ? Promise.resolve({ ok: false, code: 'invalid', outcome: 'not-dispatched' })
      : undefined
  );
  await expect(
    f.adapter().addTaskComment('host-team:TEST-original', f.taskId, request)
  ).rejects.toBeInstanceOf(HostTaskSubmissionRefusal);
  expect(f.invoke.mock.calls.map(([r]) => r.operation)).toEqual(['task.comment']);
  f.intercept(undefined);
  f.keepAck();
  await expect(
    f
      .adapter()
      .addTaskComment('host-team:TEST-original', f.taskId, { ...request, text: 'TEST corrected' })
  ).resolves.toMatchObject({ text: 'TEST corrected' });
});
it('does not classify generic rejected outcomes as finite absence proof', async () => {
  const f = fixture(),
    request = { text: 'TEST original', command: identity() };
  f.intercept((command) =>
    command.operation === 'task.comment'
      ? Promise.resolve({ ok: false, code: 'busy', outcome: 'rejected' })
      : undefined
  );
  await expect(
    f.adapter().addTaskComment('host-team:TEST-original', f.taskId, request)
  ).rejects.not.toBeInstanceOf(HostTaskSubmissionRefusal);
  expect(f.invoke.mock.calls.map(([r]) => r.operation)).toEqual(['task.comment']);
  await expect(
    f.adapter().addTaskComment('host-team:TEST-original', f.taskId, { ...request, text: 'Changed' })
  ).rejects.toMatchObject({ code: 'submission-payload-conflict' });
});
