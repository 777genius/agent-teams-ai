import { describe, expect, it, vi } from 'vitest';

import {
  createDeviceAuthorization,
  type DeviceIssuer,
} from '../../../src/features/pr-monitor/core/application/deviceAuthorization';

const configuration = {
  clientId: 'TEST_PUBLIC_CLIENT_ID',
  scope: 'repo',
  permissionNotice: 'TEST permission notice',
};
const device = {
  device_code: 'TEST_PRIVATE_DEVICE_CODE',
  user_code: 'TEST-CODE',
  verification_uri: 'https://github.com/login/device',
  expires_in: 900,
  interval: 5,
};
const access = {
  access_token: 'TEST_PRIVATE_ACCESS_TOKEN',
  refresh_token: 'TEST_PRIVATE_REFRESH_TOKEN',
  token_type: 'bearer',
  expires_in: 28800,
  refresh_token_expires_in: 15897600,
};
function fixture(config: typeof configuration | null = configuration) {
  let time = 0;
  const issuer = {
    request: vi.fn<DeviceIssuer['request']>(async () => device as unknown),
    exchange: vi.fn<DeviceIssuer['exchange']>(
      async () => ({ error: 'authorization_pending' }) as unknown
    ),
    identity: vi.fn<DeviceIssuer['identity']>(async () => '123'),
  };
  const save = vi.fn<Parameters<typeof createDeviceAuthorization>[0]['save']>(
    async () => undefined
  );
  const flow = createDeviceAuthorization({
    configuration: config,
    issuer,
    save,
    now: () => time,
    newId: () => 'test-attempt',
  });
  return {
    flow,
    issuer,
    save,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

describe('backendless GitHub device authorization', () => {
  it('reports an unregistered build without borrowing another application identity', async () => {
    const f = fixture(null);
    expect(await f.flow.begin()).toMatchObject({ ok: false, error: { kind: 'not_configured' } });
    expect(f.issuer.request).not.toHaveBeenCalled();
  });
  it('returns only user-safe device data and never polls before the issuer interval', async () => {
    const f = fixture();
    const begun = await f.flow.begin();
    expect(begun).toMatchObject({
      ok: true,
      value: { userCode: 'TEST-CODE', attemptId: 'test-attempt' },
    });
    expect(JSON.stringify(begun)).not.toContain('TEST_PRIVATE');
    await f.flow.poll('test-attempt');
    expect(f.issuer.exchange).not.toHaveBeenCalled();
    f.advance(5000);
    expect(await f.flow.poll('test-attempt')).toMatchObject({ value: { status: 'pending' } });
    expect(f.issuer.exchange).toHaveBeenCalledTimes(1);
    expect(f.issuer.request.mock.calls[0]?.[0]).toEqual({
      client_id: configuration.clientId,
      scope: 'repo',
    });
  });
  it('honors slow_down and deduplicates rapid renderer polling', async () => {
    const f = fixture();
    await f.flow.begin();
    f.advance(5000);
    f.issuer.exchange.mockResolvedValueOnce({ error: 'slow_down', interval: 10 });
    expect(await f.flow.poll('test-attempt')).toMatchObject({
      value: { retryAt: '1970-01-01T00:00:15.000Z' },
    });
    f.advance(9000);
    await f.flow.poll('test-attempt');
    expect(f.issuer.exchange).toHaveBeenCalledTimes(1);
    f.advance(1000);
    await f.flow.poll('test-attempt');
    expect(f.issuer.exchange).toHaveBeenCalledTimes(2);
  });
  it('refuses expired codes and arbitrary verification websites', async () => {
    const f = fixture();
    await f.flow.begin();
    f.advance(900001);
    expect(await f.flow.poll('test-attempt')).toMatchObject({ error: { kind: 'unauthorized' } });
    expect(f.issuer.exchange).not.toHaveBeenCalled();
    f.issuer.request.mockResolvedValueOnce({
      ...device,
      verification_uri: 'https://evil.example/login',
    });
    expect((await f.flow.begin()).ok).toBe(false);
  });
  it('validates identity and persists encrypted-store input without exposing tokens', async () => {
    const f = fixture();
    await f.flow.begin();
    f.advance(5000);
    f.issuer.exchange.mockResolvedValueOnce(access);
    const result = await f.flow.poll('test-attempt');
    expect(result).toEqual({ ok: true, value: { status: 'connected' } });
    expect(f.issuer.identity).toHaveBeenCalledWith(access.access_token, expect.any(AbortSignal));
    expect(f.save).toHaveBeenCalledWith(
      expect.objectContaining({
        accessToken: access.access_token,
        accountId: '123',
        clientId: configuration.clientId,
      }),
      expect.any(AbortSignal)
    );
    expect(JSON.stringify(result)).not.toContain('TEST_PRIVATE');
    expect(f.issuer.exchange.mock.calls[0]?.[0]).not.toHaveProperty('client_secret');
  });
  it('cancels an in-flight exchange without saving its late success', async () => {
    const f = fixture();
    await f.flow.begin();
    f.advance(5000);
    let finish!: (value: unknown) => void;
    f.issuer.exchange.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const pending = f.flow.poll('test-attempt');
    f.flow.cancel();
    finish(access);
    expect(await pending).toMatchObject({ error: { kind: 'aborted' } });
    expect(f.save).not.toHaveBeenCalled();
  });
  it('rejects concurrent polls and keeps denied-provider details private', async () => {
    const f = fixture();
    await f.flow.begin();
    f.advance(5000);
    let finish!: (value: unknown) => void;
    f.issuer.exchange.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const pending = f.flow.poll('test-attempt');
    await f.flow.poll('test-attempt');
    expect(f.issuer.exchange).toHaveBeenCalledTimes(1);
    finish({ error: 'access_denied', error_description: 'TEST_PRIVATE_PROVIDER_DETAIL' });
    const result = await pending;
    expect(result).toMatchObject({ error: { kind: 'unauthorized' } });
    expect(JSON.stringify(result)).not.toContain('TEST_PRIVATE');
  });
  it('rotates device-issued credentials without a secret and refuses account substitution', async () => {
    const f = fixture();
    f.issuer.exchange.mockResolvedValue(access);
    const previous = {
      accessToken: 'TEST_OLD',
      refreshToken: 'TEST_REFRESH',
      clientId: configuration.clientId,
      accountId: '123',
    };
    expect(await f.flow.refresh(previous, new AbortController().signal)).toMatchObject({
      accountId: '123',
      accessToken: access.access_token,
    });
    expect(f.issuer.exchange.mock.calls[0]?.[0]).toEqual({
      client_id: configuration.clientId,
      refresh_token: previous.refreshToken,
      grant_type: 'refresh_token',
    });
    f.issuer.identity.mockResolvedValueOnce('999');
    await expect(f.flow.refresh(previous, new AbortController().signal)).rejects.toThrow(
      'account changed'
    );
    expect(f.save).toHaveBeenCalledTimes(1);
  });
});
