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
  pid = 43123;
  stderr = new EventEmitter();
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

    expect(handle).toEqual({
      url: 'http://127.0.0.1:41001/mcp',
      port: 41001,
      pid: 43123,
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
