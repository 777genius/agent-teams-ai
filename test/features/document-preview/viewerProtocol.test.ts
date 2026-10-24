// @vitest-environment node
import { createServer, type Server } from 'node:http';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (request: { url: string; method: string }) => Promise<Response>;
const electron = vi.hoisted(() => ({ handler: undefined as Handler | undefined }));
vi.mock('electron', () => {
  const protocol = {
    registerSchemesAsPrivileged: vi.fn(),
    handle: (_scheme: string, handler: Handler) => {
      electron.handler = handler;
    },
    unhandle: vi.fn(),
  };
  return {
    app: { getAppPath: () => process.cwd() },
    protocol,
    session: { fromPartition: () => ({ protocol }) },
    net: { fetch: (url: string, options: RequestInit) => fetch(url, options) },
  };
});

import { registerViewerProtocol } from '../../../src/features/document-preview/main/infrastructure/viewerProtocol';

// A request allowed before URL resolution must not become a forbidden Vite
// endpoint after a second decode/normalization. The real server detects escapes.
describe('development viewer proxy URL boundary', () => {
  let server: Server;
  let requests: string[];
  beforeEach(async () => {
    requests = [];
    server = createServer((request, response) => {
      requests.push(request.url ?? '');
      response.end('local viewer asset');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test server address');
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('ELECTRON_RENDERER_URL', `http://127.0.0.1:${address.port}`);
    registerViewerProtocol();
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  });

  it('fetches a permitted local asset and preserves the strict CSP', async () => {
    const result = await electron.handler!({
      url: 'document-preview://viewer/file-viewer/worker.js',
      method: 'GET',
    });
    expect(result.status).toBe(200);
    expect(await result.text()).toBe('local viewer asset');
    expect(requests).toEqual(['/file-viewer/worker.js']);
    expect(result.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
  });

  it('rejects encoded traversal after URL resolution without fetching the escaped endpoint', async () => {
    for (const pathname of [
      '/file-viewer/%252e%252e/private.txt',
      '/file-viewer/%252e%252e/%252e%252e/private.txt',
    ]) {
      const result = await electron.handler!({
        url: 'document-preview://viewer' + pathname,
        method: 'GET',
      });
      expect(result.status, pathname).toBe(403);
    }
    expect(requests).toEqual([]);
  });
});
