// @vitest-environment node
import { expect, it, vi } from 'vitest';

import { parseTeamLifecyclePayload } from '../../../src/features/agent-backend/main/adapters/input/teamLifecycleValues';
import { projectTeamLifecycle } from '../../../src/features/agent-backend/main/adapters/output/projectTeamLifecycle';
import { createHostProductLifecycleApi } from '../../../src/features/agent-backend/renderer/createHostProductLifecycleApi';

import type {
  AgentBackendApi,
  BackendOperationRequest,
  BackendOperationResult,
} from '../../../src/features/agent-backend/contracts/operations';
import type { BackendQueuedUserMessages } from '../../../src/features/agent-backend/contracts/teamLifecycle';

const revision = 'a'.repeat(64),
  signature = 'b'.repeat(64),
  handle = { handleId: 'TEST-queue-handle' };
const identity = (index: number) => ({ messageId: 'TEST-message-' + index });
const success = (value: unknown): BackendOperationResult => ({
  ok: true,
  value: value as Extract<BackendOperationResult, { ok: true }>['value'],
});
const page = (indices: number[], nextCursor: string | null): BackendQueuedUserMessages => ({
  kind: 'queued_user_messages',
  member: 'alice',
  messages: indices.map(identity),
  revision,
  nextCursor,
});
function fixture(run: (request: BackendOperationRequest) => Promise<BackendOperationResult>) {
  let current = true;
  const invoke = vi.fn(run),
    resolve = vi.fn(async () => ({ handle })),
    invalidateReads = vi.fn();
  const api = createHostProductLifecycleApi({
    backend: { invoke } as AgentBackendApi,
    captureScope: () => () => current,
    resolve,
    invalidateReads,
  });
  return {
    api,
    invoke,
    resolve,
    invalidateReads,
    invalidate: () => {
      current = false;
    },
  };
}

it('collects every identity at the original handle before exposing a confirmation inventory', async () => {
  let finish!: (value: BackendOperationResult) => void;
  const waiting = new Promise<BackendOperationResult>((done) => {
    finish = done;
  });
  const f = fixture(async () =>
    f.invoke.mock.calls.length === 1 ? success(page([0, 1], '2.' + signature)) : waiting
  );
  let settled = false;
  const result = f.api.getQueuedUserMessages('TEST-original', 'alice').then((value) => {
    settled = true;
    return value;
  });
  await vi.waitFor(() => expect(f.invoke).toHaveBeenCalledTimes(2));
  expect(settled).toBe(false);
  expect(f.resolve).toHaveBeenCalledTimes(1);
  expect(f.invalidateReads).not.toHaveBeenCalled();
  const [first, second] = f.invoke.mock.calls.map(([request]) => request);
  expect(second).toEqual({ ...first, payload: { member: 'alice', cursor: '2.' + signature } });
  finish(success(page([2], null)));
  await expect(result).resolves.toEqual({
    member: 'alice',
    messages: [identity(0), identity(1), identity(2)],
  });
  expect(f.invoke.mock.calls.every(([request]) => request.operation === 'team.queue.read')).toBe(
    true
  );
});

it('accepts a plain empty queue and projects legacy complete rows to identities without inventing blank text', async () => {
  const legacy = {
    kind: 'queued_user_messages',
    member: 'alice',
    messages: [
      {
        ...identity(0),
        text: 'TEST retained exact text',
        timestamp: '2026-11-27T00:00:00.000Z',
        summary: 'TEST summary',
      },
    ],
  };
  const before = structuredClone(legacy);
  const projected = projectTeamLifecycle(legacy, 'team.queue.read', 'TEST-read');
  expect(projected).toEqual({
    kind: 'queued_user_messages',
    member: 'alice',
    messages: [identity(0)],
  });
  expect(legacy).toEqual(before);
  const f = fixture(async () => success(projected));
  await expect(f.api.getQueuedUserMessages('TEST-key', 'alice')).resolves.toEqual({
    member: 'alice',
    messages: [identity(0)],
  });
  const empty = fixture(async () =>
    success({ kind: 'queued_user_messages', member: 'alice', messages: [] })
  );
  await expect(empty.api.getQueuedUserMessages('TEST-key', 'alice')).resolves.toEqual({
    member: 'alice',
    messages: [],
  });
});

it.each([
  ['changed revision', { ...page([1], null), revision: 'c'.repeat(64) }],
  ['duplicate identity', page([0], null)],
  ['empty final page', page([], null)],
  ['repeated cursor', page([1], '1.' + signature)],
  ['skipped identity offset', page([1], '3.' + signature)],
  [
    'missing continuation',
    { kind: 'queued_user_messages', member: 'alice', messages: [identity(1)], revision },
  ],
  [
    'plain page after continuation',
    { kind: 'queued_user_messages', member: 'alice', messages: [identity(1)] },
  ],
  ['different member', { ...page([1], null), member: 'bob' }],
])('refuses %s instead of returning partial discard identities', async (_label, next) => {
  const f = fixture(async () =>
    success(f.invoke.mock.calls.length === 1 ? page([0], '1.' + signature) : next)
  );
  await expect(f.api.getQueuedUserMessages('TEST-key', 'alice')).rejects.toMatchObject({
    code: 'invalid-queue-view',
  });
  expect(f.invoke).toHaveBeenCalledTimes(2);
  expect(f.invalidateReads).not.toHaveBeenCalled();
});

it('rejects duplicates even in unpaged responses and refuses inventory above the existing 4096 bound', async () => {
  for (const messages of [
    [identity(0), identity(0)],
    Array.from({ length: 4097 }, (_, index) => identity(index)),
  ]) {
    const f = fixture(async () =>
      success({ kind: 'queued_user_messages', member: 'alice', messages })
    );
    await expect(f.api.getQueuedUserMessages('TEST-key', 'alice')).rejects.toMatchObject({
      code: 'invalid-queue-view',
    });
    expect(f.invoke).toHaveBeenCalledTimes(1);
  }
});

it('stops at context loss during a page read without resolving a replacement handle or exposing IDs', async () => {
  const f = fixture(async () => {
    if (f.invoke.mock.calls.length === 1) return success(page([0], '1.' + signature));
    f.invalidate();
    return success(page([1], null));
  });
  await expect(f.api.getQueuedUserMessages('TEST-key', 'alice')).rejects.toMatchObject({
    code: 'context-changed',
    outcome: 'not-dispatched',
  });
  expect(f.resolve).toHaveBeenCalledTimes(1);
  expect(f.invoke).toHaveBeenCalledTimes(2);
  expect(f.invalidateReads).not.toHaveBeenCalled();
});

it('Main validates cursor input and paired revision/continuation output while dropping legacy message bodies', () => {
  expect(
    parseTeamLifecyclePayload('team.queue.read', { member: 'alice', cursor: '512.' + signature })
  ).toEqual({ member: 'alice', cursor: '512.' + signature });
  for (const cursor of ['', '0.' + signature, '01.' + signature, '1.bad', 1])
    expect(() =>
      parseTeamLifecyclePayload('team.queue.read', { member: 'alice', cursor })
    ).toThrow();
  expect(projectTeamLifecycle(page([0], null), 'team.queue.read', 'TEST-read')).toEqual(
    page([0], null)
  );
  for (const value of [
    { kind: 'queued_user_messages', member: 'alice', messages: [identity(0)], revision },
    { kind: 'queued_user_messages', member: 'alice', messages: [identity(0)], nextCursor: null },
    { ...page([0], null), revision: 'TEST-invalid' },
    { ...page([0], null), nextCursor: 'TEST-invalid' },
    { ...page([0], null), messages: [identity(0), identity(0)] },
    { ...page([0], null), messages: [{ ...identity(0), text: 'TEST no timestamp' }] },
    { ...page([0], null), messages: [{ ...identity(0), privateIntent: 'TEST-private' }] },
  ])
    expect(() => projectTeamLifecycle(value, 'team.queue.read', 'TEST-read')).toThrow();
});
