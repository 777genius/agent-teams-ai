import { afterEach, describe, expect, it, vi } from 'vitest';

import { GitHubAuthorizationError } from '../../../src/features/pr-monitor/core/application/deviceAuthorization';
import { createGitHubAccounts } from '../../../src/features/pr-monitor/main/composition/githubAccounts';

import type {
  DeviceIssuer,
  OAuthCredential,
} from '../../../src/features/pr-monitor/core/application/deviceAuthorization';
import type { createGitHubReaders } from '../../../src/features/pr-monitor/main/composition/githubReaders';
import type { PullRequestReader } from '@pr-monitor/core';

const configuration = {
  clientId: 'TEST_CLIENT_ID',
  scope: '',
  permissionNotice: 'TEST GitHub App read permissions',
};
const code = {
  device_code: 'TEST_PRIVATE_CODE',
  user_code: 'TEST-CODE',
  verification_uri: 'https://github.com/login/device',
  expires_in: 900,
  interval: 5,
};

afterEach(() => vi.unstubAllGlobals());

function deviceFixture(override: Partial<OAuthCredential> = {}) {
  let now = 100_000;
  let saved: OAuthCredential | null = {
    clientId: configuration.clientId,
    accountId: '123',
    accessToken: 'TEST_OLD_ACCESS',
    refreshToken: 'TEST_OLD_REFRESH',
    expiresAt: 220_000,
    refreshExpiresAt: 3_700_000,
    ...override,
  };
  const store = {
    read: vi.fn(async () => saved),
    save: vi.fn(async (next: OAuthCredential) => {
      saved = next;
    }),
    clear: vi.fn(async () => {
      saved = null;
    }),
  };
  const issuer = {
    request: vi.fn<DeviceIssuer['request']>(async () => code),
    exchange: vi.fn<DeviceIssuer['exchange']>(async () => ({
      access_token: 'TEST_NEW_ACCESS',
      refresh_token: 'TEST_NEW_REFRESH',
      token_type: 'bearer',
      expires_in: 3600,
      refresh_token_expires_in: 7200,
    })),
    identity: vi.fn<DeviceIssuer['identity']>(async () => '123'),
  };
  const readers = {
    get: vi.fn<ReturnType<typeof createGitHubReaders>['get']>(async () => ({
      list: vi.fn<PullRequestReader['list']>(),
      get: vi.fn<PullRequestReader['get']>(),
    })),
    dispose: vi.fn(),
  };
  const cliAccount = vi.fn(async () => null as string | null);
  const fetcher = vi.fn<typeof fetch>(async () => new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetcher);
  const accounts = createGitHubAccounts({
    readers,
    store,
    configuration,
    issuer,
    cliAccount,
    now: () => now,
  });
  return {
    accounts,
    store,
    issuer,
    readers,
    fetcher,
    cliAccount,
    advance: (ms: number) => {
      now += ms;
    },
    async connection() {
      const connected = await accounts.connect(new AbortController().signal);
      if (!connected.ok) throw new Error('Fixture failed');
      await connected.value.createReader({ provider: 'github', owner: 'test', repo: 'fixture' });
      const transport = readers.get.mock.lastCall![0];
      return {
        account: connected.value,
        read: () =>
          transport({
            path: '/repos/test/fixture/pulls?state=open&per_page=30&page=1',
            headers: {},
          }),
      };
    },
  };
}

describe('native GitHub account lifecycle', () => {
  it('prefers a valid CLI account and binds the resulting reader to that account', async () => {
    const cliAccount = vi.fn(async () => 'first-account' as string | null);
    const store = { read: vi.fn(), save: vi.fn(), clear: vi.fn() };
    const readers = { get: vi.fn(), dispose: vi.fn() } as ReturnType<typeof createGitHubReaders>;
    const accounts = createGitHubAccounts({ readers, store, configuration, cliAccount });
    const result = await accounts.connect(new AbortController().signal);
    expect(result).toMatchObject({ ok: true, value: { kind: 'cli' } });
    expect(store.read).not.toHaveBeenCalled();
    if (!result.ok) throw new Error('Fixture failed');
    cliAccount.mockResolvedValue('different-account');
    expect(await result.value.isCurrent(new AbortController().signal)).toBe(false);
  });
  it('retires an old refresh before a new device login can replace its account', async () => {
    let now = 100_000;
    let saved: OAuthCredential = {
      clientId: configuration.clientId,
      accountId: '123',
      accessToken: 'TEST_OLD_ACCESS',
      refreshToken: 'TEST_OLD_REFRESH',
      expiresAt: 100_001,
    };
    const store = {
      read: vi.fn(async () => saved),
      save: vi.fn(async (next: OAuthCredential, signal?: AbortSignal) => {
        if (signal?.aborted) throw new Error('cancelled');
        saved = next;
      }),
      clear: vi.fn(),
    };
    let finishOld!: (value: unknown) => void;
    const issuer: DeviceIssuer = {
      request: vi.fn(async () => code),
      exchange: vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finishOld = resolve;
            })
        )
        .mockResolvedValue({
          access_token: 'TEST_NEW_ACCESS',
          refresh_token: 'TEST_NEW_REFRESH',
          token_type: 'bearer',
          expires_in: 3600,
        }),
      identity: vi.fn(async () => '123'),
    };
    const readers = { get: vi.fn(), dispose: vi.fn() } as ReturnType<typeof createGitHubReaders>;
    const accounts = createGitHubAccounts({
      readers,
      store,
      configuration,
      issuer,
      cliAccount: async () => null,
      now: () => now,
    });
    const oldConnection = accounts.connect(new AbortController().signal);
    await vi.waitFor(() => expect(issuer.exchange).toHaveBeenCalledTimes(1));
    const begun = await accounts.beginLogin();
    if (!begun.ok) throw new Error('Fixture failed');
    now += 5000;
    expect(await accounts.flow.poll(begun.value.attemptId)).toEqual({
      ok: true,
      value: { status: 'connected' },
    });
    finishOld({
      access_token: 'TEST_LATE_OLD_ACCESS',
      refresh_token: 'TEST_LATE_OLD_REFRESH',
      token_type: 'bearer',
      expires_in: 3600,
    });
    expect((await oldConnection).ok).toBe(false);
    expect(saved.accessToken).toBe('TEST_NEW_ACCESS');
    expect(store.save).toHaveBeenCalledTimes(1);
  });
  it('refuses Device Flow when secure system storage is unavailable', async () => {
    const request = vi.fn();
    const accounts = createGitHubAccounts({
      readers: { get: vi.fn(), dispose: vi.fn() } as ReturnType<typeof createGitHubReaders>,
      store: { read: vi.fn(), save: vi.fn(), clear: vi.fn(), available: async () => false },
      configuration,
      issuer: { request, exchange: vi.fn(), identity: vi.fn() },
      cliAccount: async () => null,
    });
    expect(await accounts.beginLogin()).toMatchObject({ error: { kind: 'unsupported' } });
    expect(request).not.toHaveBeenCalled();
  });
  it('never serves a replacement account token through an earlier account handle', async () => {
    const f = deviceFixture();
    const old = await f.connection();
    const begun = await f.accounts.flow.begin();
    if (!begun.ok) throw new Error('Fixture failed');
    f.issuer.identity.mockResolvedValue('456');
    f.advance(5000);
    expect(await f.accounts.flow.poll(begun.value.attemptId)).toMatchObject({
      value: { status: 'connected' },
    });
    expect(await old.account.isCurrent(new AbortController().signal)).toBe(false);
    await expect(old.read()).rejects.toThrow('disconnected');
    expect(f.fetcher).not.toHaveBeenCalled();
    expect((await f.accounts.connect(new AbortController().signal)).ok).toBe(true);
  });
  it('keeps retired device credentials unusable after failed sign-out while CLI remains independent', async () => {
    const f = deviceFixture();
    const old = await f.connection();
    f.store.clear.mockRejectedValueOnce(new Error('TEST_DELETE_FAILED'));
    await expect(f.accounts.signOut()).rejects.toThrow('TEST_DELETE_FAILED');
    expect(await old.account.isCurrent(new AbortController().signal)).toBe(false);
    expect(await f.accounts.connect(new AbortController().signal)).toMatchObject({
      error: { kind: 'sign_in_required' },
    });
    expect(f.store.read).toHaveBeenCalledOnce();
    f.cliAccount.mockResolvedValueOnce('TEST_CLI');
    expect(await f.accounts.connect(new AbortController().signal)).toMatchObject({
      value: { kind: 'cli' },
    });
    const begun = await f.accounts.beginLogin();
    if (!begun.ok) throw new Error('Fixture failed');
    f.advance(5000);
    expect(await f.accounts.flow.poll(begun.value.attemptId)).toMatchObject({
      value: { status: 'connected' },
    });
    expect((await f.accounts.connect(new AbortController().signal)).ok).toBe(true);
  });
  it.each(['expired', 'rejected', 'identity'] as const)(
    'retires an established connection on terminal %s refresh failure',
    async (reason) => {
      const f = deviceFixture(reason === 'expired' ? { refreshExpiresAt: 219_999 } : {});
      const connection = await f.connection();
      f.advance(120_000);
      if (reason === 'rejected')
        f.issuer.exchange.mockResolvedValue({ error: 'bad_refresh_token' });
      if (reason === 'identity')
        f.issuer.identity.mockRejectedValue(new GitHubAuthorizationError('Sign in again.'));
      await expect(connection.read()).rejects.toBeInstanceOf(GitHubAuthorizationError);
      expect(await connection.account.isCurrent(new AbortController().signal)).toBe(false);
      expect(await f.accounts.connect(new AbortController().signal)).toMatchObject({
        error: { kind: 'sign_in_required' },
      });
      expect(f.store.read).toHaveBeenCalledOnce();
      expect(f.fetcher).not.toHaveBeenCalled();
    }
  );
  it('keeps a connection retryable after transient identity failure without reusing its retired refresh token', async () => {
    const f = deviceFixture();
    const connection = await f.connection();
    f.advance(120_000);
    f.issuer.identity.mockRejectedValueOnce(new Error('TEST_OFFLINE'));
    await expect(connection.read()).rejects.toThrow('TEST_OFFLINE');
    expect(await connection.account.isCurrent(new AbortController().signal)).toBe(true);
    expect(f.store.save).not.toHaveBeenCalled();
    expect(f.fetcher).not.toHaveBeenCalled();
    await connection.read();
    expect(f.issuer.exchange).toHaveBeenCalledOnce();
    expect(f.store.save).toHaveBeenCalledOnce();
    expect(f.fetcher).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: 'Bearer TEST_NEW_ACCESS' }),
      })
    );
  });
});
