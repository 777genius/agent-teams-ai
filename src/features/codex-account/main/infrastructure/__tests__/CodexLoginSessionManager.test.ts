import { describe, expect, it, vi } from 'vitest';

import { CodexLoginSessionManager } from '../CodexLoginSessionManager';

import type {
  CodexAppServerLoginAccountResponse,
  CodexAppServerSession,
  CodexAppServerSessionFactory,
} from '@main/services/infrastructure/codexAppServer';

function createSessionManagerHarness(loginResponse: CodexAppServerLoginAccountResponse): {
  manager: CodexLoginSessionManager;
  session: CodexAppServerSession;
  request: ReturnType<typeof vi.fn>;
  emitNotification: (method: string, params: unknown) => void;
} {
  let notificationListener: ((method: string, params: unknown) => void) | null = null;
  const request = vi.fn(async (method: string) => {
    if (method === 'account/login/start') {
      return loginResponse;
    }
    if (method === 'account/login/cancel') {
      return { status: 'canceled' };
    }
    throw new Error(`Unexpected method ${method}`);
  });

  const session = {
    initializeResponse: {
      userAgent: 'codex-cli 0.125.0',
      codexHome: '/Users/me/.codex',
      platformFamily: 'macos',
      platformOs: 'darwin',
    },
    request,
    notify: async () => undefined,
    onNotification: (listener: (method: string, params: unknown) => void) => {
      notificationListener = listener;
      return () => {
        notificationListener = null;
      };
    },
    close: vi.fn(async () => undefined),
  } as unknown as CodexAppServerSession;

  const factory = {
    openSession: vi.fn(async () => session),
  } as unknown as CodexAppServerSessionFactory;

  return {
    manager: new CodexLoginSessionManager(factory, { warn: () => undefined }),
    session,
    request,
    emitNotification: (method, params) => {
      notificationListener?.(method, params);
    },
  };
}

describe('CodexLoginSessionManager', () => {
  it('uses the documented ChatGPT browser flow by default', async () => {
    const { manager, request } = createSessionManagerHarness({
      type: 'chatgpt',
      loginId: 'browser-login',
      authUrl:
        'https://chatgpt.com/auth?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback',
    });

    await manager.start({ binaryPath: '/usr/local/bin/codex', env: {} });

    expect(request).toHaveBeenCalledWith(
      'account/login/start',
      { type: 'chatgpt' },
      expect.any(Number)
    );
    expect(manager.getState()).toMatchObject({
      status: 'pending',
      authUrl:
        'https://chatgpt.com/auth?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback',
      userCode: null,
    });

    await manager.cancel();
  });

  it('uses the documented device-code flow only when explicitly requested', async () => {
    const { manager, request } = createSessionManagerHarness({
      type: 'chatgptDeviceCode',
      loginId: 'device-login',
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'ABCD-1234',
    });

    await manager.start({
      binaryPath: '/usr/local/bin/codex',
      env: {},
      mode: 'device_code',
    });

    expect(request).toHaveBeenCalledWith(
      'account/login/start',
      { type: 'chatgptDeviceCode' },
      expect.any(Number)
    );
    expect(manager.getState()).toMatchObject({
      status: 'pending',
      authUrl: 'https://auth.openai.com/codex/device',
      userCode: 'ABCD-1234',
    });

    await manager.cancel();
  });

  it('rejects a non-https browser auth URL', async () => {
    const { manager } = createSessionManagerHarness({
      type: 'chatgpt',
      loginId: 'browser-login',
      authUrl: ['http', '://chatgpt.com/auth'].join(''),
    });

    await expect(manager.start({ binaryPath: '/usr/local/bin/codex', env: {} })).rejects.toThrow(
      'non-https auth URL'
    );
    expect(manager.getState()).toMatchObject({
      status: 'failed',
    });
  });

  it('rejects a device-code response for the default browser flow', async () => {
    const { manager } = createSessionManagerHarness({
      type: 'chatgptDeviceCode',
      loginId: 'device-login',
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'ABCD-1234',
    });

    await expect(manager.start({ binaryPath: '/usr/local/bin/codex', env: {} })).rejects.toThrow(
      'unexpected login response type'
    );
    expect(manager.getState()).toMatchObject({
      status: 'failed',
    });
  });

  it('rejects a browser response for the explicit device-code flow', async () => {
    const { manager } = createSessionManagerHarness({
      type: 'chatgpt',
      loginId: 'browser-login',
      authUrl:
        'https://chatgpt.com/auth?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback',
    });

    await expect(
      manager.start({
        binaryPath: '/usr/local/bin/codex',
        env: {},
        mode: 'device_code',
      })
    ).rejects.toThrow('unexpected login response type');
    expect(manager.getState()).toMatchObject({
      status: 'failed',
    });
  });

  it('rejects an empty device-code user code', async () => {
    const { manager } = createSessionManagerHarness({
      type: 'chatgptDeviceCode',
      loginId: 'device-login',
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: '   ',
    });

    await expect(
      manager.start({
        binaryPath: '/usr/local/bin/codex',
        env: {},
        mode: 'device_code',
      })
    ).rejects.toThrow('empty ChatGPT login code');
    expect(manager.getState()).toMatchObject({
      status: 'failed',
    });
  });

  it('keeps the active login pending when an unrelated completion notification arrives', async () => {
    const { manager, emitNotification } = createSessionManagerHarness({
      type: 'chatgpt',
      loginId: 'browser-login',
      authUrl:
        'https://chatgpt.com/auth?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback',
    });

    await manager.start({ binaryPath: '/usr/local/bin/codex', env: {} });
    emitNotification('account/login/completed', {
      loginId: 'other-login',
      success: true,
      error: null,
    });

    expect(manager.getState()).toMatchObject({
      status: 'pending',
      authUrl:
        'https://chatgpt.com/auth?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback',
    });

    await manager.cancel();
  });

  it('clears login state when the matching browser login completes successfully', async () => {
    const { manager, emitNotification, session } = createSessionManagerHarness({
      type: 'chatgpt',
      loginId: 'browser-login',
      authUrl:
        'https://chatgpt.com/auth?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback',
    });

    await manager.start({ binaryPath: '/usr/local/bin/codex', env: {} });
    emitNotification('account/login/completed', {
      loginId: 'browser-login',
      success: true,
      error: null,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(session.close).toHaveBeenCalledTimes(1);
    expect(manager.getState()).toMatchObject({
      status: 'idle',
      authUrl: null,
      userCode: null,
    });
  });

  it('keeps device-code details visible when the matching login fails', async () => {
    const { manager, emitNotification } = createSessionManagerHarness({
      type: 'chatgptDeviceCode',
      loginId: 'device-login',
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'ABCD-1234',
    });

    await manager.start({
      binaryPath: '/usr/local/bin/codex',
      env: {},
      mode: 'device_code',
    });
    emitNotification('account/login/completed', {
      loginId: 'device-login',
      success: false,
      error: 'Login was not completed',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(manager.getState()).toMatchObject({
      status: 'failed',
      error: 'Login was not completed',
      authUrl: 'https://auth.openai.com/codex/device',
      userCode: 'ABCD-1234',
    });
  });

  it('cancels an active browser login through app-server and clears copied link state', async () => {
    const { manager, request, session } = createSessionManagerHarness({
      type: 'chatgpt',
      loginId: 'browser-login',
      authUrl:
        'https://chatgpt.com/auth?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback',
    });

    await manager.start({ binaryPath: '/usr/local/bin/codex', env: {} });
    await manager.cancel();

    expect(request).toHaveBeenCalledWith(
      'account/login/cancel',
      { loginId: 'browser-login' },
      expect.any(Number)
    );
    expect(session.close).toHaveBeenCalledTimes(1);
    expect(manager.getState()).toMatchObject({
      status: 'cancelled',
      authUrl: null,
      userCode: null,
    });
  });
});
