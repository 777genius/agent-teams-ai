// @vitest-environment node
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
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
import type { JsonValue } from '@agent-teams/legacy-agent-host/contracts';
import type { ProviderOAuthSnapshot } from '@agent-teams/legacy-agent-host/management/contracts';

async function fixture(
  method: 'code' | 'auto' = 'code',
  options: {
    providerId?: string;
    authorizationUrl?: string;
    instructions?: string;
    holdAuto?: boolean;
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
        phase = 'cancelled';
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
