import { describe, expect, it } from 'vitest';

import { CodexAccountAppServerClient } from '../CodexAccountAppServerClient';

import type {
  CodexAppServerSession,
  CodexAppServerSessionFactory,
} from '@main/services/infrastructure/codexAppServer';

type WithSessionOptions = Parameters<CodexAppServerSessionFactory['withSession']>[0];

function createFactory(request: CodexAppServerSession['request']): {
  factory: CodexAppServerSessionFactory;
  requests: { method: string; params: unknown }[];
  sessionOptions: WithSessionOptions[];
} {
  const requests: { method: string; params: unknown }[] = [];
  const sessionOptions: WithSessionOptions[] = [];
  const session: CodexAppServerSession = {
    initializeResponse: {
      userAgent: 'codex-cli 0.117.0',
      codexHome: '/Users/me/.codex',
      platformFamily: 'macos',
      platformOs: 'darwin',
    },
    request: async <TResult>(method: string, params?: unknown, timeoutMs?: number) => {
      requests.push({ method, params });
      return request<TResult>(method, params, timeoutMs);
    },
    notify: async () => undefined,
    onNotification: () => () => undefined,
    close: async () => undefined,
  };

  const factory = {
    withSession: async <TResult>(
      options: WithSessionOptions,
      handler: (session: CodexAppServerSession) => Promise<TResult>
    ): Promise<TResult> => {
      sessionOptions.push(options);
      return handler(session);
    },
  } as unknown as CodexAppServerSessionFactory;

  return { factory, requests, sessionOptions };
}

describe('CodexAccountAppServerClient', () => {
  it('reads account and optional rate limits in one app-server session', async () => {
    let sessionCount = 0;
    const { factory, requests, sessionOptions } = createFactory(async <TResult>(method: string) => {
      if (method === 'account/read') {
        return {
          account: { type: 'chatgpt', email: 'user@example.com', planType: 'pro' },
          requiresOpenaiAuth: true,
        } as TResult;
      }
      if (method === 'account/rateLimits/read') {
        return {
          rateLimits: {
            limitId: 'codex',
            limitName: null,
            primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: null },
            secondary: null,
            credits: null,
            planType: 'pro',
          },
          rateLimitsByLimitId: null,
        } as TResult;
      }
      throw new Error(`Unexpected method ${method}`);
    });
    const countedFactory = {
      withSession: async <TResult>(
        options: unknown,
        handler: (session: CodexAppServerSession) => Promise<TResult>
      ): Promise<TResult> => {
        sessionCount += 1;
        return factory.withSession(options as never, handler);
      },
    } as unknown as CodexAppServerSessionFactory;

    const client = new CodexAccountAppServerClient(countedFactory);
    const result = await client.readAccountSnapshot({
      binaryPath: '/usr/local/bin/codex',
      env: {},
      refreshToken: true,
      includeRateLimits: true,
    });

    expect(sessionCount).toBe(1);
    expect(result.account.account).toMatchObject({
      type: 'chatgpt',
      email: 'user@example.com',
    });
    expect(result.rateLimits).toMatchObject({
      ok: true,
      payload: {
        rateLimits: {
          primary: { usedPercent: 42 },
        },
      },
    });
    expect(result.initialize.codexHome).toBe('/Users/me/.codex');
    expect(requests).toEqual([
      { method: 'account/read', params: { refreshToken: true } },
      { method: 'account/rateLimits/read', params: undefined },
    ]);
    expect(sessionOptions).toEqual([
      expect.objectContaining({
        requestTimeoutMs: 8_000,
        initializeTimeoutMs: 12_000,
        totalTimeoutMs: 26_500,
      }),
    ]);
  });

  it('keeps a successful account read when optional rate limits fail', async () => {
    const rateLimitError = new Error('rate limits failed');
    const { factory } = createFactory(async <TResult>(method: string) => {
      if (method === 'account/read') {
        return {
          account: { type: 'apiKey' },
          requiresOpenaiAuth: false,
        } as TResult;
      }
      if (method === 'account/rateLimits/read') {
        throw rateLimitError;
      }
      throw new Error(`Unexpected method ${method}`);
    });

    const client = new CodexAccountAppServerClient(factory);
    const result = await client.readAccountSnapshot({
      binaryPath: '/usr/local/bin/codex',
      env: {},
      includeRateLimits: true,
    });

    expect(result.account).toEqual({
      account: { type: 'apiKey' },
      requiresOpenaiAuth: false,
    });
    expect(result.rateLimits).toEqual({
      ok: false,
      error: rateLimitError,
    });
  });

  it('surfaces account read failures without attempting rate limits', async () => {
    const requests: string[] = [];
    const { factory } = createFactory(async <TResult>(method: string) => {
      requests.push(method);
      if (method === 'account/read') {
        throw new Error('account failed');
      }
      return {} as TResult;
    });

    const client = new CodexAccountAppServerClient(factory);

    await expect(
      client.readAccountSnapshot({
        binaryPath: '/usr/local/bin/codex',
        env: {},
        includeRateLimits: true,
      })
    ).rejects.toThrow('account failed');
    expect(requests).toEqual(['account/read']);
  });
});
