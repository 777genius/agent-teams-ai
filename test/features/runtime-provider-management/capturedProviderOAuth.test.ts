// @vitest-environment node
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

import { CapturedProviderOAuth } from '../../../src/features/runtime-provider-management/main/adapters/output/CapturedProviderOAuth';
import { FileProviderOAuthIntentStore } from '../../../src/features/runtime-provider-management/main/infrastructure/FileProviderOAuthIntentStore';
import type {
  CapturedProviderManagement,
  ProviderManagementOperation,
} from '../../../src/features/agent-backend/main';
import type { RuntimeProviderOAuthProgressDto } from '../../../src/features/runtime-provider-management/contracts';
import type { ProviderOAuthSnapshot } from '@agent-teams/legacy-agent-host/management/contracts';
import type { JsonValue } from '@agent-teams/legacy-agent-host/contracts';

async function fixture(method: 'code' | 'auto' = 'code') {
  const directory = await mkdtemp(join(tmpdir(), 'TEST-main-oauth-intents-'));
  const store = new FileProviderOAuthIntentStore(directory);
  const input = {
    operationId: 'TEST-operation-1',
    providerId: 'TEST-provider',
    methodIndex: 2,
    displayName: 'TEST Provider',
    authOptionId: 'oauth:2',
    fields: { plan: 'TEST-private-field' },
  };
  const progress: RuntimeProviderOAuthProgressDto[] = [];
  const calls: { operation: string; payload: Record<string, JsonValue> }[] = [];
  let phase: ProviderOAuthSnapshot['phase'] =
    method === 'code' ? 'waiting-for-code' : 'waiting-for-browser';
  let current = true,
    sequence = 1,
    fail = false;
  const target: CapturedProviderManagement = {
    profileId: 'TEST-original',
    configRevision: 'TEST-v1',
    targetId: 'a'.repeat(64),
    isCurrent: () => current,
    async request(
      operation: ProviderManagementOperation,
      payload: Record<string, JsonValue>
    ): Promise<JsonValue> {
      calls.push({ operation, payload });
      if (fail) throw new Error('TEST-raw-auth-token');
      if (operation === 'oauth.start') expect(await store.read(input.operationId)).not.toBeNull();
      if (operation === 'oauth.authorization')
        return {
          ok: true,
          value: {
            authorizationUrl: 'https://TEST.invalid/login?state=TEST-private-url',
            instructions: 'TEST-private-instructions',
          },
        };
      if (operation === 'oauth.complete') {
        phase = 'completed';
        sequence++;
      }
      if (operation === 'oauth.cancel' && phase !== 'completed') {
        phase = 'cancelled';
        sequence++;
      }
      return {
        ok: true,
        value: {
          operationId: input.operationId,
          profileId: target.profileId,
          configRevision: target.configRevision,
          providerId: input.providerId,
          methodIndex: input.methodIndex,
          phase,
          completionMethod: method,
          sequence,
          expiresAt: Date.now() + 10000,
        },
      };
    },
  };
  const restore = vi.fn(async (targetId: string) => {
    expect(targetId).toBe(target.targetId);
    return target;
  });
  const openExternal = vi.fn(async (_url: string) => {});
  const deps = {
    intents: store,
    restore,
    openExternal,
    emitProgress: (event: RuntimeProviderOAuthProgressDto) => progress.push(event),
  };
  return {
    target,
    input,
    store,
    directory,
    progress,
    calls,
    deps,
    openExternal,
    oauth: new CapturedProviderOAuth(deps),
    stale: () => {
      current = false;
    },
    fail: () => {
      fail = true;
    },
  };
}

it('persists the original target before native start; opens privately and restores code controls against that same target', async () => {
  const f = await fixture();
  const pending = f.oauth.connect(f.target, f.input);
  await vi.waitFor(() => expect(f.openExternal).toHaveBeenCalledTimes(1));
  const restored = new CapturedProviderOAuth(f.deps);
  expect(
    await restored.submitCode({ operationId: f.input.operationId, code: 'TEST-private-code' })
  ).toEqual({ ok: true });
  await pending;
  expect(f.calls.filter((call) => call.operation === 'oauth.start')).toHaveLength(1);
  expect(f.calls.find((call) => call.operation === 'oauth.complete')?.payload).toEqual({
    operationId: f.input.operationId,
    commandId: `${f.input.operationId}:code`,
    code: 'TEST-private-code',
  });
  const journal = await readFile(join(f.directory, (await readdir(f.directory))[0]!), 'utf8');
  for (const secret of [
    'TEST-private-field',
    'TEST-private-code',
    'TEST-private-url',
    'TEST-private-instructions',
  ]) {
    expect(journal).not.toContain(secret);
    expect(JSON.stringify(f.progress)).not.toContain(secret);
  }
  const startCount = f.calls.filter((call) => call.operation === 'oauth.start').length;
  await restored.connect(f.target, f.input);
  expect(f.calls.filter((call) => call.operation === 'oauth.start')).toHaveLength(startCount);
  expect(f.openExternal).toHaveBeenCalledTimes(1);
});

it('auto completion submits once and duplicate completed operation reads without a second authorize/browser effect', async () => {
  const f = await fixture('auto');
  await f.oauth.connect(f.target, f.input);
  await new CapturedProviderOAuth(f.deps).connect(f.target, f.input);
  expect(f.calls.filter((call) => call.operation === 'oauth.start')).toHaveLength(1);
  expect(f.calls.filter((call) => call.operation === 'oauth.complete')).toEqual([
    {
      operation: 'oauth.complete',
      payload: { operationId: f.input.operationId, commandId: `${f.input.operationId}:auto` },
    },
  ]);
  expect(f.openExternal).toHaveBeenCalledTimes(1);
});

it('foreground switch refuses code while retained cancellation restores the original target and never deletes credentials', async () => {
  const f = await fixture();
  const pending = f.oauth.connect(f.target, f.input).catch(() => undefined);
  await vi.waitFor(() => expect(f.openExternal).toHaveBeenCalledTimes(1));
  f.stale();
  const restored = new CapturedProviderOAuth(f.deps);
  expect(
    await restored.submitCode({ operationId: f.input.operationId, code: 'TEST-wrong-context' })
  ).toEqual(expect.objectContaining({ ok: false }));
  expect(await restored.cancel({ operationId: f.input.operationId })).toEqual({ ok: true });
  await pending;
  expect(
    f.calls.some((call) => call.operation === 'credential' || call.operation === 'oauth.complete')
  ).toBe(false);
});

it('changed intent with the same operation ID conflicts and a lost native result is never resubmitted', async () => {
  const f = await fixture();
  f.fail();
  await expect(f.oauth.connect(f.target, f.input)).rejects.toThrow('unconfirmed');
  await expect(
    f.oauth.connect(f.target, { ...f.input, fields: { plan: 'TEST-changed' } })
  ).rejects.toThrow('conflict');
  await expect(new CapturedProviderOAuth(f.deps).connect(f.target, f.input)).rejects.toThrow();
  expect(f.calls.filter((call) => call.operation === 'oauth.start')).toHaveLength(1);
  expect(f.openExternal).not.toHaveBeenCalled();
});
