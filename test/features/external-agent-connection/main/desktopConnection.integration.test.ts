// @vitest-environment node
import { request as httpRequest } from 'node:http';

import { createDesktopExternalAgentConnection } from '@features/external-agent-connection/main/composition/createDesktopExternalAgentConnection';
import { getDesktopMcpChildEnvironment } from '@features/external-agent-connection/main/desktopMcpEnvironment';
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
    let liveConsumers = false;
    let startupFailure = true;
    let liveRuntimeConsumers = false;
    let reconfigureFails = false;
    const spawnedEnvironments: Record<string, string>[] = [];
    const order: string[] = [];
    const mcp = {
      getCurrentHandle: () => handle,
      assertNoLiveConsumers: async () => {
        if (liveConsumers) throw new Error('Stop teams using MCP before switching.');
      },
      ensureStarted: async () => {
        if (startupFailure) throw new Error('Sandbox MCP startup failed');
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
        if (reconfigureFails) throw new Error('Root services unavailable');
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
      assertNoLiveRuntimeConsumers: () => {
        if (liveRuntimeConsumers) throw new Error('Stop teams using MCP before switching.');
      },
    });
    let app = Fastify();
    connection.registerHttp(app);
    const admitted = deferred();
    const finishWrite = deferred();
    const writtenRoots: string[] = [];
    const shutdownAdmitted = deferred(),
      finishShutdownWrite = deferred();
    const installDraftRoutes = (server: ReturnType<typeof Fastify>) => {
      server.post('/api/draft', async () => {
        admitted.resolve();
        await finishWrite.promise;
        writtenRoots.push(root);
        return { saved: true };
      });
      for (const url of ['/api/ssh/connect', '/api/ssh/disconnect']) {
        server.post(url, () => ({ ignored: true }));
      }
      server.post('/api/hung', async () => {
        shutdownAdmitted.resolve();
        await finishShutdownWrite.promise;
        return {};
      });
    };
    installDraftRoutes(app);
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
      const failed = await connection.retryConnection();
      expect(failed.mcp.status).toBe('error');
      expect(failed.errorCode).toBe('MCP_START_FAILED');
      expect(failed.reason).toBe('Sandbox MCP startup failed');
      // Another owned supervisor consumer can recover without a facade retry.
      startupFailure = false;
      await mcp.ensureStarted();
      const before = await connection.getConnectionInfo();
      expect(before.mcp.status).toBe('ready');
      expect(before.capabilities.draftCreation).toBe(true);
      expect(before.errorCode).toBeNull();
      expect(before.reason).toBeNull();
      expect(before.recovery).toBeNull();
      liveRuntimeConsumers = true;
      await expect(
        connection.updateRoot(() => {
          root = '/sandbox/wrong';
        })
      ).rejects.toThrow('Stop teams');
      await expect(
        connection.changeContext(() => {
          local = false;
        })
      ).rejects.toThrow('Stop teams');
      expect((await connection.getConnectionInfo()).context).toEqual(before.context);
      expect(local).toBe(true);
      expect(root).toBe('/sandbox/connection-old');
      expect(order).toEqual(['start:/sandbox/connection-old']);
      liveRuntimeConsumers = false;
      const oldApp = app;
      app = Fastify();
      connection.registerHttp(app);
      installDraftRoutes(app);
      controlUrl = await app.listen({ host: '127.0.0.1', port: 0 });
      await oldApp.close();
      const drift = await connection.getConnectionInfo();
      expect(drift.mcp.status).toBe('error');
      expect(drift.mcp.url).toBeNull();
      liveConsumers = true;
      const busy = await connection.retryConnection();
      expect(busy.mcp.status).toBe('error');
      expect(busy.reason).toContain('Stop teams');
      expect(busy.context).toEqual(before.context);
      expect(order).toEqual(['start:/sandbox/connection-old']);
      liveConsumers = false;
      const replacement = await connection.retryConnection();
      expect(replacement.mcp.status).toBe('ready');
      expect(spawnedEnvironments.at(-1)?.AGENT_TEAMS_BOUND_CONTROL_URL).toBe(controlUrl);
      expect(replacement.context.connectionGeneration).toBeGreaterThan(
        before.context.connectionGeneration
      );
      handle = null; // The supervisor's observable state after unexpected child exit.
      const crash = await connection.getConnectionInfo();
      expect(crash.mcp.status).toBe('error');
      expect(crash.recovery).toContain('Retry');
      const resumed = await connection.retryConnection();
      expect(resumed.mcp.status).toBe('ready');
      const rootOrderOffset = order.length;
      const headers = { 'x-agent-teams-app-context': JSON.stringify(resumed.context) };
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
      expect(order).toHaveLength(rootOrderOffset);
      finishWrite.resolve();
      await update;
      expect(writtenRoots).toEqual(['/sandbox/connection-old']);
      expect(order.slice(rootOrderOffset)).toEqual([
        'stop:/sandbox/connection-old',
        'update',
        'reconfigure:/sandbox/connection-new',
        'start:/sandbox/connection-new',
      ]);
      expect(spawnedEnvironments.slice(-2).map((env) => env.AGENT_TEAMS_MCP_CLAUDE_DIR)).toEqual([
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
      // A failed local switch must resume native launches against the actual root.
      await expect(
        connection.changeContext(() => {
          throw new Error('SSH connect failed');
        })
      ).rejects.toThrow('SSH connect failed');
      expect(() => connection.assertLaunchAdmission()).not.toThrow();
      expect((await connection.getConnectionInfo()).mcp.status).toBe('ready');
      expect(spawnedEnvironments.at(-1)?.AGENT_TEAMS_MCP_CLAUDE_DIR).toBe(root);
      await expect(
        connection.updateRoot(() => {
          root = '/sandbox/connection-failed-update';
          throw new Error('Config write failed');
        })
      ).rejects.toThrow('Config write failed');
      expect(() => connection.assertLaunchAdmission()).not.toThrow();
      expect(spawnedEnvironments.at(-1)?.AGENT_TEAMS_MCP_CLAUDE_DIR).toBe(
        '/sandbox/connection-failed-update'
      );
      await connection.updateRoot(() => {
        root = '/sandbox/connection-new';
      });
      reconfigureFails = true;
      await expect(
        connection.changeContext(() => {
          throw new Error('SSH connect failed');
        })
      ).rejects.toThrow('SSH connect failed');
      expect(() => connection.assertLaunchAdmission()).toThrow('changing context');
      expect(handle).toBeNull();
      reconfigureFails = false;
      expect((await connection.retryConnection()).mcp.status).toBe('ready');
      // A partially completed remote switch cannot restore local authority.
      await expect(
        connection.changeContext(() => {
          local = false;
          throw new Error('Remote setup failed');
        })
      ).rejects.toThrow('Remote setup failed');
      expect(() => connection.assertLaunchAdmission()).toThrow('changing context');
      const remote = await connection.getConnectionInfo();
      expect(remote.mcp.url).toBeNull();
      expect(remote.cdp.httpOrigin).toBeNull();
      expect(remote.capabilities.rendererControl).toBe(false);
      expect(() => getDesktopMcpChildEnvironment()).toThrow('unavailable');
      await connection.changeContext(() => {
        local = true;
      });
      const finalInfo = await connection.getConnectionInfo();
      const hung = request('/api/hung', {
        'x-agent-teams-app-context': JSON.stringify(finalInfo.context),
      });
      await shutdownAdmitted.promise;
      const parked = connection.updateRoot(() => {
        root = '/sandbox/must-not-write';
      });
      const rejected = expect(parked).rejects.toThrow('shutting down');
      await vi.waitFor(async () =>
        expect((await connection.getConnectionInfo()).control.status).toBe('starting')
      );
      await connection.shutdown();
      expect(handle).toBeNull();
      expect(root).toBe('/sandbox/connection-new');
      finishShutdownWrite.resolve();
      await hung;
      await rejected;
      expect(root).toBe('/sandbox/connection-new');
    } finally {
      finishWrite.resolve();
      finishShutdownWrite.resolve();
      await connection.shutdown();
      await app.close();
    }
  });
});
