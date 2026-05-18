import { EventEmitter } from 'events';
import http from 'http';
import net from 'net';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  killProcessTreeMock: vi.fn(),
  spawnCliMock: vi.fn(),
}));

vi.mock('@main/utils/childProcess', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/utils/childProcess')>();
  return {
    ...actual,
    killProcessTree: (...args: unknown[]) => hoisted.killProcessTreeMock(...args),
    spawnCli: (...args: unknown[]) => hoisted.spawnCliMock(...args),
  };
});

import { AgentTeamsMcpHttpServer } from '@main/services/team/AgentTeamsMcpHttpServer';

class FakeChildProcess extends EventEmitter {
  pid: number;
  stderr = new EventEmitter();

  constructor(pid = 43123) {
    super();
    this.pid = pid;
  }
}

async function allocateLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to allocate port')));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

describe('AgentTeamsMcpHttpServer', () => {
  beforeEach(() => {
    hoisted.killProcessTreeMock.mockReset();
    hoisted.spawnCliMock.mockReset();
  });

  it('starts the MCP server over HTTP with hidden app-owned process env', async () => {
    const child = new FakeChildProcess();
    const spawnProcess = vi.fn(() => child as any);
    const server = new AgentTeamsMcpHttpServer({
      resolveLaunchSpec: async () => ({
        command: 'node',
        args: ['mcp-server/dist/index.js'],
      }),
      allocatePort: async () => 41001,
      spawnProcess,
      waitForPort: vi.fn(async () => undefined),
    });

    const handle = await server.ensureStarted();

    expect(handle).toMatchObject({
      url: 'http://127.0.0.1:41001/mcp',
      port: 41001,
      pid: 43123,
      generation: 1,
      diagnostics: [],
    });
    expect(handle.urlHash).toMatch(/^[a-f0-9]{64}$/);
    expect(handle.transportEvidence).toMatchObject({
      schemaVersion: 1,
      transport: 'httpStream',
      host: '127.0.0.1',
      port: 41001,
      endpoint: '/mcp',
      url: 'http://127.0.0.1:41001/mcp',
      urlHash: handle.urlHash,
      generation: 1,
    });
    expect(spawnProcess).toHaveBeenCalledWith(
      'node',
      [
        'mcp-server/dist/index.js',
        '--transport',
        'httpStream',
        '--host',
        '127.0.0.1',
        '--port',
        '41001',
        '--endpoint',
        '/mcp',
      ],
      expect.objectContaining({
        AGENT_TEAMS_MCP_TRANSPORT: 'httpStream',
        AGENT_TEAMS_MCP_HTTP_PORT: '41001',
        AGENT_TEAMS_MCP_HTTP_ENDPOINT: '/mcp',
      })
    );
  });

  it('uses a hidden default spawn without holding stdout open', async () => {
    const child = new FakeChildProcess();
    hoisted.spawnCliMock.mockReturnValue(child as any);
    const server = new AgentTeamsMcpHttpServer({
      resolveLaunchSpec: async () => ({
        command: 'node',
        args: ['mcp-server/dist/index.js'],
      }),
      allocatePort: async () => 41005,
      waitForPort: vi.fn(async () => undefined),
    });

    const handle = await server.ensureStarted();

    expect(handle.pid).toBe(43123);
    expect(hoisted.spawnCliMock).toHaveBeenCalledWith(
      'node',
      [
        'mcp-server/dist/index.js',
        '--transport',
        'httpStream',
        '--host',
        '127.0.0.1',
        '--port',
        '41005',
        '--endpoint',
        '/mcp',
      ],
      expect.objectContaining({
        env: expect.objectContaining({
          AGENT_TEAMS_MCP_TRANSPORT: 'httpStream',
          AGENT_TEAMS_MCP_HTTP_PORT: '41005',
          AGENT_TEAMS_MCP_HTTP_ENDPOINT: '/mcp',
        }),
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
      })
    );
  });

  it('coalesces concurrent starts', async () => {
    const child = new FakeChildProcess();
    const spawnProcess = vi.fn(() => child as any);
    const server = new AgentTeamsMcpHttpServer({
      resolveLaunchSpec: async () => ({
        command: 'node',
        args: ['mcp-server/dist/index.js'],
      }),
      allocatePort: async () => 41002,
      spawnProcess,
      waitForPort: async () => undefined,
    });

    const [first, second] = await Promise.all([server.ensureStarted(), server.ensureStarted()]);

    expect(first).toBe(second);
    expect(spawnProcess).toHaveBeenCalledTimes(1);
  });

  it('reuses an existing handle only after its health check still passes', async () => {
    const child = new FakeChildProcess();
    const spawnProcess = vi.fn(() => child as any);
    const waitForPort = vi.fn(async () => undefined);
    const server = new AgentTeamsMcpHttpServer({
      resolveLaunchSpec: async () => ({
        command: 'node',
        args: ['mcp-server/dist/index.js'],
      }),
      allocatePort: async () => 41006,
      spawnProcess,
      waitForPort,
    });

    const first = await server.ensureStarted();
    const second = await server.ensureStarted();

    expect(second).toBe(first);
    expect(spawnProcess).toHaveBeenCalledTimes(1);
    expect(waitForPort).toHaveBeenCalledWith('127.0.0.1', 41006, 5_000);
    expect(waitForPort).toHaveBeenCalledWith('127.0.0.1', 41006, 3_000);
    expect(hoisted.killProcessTreeMock).not.toHaveBeenCalled();
  });

  it('restarts a cached HTTP MCP server handle when the health check goes stale', async () => {
    const firstChild = new FakeChildProcess(43123);
    const secondChild = new FakeChildProcess(43124);
    const spawnProcess = vi
      .fn()
      .mockReturnValueOnce(firstChild as any)
      .mockReturnValueOnce(secondChild as any);
    const allocatePort = vi.fn().mockResolvedValueOnce(41007).mockResolvedValueOnce(41008);
    const waitForPort = vi.fn(async (_host: string, port: number, timeoutMs: number) => {
      if (port === 41007 && timeoutMs === 3_000) {
        throw new Error('stale health check');
      }
    });
    const server = new AgentTeamsMcpHttpServer({
      resolveLaunchSpec: async () => ({
        command: 'node',
        args: ['mcp-server/dist/index.js'],
      }),
      allocatePort,
      spawnProcess,
      waitForPort,
    });

    const first = await server.ensureStarted();
    const second = await server.ensureStarted();

    expect(first.url).toBe('http://127.0.0.1:41007/mcp');
    expect(second).toMatchObject({
      url: 'http://127.0.0.1:41007/mcp',
      port: 41007,
      pid: 43124,
      generation: 2,
      diagnostics: ['opencode_app_mcp_restart_reason:health_reuse_failed'],
    });
    expect(second.transportEvidence).toMatchObject({
      port: 41007,
      url: 'http://127.0.0.1:41007/mcp',
      urlHash: second.urlHash,
      generation: 2,
    });
    expect(spawnProcess).toHaveBeenCalledTimes(2);
    expect(allocatePort).toHaveBeenCalledTimes(1);
    expect(hoisted.killProcessTreeMock).toHaveBeenCalledWith(firstChild, 'SIGKILL');
    expect(waitForPort).toHaveBeenCalledWith('127.0.0.1', 41007, 5_000);
    expect(waitForPort).toHaveBeenCalledWith('127.0.0.1', 41007, 3_000);
    expect(waitForPort).toHaveBeenCalledWith('127.0.0.1', 41007, 5_000);
    expect(vi.mocked(console.warn).mock.calls[0]?.join(' ')).toContain('failed health reuse check');
    expect(vi.mocked(console.warn).mock.calls[1]?.join(' ')).toContain(
      'opencode_app_mcp_restart_reason:health_reuse_failed'
    );
    vi.mocked(console.warn).mockClear();
  });

  it('falls back without killing unknown processes when the preferred restart port stays occupied', async () => {
    const firstChild = new FakeChildProcess(43123);
    const secondChild = new FakeChildProcess(43124);
    const blocker = net.createServer();
    const blockedPort = await new Promise<number>((resolve, reject) => {
      blocker.once('error', reject);
      blocker.listen(0, '127.0.0.1', () => {
        const address = blocker.address();
        if (!address || typeof address === 'string') {
          reject(new Error('Failed to allocate blocked test port'));
          return;
        }
        resolve(address.port);
      });
    });
    const fallbackPort = blockedPort === 65_535 ? blockedPort - 1 : blockedPort + 1;
    const spawnProcess = vi
      .fn()
      .mockReturnValueOnce(firstChild as any)
      .mockReturnValueOnce(secondChild as any);
    const allocatePort = vi
      .fn()
      .mockResolvedValueOnce(blockedPort)
      .mockResolvedValueOnce(fallbackPort);
    const waitForPort = vi.fn(async (_host: string, port: number, timeoutMs: number) => {
      if (port === blockedPort && timeoutMs === 3_000) {
        throw new Error('stale health check');
      }
    });
    const server = new AgentTeamsMcpHttpServer({
      resolveLaunchSpec: async () => ({
        command: 'node',
        args: ['mcp-server/dist/index.js'],
      }),
      allocatePort,
      spawnProcess,
      waitForPort,
    });

    try {
      const first = await server.ensureStarted();
      const second = await server.ensureStarted();

      expect(first.url).toBe(`http://127.0.0.1:${blockedPort}/mcp`);
      expect(second).toMatchObject({
        url: `http://127.0.0.1:${fallbackPort}/mcp`,
        port: fallbackPort,
        pid: 43124,
        generation: 2,
      });
      expect(second.diagnostics).toContain('opencode_app_mcp_public_url_changed');
      expect(second.diagnostics).toContain(
        `opencode_app_mcp_preferred_port_unavailable:${blockedPort}`
      );
      expect(hoisted.killProcessTreeMock).toHaveBeenCalledTimes(1);
      expect(allocatePort).toHaveBeenCalledTimes(2);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
      vi.mocked(console.warn).mockClear();
    }
  });

  it('fails startup promptly when the child exits before readiness', async () => {
    const child = new FakeChildProcess();
    const server = new AgentTeamsMcpHttpServer({
      resolveLaunchSpec: async () => ({
        command: 'node',
        args: ['mcp-server/dist/index.js'],
      }),
      allocatePort: async () => 41003,
      spawnProcess: vi.fn(() => child as any),
      waitForPort: vi.fn(() => {
        child.emit('exit', 1, null);
        return new Promise<void>(() => {
          // Keep readiness pending so startup resolves only through the child exit.
        });
      }),
    });

    await expect(server.ensureStarted()).rejects.toThrow(
      'Agent Teams MCP HTTP server exited before startup completed with code 1'
    );
    expect(hoisted.killProcessTreeMock).toHaveBeenCalledWith(child, 'SIGKILL');
    expect(vi.mocked(console.warn).mock.calls[0]?.join(' ')).toContain(
      'Agent Teams MCP HTTP server exited before startup completed with code 1'
    );
    vi.mocked(console.warn).mockClear();
  });

  it('does not return a handle if the child exits during readiness polling', async () => {
    const child = new FakeChildProcess();
    const server = new AgentTeamsMcpHttpServer({
      resolveLaunchSpec: async () => ({
        command: 'node',
        args: ['mcp-server/dist/index.js'],
      }),
      allocatePort: async () => 41004,
      spawnProcess: vi.fn(() => child as any),
      waitForPort: vi.fn(async () => {
        await Promise.resolve();
        child.emit('exit', 0, null);
      }),
    });

    await expect(server.ensureStarted()).rejects.toThrow(
      'Agent Teams MCP HTTP server exited before startup completed'
    );
    expect(hoisted.killProcessTreeMock).toHaveBeenCalledWith(child, 'SIGKILL');
    expect(vi.mocked(console.warn).mock.calls[0]?.join(' ')).toContain(
      'Agent Teams MCP HTTP server exited before startup completed with code 0'
    );
    vi.mocked(console.warn).mockClear();
  });

  it('waits for the HTTP health endpoint before marking the server ready', async () => {
    const child = new FakeChildProcess();
    const port = await allocateLoopbackPort();
    let healthRequests = 0;
    const healthServer = http.createServer((request, response) => {
      if (request.url === '/health') {
        healthRequests += 1;
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end('ok');
        return;
      }
      response.writeHead(404);
      response.end();
    });
    const spawnProcess = vi.fn((_command: string, args: string[]) => {
      expect(args).toContain(String(port));
      healthServer.listen(port, '127.0.0.1');
      return child as any;
    });
    const server = new AgentTeamsMcpHttpServer({
      resolveLaunchSpec: async () => ({
        command: 'node',
        args: ['mcp-server/dist/index.js'],
      }),
      allocatePort: async () => port,
      spawnProcess,
    });

    try {
      const handle = await server.ensureStarted();

      expect(handle.url).toBe(`http://127.0.0.1:${port}/mcp`);
      expect(healthRequests).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((resolve) => healthServer.close(() => resolve()));
    }
  });
});
