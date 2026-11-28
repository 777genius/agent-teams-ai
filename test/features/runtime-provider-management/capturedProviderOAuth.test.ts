// @vitest-environment node
import crypto, { createHash, scryptSync } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it, vi } from 'vitest';

import { CapturedProviderOAuth } from '../../../src/features/runtime-provider-management/main/adapters/output/CapturedProviderOAuth';
import { FileProviderOAuthIntentStore } from '../../../src/features/runtime-provider-management/main/infrastructure/FileProviderOAuthIntentStore';
import {
  getCopyableOAuthAuthorizationUrl,
  isSafeOAuthAuthorizationUrl,
  sanitizeOAuthInstructions,
} from '../../../src/features/runtime-provider-management/main/infrastructure/runtimeProviderOAuthPresentation';

import type {
  CapturedProviderManagement,
  ProviderManagementOperation,
} from '../../../src/features/agent-backend/main';
import type { RuntimeProviderOAuthProgressDto } from '../../../src/features/runtime-provider-management/contracts';
import type { ProviderOAuthIntent, ProviderOAuthIntentStore } from '../../../src/features/runtime-provider-management/main/infrastructure/FileProviderOAuthIntentStore';
import type { JsonValue } from '@agent-teams/legacy-agent-host/contracts';
import type { ProviderOAuthSnapshot } from '@agent-teams/legacy-agent-host/management/contracts';

async function fixture(
  method: 'code' | 'auto' = 'code',
  options: {
    providerId?: string;
    authorizationUrl?: string;
    instructions?: string;
    holdAuto?: boolean;
    cancelPhase?: 'completed' | 'held' | 'failed' | 'cancelling';
    sequence?: number;
    read?: (snapshot: ProviderOAuthSnapshot) => ProviderOAuthSnapshot | Promise<ProviderOAuthSnapshot>;
  } = {}
) {
  const directory = await mkdtemp(join(tmpdir(), 'TEST-main-oauth-intents-'));
  const store = new FileProviderOAuthIntentStore(directory);
  const input = {
    operationId: 'TEST-operation-1',
    providerId: options.providerId ?? 'TEST-provider',
    methodIndex: 2,
    displayName: 'TEST Provider',
    authOptionId: 'oauth:2',
    fields: { plan: 'TEST-private-field' },
  };
  const instructionPrefix =
    method === 'auto'
      ? 'Enter A7F0-835A in your browser.'
      : 'Finish sign-in in your browser and paste the returned code.';
  // This original private marker now uses a real credential grammar: ordinary instruction
  // text is intentionally displayable, while tokens and authorization URLs must be hidden.
  const nativeInstructions =
    options.instructions ??
    `${instructionPrefix} token=TEST-private-instructions https://TEST.invalid/login?state=TEST-private-url`;
  const expiresAt = Date.now() + 10000;
  const progress: RuntimeProviderOAuthProgressDto[] = [];
  const calls: { operation: string; payload: Record<string, JsonValue> }[] = [];
  let phase: ProviderOAuthSnapshot['phase'] =
    method === 'code' ? 'waiting-for-code' : 'waiting-for-browser';
  let current = true,
    sequence = options.sequence ?? 1,
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
            authorizationUrl:
              options.authorizationUrl ?? 'https://TEST.invalid/login?state=TEST-private-url',
            instructions: nativeInstructions,
          },
        };
      if (operation === 'oauth.complete') {
        phase = method === 'auto' && options.holdAuto ? 'completing' : 'completed';
        sequence++;
      }
      if (operation === 'oauth.cancel' && phase !== 'completed') {
        phase = options.cancelPhase ?? 'cancelled';
        sequence++;
      }
      const snapshot: ProviderOAuthSnapshot = {
        operationId: input.operationId,
        profileId: target.profileId,
        configRevision: target.configRevision,
        providerId: input.providerId,
        methodIndex: input.methodIndex,
        phase,
        completionMethod: method,
        sequence,
        expiresAt,
      };
      return {
        ok: true,
        value:
          operation === 'oauth.read' && options.read
            ? { ...(await options.read(snapshot)) }
            : { ...snapshot },
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
    instructionPrefix,
    nativeInstructions,
    expiresAt,
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
  await vi.waitFor(() =>
    expect(f.progress.at(-1)?.instructions).toBe(
      `${f.instructionPrefix} token=...redacted [authorization link hidden]`
    )
  );
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
  expect(journal).not.toContain(f.nativeInstructions);
  expect(journal).not.toContain(f.instructionPrefix);
  expect(f.progress.at(-1)).toMatchObject({ phase: 'completing', instructions: null });
  expect(f.progress.at(-1)?.authorizationUrl).toBeUndefined();
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
  expect(f.progress.some((event) => event.instructions?.includes('A7F0-835A'))).toBe(true);
  expect(f.progress.at(-1)).toMatchObject({ phase: 'completing', instructions: null });
  expect(f.progress.at(-1)?.authorizationUrl).toBeUndefined();
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

function held() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

it('uses the original OAuth text and copyable-link policies without exposing native secrets', () => {
  expect(
    sanitizeOAuthInstructions(
      '\u001b[31mEnter A7F0-835A.\u001b[0m token=TEST-private-instructions https://TEST.invalid/login?state=TEST-private-url'
    )
  ).toBe('Enter A7F0-835A. token=...redacted [authorization link hidden]');
  expect(sanitizeOAuthInstructions(' \u001b[0m ')).toBeNull();
  expect(sanitizeOAuthInstructions('A'.repeat(1001))).toBe('A'.repeat(1000) + '...');
  const copyable = 'https://github.com:8443/login/device/?flow=TEST-public#device';
  expect(isSafeOAuthAuthorizationUrl(copyable)).toBe(true);
  expect(getCopyableOAuthAuthorizationUrl('github-copilot', copyable)).toBe(copyable);
  for (const [providerId, url] of [
    ['TEST-provider', 'https://github.com/login/device'],
    ['github-copilot', 'http://github.com/login/device'],
    ['github-copilot', 'https://github.com.TEST.invalid/login/device'],
    ['github-copilot', 'https://github.com/login/other'],
    ['github-copilot', 'https://TEST-user:TEST-password@github.com/login/device'],
    ['github-copilot', 'javascript:TEST-private-url'],
  ]) {
    expect(getCopyableOAuthAuthorizationUrl(providerId!, url!)).toBeNull();
  }
  expect(
    isSafeOAuthAuthorizationUrl('https://TEST-user:TEST-password@github.com/login/device')
  ).toBe(false);
  expect(isSafeOAuthAuthorizationUrl('javascript:TEST-private-url')).toBe(false);
  expect(
    isSafeOAuthAuthorizationUrl('https://github.com/login/device?' + 'A'.repeat(8192))
  ).toBe(false);
});

it('retains sanitized device instructions while the original auto callback waits and clears them on cancellation', async () => {
  const f = await fixture('auto', { holdAuto: true });
  const pending = f.oauth.connect(f.target, f.input).then(
    () => 'completed',
    () => 'unconfirmed'
  );
  try {
    await vi.waitFor(() =>
      expect(f.calls.filter((call) => call.operation === 'oauth.complete')).toHaveLength(1)
    );
    expect(f.progress.at(-1)).toMatchObject({
      operationId: f.input.operationId,
      providerId: f.input.providerId,
      phase: 'waiting-for-browser',
      completionMethod: 'auto',
      instructions: f.instructionPrefix + ' token=...redacted [authorization link hidden]',
    });
    expect(f.progress.at(-1)?.authorizationUrl).toBeUndefined();
    expect(await f.oauth.cancel({ operationId: f.input.operationId })).toEqual({ ok: true });
    expect(await pending).toBe('unconfirmed');
    expect(f.progress.at(-1)).toMatchObject({ phase: 'cancelled', instructions: null });
    expect(f.progress.at(-1)?.authorizationUrl).toBeUndefined();
    expect(f.calls.filter((call) => call.operation === 'oauth.complete')).toEqual([
      {
        operation: 'oauth.complete',
        payload: { operationId: f.input.operationId, commandId: f.input.operationId + ':auto' },
      },
    ]);
    expect(f.calls.filter((call) => call.operation === 'oauth.authorization')).toHaveLength(1);
    expect(f.openExternal).toHaveBeenCalledTimes(1);
    const journal = await readFile(join(f.directory, (await readdir(f.directory))[0]!), 'utf8');
    for (const secret of [
      'A7F0-835A',
      f.instructionPrefix,
      'TEST-private-instructions',
      'TEST-private-url',
    ])
      expect(journal).not.toContain(secret);
  } finally {
    await f.oauth.cancel({ operationId: f.input.operationId });
    await pending;
  }
});

it.each([
  ['completed', 'completing'],
  ['held', 'failed'],
  ['failed', 'failed'],
  ['cancelling', 'cancelled'],
] as const)('clears original instructions for a %s cancel response without confirming cancellation', async (phase, publicPhase) => {
  const f = await fixture('auto', { holdAuto: true, cancelPhase: phase });
  const pending = f.oauth.connect(f.target, f.input).catch(() => undefined);
  try {
    await vi.waitFor(() =>
      expect(f.calls.filter((call) => call.operation === 'oauth.complete')).toHaveLength(1)
    );
    expect(f.progress.at(-1)?.instructions).toContain(f.instructionPrefix);
    expect(await f.oauth.cancel({ operationId: f.input.operationId })).toMatchObject({ ok: false });
    await pending;
    expect(f.progress.at(-1)).toMatchObject({
      operationId: f.input.operationId, phase: publicPhase, instructions: null,
    });
    expect(f.progress.at(-1)?.authorizationUrl).toBeUndefined();
    expect(f.calls.filter((call) => call.operation === 'oauth.start')).toHaveLength(1);
    expect(f.calls.filter((call) => call.operation === 'oauth.complete')).toHaveLength(1);
    expect(f.openExternal).toHaveBeenCalledTimes(1);
  } finally {
    await f.oauth.cancel({ operationId: f.input.operationId });
    await pending;
    await rm(f.directory, { recursive: true, force: true });
  }
});

it.each([
  {
    name: 'original GitHub device link',
    providerId: 'github-copilot',
    url: 'https://github.com:8443/login/device/?flow=TEST-public#device',
    publicLink: true,
  },
  {
    name: 'another provider',
    providerId: 'TEST-provider',
    url: 'https://github.com/login/device',
    publicLink: false,
  },
  {
    name: 'another path',
    providerId: 'github-copilot',
    url: 'https://github.com/login/other',
    publicLink: false,
  },
  {
    name: 'oversized public link',
    providerId: 'github-copilot',
    url: 'https://github.com/login/device?' + 'A'.repeat(8192),
    publicLink: false,
  },
])(
  'projects $name only through the canonical public link policy',
  async ({ providerId, url, publicLink }) => {
    const f = await fixture('code', { providerId, authorizationUrl: url });
    const pending = f.oauth.connect(f.target, f.input).catch(() => undefined);
    try {
      await vi.waitFor(() =>
        expect(f.progress.at(-1)?.instructions).toContain(f.instructionPrefix)
      );
      expect(f.openExternal).toHaveBeenCalledTimes(1);
      expect(f.openExternal).toHaveBeenCalledWith(new URL(url).href);
      expect(f.progress.at(-1)?.authorizationUrl).toBe(publicLink ? url : undefined);
      const journal = await readFile(join(f.directory, (await readdir(f.directory))[0]!), 'utf8');
      expect(journal).not.toContain(url);
      expect(journal).not.toContain(f.instructionPrefix);
      expect(await f.oauth.cancel({ operationId: f.input.operationId })).toEqual({ ok: true });
      await pending;
      expect(f.progress.at(-1)).toMatchObject({ phase: 'cancelled', instructions: null });
      expect(f.progress.at(-1)?.authorizationUrl).toBeUndefined();
    } finally {
      await f.oauth.cancel({ operationId: f.input.operationId });
      await pending;
    }
  }
);

it.each(['cancelled', 'completed', 'stale'] as const)(
  'does not publish native instructions when %s wins during the original browser open',
  async (outcome) => {
    const f = await fixture();
    const opener = held();
    f.openExternal.mockImplementation(() => opener.promise);
    const pending = f.oauth.connect(f.target, f.input).then(
      () => 'completed',
      () => 'unconfirmed'
    );
    try {
      await vi.waitFor(() => expect(f.openExternal).toHaveBeenCalledTimes(1));
      if (outcome === 'cancelled')
        expect(await f.oauth.cancel({ operationId: f.input.operationId })).toEqual({ ok: true });
      else if (outcome === 'completed')
        expect(
          await f.oauth.submitCode({
            operationId: f.input.operationId,
            code: 'TEST-private-code',
          })
        ).toEqual({ ok: true });
      else f.stale();
      opener.release();
      expect(await pending).toBe(outcome === 'completed' ? 'completed' : 'unconfirmed');
      expect(
        f.progress.some((event) => event.instructions?.includes(f.instructionPrefix))
      ).toBe(false);
      expect(f.progress.every((event) => event.authorizationUrl === undefined)).toBe(true);
      expect(f.calls.filter((call) => call.operation === 'oauth.start')).toHaveLength(1);
      expect(f.calls.filter((call) => call.operation === 'oauth.complete')).toHaveLength(
        outcome === 'completed' ? 1 : 0
      );
      if (outcome !== 'stale')
        expect(f.progress.at(-1)).toMatchObject({
          phase: outcome === 'completed' ? 'completing' : 'cancelled',
          instructions: null,
        });
    } finally {
      opener.release();
      await f.oauth.cancel({ operationId: f.input.operationId });
      await pending;
    }
  }
);

it.each([
  { name: 'another operation', patch: { operationId: 'TEST-operation-other' } },
  { name: 'another original profile', patch: { profileId: 'TEST-another-profile' } },
  { name: 'another method index', patch: { methodIndex: 3 } },
  { name: 'another completion method', patch: { completionMethod: 'code' } },
  { name: 'regressed sequence', patch: { sequence: 1 } },
  { name: 'phase without a new sequence', patch: { phase: 'completed' } },
] satisfies { name: string; patch: Partial<ProviderOAuthSnapshot> }[])(
  'rejects $name in the fresh original read before presenting or auto-completing',
  async ({ patch }) => {
    const f = await fixture('auto', {
      sequence: 2,
      read: (snapshot) => ({ ...snapshot, ...patch }),
    });
    await expect(f.oauth.connect(f.target, f.input)).rejects.toThrow('unconfirmed');
    expect(f.openExternal).toHaveBeenCalledTimes(1);
    expect(f.calls.filter((call) => call.operation === 'oauth.read')).toHaveLength(1);
    expect(f.calls.filter((call) => call.operation === 'oauth.complete')).toHaveLength(0);
    expect(f.progress.some((event) => event.instructions?.includes('A7F0-835A'))).toBe(false);
    expect(f.calls.filter((call) => call.operation === 'oauth.cancel')).toEqual([
      { operation: 'oauth.cancel', payload: { operationId: f.input.operationId } },
    ]);
  }
);

it('refuses a changed original expiry and a context change during the fresh read', async () => {
  const changed = await fixture('auto', {
    read: (snapshot) => ({ ...snapshot, expiresAt: snapshot.expiresAt + 1 }),
  });
  await expect(changed.oauth.connect(changed.target, changed.input)).rejects.toThrow('unconfirmed');
  let markStale = () => {};
  const stale = await fixture('auto', {
    read: (snapshot) => {
      markStale();
      return snapshot;
    },
  });
  markStale = stale.stale;
  await expect(stale.oauth.connect(stale.target, stale.input)).rejects.toThrow('unconfirmed');
  for (const f of [changed, stale]) {
    expect(f.calls.filter((call) => call.operation === 'oauth.read')).toHaveLength(1);
    expect(f.calls.filter((call) => call.operation === 'oauth.complete')).toHaveLength(0);
    expect(f.progress.some((event) => event.instructions?.includes('A7F0-835A'))).toBe(false);
  }
});

it.each(['before-read', 'after-read'] as const)(
  'keeps the original expiry %s without publishing late presentation or submitting auto completion',
  async (when) => {
    const clock = vi.spyOn(Date, 'now');
    try {
      const f = await fixture('auto', {
        read: (snapshot) => {
          if (when === 'after-read') clock.mockReturnValue(snapshot.expiresAt);
          return snapshot;
        },
      });
      if (when === 'before-read')
        f.openExternal.mockImplementation(async () => {
          clock.mockReturnValue(f.expiresAt);
        });
      await expect(f.oauth.connect(f.target, f.input)).rejects.toThrow('unconfirmed');
      expect(f.calls.filter((call) => call.operation === 'oauth.read')).toHaveLength(
        when === 'before-read' ? 0 : 1
      );
      expect(f.calls.filter((call) => call.operation === 'oauth.complete')).toHaveLength(0);
      expect(f.progress.some((event) => event.instructions?.includes('A7F0-835A'))).toBe(false);
      expect(f.calls.filter((call) => call.operation === 'oauth.cancel')).toEqual([
        { operation: 'oauth.cancel', payload: { operationId: f.input.operationId } },
      ]);
    } finally {
      clock.mockRestore();
    }
  }
);

function originalStartSalt(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !('fingerprintKdf' in value)) throw new Error('Expected private start descriptor');
  const descriptor = value.fingerprintKdf;
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor) ||
      !('version' in descriptor) || descriptor.version !== 1 ||
      !('salt' in descriptor) || typeof descriptor.salt !== 'string')
    throw new Error('Invalid private start descriptor');
  expect(Object.keys(descriptor).sort()).toEqual(['salt', 'version']);
  expect(descriptor.salt).toMatch(/^[a-f0-9]{32}$/);
  return descriptor.salt;
}

it.each(['one-character', 'empty'] as const)(
  'stores a versioned private OAuth start fingerprint for %s fields and replays its original',
  async kind => {
    const f = await fixture('auto');
    const fields: Record<string, string> = kind === 'empty' ? {} : { client_secret: '!' };
    const input = { ...f.input, fields }, original = structuredClone(input);
    try {
      const pending = f.oauth.connect(f.target, input);
      if (kind === 'one-character') fields.client_secret = 'TEST-mutated-after-call';
      await pending;
      const saved = await f.store.read(input.operationId);
      if (!saved) throw new Error('Expected original Main intent');
      const salt = originalStartSalt(saved);
      expect(Object.isFrozen(saved)).toBe(true);
      expect(Object.isFrozen('fingerprintKdf' in saved ? saved.fingerprintKdf : null)).toBe(true);
      const preimage = JSON.stringify([f.target.targetId, original.providerId,
        original.methodIndex, original.authOptionId,
        Object.entries(original.fields).sort(([left], [right]) => left.localeCompare(right))]);
      const legacy = createHash('sha256').update(preimage).digest('hex');
      expect(saved.fingerprint).toBe(scryptSync(preimage, Buffer.from(salt, 'hex'), 32,
        { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }).toString('hex'));
      expect(saved.fingerprint).not.toBe(legacy);
      const path = join(f.directory, (await readdir(f.directory))[0]!);
      const bytes = await readFile(path, 'utf8');
      expect(bytes).not.toContain(legacy);
      expect(bytes).not.toContain('"client_secret"');
      expect(bytes).not.toContain('"!"');
      expect(bytes).not.toContain('TEST-mutated-after-call');
      expect(f.calls.find(call => call.operation === 'oauth.start')?.payload.fields)
        .toEqual(original.fields);
      f.stale();
      const clock = vi.spyOn(Date, 'now').mockReturnValue(f.expiresAt + 1);
      try { await new CapturedProviderOAuth(f.deps).connect(f.target, original); }
      finally { clock.mockRestore(); }
      expect(await readFile(path, 'utf8')).toBe(bytes);
      expect(f.calls.filter(call => call.operation === 'oauth.start')).toHaveLength(1);
      expect(f.calls.filter(call => call.operation === 'oauth.complete')).toHaveLength(1);
      expect(f.openExternal).toHaveBeenCalledTimes(1);
    } finally { await rm(f.directory, { recursive: true, force: true }); }
  }
);

it('retains the exact markerless Main start vector on cold completed replay after context and expiry drift', async () => {
  const f = await fixture('auto');
  const preimage = JSON.stringify(['a'.repeat(64), 'TEST-provider', 2, 'oauth:2',
    [['plan', 'TEST-private-field']]]);
  const legacy = { schemaVersion: 1 as const, operationId: f.input.operationId,
    targetId: f.target.targetId, providerId: f.input.providerId, methodIndex: 2,
    authOptionId: 'oauth:2', displayName: f.input.displayName,
    fingerprint: createHash('sha256').update(preimage).digest('hex') };
  try {
    expect(await f.store.create(legacy)).toBe(true);
    const path = join(f.directory, (await readdir(f.directory))[0]!);
    const bytes = await readFile(path, 'utf8');
    f.target.request = async (operation, payload) => {
      f.calls.push({ operation, payload });
      expect(operation).toBe('oauth.read');
      return { ok: true, value: { operationId: f.input.operationId,
        profileId: f.target.profileId, configRevision: f.target.configRevision,
        providerId: f.input.providerId, methodIndex: 2, phase: 'completed',
        completionMethod: 'auto', sequence: 17, expiresAt: f.expiresAt } };
    };
    f.stale();
    const current = vi.spyOn(f.target, 'isCurrent');
    const clock = vi.spyOn(Date, 'now').mockReturnValue(f.expiresAt + 1);
    try {
      await new CapturedProviderOAuth(f.deps).connect(f.target, f.input);
      expect(current).not.toHaveBeenCalled();
    } finally { current.mockRestore(); clock.mockRestore(); }
    expect(await readFile(path, 'utf8')).toBe(bytes);
    expect(await f.store.read(f.input.operationId)).toEqual(legacy);
    expect(f.calls.map(call => call.operation)).toEqual(['oauth.read']);
    expect(f.openExternal).not.toHaveBeenCalled();
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

it.each([false, true])(
  'reconciles the first atomic Main intent descriptor across two owners: changed fields=%s',
  async changed => {
    const f = await fixture('auto');
    const originalRead = Promise.withResolvers<void>(), bothCreates = Promise.withResolvers<void>();
    const nativeCompleted = Promise.withResolvers<void>();
    let reads = 0;
    const candidates: ProviderOAuthIntent[] = [];
    const request = f.target.request.bind(f.target);
    f.target.request = async (operation, payload) => {
      const response = await request(operation, payload);
      if (operation === 'oauth.complete') nativeCompleted.resolve();
      return response;
    };
    const intents: ProviderOAuthIntentStore = {
      async read(operationId) {
        const saved = await f.store.read(operationId);
        if (reads++ < 2) {
          if (reads === 2) originalRead.resolve();
          await originalRead.promise;
        }
        return saved;
      },
      async create(intent) {
        candidates.push(structuredClone(intent));
        if (candidates.length === 2) bothCreates.resolve();
        await bothCreates.promise;
        const created = await f.store.create(intent);
        // The losing reader observes a completed original, not an in-progress native reply.
        if (!created) await nativeCompleted.promise;
        return created;
      },
    };
    const inputs = [structuredClone(f.input), { ...f.input,
      fields: changed ? { plan: 'TEST-different-field' } : { ...f.input.fields } }];
    const pending = inputs.map(input =>
      new CapturedProviderOAuth({ ...f.deps, intents }).connect(f.target, input));
    const settled = Promise.allSettled(pending);
    try {
      await vi.waitFor(() => expect(candidates).toHaveLength(2), { timeout: 2_000 });
      const outcomes = await settled;
      expect(outcomes.filter(result => result.status === 'fulfilled'))
        .toHaveLength(changed ? 1 : 2);
      expect(outcomes.filter(result => result.status === 'rejected'))
        .toHaveLength(changed ? 1 : 0);
      expect(candidates).toHaveLength(2);
      expect(originalStartSalt(candidates[0])).not.toBe(originalStartSalt(candidates[1]));
      const saved = await f.store.read(f.input.operationId);
      if (!saved) throw new Error('Expected winning Main intent');
      expect(candidates.filter(candidate => candidate.fingerprint === saved.fingerprint))
        .toHaveLength(1);
      const starts = f.calls.filter(call => call.operation === 'oauth.start');
      expect(starts).toHaveLength(1);
      if (changed) {
        const winner = outcomes.findIndex(result => result.status === 'fulfilled');
        expect(starts[0]!.payload.fields).toEqual(inputs[winner]!.fields);
      }
      expect(f.calls.filter(call => call.operation === 'oauth.complete')).toHaveLength(1);
      expect(f.calls.filter(call => call.operation === 'oauth.cancel')).toEqual([]);
      expect(f.openExternal).toHaveBeenCalledTimes(1);
      const bytes = await readFile(join(f.directory, (await readdir(f.directory))[0]!), 'utf8');
      expect(JSON.parse(bytes)).toEqual(saved);
    } finally {
      originalRead.resolve(); bothCreates.resolve(); nativeCompleted.resolve();
      await Promise.allSettled(pending);
      await rm(f.directory, { recursive: true, force: true });
    }
  }
);

it('keeps an uncertain committed Main intent undispatched and cold re-entry read-only', async () => {
  const f = await fixture('auto');
  f.target.request = async (operation, payload) => {
    f.calls.push({ operation, payload });
    expect(operation).toBe('oauth.read');
    return { ok: true, value: null };
  };
  const owner = new CapturedProviderOAuth({ ...f.deps, intents: {
    read: operationId => f.store.read(operationId),
    async create(intent) {
      expect(await f.store.create(intent)).toBe(true);
      throw new Error('TEST original intent committed before acknowledgement failed');
    },
  } });
  try {
    await expect(owner.connect(f.target, f.input)).rejects.toThrow();
    expect(f.calls).toEqual([]);
    expect(f.openExternal).not.toHaveBeenCalled();
    originalStartSalt(await f.store.read(f.input.operationId));
    const path = join(f.directory, (await readdir(f.directory))[0]!);
    const bytes = await readFile(path, 'utf8');
    await expect(new CapturedProviderOAuth(f.deps).connect(f.target, f.input)).rejects.toThrow();
    expect(f.calls.map(call => call.operation)).toEqual(['oauth.read']);
    expect(await readFile(path, 'utf8')).toBe(bytes);
    expect(f.openExternal).not.toHaveBeenCalled();
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

it.each(['removed', 'replaced'] as const)(
  'refuses a %s original Main intent after its captured replay read without fresh dispatch',
  async change => {
    const f = await fixture('auto');
    try {
      await f.oauth.connect(f.target, f.input);
      const path = join(f.directory, (await readdir(f.directory))[0]!);
      let first = true, retained = '';
      const intents: ProviderOAuthIntentStore = {
        async read(operationId) {
          const saved = await f.store.read(operationId);
          if (first) {
            if (!saved) throw new Error('Expected original Main replay record');
            first = false;
            if (change === 'removed') await unlink(path);
            else {
              retained = JSON.stringify({ ...saved, displayName: 'TEST-replaced-display' }) + '\n';
              await writeFile(path, retained, { mode: 0o600 });
            }
          }
          return saved;
        },
        create: async () => { throw new Error('Replay cannot create another original'); },
      };
      const before = f.calls.length;
      await expect(new CapturedProviderOAuth({ ...f.deps, intents })
        .connect(f.target, f.input)).rejects.toThrow();
      expect(f.calls.slice(before)).toEqual([]);
      if (change === 'removed') expect(await f.store.read(f.input.operationId)).toBeNull();
      else expect(await readFile(path, 'utf8')).toBe(retained);
      expect(f.openExternal).toHaveBeenCalledTimes(1);
    } finally { await rm(f.directory, { recursive: true, force: true }); }
  }
);

it('rejects malformed or unsupported stored Main start descriptors', async () => {
  const f = await fixture('auto');
  try {
    await f.oauth.connect(f.target, f.input);
    const saved = await f.store.read(f.input.operationId);
    if (!saved) throw new Error('Expected valid original before descriptor corruption');
    const path = join(f.directory, (await readdir(f.directory))[0]!);
    for (const descriptor of [
      { version: 2, salt: 'a'.repeat(32) },
      { version: 1, salt: 'A'.repeat(32) },
      { version: 1, salt: 'a'.repeat(30) },
      { version: 1, salt: 'a'.repeat(32), N: 32768 },
    ]) {
      await writeFile(path, JSON.stringify({ ...saved, fingerprintKdf: descriptor }) + '\n',
        { mode: 0o600 });
      await expect(f.store.read(f.input.operationId)).rejects.toThrow();
    }
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});


function controlledStartCrypto() {
  const callbacks: ((error?: Error) => void)[] = [];
  let started = 0;
  const mock = vi.spyOn(crypto, 'scrypt').mockImplementation(
    (...[input, salt, length, options, callback]: Parameters<typeof crypto.scrypt>) => {
      if (!Buffer.isBuffer(input) || !Buffer.isBuffer(salt))
        throw new Error('Expected bounded crypto input buffers');
      expect(length).toBe(32);
      expect(options).toEqual({ N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 });
      started++;
      // Only callback scheduling is controlled here; real scrypt bytes are checked above.
      callbacks.push(error => callback(error ?? null,
        createHash('sha256').update(input).update(salt).digest()));
    }
  );
  syncBuiltinESMExports();
  return {
    started: () => started,
    finish(error?: Error) {
      const callback = callbacks.shift();
      if (!callback) throw new Error('No pending TEST crypto callback');
      callback(error);
    },
    restore() {
      while (callbacks.length) callbacks.shift()!(new Error('TEST crypto cleanup'));
      mock.mockRestore();
      syncBuiltinESMExports();
    },
  };
}

it('joins exact pending Main starts, rejects different fields, and cancels without waiting for crypto', async () => {
  const f = await fixture('auto'), controlled = controlledStartCrypto();
  const create = vi.spyOn(f.store, 'create');
  const originals = Promise.allSettled([
    f.oauth.connect(f.target, f.input),
    f.oauth.connect(f.target, { ...f.input, fields: { ...f.input.fields } }),
  ]);
  const pending: Promise<unknown>[] = [originals];
  try {
    await vi.waitFor(() => expect(controlled.started()).toBe(1), { timeout: 2_000 });
    await expect(f.oauth.connect(f.target, { ...f.input, fields: { plan: 'TEST-different' } }))
      .rejects.toThrow('OAuth intent conflict');
    let cancelled = false;
    const cancellation = f.oauth.cancel({ operationId: f.input.operationId })
      .then(value => { cancelled = true; return value; });
    pending.push(cancellation);
    await vi.waitFor(() => expect(cancelled).toBe(true), { timeout: 2_000 });
    expect(await cancellation).toEqual({ ok: true });
    expect(controlled.started()).toBe(1);
    expect(create).not.toHaveBeenCalled();
    expect(f.calls).toEqual([]);
    expect(f.openExternal).not.toHaveBeenCalled();
    controlled.finish();
    expect((await originals).map(result => result.status)).toEqual(['rejected', 'rejected']);
    const retry = Promise.allSettled([f.oauth.connect(f.target, f.input)]);
    pending.push(retry);
    await vi.waitFor(() => expect(controlled.started()).toBe(2), { timeout: 2_000 });
    controlled.finish();
    expect((await retry)[0]!.status).toBe('fulfilled');
    expect(create).toHaveBeenCalledTimes(1);
    expect(f.calls.filter(call => call.operation === 'oauth.start')).toHaveLength(1);
    expect(f.calls.filter(call => call.operation === 'oauth.complete')).toHaveLength(1);
    expect(f.calls.filter(call => call.operation === 'oauth.cancel')).toEqual([]);
    expect(f.openExternal).toHaveBeenCalledTimes(1);
  } finally {
    controlled.restore();
    await Promise.all(pending);
    create.mockRestore();
    await rm(f.directory, { recursive: true, force: true });
  }
});

it('rejects failed Main crypto without a fast fallback and releases the settled admission', async () => {
  const f = await fixture('auto'), controlled = controlledStartCrypto();
  const create = vi.spyOn(f.store, 'create');
  const first = Promise.allSettled([f.oauth.connect(f.target, f.input)]);
  const pending: Promise<unknown>[] = [first];
  try {
    await vi.waitFor(() => expect(controlled.started()).toBe(1), { timeout: 2_000 });
    controlled.finish(new Error('TEST crypto failed'));
    expect((await first)[0]!.status).toBe('rejected');
    expect(create).not.toHaveBeenCalled();
    expect(f.calls).toEqual([]);
    expect(await f.store.read(f.input.operationId)).toBeNull();
    const retry = Promise.allSettled([f.oauth.connect(f.target, f.input)]);
    pending.push(retry);
    await vi.waitFor(() => expect(controlled.started()).toBe(2), { timeout: 2_000 });
    controlled.finish();
    expect((await retry)[0]!.status).toBe('fulfilled');
    originalStartSalt(await f.store.read(f.input.operationId));
    expect(create).toHaveBeenCalledTimes(1);
    expect(f.calls.filter(call => call.operation === 'oauth.start')).toHaveLength(1);
  } finally {
    controlled.restore();
    await Promise.all(pending);
    create.mockRestore();
    await rm(f.directory, { recursive: true, force: true });
  }
});

it('rechecks the original Main context after crypto before creating any intent', async () => {
  const f = await fixture('auto'), controlled = controlledStartCrypto();
  const create = vi.spyOn(f.store, 'create');
  const pending = Promise.allSettled([f.oauth.connect(f.target, f.input)]);
  try {
    await vi.waitFor(() => expect(controlled.started()).toBe(1), { timeout: 2_000 });
    f.stale();
    controlled.finish();
    expect((await pending)[0]!.status).toBe('rejected');
    expect(create).not.toHaveBeenCalled();
    expect(await f.store.read(f.input.operationId)).toBeNull();
    expect(f.calls).toEqual([]);
    expect(f.openExternal).not.toHaveBeenCalled();
    expect(f.deps.restore).not.toHaveBeenCalled();
  } finally {
    controlled.restore();
    await pending;
    create.mockRestore();
    await rm(f.directory, { recursive: true, force: true });
  }
});

it('refuses a full shared crypto queue without creating or dispatching a Main start', async () => {
  const f = await fixture('auto'), controlled = controlledStartCrypto();
  const create = vi.spyOn(f.store, 'create');
  const pending: Promise<unknown>[] = [];
  try {
    const { deriveSecretFingerprint } =
      await import('@agent-teams/legacy-agent-host/management/secret-fingerprint');
    const queued = Promise.allSettled(Array.from({ length: 9 }, (_, index) =>
      deriveSecretFingerprint({ value: 'TEST-queued-' + index })));
    pending.push(queued);
    expect(controlled.started()).toBe(1);
    await expect(f.oauth.connect(f.target, f.input)).rejects.toThrow('Secret fingerprint busy');
    expect(create).not.toHaveBeenCalled();
    expect(f.calls).toEqual([]);
    expect(f.openExternal).not.toHaveBeenCalled();
    expect(await f.store.read(f.input.operationId)).toBeNull();
    for (let index = 0; index < 9; index++) controlled.finish();
    expect((await queued).every(result => result.status === 'fulfilled')).toBe(true);
    const retry = Promise.allSettled([f.oauth.connect(f.target, f.input)]);
    pending.push(retry);
    await vi.waitFor(() => expect(controlled.started()).toBe(10), { timeout: 2_000 });
    controlled.finish();
    expect((await retry)[0]!.status).toBe('fulfilled');
    expect(create).toHaveBeenCalledTimes(1);
    expect(f.calls.filter(call => call.operation === 'oauth.start')).toHaveLength(1);
  } finally {
    controlled.restore();
    await Promise.all(pending);
    create.mockRestore();
    await rm(f.directory, { recursive: true, force: true });
  }
});

it.each(['before-commit', 'after-commit'] as const)(
  'cancels an original Main create during %s I/O without dispatching native OAuth',
  async stage => {
    const f = await fixture('auto'), released = Promise.withResolvers<void>();
    let entered = false, committedBytes = '';
    let candidate: ProviderOAuthIntent | undefined;
    const owner = new CapturedProviderOAuth({ ...f.deps, intents: {
      read: operationId => f.store.read(operationId),
      async create(intent) {
        candidate = structuredClone(intent);
        if (stage === 'before-commit') { entered = true; await released.promise; }
        const created = await f.store.create(intent);
        committedBytes = await readFile(join(f.directory, (await readdir(f.directory))[0]!), 'utf8');
        if (stage === 'after-commit') { entered = true; await released.promise; }
        return created;
      },
    } });
    const pending = Promise.allSettled([owner.connect(f.target, f.input)]);
    let cancellation: ReturnType<CapturedProviderOAuth['cancel']> | undefined;
    try {
      await vi.waitFor(() => expect(entered).toBe(true), { timeout: 2_000 });
      expect(await f.store.read(f.input.operationId))
        .toEqual(stage === 'before-commit' ? null : candidate);
      let settled = false;
      cancellation = owner.cancel({ operationId: f.input.operationId })
        .then(value => { settled = true; return value; });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(settled).toBe(false);
      expect(f.calls).toEqual([]);
      expect(f.openExternal).not.toHaveBeenCalled();
      released.resolve();
      expect(await cancellation).toEqual({ ok: true });
      expect((await pending)[0]!.status).toBe('rejected');
      if (!candidate) throw new Error('Expected original captured create candidate');
      originalStartSalt(candidate);
      expect(await f.store.read(f.input.operationId)).toEqual(candidate);
      expect(await readFile(join(f.directory, (await readdir(f.directory))[0]!), 'utf8'))
        .toBe(committedBytes);
      expect(f.calls).toEqual([]);
      expect(f.openExternal).not.toHaveBeenCalled();
      expect(f.deps.restore).not.toHaveBeenCalled();
    } finally {
      released.resolve();
      await pending;
      await cancellation;
      await rm(f.directory, { recursive: true, force: true });
    }
  }
);
