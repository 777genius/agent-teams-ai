// @vitest-environment node
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { BackendRoutingError } from '../../../src/features/agent-backend/main';
import { CapturedCodexAuthCommands } from '../../../src/features/runtime-provider-management/main/adapters/output/CapturedCodexAuthCommands';
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
      request: (operation, payload) => busy
        ? Promise.resolve({ ok: false, code: 'busy' })
        : f.target.request(operation, payload),
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
