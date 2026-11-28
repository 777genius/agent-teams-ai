import { describe, expect, it, vi } from 'vitest';

import { createGitHubAccounts } from '../../../src/features/pr-monitor/main/composition/githubAccounts';

import type {
  DeviceIssuer,
  OAuthCredential,
} from '../../../src/features/pr-monitor/core/application/deviceAuthorization';
import type { createGitHubReaders } from '../../../src/features/pr-monitor/main/composition/githubReaders';

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
});
