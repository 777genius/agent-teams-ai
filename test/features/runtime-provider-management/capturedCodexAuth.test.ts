// @vitest-environment node
import { mkdir, mkdtemp, readFile, realpath, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it, vi } from 'vitest';

import { BackendRoutingError } from '../../../src/features/agent-backend/main';
import { CapturedCodexAuthCommands } from '../../../src/features/runtime-provider-management/main/adapters/output/CapturedCodexAuthCommands';
import { CapturedCodexLogin } from '../../../src/features/runtime-provider-management/main/adapters/output/CapturedCodexLogin';
import { FileCodexAuthIntentStore } from '../../../src/features/runtime-provider-management/main/infrastructure/FileCodexAuthIntentStore';

import type {
  CapturedProviderManagement,
  ProviderManagementOperation,
} from '../../../src/features/agent-backend/main';
import type { CodexAuthIntent } from '../../../src/features/runtime-provider-management/main/infrastructure/FileCodexAuthIntentStore';
import type { JsonValue } from '@agent-teams/legacy-agent-host/contracts';

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-codex-auth-main-')));
  const directory = join(root, 'intents'),
    targetId = 'a'.repeat(64);
  const store = new FileCodexAuthIntentStore(directory);
  const receipts = new Map<string, Record<string, JsonValue>>();
  let effects = 0,
    loseReply = false;
  const requests: string[] = [];
  const target: CapturedProviderManagement = {
    targetId,
    profileId: 'TEST-codex',
    configRevision: 'TEST-config',
    isCurrent: () => true,
    async request(operation: ProviderManagementOperation, payload: Record<string, JsonValue>) {
      requests.push(operation);
      if (operation === 'credential.lookup')
        return { ok: true, value: receipts.get(String(payload.commandId)) ?? null };
      if (operation !== 'credential') throw new Error('Unexpected operation');
      const intent = await store.read(targetId);
      expect(intent?.commandId).toBe(payload.commandId); // Intent exists before any native effect.
      effects++;
      const value: Record<string, JsonValue> = {
        commandId: payload.commandId!,
        kind: payload.kind!,
        providerId: 'codex',
        profileId: 'TEST-codex',
        configRevision: 'TEST-config',
        phase: 'completed',
      };
      receipts.set(String(payload.commandId), value);
      if (loseReply) throw new BackendRoutingError('unavailable', 'unknown');
      return { ok: true, value };
    },
  };
  return {
    root,
    directory,
    targetId,
    target,
    store,
    requests,
    effects: () => effects,
    lose: () => {
      loseReply = true;
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

it('a lost original reply is recovered after Main restart by lookup, with no duplicate mutation or auth journal data', async () => {
  const f = await fixture();
  try {
    f.lose();
    const first = new CapturedCodexAuthCommands(async () => f.target, f.store);
    await expect(first.execute('credential.forget')).rejects.toThrow('intent was retained');
    const intent = await f.store.read(f.targetId);
    expect(intent?.kind).toBe('credential.forget');
    expect(
      Object.keys(
        JSON.parse(await readFile(join(f.directory, f.targetId + '.json'), 'utf8'))
      ).sort()
    ).toEqual(['commandId', 'kind', 'schemaVersion', 'targetId']);
    const recovered = new CapturedCodexAuthCommands(
      async () => f.target,
      new FileCodexAuthIntentStore(f.directory)
    );
    expect(await recovered.execute('credential.forget')).toBe(f.target);
    expect(f.effects()).toBe(1);
    expect(f.requests).toEqual(['credential', 'credential.lookup']);
    expect(await f.store.read(f.targetId)).toBeNull();
  } finally {
    await f.cleanup();
  }
});

it('a missing original receipt remains held, and cannot silently resubmit the native mutation', async () => {
  const f = await fixture();
  try {
    const intent: CodexAuthIntent = {
      schemaVersion: 1,
      targetId: f.targetId,
      kind: 'credential.refresh',
      commandId: 'codex-auth-11111111-1111-4111-8111-111111111111',
    };
    expect(await f.store.create(intent)).toBe(true);
    const recovered = new CapturedCodexAuthCommands(async () => f.target, f.store);
    await expect(recovered.execute('credential.refresh')).rejects.toThrow('intent was retained');
    expect(f.effects()).toBe(0);
    expect(f.requests).toEqual(['credential.lookup']);
    expect(await f.store.read(f.targetId)).toEqual(intent);
  } finally {
    await f.cleanup();
  }
});

it('private intent slots admit one writer and a stale cleanup cannot unlink a newer original operation', async () => {
  const f = await fixture();
  try {
    const a: CodexAuthIntent = {
      schemaVersion: 1,
      targetId: f.targetId,
      kind: 'credential.refresh',
      commandId: 'codex-auth-11111111-1111-4111-8111-111111111111',
    };
    const b: CodexAuthIntent = {
      ...a,
      kind: 'credential.forget',
      commandId: 'codex-auth-22222222-2222-4222-8222-222222222222',
    };
    const second = new FileCodexAuthIntentStore(f.directory);
    expect((await Promise.all([f.store.create(a), second.create(b)])).filter(Boolean)).toHaveLength(
      1
    );
    const current = await f.store.read(f.targetId);
    expect(current).not.toBeNull();
    await f.store.retire(current!);
    const next = current!.commandId === a.commandId ? b : a;
    expect(await second.create(next)).toBe(true);
    await expect(f.store.retire(current!)).rejects.toThrow('could not be confirmed');
    expect(await f.store.read(f.targetId)).toEqual(next);
    await second.retire(next);
    const loginA: CodexAuthIntent = { ...a, kind: 'login.browser', contextId: 'TEST-context' };
    const loginB: CodexAuthIntent = {
      ...b,
      targetId: 'b'.repeat(64),
      kind: 'login.device_code',
      contextId: 'TEST-context',
    };
    expect(
      (await Promise.all([f.store.create(loginA), second.create(loginB)])).filter(Boolean)
    ).toHaveLength(1);
    const retained = await f.store.pendingLogin();
    expect([loginA.commandId, loginB.commandId]).toContain(retained?.commandId);
    await second.retire(retained!);
    await rename(f.directory, join(f.root, 'original-intents'));
    await mkdir(f.directory, { mode: 0o700 });
    await expect(f.store.pendingLogin()).rejects.toThrow('could not be confirmed');
  } finally {
    await f.cleanup();
  }
});

it('a proven pre-admission rejection retires only the unsent intent and permits a later explicit retry', async () => {
  const f = await fixture();
  try {
    let busy = true;
    const target: CapturedProviderManagement = {
      ...f.target,
      request: (operation, payload) =>
        busy ? Promise.resolve({ ok: false, code: 'busy' }) : f.target.request(operation, payload),
    };
    const auth = new CapturedCodexAuthCommands(async () => target, f.store);
    await expect(auth.execute('credential.refresh')).rejects.toThrow('rejected before it started');
    expect(f.effects()).toBe(0);
    expect(await f.store.read(f.targetId)).toBeNull();
    busy = false;
    await auth.execute('credential.refresh');
    expect(f.effects()).toBe(1);
    expect(await f.store.read(f.targetId)).toBeNull();
  } finally {
    await f.cleanup();
  }
});

it('login recovery requires its original context and exact receipt, and a completed recovery cannot start a second login', async () => {
  for (const scenario of [
    'missing-context',
    'foreign-receipt',
    'completed',
    'store-retry',
    'restore-retry',
    'held',
  ]) {
    const f = await fixture();
    try {
      const intent: CodexAuthIntent = {
        schemaVersion: 1,
        targetId: f.targetId,
        kind: 'login.browser',
        commandId: 'codex-auth-11111111-1111-4111-8111-111111111111',
        ...(scenario === 'missing-context' ? {} : { contextId: 'TEST-context' }),
      };
      await f.store.create(intent);
      if (scenario === 'store-retry')
        vi.spyOn(f.store, 'pendingLogin').mockRejectedValueOnce(
          new Error('TEST transient store failure')
        );
      const requests: string[] = [];
      let restores = 0;
      const target = {
        ...f.target,
        originalContextId: 'TEST-context',
        request: async (operation: ProviderManagementOperation) => {
          requests.push(operation);
          return {
            ok: true,
            value: {
              operationId: intent.commandId,
              providerId: 'codex',
              profileId: scenario === 'foreign-receipt' ? 'foreign' : f.target.profileId,
              configRevision: f.target.configRevision,
              methodIndex: 0,
              completionMethod: 'auto',
              phase: scenario === 'held' ? 'held' : 'completed',
              sequence: 3,
              expiresAt: Date.now() + 60_000,
            },
          };
        },
      };
      const login = new CapturedCodexLogin(
        f.store,
        async (targetId, contextId) => {
          expect([targetId, contextId]).toEqual([f.targetId, 'TEST-context']);
          if (scenario === 'restore-retry' && ++restores === 1)
            throw new Error('TEST transient restore failure');
          return target;
        },
        () => {}
      );
      if (scenario === 'missing-context')
        await expect(login.start(target, 'browser')).rejects.toThrow('context is unavailable');
      else {
        if (['store-retry', 'restore-retry'].includes(scenario))
          await expect(login.start(target, 'browser')).rejects.toThrow('TEST transient');
        await login.start(target, 'browser');
      }
      expect(requests).toEqual(scenario === 'missing-context' ? [] : ['oauth.read']);
      expect(await f.store.pendingLogin()).toEqual(
        ['completed', 'store-retry', 'restore-retry'].includes(scenario) ? null : intent
      );
      if (scenario === 'foreign-receipt') expect(login.state(target).status).toBe('failed');
      if (scenario === 'held') {
        await expect(
          login.start({ ...target, targetId: 'b'.repeat(64) }, 'browser')
        ).rejects.toThrow('No new login');
        expect(await f.store.pendingLogin()).toEqual(intent);
        expect(requests).toEqual(['oauth.read']);
      }
    } finally {
      await f.cleanup();
    }
  }
});

it('terminal and undispatched login retirement retries only the original local intent, once for concurrent observers', async () => {
  for (const phase of ['completed', 'cancelled', 'failed', 'busy', 'not-dispatched']) {
    const f = await fixture();
    try {
      const retire = vi
        .spyOn(f.store, 'retire')
        .mockRejectedValueOnce(new Error('TEST transient retire failure'));
      const requests: string[] = [];
      let settled = 0;
      const target = {
        ...f.target,
        originalContextId: 'TEST-context',
        request: async (
          operation: ProviderManagementOperation,
          payload: Record<string, JsonValue>
        ): Promise<JsonValue> => {
          requests.push(operation);
          if (phase === 'not-dispatched')
            throw new BackendRoutingError('unavailable', 'not-dispatched');
          if (phase === 'busy') return { ok: false, code: 'busy' };
          return {
            ok: true,
            value: {
              operationId: payload.operationId!,
              providerId: 'codex',
              profileId: f.target.profileId,
              configRevision: f.target.configRevision,
              methodIndex: 0,
              completionMethod: 'auto',
              phase,
              sequence: 3,
              expiresAt: Date.now() + 60_000,
              ...(phase === 'failed' ? { reason: 'native-rejected' } : {}),
            },
          };
        },
      };
      const login = new CapturedCodexLogin(
        f.store,
        async () => target,
        (_target, terminal) => {
          if (terminal) settled++;
        }
      );
      await login.start(target, 'browser');
      const original = await f.store.pendingLogin();
      expect(original?.targetId).toBe(f.targetId);
      expect(login.state(target).status).toBe('failed');
      expect(retire).toHaveBeenCalledTimes(1);
      await Promise.all([login.start(target, 'browser'), login.cancel()]);
      expect(retire).toHaveBeenCalledTimes(2);
      expect(retire.mock.calls.map(([intent]) => intent)).toEqual([original, original]);
      expect(requests).toEqual(['oauth.start']);
      expect(await f.store.pendingLogin()).toBeNull();
      expect(settled).toBe(1);
      expect(login.state(target).status).toBe(
        phase === 'completed' ? 'idle' : phase === 'cancelled' ? 'cancelled' : 'failed'
      );
      expect(login.state(target).authUrl).toBeUndefined();
    } finally {
      await f.cleanup();
    }
  }
});
