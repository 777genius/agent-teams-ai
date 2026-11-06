// @vitest-environment node
import { expect, it, vi } from 'vitest';

import { captureProviderManagement } from '../../../src/features/agent-backend/main/infrastructure/CapturedProviderManagement';
import type { ProviderManagementOperation } from '../../../src/features/agent-backend/main';
import type { JsonValue } from '@agent-teams/legacy-agent-host/contracts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  let current = true,
    available = true;
  const opening = deferred<void>();
  const reply = deferred<JsonValue>();
  let blockReply = false;
  const requests: { method: string; params?: JsonValue; control?: boolean }[] = [];
  const client = {
    async request(
      method: string,
      params?: JsonValue,
      options: { control?: boolean } = {}
    ): Promise<JsonValue> {
      requests.push({
        method,
        ...(params === undefined ? {} : { params }),
        ...(options.control === undefined ? {} : { control: options.control }),
      });
      return blockReply ? reply.promise : { ok: true, value: null };
    },
  };
  const start = vi.fn(() => opening.promise);
  const capture = captureProviderManagement({
    targetId: 'TEST-private-target',
    profileId: 'TEST-original',
    configRevision: 'TEST-v1',
    client,
    start,
    ownerAvailable: () => available,
    foregroundCurrent: () => current,
  });
  return {
    capture,
    opening,
    reply,
    requests,
    start,
    changeContext: () => {
      current = false;
    },
    closeOwner: () => {
      available = false;
    },
    blockReply: () => {
      blockReply = true;
    },
  };
}

it('captures management payload before lazy startup and fixes account/config selection', async () => {
  const f = fixture();
  const payload = {
    commandId: 'TEST-intent',
    kind: 'credential.set',
    providerId: 'TEST-provider',
    key: 'TEST-original-key',
    metadata: { plan: 'TEST-original-plan' },
  };
  const pending = f.capture.request('credential', payload);
  payload.providerId = 'TEST-another';
  payload.key = 'TEST-different';
  payload.metadata.plan = 'TEST-different';
  f.opening.resolve();
  await pending;
  expect(f.requests).toEqual([
    {
      method: 'management.credential',
      control: false,
      params: {
        commandId: 'TEST-intent',
        kind: 'credential.set',
        providerId: 'TEST-provider',
        key: 'TEST-original-key',
        metadata: { plan: 'TEST-original-plan' },
        profileId: 'TEST-original',
        configRevision: 'TEST-v1',
      },
    },
  ]);
  expect(Object.isFrozen(f.capture)).toBe(true);
});

it('context change during startup prevents a new write while original cancellation still targets its captured owner', async () => {
  const f = fixture();
  const pending = f.capture.request('oauth.complete', {
    operationId: 'TEST-original-flow',
    commandId: 'TEST-code',
    code: 'TEST-code',
  });
  f.changeContext();
  f.opening.resolve();
  await expect(pending).rejects.toMatchObject({ code: 'forbidden', outcome: 'not-dispatched' });
  expect(f.requests).toEqual([]);
  expect(f.capture.isCurrent()).toBe(false);
  await f.capture.request('oauth.cancel', { operationId: 'TEST-original-flow' });
  expect(f.requests).toEqual([
    {
      method: 'management.oauth.cancel',
      control: true,
      params: {
        operationId: 'TEST-original-flow',
        profileId: 'TEST-original',
        configRevision: 'TEST-v1',
      },
    },
  ]);
});

it('late mutation response stays UNKNOWN after context change and lookup uses the original profile without redispatch', async () => {
  const f = fixture();
  f.opening.resolve();
  f.blockReply();
  const pending = f.capture.request('credential', {
    commandId: 'TEST-intent',
    kind: 'credential.forget',
    providerId: 'TEST-provider',
  });
  await vi.waitFor(() => expect(f.requests).toHaveLength(1));
  f.changeContext();
  f.reply.resolve({ ok: true, value: { phase: 'completed' } });
  await expect(pending).rejects.toMatchObject({ code: 'forbidden', outcome: 'unknown' });
  await f.capture.request('credential.lookup', { commandId: 'TEST-intent' });
  expect(f.requests.map((entry) => entry.method)).toEqual([
    'management.credential',
    'management.credential.lookup',
  ]);
  expect(f.requests[1]).toMatchObject({
    control: true,
    params: { commandId: 'TEST-intent', profileId: 'TEST-original', configRevision: 'TEST-v1' },
  });
});

it('invalid operation, account override and non-finite payload fail before startup', async () => {
  const f = fixture();
  for (const [operation, payload] of [
    ['runtime.open', {}],
    ['catalog', { profileId: 'TEST-forged' }],
    ['catalog', { configRevision: 'TEST-forged' }],
    ['catalog', { bad: Number.NaN }],
  ] as const) {
    await expect(
      f.capture.request(operation as ProviderManagementOperation, payload)
    ).rejects.toMatchObject({ code: 'invalid-binding', outcome: 'not-dispatched' });
  }
  expect(f.start).not.toHaveBeenCalled();
  expect(f.requests).toEqual([]);
});

it('closing the captured owner refuses even retained controls instead of selecting a replacement', async () => {
  const f = fixture();
  f.opening.resolve();
  f.closeOwner();
  await expect(
    f.capture.request('oauth.cancel', { operationId: 'TEST-flow' })
  ).rejects.toMatchObject({ code: 'unavailable', outcome: 'not-dispatched' });
  expect(f.start).not.toHaveBeenCalled();
  expect(f.requests).toEqual([]);
});
