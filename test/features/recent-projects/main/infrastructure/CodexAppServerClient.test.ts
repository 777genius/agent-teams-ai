import { describe, expect, it, vi } from 'vitest';

import { CodexAppServerClient } from '@features/recent-projects/main/infrastructure/codex/CodexAppServerClient';

import type { JsonRpcSession, JsonRpcStdioClient } from '@features/recent-projects/main/infrastructure/codex/JsonRpcStdioClient';

function createSession(
  request: JsonRpcSession['request'],
  notify: JsonRpcSession['notify'] = vi.fn().mockResolvedValue(undefined)
): JsonRpcSession {
  return {
    request,
    notify,
  };
}

describe('CodexAppServerClient', () => {
  it('loads live and archived threads in a single app-server session', async () => {
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
          return Promise.resolve({
            data: [{ id: 'archived-1', cwd: '/Users/test/archive-project', source: 'vscode' }],
          });
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

    expect(withSession).toHaveBeenCalledTimes(1);
    expect(withSession).toHaveBeenCalledWith(
      expect.objectContaining({
        binaryPath: '/usr/local/bin/codex',
        requestTimeoutMs: 4500,
        totalTimeoutMs: 6000,
      }),
      expect.any(Function)
    );
    expect(session.notify).toHaveBeenCalledWith('initialized');
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

  it('raises the session timeout budget above the longest request timeout', async () => {
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
        totalTimeoutMs: 6000,
      }),
      expect.any(Function)
    );
  });
});
