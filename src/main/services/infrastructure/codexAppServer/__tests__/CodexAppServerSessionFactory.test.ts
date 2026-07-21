import { describe, expect, it, vi } from 'vitest';

import { CodexAppServerSessionFactory } from '../CodexAppServerSessionFactory';

import type { JsonRpcSession, JsonRpcStdioClient } from '../JsonRpcStdioClient';

function createSession(request: JsonRpcSession['request']): JsonRpcSession {
  return {
    request,
    notify: vi.fn(async () => undefined),
    onNotification: vi.fn(() => () => undefined),
    close: vi.fn(async () => undefined),
  };
}

describe('CodexAppServerSessionFactory', () => {
  it('allows enough total time for a cold initialize and one request', async () => {
    const request = async <TResult>(
      method: string,
      _params?: unknown,
      timeoutMs?: number
    ): Promise<TResult> => {
      expect(method).toBe('initialize');
      expect(timeoutMs).toBe(12_000);
      return {
        userAgent: 'codex-cli 0.144.1',
        codexHome: '/Users/test/.codex',
        platformFamily: 'macos',
        platformOs: 'darwin',
      } as TResult;
    };
    const session = createSession(request);
    const withSession = vi.fn();
    withSession.mockImplementation(
      async (
        _options: unknown,
        handler: (session: JsonRpcSession) => Promise<unknown>
      ): Promise<unknown> => handler(session)
    );
    const factory = new CodexAppServerSessionFactory({
      withSession,
    } as unknown as JsonRpcStdioClient);

    await factory.withSession(
      {
        binaryPath: '/usr/local/bin/codex',
        label: 'test session',
      },
      async () => 'ready'
    );

    expect(withSession).toHaveBeenCalledWith(
      expect.objectContaining({
        requestTimeoutMs: 3_000,
        totalTimeoutMs: 16_500,
      }),
      expect.any(Function)
    );
  });
});
