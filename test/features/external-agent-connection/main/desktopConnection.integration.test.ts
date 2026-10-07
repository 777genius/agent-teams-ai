// @vitest-environment node
import { createDesktopExternalAgentConnection } from '@features/external-agent-connection/main/composition/createDesktopExternalAgentConnection';
import { getDesktopMcpChildEnvironment } from '@features/external-agent-connection/main/desktopMcpEnvironment';
import { request as httpRequest } from 'node:http';

import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import type { NativeRendererCdp } from '@features/external-agent-connection/main/NativeRendererCdp';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('desktop connection bound HTTP lifecycle', () => {
  // A root update before an admitted write settles would save this draft in the wrong root.
  it('drains the old root, replaces the child context and rejects stale writes and self-drains', async () => {
    let root = '/sandbox/connection-old';
    let local = true;
    let controlReady = false;
    let controlUrl = '';
    const request = (url: string, headers: Record<string, string> = {}, signal?: AbortSignal) =>
      fetch(`${controlUrl}${url}`, { method: 'POST', headers, signal });
    let handle: { url: string; generation: number } | null = null;
    let generation = 0;
    const spawnedEnvironments: Record<string, string>[] = [];
    const order: string[] = [];
    const mcp = {
      getCurrentHandle: () => handle,
      ensureStarted: async () => {
        if (!handle) {
          spawnedEnvironments.push(
            getDesktopMcpChildEnvironment({ AGENT_TEAMS_MCP_CLAUDE_DIR: '/foreign' })
          );
          handle = { url: 'http://127.0.0.1:41001/mcp', generation: ++generation };
          order.push(`start:${root}`);
        }
        return handle;
      },
      stop: async () => {
        order.push(`stop:${root}`);
        handle = null;
      },
      appContext: { bind: () => () => undefined },
    };
    const connection = createDesktopExternalAgentConnection({
      appInstanceId: 'sandbox-instance',
      userDataPath: '/sandbox/profile',
      getRoot: () => root,
      getMainContents: () => null,
      getCdpEnabled: () => false,
      getAppVersion: () => 'test',
      isLocalContext: () => local,
      getControlUrl: () => (controlReady ? controlUrl : null),
      startControl: async () => {
        controlReady = true;
      },
      reconfigureRoot: () => {
        order.push(`reconfigure:${root}`);
      },
      cdp: {
        read: async () => ({
          cdp: {
            status: 'disabled',
            httpOrigin: null,
            browserWsUrl: null,
            rendererTargetId: null,
            rendererWsUrl: null,
            targetGeneration: 0,
          },
          reason: null,
        }),
      } as unknown as NativeRendererCdp,
      mcp,
      httpEnabled: true,
    });
    const app = Fastify();
    connection.registerHttp(app);
    const admitted = deferred();
    const finishWrite = deferred();
    const writtenRoots: string[] = [];
    app.post('/api/draft', async () => {
      admitted.resolve();
      await finishWrite.promise;
      writtenRoots.push(root);
      return { saved: true };
    });
    for (const url of ['/api/app/connection/retry', '/api/ssh/connect', '/api/ssh/disconnect']) {
      if (url.startsWith('/api/ssh/')) app.post(url, () => ({ ignored: true }));
    }
    controlUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      expect((await fetch(`${controlUrl}/api/app/connection`)).status).toBe(200);
      const foreignHostStatus = await new Promise<number | undefined>((resolve, reject) => {
        const request = httpRequest(
          `${controlUrl}/api/app/connection`,
          { headers: { Host: 'foreign.example' } },
          (response) => {
            response.resume();
            resolve(response.statusCode);
          }
        );
        request.on('error', reject);
        request.end();
      });
      expect(foreignHostStatus).toBe(403);
      expect(
        (
          await fetch(`${controlUrl}/api/app/connection`, {
            headers: { Origin: 'https://foreign.example' },
          })
        ).status
      ).toBe(403);
      const before = await connection.retryConnection();
      const headers = { 'x-agent-teams-app-context': JSON.stringify(before.context) };
      const socket = new AbortController();
      const write = request('/api/draft', headers, socket.signal);
      await admitted.promise;
      socket.abort();
      await expect(write).rejects.toMatchObject({ name: 'AbortError' });
      const update = connection.updateRoot(() => {
        root = '/sandbox/connection-new';
        order.push('update');
      });
      await vi.waitFor(async () => {
        expect((await connection.getConnectionInfo()).control.status).toBe('starting');
      });
      expect((await request('/api/draft', headers)).status).toBe(409);
      expect(root).toBe('/sandbox/connection-old');
      expect(order).toEqual(['start:/sandbox/connection-old']);
      finishWrite.resolve();
      await update;
      expect(writtenRoots).toEqual(['/sandbox/connection-old']);
      expect(order.slice(1)).toEqual([
        'stop:/sandbox/connection-old',
        'update',
        'reconfigure:/sandbox/connection-new',
        'start:/sandbox/connection-new',
      ]);
      expect(spawnedEnvironments.map((env) => env.AGENT_TEAMS_MCP_CLAUDE_DIR)).toEqual([
        '/sandbox/connection-old',
        '/sandbox/connection-new',
      ]);
      const after = await connection.getConnectionInfo();
      expect(after.context.connectionGeneration).toBeGreaterThan(
        before.context.connectionGeneration
      );
      expect(after.context.dataRootFingerprint).not.toBe(before.context.dataRootFingerprint);
      expect((await request('/api/draft', headers)).status).toBe(409);
      const newHeaders = { 'x-agent-teams-app-context': JSON.stringify(after.context) };
      for (const url of ['/api/app/connection/retry', '/api/ssh/connect', '/api/ssh/disconnect']) {
        expect((await request(url, newHeaders)).status).toBe(409);
      }
      await connection.changeContext(() => {
        local = false;
      });
      const remote = await connection.getConnectionInfo();
      expect(remote.mcp.url).toBeNull();
      expect(remote.cdp.httpOrigin).toBeNull();
      expect(remote.capabilities.rendererControl).toBe(false);
      expect(() => getDesktopMcpChildEnvironment()).toThrow('unavailable');
    } finally {
      finishWrite.resolve();
      await connection.shutdown();
      await app.close();
    }
  });
});
