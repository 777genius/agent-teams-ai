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
import type {
  ProviderOAuthIntent,
  ProviderOAuthIntentStore,
} from '../../../src/features/runtime-provider-management/main/infrastructure/FileProviderOAuthIntentStore';
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
    read?: (
      snapshot: ProviderOAuthSnapshot
    ) => ProviderOAuthSnapshot | Promise<ProviderOAuthSnapshot>;
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
  expect(isSafeOAuthAuthorizationUrl('https://github.com/login/device?' + 'A'.repeat(8192))).toBe(
    false
  );
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
] as const)(
  'clears original instructions for a %s cancel response without confirming cancellation',
  async (phase, publicPhase) => {
    const f = await fixture('auto', { holdAuto: true, cancelPhase: phase });
    const pending = f.oauth.connect(f.target, f.input).catch(() => undefined);
    try {
      await vi.waitFor(() =>
        expect(f.calls.filter((call) => call.operation === 'oauth.complete')).toHaveLength(1)
      );
      expect(f.progress.at(-1)?.instructions).toContain(f.instructionPrefix);
      expect(await f.oauth.cancel({ operationId: f.input.operationId })).toMatchObject({
        ok: false,
      });
      await pending;
      expect(f.progress.at(-1)).toMatchObject({
        operationId: f.input.operationId,
        phase: publicPhase,
        instructions: null,
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
  }
);

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
      expect(f.progress.some((event) => event.instructions?.includes(f.instructionPrefix))).toBe(
        false
      );
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
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('fingerprintKdf' in value))
    throw new Error('Expected private start descriptor');
  const descriptor = value.fingerprintKdf;
  if (
    !descriptor ||
    typeof descriptor !== 'object' ||
    Array.isArray(descriptor) ||
    !('version' in descriptor) ||
    descriptor.version !== 1 ||
    !('salt' in descriptor) ||
    typeof descriptor.salt !== 'string'
  )
    throw new Error('Invalid private start descriptor');
  expect(Object.keys(descriptor).sort()).toEqual(['salt', 'version']);
  expect(descriptor.salt).toMatch(/^[a-f0-9]{32}$/);
  return descriptor.salt;
}

it.each(['one-character', 'empty'] as const)(
  'stores a versioned private OAuth start fingerprint for %s fields and replays its original',
  async (kind) => {
    const f = await fixture('auto');
    const fields: Record<string, string> = kind === 'empty' ? {} : { client_secret: '!' };
    const input = { ...f.input, fields },
      original = structuredClone(input);
    try {
      const pending = f.oauth.connect(f.target, input);
      if (kind === 'one-character') fields.client_secret = 'TEST-mutated-after-call';
      await pending;
      const saved = await f.store.read(input.operationId);
      if (!saved) throw new Error('Expected original Main intent');
      const salt = originalStartSalt(saved);
      expect(Object.isFrozen(saved)).toBe(true);
      expect(Object.isFrozen('fingerprintKdf' in saved ? saved.fingerprintKdf : null)).toBe(true);
      const preimage = JSON.stringify([
        f.target.targetId,
        original.providerId,
        original.methodIndex,
        original.authOptionId,
        Object.entries(original.fields).sort(([left], [right]) => left.localeCompare(right)),
      ]);
      const legacy = createHash('sha256').update(preimage).digest('hex');
      expect(saved.fingerprint).toBe(
        scryptSync(preimage, Buffer.from(salt, 'hex'), 32, {
          N: 32768,
          r: 8,
          p: 3,
          maxmem: 64 * 1024 * 1024,
        }).toString('hex')
      );
      expect(saved.fingerprint).not.toBe(legacy);
      const path = join(f.directory, (await readdir(f.directory))[0]!);
      const bytes = await readFile(path, 'utf8');
      expect(bytes).not.toContain(legacy);
      expect(bytes).not.toContain('"client_secret"');
      expect(bytes).not.toContain('"!"');
      expect(bytes).not.toContain('TEST-mutated-after-call');
      expect(f.calls.find((call) => call.operation === 'oauth.start')?.payload.fields).toEqual(
        original.fields
      );
      f.stale();
      const clock = vi.spyOn(Date, 'now').mockReturnValue(f.expiresAt + 1);
      try {
        await new CapturedProviderOAuth(f.deps).connect(f.target, original);
      } finally {
        clock.mockRestore();
      }
      expect(await readFile(path, 'utf8')).toBe(bytes);
      expect(f.calls.filter((call) => call.operation === 'oauth.start')).toHaveLength(1);
      expect(f.calls.filter((call) => call.operation === 'oauth.complete')).toHaveLength(1);
      expect(f.openExternal).toHaveBeenCalledTimes(1);
    } finally {
      await rm(f.directory, { recursive: true, force: true });
    }
  }
);

it('retains the exact markerless Main start vector on cold completed replay after context and expiry drift', async () => {
  const f = await fixture('auto');
  const preimage = JSON.stringify([
    'a'.repeat(64),
    'TEST-provider',
    2,
    'oauth:2',
    [['plan', 'TEST-private-field']],
  ]);
  const legacy = {
    schemaVersion: 1 as const,
    operationId: f.input.operationId,
    targetId: f.target.targetId,
    providerId: f.input.providerId,
    methodIndex: 2,
    authOptionId: 'oauth:2',
    displayName: f.input.displayName,
    fingerprint: createHash('sha256').update(preimage).digest('hex'),
  };
  try {
    expect(await f.store.create(legacy)).toBe(true);
    const path = join(f.directory, (await readdir(f.directory))[0]!);
    const bytes = await readFile(path, 'utf8');
    f.target.request = async (operation, payload) => {
      f.calls.push({ operation, payload });
      expect(operation).toBe('oauth.read');
      return {
        ok: true,
        value: {
          operationId: f.input.operationId,
          profileId: f.target.profileId,
          configRevision: f.target.configRevision,
          providerId: f.input.providerId,
          methodIndex: 2,
          phase: 'completed',
          completionMethod: 'auto',
          sequence: 17,
          expiresAt: f.expiresAt,
        },
      };
    };
    f.stale();
    const current = vi.spyOn(f.target, 'isCurrent');
    const clock = vi.spyOn(Date, 'now').mockReturnValue(f.expiresAt + 1);
    try {
      await new CapturedProviderOAuth(f.deps).connect(f.target, f.input);
      expect(current).not.toHaveBeenCalled();
    } finally {
      current.mockRestore();
      clock.mockRestore();
    }
    expect(await readFile(path, 'utf8')).toBe(bytes);
    expect(await f.store.read(f.input.operationId)).toEqual(legacy);
    expect(f.calls.map((call) => call.operation)).toEqual(['oauth.read']);
    expect(f.openExternal).not.toHaveBeenCalled();
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

it.each([false, true])(
  'reconciles the first atomic Main intent descriptor across two owners: changed fields=%s',
  async (changed) => {
    const f = await fixture('auto');
    const originalRead = Promise.withResolvers<void>(),
      bothCreates = Promise.withResolvers<void>();
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
    const inputs = [
      structuredClone(f.input),
      { ...f.input, fields: changed ? { plan: 'TEST-different-field' } : { ...f.input.fields } },
    ];
    const pending = inputs.map((input) =>
      new CapturedProviderOAuth({ ...f.deps, intents }).connect(f.target, input)
    );
    const settled = Promise.allSettled(pending);
    try {
      await vi.waitFor(() => expect(candidates).toHaveLength(2), { timeout: 2_000 });
      const outcomes = await settled;
      expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(
        changed ? 1 : 2
      );
      expect(outcomes.filter((result) => result.status === 'rejected')).toHaveLength(
        changed ? 1 : 0
      );
      expect(candidates).toHaveLength(2);
      expect(originalStartSalt(candidates[0])).not.toBe(originalStartSalt(candidates[1]));
      const saved = await f.store.read(f.input.operationId);
      if (!saved) throw new Error('Expected winning Main intent');
      expect(
        candidates.filter((candidate) => candidate.fingerprint === saved.fingerprint)
      ).toHaveLength(1);
      const starts = f.calls.filter((call) => call.operation === 'oauth.start');
      expect(starts).toHaveLength(1);
      if (changed) {
        const winner = outcomes.findIndex((result) => result.status === 'fulfilled');
        expect(starts[0]!.payload.fields).toEqual(inputs[winner]!.fields);
      }
      expect(f.calls.filter((call) => call.operation === 'oauth.complete')).toHaveLength(1);
      expect(f.calls.filter((call) => call.operation === 'oauth.cancel')).toEqual([]);
      expect(f.openExternal).toHaveBeenCalledTimes(1);
      const bytes = await readFile(join(f.directory, (await readdir(f.directory))[0]!), 'utf8');
      expect(JSON.parse(bytes)).toEqual(saved);
    } finally {
      originalRead.resolve();
      bothCreates.resolve();
      nativeCompleted.resolve();
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
  const owner = new CapturedProviderOAuth({
    ...f.deps,
    intents: {
      read: (operationId) => f.store.read(operationId),
      async create(intent) {
        expect(await f.store.create(intent)).toBe(true);
        throw new Error('TEST original intent committed before acknowledgement failed');
      },
    },
  });
  try {
    await expect(owner.connect(f.target, f.input)).rejects.toThrow();
    expect(f.calls).toEqual([]);
    expect(f.openExternal).not.toHaveBeenCalled();
    originalStartSalt(await f.store.read(f.input.operationId));
    const path = join(f.directory, (await readdir(f.directory))[0]!);
    const bytes = await readFile(path, 'utf8');
    await expect(new CapturedProviderOAuth(f.deps).connect(f.target, f.input)).rejects.toThrow();
    expect(f.calls.map((call) => call.operation)).toEqual(['oauth.read']);
    expect(await readFile(path, 'utf8')).toBe(bytes);
    expect(f.openExternal).not.toHaveBeenCalled();
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

it.each(['removed', 'replaced'] as const)(
  'refuses a %s original Main intent after its captured replay read without fresh dispatch',
  async (change) => {
    const f = await fixture('auto');
    try {
      await f.oauth.connect(f.target, f.input);
      const path = join(f.directory, (await readdir(f.directory))[0]!);
      let first = true,
        retained = '';
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
        create: async () => {
          throw new Error('Replay cannot create another original');
        },
      };
      const before = f.calls.length;
      await expect(
        new CapturedProviderOAuth({ ...f.deps, intents }).connect(f.target, f.input)
      ).rejects.toThrow();
      expect(f.calls.slice(before)).toEqual([]);
      if (change === 'removed') expect(await f.store.read(f.input.operationId)).toBeNull();
      else expect(await readFile(path, 'utf8')).toBe(retained);
      expect(f.openExternal).toHaveBeenCalledTimes(1);
    } finally {
      await rm(f.directory, { recursive: true, force: true });
    }
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
      await writeFile(path, JSON.stringify({ ...saved, fingerprintKdf: descriptor }) + '\n', {
        mode: 0o600,
      });
      await expect(f.store.read(f.input.operationId)).rejects.toThrow();
    }
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

function controlledStartCrypto() {
  const callbacks: ((error?: Error) => void)[] = [];
  let started = 0;
  const mock = vi
    .spyOn(crypto, 'scrypt')
    .mockImplementation(
      (...[input, salt, length, options, callback]: Parameters<typeof crypto.scrypt>) => {
        if (!Buffer.isBuffer(input) || !Buffer.isBuffer(salt))
          throw new Error('Expected bounded crypto input buffers');
        expect(length).toBe(32);
        expect(options).toEqual({ N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 });
        started++;
        // Only callback scheduling is controlled here; real scrypt bytes are checked above.
        callbacks.push((error) =>
          callback(error ?? null, createHash('sha256').update(input).update(salt).digest())
        );
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
  const f = await fixture('auto'),
    controlled = controlledStartCrypto();
  const create = vi.spyOn(f.store, 'create');
  const first = f.oauth.connect(f.target, f.input);
  const duplicate = f.oauth.connect(f.target, { ...f.input, fields: { ...f.input.fields } });
  const originals = Promise.allSettled([first, duplicate]);
  const pending: Promise<unknown>[] = [originals];
  try {
    await vi.waitFor(() => expect(controlled.started()).toBe(1), { timeout: 2_000 });
    expect(duplicate).toBe(first);
    await expect(
      f.oauth.connect(f.target, { ...f.input, fields: { plan: 'TEST-different' } })
    ).rejects.toThrow('OAuth intent conflict');
    let cancelled = false;
    const cancellation = f.oauth.cancel({ operationId: f.input.operationId }).then((value) => {
      cancelled = true;
      return value;
    });
    pending.push(cancellation);
    await vi.waitFor(() => expect(cancelled).toBe(true), { timeout: 2_000 });
    expect(await cancellation).toEqual({ ok: true });
    expect(controlled.started()).toBe(1);
    expect(create).not.toHaveBeenCalled();
    expect(f.calls).toEqual([]);
    expect(f.openExternal).not.toHaveBeenCalled();
    controlled.finish();
    expect((await originals).map((result) => result.status)).toEqual(['rejected', 'rejected']);
    const retry = Promise.allSettled([f.oauth.connect(f.target, f.input)]);
    pending.push(retry);
    await vi.waitFor(() => expect(controlled.started()).toBe(2), { timeout: 2_000 });
    controlled.finish();
    expect((await retry)[0]!.status).toBe('fulfilled');
    expect(create).toHaveBeenCalledTimes(1);
    expect(f.calls.filter((call) => call.operation === 'oauth.start')).toHaveLength(1);
    expect(f.calls.filter((call) => call.operation === 'oauth.complete')).toHaveLength(1);
    expect(f.calls.filter((call) => call.operation === 'oauth.cancel')).toEqual([]);
    expect(f.openExternal).toHaveBeenCalledTimes(1);
  } finally {
    controlled.restore();
    await Promise.all(pending);
    create.mockRestore();
    await rm(f.directory, { recursive: true, force: true });
  }
});

it('rejects failed Main crypto without a fast fallback and releases the settled admission', async () => {
  const f = await fixture('auto'),
    controlled = controlledStartCrypto();
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
    expect(f.calls.filter((call) => call.operation === 'oauth.start')).toHaveLength(1);
  } finally {
    controlled.restore();
    await Promise.all(pending);
    create.mockRestore();
    await rm(f.directory, { recursive: true, force: true });
  }
});

it('rechecks the original Main context after crypto before creating any intent', async () => {
  const f = await fixture('auto'),
    controlled = controlledStartCrypto();
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
  const f = await fixture('auto'),
    controlled = controlledStartCrypto();
  const create = vi.spyOn(f.store, 'create');
  const pending: Promise<unknown>[] = [];
  try {
    const { deriveSecretFingerprint } =
      await import('@agent-teams/legacy-agent-host/management/secret-fingerprint');
    const queued = Promise.allSettled(
      Array.from({ length: 9 }, (_, index) =>
        deriveSecretFingerprint({ value: 'TEST-queued-' + index })
      )
    );
    pending.push(queued);
    expect(controlled.started()).toBe(1);
    await expect(f.oauth.connect(f.target, f.input)).rejects.toThrow('Secret fingerprint busy');
    expect(create).not.toHaveBeenCalled();
    expect(f.calls).toEqual([]);
    expect(f.openExternal).not.toHaveBeenCalled();
    expect(await f.store.read(f.input.operationId)).toBeNull();
    for (let index = 0; index < 9; index++) controlled.finish();
    expect((await queued).every((result) => result.status === 'fulfilled')).toBe(true);
    const retry = Promise.allSettled([f.oauth.connect(f.target, f.input)]);
    pending.push(retry);
    await vi.waitFor(() => expect(controlled.started()).toBe(10), { timeout: 2_000 });
    controlled.finish();
    expect((await retry)[0]!.status).toBe('fulfilled');
    expect(create).toHaveBeenCalledTimes(1);
    expect(f.calls.filter((call) => call.operation === 'oauth.start')).toHaveLength(1);
  } finally {
    controlled.restore();
    await Promise.all(pending);
    create.mockRestore();
    await rm(f.directory, { recursive: true, force: true });
  }
});

it.each(['before-commit', 'after-commit'] as const)(
  'cancels an original Main create during %s I/O without dispatching native OAuth',
  async (stage) => {
    const f = await fixture('auto'),
      released = Promise.withResolvers<void>();
    let entered = false,
      committedBytes = '';
    let candidate: ProviderOAuthIntent | undefined;
    const owner = new CapturedProviderOAuth({
      ...f.deps,
      intents: {
        read: (operationId) => f.store.read(operationId),
        async create(intent) {
          candidate = structuredClone(intent);
          if (stage === 'before-commit') {
            entered = true;
            await released.promise;
          }
          const created = await f.store.create(intent);
          committedBytes = await readFile(
            join(f.directory, (await readdir(f.directory))[0]!),
            'utf8'
          );
          if (stage === 'after-commit') {
            entered = true;
            await released.promise;
          }
          return created;
        },
      },
    });
    const pending = Promise.allSettled([owner.connect(f.target, f.input)]);
    let cancellation: ReturnType<CapturedProviderOAuth['cancel']> | undefined;
    try {
      await vi.waitFor(() => expect(entered).toBe(true), { timeout: 2_000 });
      expect(await f.store.read(f.input.operationId)).toEqual(
        stage === 'before-commit' ? null : candidate
      );
      let settled = false;
      cancellation = owner.cancel({ operationId: f.input.operationId }).then((value) => {
        settled = true;
        return value;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      expect(f.calls).toEqual([]);
      expect(f.openExternal).not.toHaveBeenCalled();
      released.resolve();
      expect(await cancellation).toEqual({ ok: true });
      expect((await pending)[0]!.status).toBe('rejected');
      if (!candidate) throw new Error('Expected original captured create candidate');
      originalStartSalt(candidate);
      expect(await f.store.read(f.input.operationId)).toEqual(candidate);
      expect(await readFile(join(f.directory, (await readdir(f.directory))[0]!), 'utf8')).toBe(
        committedBytes
      );
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

it.each(['removed', 'replaced'] as const)(
  'G1d refuses its original %s after successful Main creation before native start',
  async (change) => {
    const f = await fixture('auto');
    let originalPath = '',
      replacement = '';
    const oauth = new CapturedProviderOAuth({
      ...f.deps,
      intents: {
        read: (id) => f.store.read(id),
        async create(intent) {
          const created = await f.store.create(intent);
          expect(created).toBe(true);
          originalPath = join(f.directory, (await readdir(f.directory))[0]!);
          if (change === 'removed') await unlink(originalPath);
          else {
            replacement =
              JSON.stringify({ ...intent, displayName: 'TEST-replaced-original' }) + '\n';
            await writeFile(originalPath, replacement, { mode: 0o600 });
          }
          return created;
        },
      },
    });
    try {
      const outcome = await oauth.connect(f.target, f.input).then(
        () => null,
        (error) => error
      );
      expect(f.calls.filter((call) => call.operation === 'oauth.start')).toEqual([]);
      expect(outcome).toBeInstanceOf(Error);
      expect(f.openExternal).not.toHaveBeenCalled();
      if (change === 'removed') expect(await f.store.read(f.input.operationId)).toBeNull();
      else expect(await readFile(originalPath, 'utf8')).toBe(replacement);
    } finally {
      await rm(f.directory, { recursive: true, force: true });
    }
  }
);

it.each(['removed', 'replaced'] as const)(
  'G1d refuses its original %s while the final retained Host read is pending',
  async (change) => {
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    let blocked = false;
    const f = await fixture('auto', {
      read: async (snapshot) => {
        if (blocked) {
          entered.resolve();
          await release.promise;
        }
        return snapshot;
      },
    });
    await f.oauth.connect(f.target, f.input);
    const path = join(f.directory, (await readdir(f.directory))[0]!);
    blocked = true;
    const pending = new CapturedProviderOAuth(f.deps).connect(f.target, f.input).then(
      () => null,
      (error) => error
    );
    try {
      await entered.promise;
      if (change === 'removed') await unlink(path);
      else {
        const original = await f.store.read(f.input.operationId);
        if (!original) throw new Error('Expected original TEST intent');
        await writeFile(
          path,
          JSON.stringify({ ...original, displayName: 'TEST-replaced-original' }) + '\n',
          { mode: 0o600 }
        );
      }
      release.resolve();
      expect(await pending).toBeInstanceOf(Error);
      expect(f.calls.filter((call) => call.operation === 'oauth.start')).toHaveLength(1);
      expect(f.openExternal).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
      await pending;
      await rm(f.directory, { recursive: true, force: true });
    }
  }
);

it('G1d never cancels another captured target when its own pending create loses', async () => {
  const f = await fixture('auto');
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const foreignCalls: string[] = [];
  const originalRequest = f.target.request.bind(f.target);
  const foreign: CapturedProviderManagement = {
    ...f.target,
    targetId: 'b'.repeat(64),
    async request(operation, payload) {
      foreignCalls.push(operation);
      return originalRequest(operation, payload);
    },
  };
  const restore = vi.fn(async (targetId: string) => {
    expect(targetId).toBe(foreign.targetId);
    return foreign;
  });
  const oauth = new CapturedProviderOAuth({
    ...f.deps,
    restore,
    intents: {
      read: (id) => f.store.read(id),
      async create(intent) {
        entered.resolve();
        await release.promise;
        return f.store.create(intent);
      },
    },
  });
  const pending = oauth.connect(f.target, f.input).then(
    () => null,
    (error) => error
  );
  let cancellation: ReturnType<CapturedProviderOAuth['cancel']> | undefined;
  try {
    await entered.promise;
    await f.oauth.connect(foreign, f.input);
    const path = join(f.directory, (await readdir(f.directory))[0]!);
    const bytes = await readFile(path, 'utf8'),
      before = foreignCalls.length;
    cancellation = oauth.cancel({ operationId: f.input.operationId });
    release.resolve();
    expect(await cancellation).toEqual({
      ok: false,
      error: 'Unable to confirm the original sign-in operation.',
    });
    expect(await pending).toBeInstanceOf(Error);
    expect(restore).not.toHaveBeenCalled();
    expect(foreignCalls.slice(before)).toEqual([]);
    expect(await readFile(path, 'utf8')).toBe(bytes);
    expect(f.calls.filter((call) => call.operation === 'oauth.start')).toHaveLength(1);
  } finally {
    release.resolve();
    await cancellation;
    await pending;
    await rm(f.directory, { recursive: true, force: true });
  }
});

it.each(['cancel', 'stale'] as const)(
  'G1d stops waiting presentation after its first listener makes the owner %s',
  async (action) => {
    const f = await fixture('auto');
    const first: RuntimeProviderOAuthProgressDto[] = [],
      second: RuntimeProviderOAuthProgressDto[] = [];
    const controls: ReturnType<CapturedProviderOAuth['cancel']>[] = [];
    f.oauth.subscribe((event) => {
      if (event.phase !== 'waiting-for-browser') return;
      first.push(event);
      if (action === 'cancel') controls.push(f.oauth.cancel({ operationId: f.input.operationId }));
      else f.stale();
    });
    f.oauth.subscribe((event) => {
      if (event.phase === 'waiting-for-browser') second.push(event);
    });
    try {
      await expect(f.oauth.connect(f.target, f.input)).rejects.toThrow('unconfirmed');
      await Promise.all(controls);
      expect(first).toHaveLength(1);
      expect(second).toEqual([]);
      expect(f.openExternal).not.toHaveBeenCalled();
    } finally {
      await Promise.all(controls);
      await rm(f.directory, { recursive: true, force: true });
    }
  }
);

it.each(['cancel', 'stale'] as const)(
  'G1d clears a confirmed terminal presentation once when a listener makes the owner %s',
  async (action) => {
    let terminal = false;
    const f = await fixture('auto', {
      holdAuto: true,
      read: (snapshot) =>
        terminal ? { ...snapshot, phase: 'cancelled', sequence: snapshot.sequence + 1 } : snapshot,
    });
    const first: RuntimeProviderOAuthProgressDto[] = [],
      second: RuntimeProviderOAuthProgressDto[] = [];
    const controls: ReturnType<CapturedProviderOAuth['cancel']>[] = [];
    f.oauth.subscribe((event) => {
      if (event.phase !== 'cancelled') return;
      first.push(event);
      if (action === 'cancel') controls.push(f.oauth.cancel({ operationId: f.input.operationId }));
      else f.stale();
    });
    f.oauth.subscribe((event) => {
      if (event.phase === 'cancelled') second.push(event);
    });
    const pending = f.oauth.connect(f.target, f.input).then(
      () => null,
      (error) => error
    );
    try {
      await vi.waitFor(() =>
        expect(f.calls.some((call) => call.operation === 'oauth.complete')).toBe(true)
      );
      terminal = true;
      expect(await pending).toBeInstanceOf(Error);
      await Promise.all(controls);
      expect(first).toHaveLength(1);
      expect(second).toHaveLength(action === 'cancel' ? 1 : 0);
      expect(f.progress.filter((event) => event.phase === 'cancelled')).toHaveLength(1);
      expect(first[0]).toMatchObject({ instructions: null });
      expect(first[0]?.authorizationUrl).toBeUndefined();
    } finally {
      terminal = true;
      await f.oauth.cancel({ operationId: f.input.operationId });
      await pending;
      await Promise.all(controls);
      await rm(f.directory, { recursive: true, force: true });
    }
  }
);

it('publishes a newer held cleanup after the same original cancelling response', async () => {
  const options: NonNullable<Parameters<typeof fixture>[1]> = {
    holdAuto: true,
    cancelPhase: 'cancelling',
  };
  const f = await fixture('auto', options);
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const originalRequest = f.target.request.bind(f.target);
  f.target.request = async (operation, payload) => {
    const reply = await originalRequest(operation, payload);
    if (operation === 'oauth.complete') {
      entered.resolve();
      await release.promise;
    }
    return reply;
  };
  const pending = f.oauth.connect(f.target, f.input).then(
    () => null,
    (error) => error
  );
  try {
    await entered.promise;
    expect(f.progress.at(-1)?.instructions).toContain(f.instructionPrefix);
    expect(await f.oauth.cancel({ operationId: f.input.operationId })).toMatchObject({
      ok: false,
    });
    expect(f.progress.at(-1)).toMatchObject({
      phase: 'cancelled',
      instructions: null,
      completionMethod: 'auto',
    });
    options.cancelPhase = 'held';
    release.resolve();
    expect(await pending).toBeInstanceOf(Error);
    const cleared = f.progress.filter((event) => ['cancelled', 'failed'].includes(event.phase));
    expect(cleared.map((event) => event.phase)).toEqual(['cancelled', 'failed']);
    expect(cleared.every((event) => event.instructions === null)).toBe(true);
    expect(cleared.every((event) => event.authorizationUrl === undefined)).toBe(true);
    expect(f.calls.filter((call) => call.operation === 'oauth.start')).toHaveLength(1);
    expect(f.calls.filter((call) => call.operation === 'oauth.complete')).toHaveLength(1);
    expect(f.openExternal).toHaveBeenCalledTimes(1);
  } finally {
    release.resolve();
    await f.oauth.cancel({ operationId: f.input.operationId });
    await pending;
    await rm(f.directory, { recursive: true, force: true });
  }
});

it('does not replace newer original cleanup progress with a late older cancel reply', async () => {
  const options: NonNullable<Parameters<typeof fixture>[1]> = {
    holdAuto: true,
    cancelPhase: 'cancelling',
  };
  const f = await fixture('auto', options);
  const autoEntered = Promise.withResolvers<void>(),
    autoRelease = Promise.withResolvers<void>(),
    cancelEntered = Promise.withResolvers<void>(),
    cancelRelease = Promise.withResolvers<void>();
  let cancelReads = 0;
  const originalRequest = f.target.request.bind(f.target);
  f.target.request = async (operation, payload) => {
    const reply = await originalRequest(operation, payload);
    if (operation === 'oauth.complete') {
      autoEntered.resolve();
      await autoRelease.promise;
    }
    if (operation === 'oauth.cancel' && ++cancelReads === 1) {
      cancelEntered.resolve();
      await cancelRelease.promise;
    }
    return reply;
  };
  const pending = f.oauth.connect(f.target, f.input).then(
    () => null,
    (error) => error
  );
  let firstCancel: ReturnType<CapturedProviderOAuth['cancel']> | undefined;
  try {
    await autoEntered.promise;
    firstCancel = f.oauth.cancel({ operationId: f.input.operationId });
    await cancelEntered.promise;
    options.cancelPhase = 'held';
    expect(await f.oauth.cancel({ operationId: f.input.operationId })).toMatchObject({
      ok: false,
    });
    expect(f.progress.at(-1)).toMatchObject({
      phase: 'failed',
      instructions: null,
      completionMethod: 'auto',
    });
    cancelRelease.resolve();
    expect(await firstCancel).toMatchObject({ ok: false });
    expect(f.progress.at(-1)?.phase).toBe('failed');
    autoRelease.resolve();
    expect(await pending).toBeInstanceOf(Error);
    const cleared = f.progress.filter((event) => ['cancelled', 'failed'].includes(event.phase));
    expect(cleared.map((event) => event.phase)).toEqual(['failed']);
    expect(cleared[0]).toMatchObject({ instructions: null });
    expect(cleared[0]?.authorizationUrl).toBeUndefined();
    expect(f.calls.filter((call) => call.operation === 'oauth.start')).toHaveLength(1);
    expect(f.calls.filter((call) => call.operation === 'oauth.complete')).toHaveLength(1);
    expect(f.openExternal).toHaveBeenCalledTimes(1);
  } finally {
    cancelRelease.resolve();
    autoRelease.resolve();
    await firstCancel;
    await f.oauth.cancel({ operationId: f.input.operationId });
    await pending;
    await rm(f.directory, { recursive: true, force: true });
  }
});

it.each(['current', 'stale', 'journal', 'successor', 'listener-stale'] as const)(
  'keeps cold cleanup on its original route while presentation becomes %s',
  async (mode) => {
    const f = await fixture();
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>(),
      successorRelease = Promise.withResolvers<void>();
    const coldProgress: RuntimeProviderOAuthProgressDto[] = [];
    const cold = new CapturedProviderOAuth({
      ...f.deps,
      emitProgress: (event) => coldProgress.push(event),
    });
    const second = vi.fn();
    cold.subscribe(() => {
      if (mode === 'listener-stale') f.stale();
    });
    cold.subscribe(second);
    let first = true;
    const originalRequest = f.target.request.bind(f.target);
    f.target.request = async (operation, payload) => {
      const reply = await originalRequest(operation, payload);
      if (operation === 'oauth.cancel' && first) {
        first = false;
        entered.resolve();
        await release.promise;
      }
      return reply;
    };
    const pending = f.oauth.connect(f.target, f.input).catch(() => undefined);
    let cancellation: ReturnType<CapturedProviderOAuth['cancel']> | undefined;
    let successor: ReturnType<CapturedProviderOAuth['connectPrepared']> | undefined;
    try {
      await vi.waitFor(() => expect(f.openExternal).toHaveBeenCalledTimes(1));
      cancellation = cold.cancel({ operationId: f.input.operationId });
      await entered.promise;
      if (mode === 'stale') f.stale();
      if (mode === 'journal') {
        const intent = await f.store.read(f.input.operationId);
        if (!intent) throw new Error('Expected original TEST intent');
        const path = join(f.directory, (await readdir(f.directory))[0]!);
        await writeFile(path, JSON.stringify({ ...intent, displayName: 'TEST-replaced' }) + '\n', {
          mode: 0o600,
        });
      }
      if (mode === 'successor') {
        successor = cold.connectPrepared(
          {
            runtimeId: 'opencode',
            providerId: f.input.providerId,
            method: 'oauth',
            authOptionId: f.input.authOptionId,
            oauthOperationId: f.input.operationId,
          },
          async () => {
            await successorRelease.promise;
            return null;
          }
        );
      }
      release.resolve();
      expect(await cancellation).toEqual({ ok: true });
      const shouldPresent = mode === 'current' || mode === 'listener-stale';
      expect(coldProgress).toHaveLength(shouldPresent ? 1 : 0);
      if (shouldPresent) {
        expect(coldProgress[0]).toMatchObject({
          operationId: f.input.operationId,
          phase: 'cancelled',
          instructions: null,
        });
        expect(coldProgress[0]?.authorizationUrl).toBeUndefined();
      }
      expect(second).toHaveBeenCalledTimes(mode === 'current' ? 1 : 0);
      expect(f.deps.restore).toHaveBeenCalledWith(f.target.targetId);
      expect(f.calls.filter((call) => call.operation === 'oauth.start')).toHaveLength(1);
      expect(f.calls.filter((call) => call.operation === 'oauth.complete')).toEqual([]);
      expect(f.openExternal).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
      successorRelease.resolve();
      await cancellation;
      await successor;
      await pending;
      await rm(f.directory, { recursive: true, force: true });
    }
  }
);
