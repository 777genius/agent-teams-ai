// @vitest-environment node
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { expect, it, vi } from 'vitest';

import {
  fileHash,
  startHost,
} from '../../../packages/legacy-agent-host/tests/fixtures/native-host';
import { BackendRoutingError } from '../../../src/features/agent-backend/main';
import { captureProviderManagement } from '../../../src/features/agent-backend/main/infrastructure/CapturedProviderManagement';
import {
  CODEX_ACCOUNT_CANCEL_CHATGPT_LOGIN,
  CODEX_ACCOUNT_GET_SNAPSHOT,
  CODEX_ACCOUNT_LOGOUT,
  CODEX_ACCOUNT_REFRESH_SNAPSHOT,
  CODEX_ACCOUNT_START_CHATGPT_LOGIN,
} from '../../../src/features/codex-account/contracts';
import { registerCodexAccountIpc } from '../../../src/features/codex-account/main';
import { createCapturedCodexFeatures } from '../../../src/features/runtime-provider-management/main/adapters/output/createCapturedCodexFeatures';
import { FileCodexAuthIntentStore } from '../../../src/features/runtime-provider-management/main/infrastructure/FileCodexAuthIntentStore';

import type { TeamHostProfile } from '../../../packages/legacy-agent-host/dist/composition/TeamHost';
import type {
  CodexAccountAuthMode,
  CodexAccountSnapshotDto,
} from '../../../src/features/codex-account/contracts';
import type { JsonValue } from '@agent-teams/legacy-agent-host/contracts';
import type { IpcMainInvokeEvent } from 'electron';

// This controlled shebang child has POSIX custody. Native Windows qualification is separate.
const posixIt = it.skipIf(process.platform === 'win32');

/** Actual account IPC/Main → Host/D → controlled child. Electron UI/vendor login are separate gates. */
async function fixture(scenario: 'early' | 'pending' | 'rejected-then-pending', sameContext = false, protocolRevision: '0.162.0' | '0.169.0' = '0.162.0') {
  const repo = resolve(import.meta.dirname, '../../..');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-codex-login-main-')));
  for (const name of [
    'home',
    'tmp',
    'store',
    'bin',
    'a',
    'a/home',
    'a/codex',
    'a/workspace',
    'b',
    'b/home',
    'b/codex',
    'b/workspace',
  ])
    await mkdir(join(root, name), { mode: 0o700 });
  const node = await realpath(process.env.AGENT_BACKEND_TEST_NODE ?? process.execPath);
  const executable = join(root, 'bin/TEST-codex.ts');
  await writeFile(
    executable,
    `#!${node}\n` +
      (await readFile(
        join(repo, 'packages/legacy-agent-host/tests/fixtures/codex-metadata-peer.ts'),
        'utf8'
      )),
    { mode: 0o700 }
  );
  const entry = join(repo, 'packages/legacy-agent-host/dist/cli.js');
  const profile: TeamHostProfile = {
    schemaVersion: 1,
    principalId: 'TEST-human',
    teams: [],
    owner: {
      ownerId: 'TEST-owner',
      revision: 'TEST-v1',
      profileId: 'TEST-host',
      protocolVersion: 1,
      buildId: 'TEST-codex-main',
      storageRoot: join(root, 'store'),
      nodeSha256: await fileHash(node),
      hostEntrySha256: await fileHash(entry),
    },
    management: await Promise.all(
      ['a', 'b'].map(async (key) => ({
        provider: 'codex' as const,
        protocolRevision,
        profileId: 'TEST-profile-' + key,
        configRevision: 'TEST-config-' + key,
        accountBinding: 'TEST-account-' + key,
        cwd: join(root, key, 'workspace'),
        timeoutMs: 3000,
        executable: { path: executable, sha256: await fileHash(executable) },
        environment: {
          HOME: join(root, key, 'home'),
          CODEX_HOME: join(root, key, 'codex'),
          TEST_LOGIN: scenario,
          ...(protocolRevision === '0.169.0' ? { TEST_CODEX_0169: '1' } : {}),
          ...(key === 'a' ? { OPENAI_API_KEY: 'TEST-captured-private-key' } : {}),
        },
      }))
    ),
  };
  const profilePath = join(root, 'profile.json');
  await writeFile(profilePath, JSON.stringify(profile), { mode: 0o600 });
  const host = startHost({
    node,
    root,
    entry,
    profile: profilePath,
    profileHash: await fileHash(profilePath),
  });
  await host.rpc('host.handshake', { protocolVersion: 1 });
  let foreground = 'a',
    preferred: CodexAccountAuthMode = 'auto',
    loseStart = false;
  const store = new FileCodexAuthIntentStore(join(root, 'intents'));
  const restoreCalls: { targetId: string; contextId: string }[] = [];
  const clients: ReturnType<typeof createCapturedCodexFeatures>[] = [];
  let cancelReply:
    | {
        started: ReturnType<typeof Promise.withResolvers<void>>;
        release: ReturnType<typeof Promise.withResolvers<void>>;
      }
    | undefined;
  const target = (key: string) => ({
    ...captureProviderManagement({
      targetId: key.repeat(64),
      profileId: 'TEST-profile-' + key,
      configRevision: 'TEST-config-' + key,
      client: {
        request: async (method, payload) => {
          const result = await host.rpc(method, payload);
          const pending = cancelReply;
          if (method === 'management.oauth.cancel' && pending) {
            pending.started.resolve();
            await pending.release.promise;
            if (cancelReply === pending) cancelReply = undefined;
          }
          if (loseStart && method === 'management.oauth.start') {
            loseStart = false;
            throw new BackendRoutingError('unavailable', 'unknown');
          }
          return result as JsonValue;
        },
      },
      start: async () => {},
      ownerAvailable: () => true,
      foregroundCurrent: () => sameContext || foreground === key,
    }),
    originalContextId: sameContext ? 'TEST-context-shared' : 'TEST-context-' + key,
  });
  const create = () => {
    const features = createCapturedCodexFeatures(
      async () => target(foreground),
      store,
      () => preferred,
      async (targetId, contextId) => {
        restoreCalls.push({ targetId, contextId });
        const key = ['a', 'b'].find(
          (candidate) =>
            targetId === candidate.repeat(64) &&
            contextId === (sameContext ? 'TEST-context-shared' : 'TEST-context-' + candidate)
        );
        if (!key) throw new Error('Foreign original context');
        return target(key);
      }
    );
    clients.push(features);
    const handlers = new Map<
      string,
      (event: IpcMainInvokeEvent, input?: unknown) => Promise<CodexAccountSnapshotDto>
    >();
    registerCodexAccountIpc(
      {
        handle: (channel, handler) => {
          handlers.set(channel, handler);
        },
      },
      features.accountFeature
    );
    return {
      feature: features.accountFeature,
      invoke: (channel: string, options?: unknown) =>
        handlers.get(channel)!({} as IpcMainInvokeEvent, options),
    };
  };
  const lines = async (key: string) => {
    try {
      return (await readFile(join(root, key, 'home/TEST-wire.ndjson'), 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { method: string; params?: Record<string, unknown> });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  };
  return {
    root,
    store,
    create,
    restoreCalls,
    wire: lines,
    select: (key: 'a' | 'b') => {
      foreground = key;
    },
    prefer: (value: CodexAccountAuthMode) => {
      preferred = value;
    },
    lose: () => {
      loseStart = true;
    },
    complete: () => writeFile(join(root, 'a/home/TEST-complete-login'), 'TEST', { mode: 0o600 }),
    holdCancelReply: () => {
      const pending = {
        started: Promise.withResolvers<void>(),
        release: Promise.withResolvers<void>(),
      };
      cancelReply = pending;
      return { started: pending.started.promise, release: () => pending.release.resolve() };
    },
    async cleanup() {
      cancelReply?.release.resolve();
      await Promise.allSettled(clients.map((client) => client.accountFeature.dispose()));
      await host.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

for (const mode of ['browser', 'device_code'] as const) {
  posixIt(`account IPC preserves ${mode} login, exact account readiness, private presentation and refresh/logout`, async () => {
    const f = await fixture(mode === 'browser' ? 'early' : 'pending', mode === 'device_code', mode === 'browser' ? '0.169.0' : '0.162.0');
    try {
      const api = f.create();
      const snapshots: CodexAccountSnapshotDto[] = [];
      api.feature.subscribe((snapshot) => snapshots.push(snapshot));
      f.prefer('api_key');
      expect(await api.invoke(CODEX_ACCOUNT_GET_SNAPSHOT)).toMatchObject({
        apiKey: { available: true, source: 'environment' },
        launchAllowed: true,
        effectiveAuthMode: 'api_key',
        managedAccount: null,
      });
      await Promise.all([
        api.invoke(CODEX_ACCOUNT_START_CHATGPT_LOGIN, { mode }),
        api.invoke(CODEX_ACCOUNT_START_CHATGPT_LOGIN, { mode }),
      ]);
      if (mode === 'device_code') {
        await vi.waitFor(
          () =>
            expect(snapshots.at(-1)?.login).toMatchObject({
              status: 'pending',
              authUrl: expect.stringMatching(/^https:/),
              userCode: 'TEST-PRIVATE-CODE',
            }),
          { timeout: 10_000 }
        );
        const original = snapshots.at(-1)!.login;
        const duplicate = await api.invoke(CODEX_ACCOUNT_START_CHATGPT_LOGIN, { mode: 'browser' });
        expect(duplicate.login).toEqual(original); // Copy/reopen has the same private presentation.
        const saved = await f.store.pendingLogin();
        expect(saved?.contextId).toBe('TEST-context-shared');
        const journal = await readFile(join(f.root, 'intents', 'a'.repeat(64) + '.json'), 'utf8');
        expect(journal).not.toMatch(/TEST-PRIVATE-CODE|https:|loginId|TEST-captured-private-key/);
        f.select('b'); // Same foreground context, different immutable source revision.
        const changedSource = await api.invoke(CODEX_ACCOUNT_GET_SNAPSHOT);
        expect(changedSource).toMatchObject({
          managedAccount: null,
          apiKey: { available: false },
          login: { status: 'idle' },
        });
        expect(changedSource.login.authUrl).toBeUndefined();
        expect(api.feature.getCachedSnapshot()).toBeNull();
        f.select('a');
        expect((await api.invoke(CODEX_ACCOUNT_GET_SNAPSHOT)).login).toEqual(original);
        await f.complete();
      }
      await vi.waitFor(
        () =>
          expect(snapshots.at(-1)).toMatchObject({
            managedAccount: { type: 'chatgpt', email: mode === 'browser' ? null : 'test@example.invalid', planType: mode === 'browser' ? 'unknown' : 'plus' },
            login: { status: 'idle' },
            preferredAuthMode: 'api_key',
            effectiveAuthMode: 'api_key',
            launchAllowed: true,
          }),
        { timeout: 10_000 }
      );
      expect(snapshots.at(-1)!.login.authUrl).toBeUndefined();
      expect(JSON.stringify(snapshots)).not.toMatch(/TEST-private-workspace|TEST-private-user/);
      expect((await f.wire('a')).filter(row => row.method === 'initialize').every(row =>
        (row.params?.capabilities as Record<string, unknown> | undefined)?.requiredHumanApproval === undefined)).toBe(true);
      expect(api.feature.getCachedSnapshot()).toBeNull();
      expect(snapshots.some((snapshot) => snapshot.login.status === 'starting')).toBe(true);
      expect(await f.store.pendingLogin()).toBeNull();
      expect(
        (await f.wire('a')).filter((row) => row.method === 'account/login/start')
      ).toHaveLength(1);
      const refreshed = await api.invoke(CODEX_ACCOUNT_REFRESH_SNAPSHOT, {
        forceRefreshToken: true,
        includeRateLimits: true,
      });
      expect(refreshed.rateLimits?.primary?.usedPercent).toBe(0);
      expect(
        (await f.wire('a')).some(
          (row) => row.method === 'account/read' && row.params?.refreshToken === true
        )
      ).toBe(true);
      const loggedOut = await api.invoke(CODEX_ACCOUNT_LOGOUT);
      expect(loggedOut).toMatchObject({
        managedAccount: null,
        apiKey: { available: true },
        effectiveAuthMode: 'api_key',
      });
      expect((await f.wire('a')).filter((row) => row.method === 'account/logout')).toHaveLength(1);
    } finally {
      await f.cleanup();
    }
  }, 30_000);
}

posixIt('exact native rejection clears the private intent after cleanup and permits only an explicit new login', async () => {
  const f = await fixture('rejected-then-pending');
  try {
    const api = f.create();
    const observations: CodexAccountSnapshotDto[] = [];
    api.feature.subscribe(snapshot => observations.push(snapshot));
    await api.invoke(CODEX_ACCOUNT_START_CHATGPT_LOGIN, { mode: 'browser' });
    await vi.waitFor(async () => {
      const state = await api.invoke(CODEX_ACCOUNT_GET_SNAPSHOT);
      expect(state.login).toMatchObject({ status: 'failed', error: 'Codex did not complete sign-in. You can try signing in again.' });
      expect(state.login.authUrl).toBeUndefined();
      expect(state.login.userCode).toBeUndefined();
    });
    expect(await f.store.pendingLogin()).toBeNull();
    await api.invoke(CODEX_ACCOUNT_GET_SNAPSHOT);
    expect((await f.wire('a')).filter(row => row.method === 'account/login/start')).toHaveLength(1);
    await api.invoke(CODEX_ACCOUNT_START_CHATGPT_LOGIN, { mode: 'device_code' });
    await vi.waitFor(async () => expect((await api.invoke(CODEX_ACCOUNT_GET_SNAPSHOT)).login).toMatchObject({
      status: 'pending', userCode: 'TEST-PRIVATE-CODE',
    }));
    expect((await f.wire('a')).filter(row => row.method === 'account/login/start').map(row => row.params?.type))
      .toEqual(['chatgpt', 'chatgptDeviceCode']);
    expect((await f.store.pendingLogin())?.kind).toBe('login.device_code');
    await api.invoke(CODEX_ACCOUNT_CANCEL_CHATGPT_LOGIN);
    expect(await f.store.pendingLogin()).toBeNull();
    expect((await f.wire('a')).filter(row => row.method === 'account/logout')).toHaveLength(0);
    expect(JSON.stringify(observations)).not.toContain('TEST-PRIVATE-NATIVE-ERROR');
  } finally {
    await f.cleanup();
  }
}, 30_000);

posixIt('a lost login response survives Main recreation and a different context, with original cancel and no replay/logout', async () => {
  const f = await fixture('pending');
  try {
    await writeFile(join(f.root, 'a/codex/TEST-login-account.json'), 'true', { mode: 0o600 });
    const first = f.create();
    f.lose();
    expect(
      (await first.invoke(CODEX_ACCOUNT_START_CHATGPT_LOGIN, { mode: 'browser' })).login.status
    ).toBe('failed');
    const intent = await f.store.pendingLogin();
    expect(intent?.contextId).toBe('TEST-context-a');
    f.select('b');
    const recovered = f.create();
    const other = await recovered.invoke(CODEX_ACCOUNT_GET_SNAPSHOT);
    expect(other).toMatchObject({
      managedAccount: null,
      login: { status: 'idle' },
      apiKey: { available: false },
    });
    expect(other.login.authUrl).toBeUndefined();
    expect(f.restoreCalls).toEqual([{ targetId: 'a'.repeat(64), contextId: 'TEST-context-a' }]);
    await recovered.invoke(CODEX_ACCOUNT_CANCEL_CHATGPT_LOGIN);
    expect(await f.store.pendingLogin()).toBeNull();
    f.select('a');
    expect(await recovered.invoke(CODEX_ACCOUNT_GET_SNAPSHOT)).toMatchObject({
      managedAccount: { type: 'chatgpt' },
      login: { status: 'cancelled' },
    });
    const originalWire = await f.wire('a');
    expect(originalWire.filter((row) => row.method === 'account/login/start')).toHaveLength(1);
    expect(originalWire.filter((row) => row.method === 'account/logout')).toHaveLength(0);
    expect(
      (await f.wire('b')).filter((row) => row.method.startsWith('account/login/'))
    ).toHaveLength(0);
  } finally {
    await f.cleanup();
  }
}, 30_000);

posixIt(
  'logout cannot retarget after waiting for original login cancellation',
  async () => {
    const f = await fixture('pending');
    try {
      await writeFile(join(f.root, 'b/codex/TEST-login-account.json'), 'true', { mode: 0o600 });
      const api = f.create();
      await api.invoke(CODEX_ACCOUNT_START_CHATGPT_LOGIN, { mode: 'browser' });
      await vi.waitFor(async () =>
        expect((await api.invoke(CODEX_ACCOUNT_GET_SNAPSHOT)).login.status).toBe('pending')
      );
      const original = await f.store.pendingLogin();
      const barrier = f.holdCancelReply();
      const logout = api.invoke(CODEX_ACCOUNT_LOGOUT).catch((error: unknown) => error);
      await barrier.started;
      f.select('b');
      barrier.release();
      expect(await logout).toBeInstanceOf(Error);
      expect(await f.store.pendingLogin()).toBeNull();
      expect(await api.invoke(CODEX_ACCOUNT_GET_SNAPSHOT)).toMatchObject({
        managedAccount: { type: 'chatgpt' },
        login: { status: 'idle' },
      });
      expect(original?.targetId).toBe('a'.repeat(64));
      const a = await f.wire('a'),
        b = await f.wire('b');
      expect(a.filter((row) => row.method === 'account/login/start')).toHaveLength(1);
      expect(a.filter((row) => row.method === 'account/login/cancel')).toHaveLength(1);
      expect(a.filter((row) => row.method === 'account/logout')).toHaveLength(0);
      expect(
        b.filter(
          (row) => row.method.startsWith('account/login/') || row.method === 'account/logout'
        )
      ).toHaveLength(0);
    } finally {
      await f.cleanup();
    }
  },
  30_000
);
