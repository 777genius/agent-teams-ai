import { describe, expect, it, vi } from 'vitest';

import { CodexAppServerClient } from '@features/recent-projects/main/infrastructure/codex/CodexAppServerClient';

import type {
  JsonRpcSession,
  JsonRpcStdioClient,
} from '@main/services/infrastructure/codexAppServer';

function createSession(
  request: JsonRpcSession['request'],
  notify: JsonRpcSession['notify'] = vi.fn().mockResolvedValue(undefined)
): JsonRpcSession {
  return {
    request,
    notify,
    onNotification: vi.fn().mockReturnValue(() => undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

describe('CodexAppServerClient', () => {
  it('loads live and archived threads in a single app-server session', async () => {
    const request = vi
      .fn()
      .mockImplementation((method: string, params?: { archived?: boolean }) => {
        if (method === 'initialize') {
          return Promise.resolve({});
        }

        if (method === 'thread/list' && params?.archived === false) {
          return Promise.resolve({
            data: [{ id: 'live-1', cwd: '/Users/test/live-project', source: 'cli' }],
          });
        }

        if (method === 'thread/list' && params?.archived === true) {
          return Promise.resolve({
            data: [{ id: 'archived-1', cwd: '/Users/test/archive-project', source: 'vscode' }],
          });
        }

        return Promise.reject(new Error(`Unexpected method: ${method}`));
      });
    const session = createSession(request);

    const withSession = vi.fn().mockImplementation((_options, handler) => handler(session));
    const client = new CodexAppServerClient({ withSession } as unknown as JsonRpcStdioClient);

    const result = await client.listRecentThreads('/usr/local/bin/codex', {
      limit: 40,
      liveRequestTimeoutMs: 4500,
      archivedRequestTimeoutMs: 2500,
      totalTimeoutMs: 4500,
    });

    expect(withSession).toHaveBeenCalledTimes(1);
    expect(withSession).toHaveBeenCalledWith(
      expect.objectContaining({
        binaryPath: '/usr/local/bin/codex',
        requestTimeoutMs: 4500,
        totalTimeoutMs: 14500,
      }),
      expect.any(Function)
    );
    expect(session.notify).toHaveBeenCalledWith('initialized');
    expect(request).toHaveBeenNthCalledWith(
      2,
      'thread/list',
      expect.objectContaining({ archived: false }),
      4500
    );
    expect(request).toHaveBeenNthCalledWith(
      3,
      'thread/list',
      expect.objectContaining({ archived: true }),
      2500
    );
    expect(result).toEqual({
      live: {
        threads: [{ id: 'live-1', cwd: '/Users/test/live-project', source: 'cli' }],
      },
      archived: {
        threads: [{ id: 'archived-1', cwd: '/Users/test/archive-project', source: 'vscode' }],
      },
    });
  });

  it('keeps live results when archived thread loading fails', async () => {
    const session = createSession(
      vi.fn().mockImplementation((method: string, params?: { archived?: boolean }) => {
        if (method === 'initialize') {
          return Promise.resolve({});
        }

        if (method === 'thread/list' && params?.archived === false) {
          return Promise.resolve({
            data: [{ id: 'live-1', cwd: '/Users/test/live-project', source: 'cli' }],
          });
        }

        if (method === 'thread/list' && params?.archived === true) {
          return Promise.reject(new Error('JSON-RPC request timed out: thread/list'));
        }

        return Promise.reject(new Error(`Unexpected method: ${method}`));
      })
    );

    const withSession = vi.fn().mockImplementation((_options, handler) => handler(session));
    const client = new CodexAppServerClient({ withSession } as unknown as JsonRpcStdioClient);

    const result = await client.listRecentThreads('/usr/local/bin/codex', {
      limit: 40,
      liveRequestTimeoutMs: 4500,
      archivedRequestTimeoutMs: 2500,
      totalTimeoutMs: 4500,
    });

    expect(result.live.threads).toEqual([
      { id: 'live-1', cwd: '/Users/test/live-project', source: 'cli' },
    ]);
    expect(result.archived).toEqual({
      threads: [],
      error: 'JSON-RPC request timed out: thread/list',
    });
  });

  it('raises the session timeout budget above sequential request timeouts', async () => {
    const session = createSession(
      vi.fn().mockImplementation((method: string, params?: { archived?: boolean }) => {
        if (method === 'initialize') {
          return Promise.resolve({});
        }

        if (method === 'thread/list') {
          return Promise.resolve({ data: [] });
        }

        return Promise.reject(new Error(`Unexpected method: ${method}`));
      })
    );

    const withSession = vi.fn().mockImplementation((_options, handler) => handler(session));
    const client = new CodexAppServerClient({ withSession } as unknown as JsonRpcStdioClient);

    await client.listRecentThreads('/usr/local/bin/codex', {
      limit: 40,
      liveRequestTimeoutMs: 4500,
      archivedRequestTimeoutMs: 2500,
      totalTimeoutMs: 4500,
    });

    expect(withSession).toHaveBeenCalledWith(
      expect.objectContaining({
        totalTimeoutMs: 14500,
      }),
      expect.any(Function)
    );
  });

  it('can load only live threads in a dedicated fallback session', async () => {
    const session = createSession(
      vi.fn().mockImplementation((method: string, params?: { archived?: boolean }) => {
        if (method === 'initialize') {
          return Promise.resolve({});
        }

        if (method === 'thread/list' && params?.archived === false) {
          return Promise.resolve({
            data: [{ id: 'live-1', cwd: '/Users/test/live-project', source: 'cli' }],
          });
        }

        return Promise.reject(new Error(`Unexpected method: ${method}`));
      })
    );

    const withSession = vi.fn().mockImplementation((_options, handler) => handler(session));
    const client = new CodexAppServerClient({ withSession } as unknown as JsonRpcStdioClient);

    const result = await client.listRecentLiveThreads('/usr/local/bin/codex', {
      limit: 40,
      requestTimeoutMs: 4500,
      totalTimeoutMs: 6000,
    });

    expect(withSession).toHaveBeenCalledWith(
      expect.objectContaining({
        binaryPath: '/usr/local/bin/codex',
        requestTimeoutMs: 4500,
        totalTimeoutMs: 12000,
        label: 'codex app-server thread/list live',
      }),
      expect.any(Function)
    );
    expect(result).toEqual({
      threads: [{ id: 'live-1', cwd: '/Users/test/live-project', source: 'cli' }],
    });
  });

  it('uses the longer initialize timeout for app-server startup', async () => {
    const request = vi
      .fn()
      .mockImplementation((method: string, _params?: unknown, timeoutMs?: number) => {
        if (method === 'initialize') {
          expect(timeoutMs).toBe(6000);
          return Promise.resolve({});
        }

        if (method === 'thread/list') {
          return Promise.resolve({ data: [] });
        }

        return Promise.reject(new Error(`Unexpected method: ${method}`));
      });

    const session = createSession(request);
    const withSession = vi.fn().mockImplementation((_options, handler) => handler(session));
    const client = new CodexAppServerClient({ withSession } as unknown as JsonRpcStdioClient);

    await client.listRecentThreads('/usr/local/bin/codex', {
      limit: 40,
      liveRequestTimeoutMs: 4500,
      archivedRequestTimeoutMs: 2500,
      totalTimeoutMs: 4500,
    });

    expect(request).toHaveBeenCalled();
  });
});
