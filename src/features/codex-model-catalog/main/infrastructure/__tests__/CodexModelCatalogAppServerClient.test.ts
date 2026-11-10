import { describe, expect, it } from 'vitest';

import { CodexModelCatalogAppServerClient } from '../CodexModelCatalogAppServerClient';

import type {
  CodexAppServerSession,
  CodexAppServerSessionFactory,
} from '@main/services/infrastructure/codexAppServer';

describe('CodexModelCatalogAppServerClient', () => {
  it('reads config and paginated model/list in one app-server session', async () => {
    const requests: { method: string; params: unknown }[] = [];
    let sessionCount = 0;
    const session: CodexAppServerSession = {
      initializeResponse: {
        userAgent: 'codex-cli 0.117.0',
        codexHome: '/Users/me/.codex',
        platformFamily: 'macos',
        platformOs: 'darwin',
      },
      request: async <TResult>(method: string, params?: unknown): Promise<TResult> => {
        requests.push({ method, params });
        if (method === 'config/read') {
          return { config: { model: 'gpt-5.4' }, origins: {} } as TResult;
        }
        if (method === 'model/list') {
          const cursor = (params as { cursor?: string | null }).cursor ?? null;
          if (cursor === null) {
            return {
              data: [{ id: 'gpt-5.4', model: 'gpt-5.4' }],
              nextCursor: 'page-2',
            } as TResult;
          }
          return {
            data: [{ id: 'gpt-5.5', model: 'gpt-5.5' }],
            nextCursor: null,
          } as TResult;
        }
        throw new Error(`Unexpected method ${method}`);
      },
      notify: async () => undefined,
      onNotification: () => () => undefined,
      close: async () => undefined,
    };
    const factory = {
      withSession: async <TResult>(
        _options: unknown,
        handler: (session: CodexAppServerSession) => Promise<TResult>
      ): Promise<TResult> => {
        sessionCount += 1;
        return handler(session);
      },
    } as unknown as CodexAppServerSessionFactory;

    const client = new CodexModelCatalogAppServerClient(factory);
    const result = await client.readModelCatalogWithConfig({
      binaryPath: '/usr/local/bin/codex',
      env: {},
      cwd: '/repo',
      profile: 'work',
    });

    expect(sessionCount).toBe(1);
    expect(result.config).toEqual({
      ok: true,
      value: { config: { model: 'gpt-5.4' }, origins: {} },
    });
    expect(result.modelCatalog).toEqual({
      data: [
        { id: 'gpt-5.4', model: 'gpt-5.4' },
        { id: 'gpt-5.5', model: 'gpt-5.5' },
      ],
      nextCursor: null,
      truncated: false,
    });
    expect(requests).toEqual([
      { method: 'config/read', params: { cwd: '/repo', profile: 'work' } },
      {
        method: 'model/list',
        params: { cursor: null, limit: 100, includeHidden: false },
      },
      {
        method: 'model/list',
        params: { cursor: 'page-2', limit: 100, includeHidden: false },
      },
    ]);
  });
});
