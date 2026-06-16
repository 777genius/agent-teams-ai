import { type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { getClaudeBasePath } from '@main/utils/pathDecoder';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  killProcessTreeMock: vi.fn(),
  spawnCliMock: vi.fn(),
  untrackCliProcessMock: vi.fn(),
}));

vi.mock('@main/utils/childProcess', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/utils/childProcess')>();
  return {
    ...actual,
    killProcessTree: (...args: unknown[]) => hoisted.killProcessTreeMock(...args),
    spawnCli: (...args: unknown[]) => hoisted.spawnCliMock(...args),
    untrackCliProcess: (...args: unknown[]) => hoisted.untrackCliProcessMock(...args),
  };
});

import {
  AgentTeamsMcpHttpServer,
  type AgentTeamsMcpHttpServerDeps,
} from '@main/services/team/AgentTeamsMcpHttpServer';

class FakeChildProcess extends EventEmitter {
  pid: number;
  stderr = new EventEmitter();

  constructor(pid = 43123) {
    super();
    this.pid = pid;
  }
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

type TestLaunchSpec = {
  command: string;
  args: string[];
  env?: Record<string, string>;
};

function buildLaunchSpecHash(launchSpec: TestLaunchSpec): string {
  const env = launchSpec.env
    ? Object.fromEntries(
        Object.entries(launchSpec.env).sort(([left], [right]) => left.localeCompare(right))
      )
    : {};
  return sha256Hex(
    JSON.stringify({ command: launchSpec.command, args: launchSpec.args, env })
  );
}

async function createTempStatePath(): Promise<{ root: string; statePath: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-teams-mcp-http-state-test-'));
  const statePath = path.join(root, 'mcp-http-server', 'state.json');
  await mkdir(path.dirname(statePath), { recursive: true });
  return { root, statePath };
}

function buildIdentity(input: {
  port: number;
  launchSpec: TestLaunchSpec;
  ownerInstanceId?: string;
}) {
  return {
    schemaVersion: 1 as const,
    service: 'agent-teams-mcp-http' as const,
    transport: 'httpStream' as const,
    host: '127.0.0.1',
    port: input.port,
    endpoint: '/mcp',
    claudeDirHash: sha256Hex(getClaudeBasePath()),
    launchSpecHash: buildLaunchSpecHash(input.launchSpec),
    ownerInstanceId: input.ownerInstanceId ?? 'previous-owner',
  };
}

function buildState(input: {
  port: number;
  pid?: number | null;
  launchSpec: TestLaunchSpec;
  ownerInstanceId?: string;
}) {
  const identity = buildIdentity(input);
  const url = `http://127.0.0.1:${input.port}/mcp`;
  return {
    ...identity,
    url,
    urlHash: sha256Hex(url),
    pid: input.pid ?? null,
    startedAt: '2026-05-21T00:00:00.000Z',
    updatedAt: '2026-05-21T00:00:00.000Z',
  };
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

async function flushAsyncCleanup(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await Promise.resolve();
}

describe('AgentTeamsMcpHttpServer', () => {
  beforeEach(() => {
    hoisted.killProcessTreeMock.mockReset();
    hoisted.spawnCliMock.mockReset();
    hoisted.untrackCliProcessMock.mockReset();
  });

  it('starts the MCP server over HTTP with hidden app-owned process env', async () => {
    const child = new FakeChildProcess();
    const spawnProcess = vi.fn(() => child as unknown as ChildProcess);
    const server = new AgentTeamsMcpHttpServer({
      statePath: null,
      resolveLaunchSpec: async () => ({
        command: 'node',
        args: ['mcp-server/dist/index.js'],
        env: { ELECTRON_RUN_AS_NODE: '1' },
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
        ELECTRON_RUN_AS_NODE: '1',
        AGENT_TEAMS_MCP_TRANSPORT: 'httpStream',
        AGENT_TEAMS_MCP_HTTP_HOST: '127.0.0.1',
        AGENT_TEAMS_MCP_HTTP_PORT: '41001',
        AGENT_TEAMS_MCP_HTTP_ENDPOINT: '/mcp',
      })
    );
  });

  it('uses a hidden default spawn without holding stdout open', async () => {
    const child = new FakeChildProcess();
    hoisted.spawnCliMock.mockReturnValue(child as unknown as ChildProcess);
    const server = new AgentTeamsMcpHttpServer({
      statePath: null,
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
          AGENT_TEAMS_MCP_HTTP_HOST: '127.0.0.1',
          AGENT_TEAMS_MCP_HTTP_PORT: '41005',
          AGENT_TEAMS_MCP_HTTP_ENDPOINT: '/mcp',
        }),
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
      })
    );
    expect(hoisted.untrackCliProcessMock).toHaveBeenCalledWith(child);
  });

  it('coalesces concurrent starts', async () => {
    const child = new FakeChildProcess();
    const spawnProcess = vi.fn(() => child as unknown as ChildProcess);
    const server = new AgentTeamsMcpHttpServer({
      statePath: null,
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

  it('does not start after shutdown has disabled future starts', async () => {
    const spawnProcess = vi.fn();
    const server = new AgentTeamsMcpHttpServer({
      statePath: null,
      resolveLaunchSpec: async () => ({
        command: 'node',
        args: ['mcp-server/dist/index.js'],
      }),
      allocatePort: async () => 41026,
      spawnProcess: spawnProcess as AgentTeamsMcpHttpServerDeps['spawnProcess'],
      waitForPort: vi.fn(async () => undefined),
    });

    await server.stop({ preventRestart: true });

    await expect(server.ensureStarted()).rejects.toThrow('startup is disabled during shutdown');
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it('raises inherited low NODE_OPTIONS heap for the managed MCP HTTP child', async () => {
    const previousNodeOptions = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = '--max-old-space-size=64';
    const child = new FakeChildProcess(41064);
    const spawnProcess = vi.fn(() => child as unknown as ChildProcess);
    const server = new AgentTeamsMcpHttpServer({
      statePath: null,
      resolveLaunchSpec: async () => ({
        command: 'node',
        args: ['mcp-server/dist/index.js'],
      }),
      allocatePort: async () => 41064,
      spawnProcess: spawnProcess as AgentTeamsMcpHttpServerDeps['spawnProcess'],
      waitForPort: vi.fn(async () => undefined),
    });

    try {
      await server.ensureStarted();

      expect(spawnProcess).toHaveBeenCalledWith(
        'node',
        expect.any(Array),
        expect.objectContaining({
          NODE_OPTIONS: '--max-old-space-size=2048',
        })
      );
    } finally {
      await server.stop();
      if (previousNodeOptions === undefined) {
        delete process.env.NODE_OPTIONS;
      } else {
        process.env.NODE_OPTIONS = previousNodeOptions;
      }
    }
  });

  it('cancels an in-flight start before spawn when shutdown disables future starts', async () => {
    let resolveLaunchSpec!: (launchSpec: { command: string; args: string[] }) => void;
    const launchSpecPromise = new Promise<{ command: string; args: string[] }>((resolve) => {
      resolveLaunchSpec = resolve;
    });
    const spawnProcess = vi.fn();
    const server = new AgentTeamsMcpHttpServer({
      statePath: null,
      resolveLaunchSpec: async () => launchSpecPromise,
      allocatePort: async () => 41027,
      spawnProcess: spawnProcess as AgentTeamsMcpHttpServerDeps['spawnProcess'],
      waitForPort: vi.fn(async () => undefined),
    });

    const startPromise = server.ensureStarted();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await server.stop({ preventRestart: true });
    resolveLaunchSpec({ command: 'node', args: ['mcp-server/dist/index.js'] });

    await expect(startPromise).rejects.toThrow('startup is disabled during shutdown');
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it('uses the persistent state lock so a concurrent second instance adopts the first', async () => {
    const { root, statePath } = await createTempStatePath();
    const launchSpec = { command: 'node', args: ['mcp-server/dist/index.js'] };
    const child = new FakeChildProcess(43131);
    const spawnProcess = vi.fn(() => child as unknown as ChildProcess);
    const probeHealth = vi.fn(async (_host: string, port: number) => ({
      healthy: true,
      statusCode: 200,
      identity: buildIdentity({ port, launchSpec, ownerInstanceId: 'first-instance' }),
    }));
    let lockTail = Promise.resolve();
    let activeLocks = 0;
    let maxActiveLocks = 0;
    const withStateLock: NonNullable<AgentTeamsMcpHttpServerDeps['withStateLock']> = async (
      _filePath,
      fn
    ) => {
      const previous = lockTail;
      let release!: () => void;
      lockTail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      activeLocks += 1;
      maxActiveLocks = Math.max(maxActiveLocks, activeLocks);
      try {
        return await fn();
      } finally {
        activeLocks -= 1;
        release();
      }
    };
    let releaseFirstReady!: () => void;
    const firstReady = new Promise<void>((resolve) => {
      releaseFirstReady = resolve;
    });
    const waitForPort = vi.fn(async () => {
      await firstReady;
    });
    const firstServer = new AgentTeamsMcpHttpServer({
      statePath,
      disableOrphanCleanup: true,
      resolveLaunchSpec: async () => launchSpec,
      allocatePort: async () => 41024,
      spawnProcess,
      waitForPort,
      probeHealth,
      withStateLock,
    });
    const secondServer = new AgentTeamsMcpHttpServer({
      statePath,
      disableOrphanCleanup: true,
      resolveLaunchSpec: async () => launchSpec,
      allocatePort: async () => 41025,
      spawnProcess,
      waitForPort,
      probeHealth,
      withStateLock,
    });

    try {
      const firstStart = firstServer.ensureStarted();
      await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledTimes(1));
      const secondStart = secondServer.ensureStarted();
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(spawnProcess).toHaveBeenCalledTimes(1);
      releaseFirstReady();
      const [first, second] = await Promise.all([firstStart, secondStart]);

      expect(first.port).toBe(41024);
      expect(second.port).toBe(41024);
      expect(second.diagnostics).toContain('opencode_app_mcp_adopted_state_server:41024');
      expect(spawnProcess).toHaveBeenCalledTimes(1);
      expect(waitForPort).toHaveBeenCalledTimes(1);
      expect(maxActiveLocks).toBe(1);
    } finally {
      releaseFirstReady();
      await lockTail;
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      vi.mocked(console.warn).mockClear();
    }
  });

  it('adopts a healthy MCP HTTP server from persistent state without spawning', async () => {
    const { root, statePath } = await createTempStatePath();
    const launchSpec = { command: 'node', args: ['mcp-server/dist/index.js'] };
    const port = 41021;
    const identity = buildIdentity({ port, launchSpec });
    await writeFile(
      statePath,
      `${JSON.stringify(buildState({ port, pid: 51234, launchSpec }), null, 2)}\n`
    );
    const spawnProcess = vi.fn();
    const probeHealth = vi.fn(async () => ({
      healthy: true,
      statusCode: 200,
      identity,
    }));
    const server = new AgentTeamsMcpHttpServer({
      statePath,
      disableOrphanCleanup: true,
      resolveLaunchSpec: async () => launchSpec,
      spawnProcess: spawnProcess as AgentTeamsMcpHttpServerDeps['spawnProcess'],
      probeHealth,
    });

    try {
      const handle = await server.ensureStarted();

      expect(handle).toMatchObject({
        url: `http://127.0.0.1:${port}/mcp`,
        port,
        pid: 51234,
        diagnostics: [`opencode_app_mcp_adopted_state_server:${port}`],
      });
      expect(spawnProcess).not.toHaveBeenCalled();
      expect(probeHealth).toHaveBeenCalledWith('127.0.0.1', port);
    } finally {
      await rm(root, { recursive: true, force: true });
      vi.mocked(console.warn).mockClear();
    }
  });

  it('ignores corrupt persistent state and starts a fresh server', async () => {
    const { root, statePath } = await createTempStatePath();
    const launchSpec = { command: 'node', args: ['mcp-server/dist/index.js'] };
    await writeFile(statePath, '{not-json', 'utf8');
    const child = new FakeChildProcess();
    const spawnProcess = vi.fn(() => child as unknown as ChildProcess);
    const server = new AgentTeamsMcpHttpServer({
      statePath,
      disableOrphanCleanup: true,
      resolveLaunchSpec: async () => launchSpec,
      allocatePort: async () => 41022,
      spawnProcess,
      waitForPort: vi.fn(async () => undefined),
    });

    try {
      const handle = await server.ensureStarted();

      expect(handle.port).toBe(41022);
      expect(handle.diagnostics).toContain('opencode_app_mcp_state_ignored:parse_failed');
      expect(spawnProcess).toHaveBeenCalledTimes(1);
    } finally {
      await rm(root, { recursive: true, force: true });
      vi.mocked(console.warn).mockClear();
    }
  });

  it('ignores persistent state when the MCP child env changed', async () => {
    const { root, statePath } = await createTempStatePath();
    const previousLaunchSpec = { command: 'node', args: ['mcp-server/dist/index.js'] };
    const currentLaunchSpec = {
      command: 'node',
      args: ['mcp-server/dist/index.js'],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    };
    await writeFile(
      statePath,
      `${JSON.stringify(
        buildState({ port: 41029, pid: 51235, launchSpec: previousLaunchSpec }),
        null,
        2
      )}\n`
    );
    const child = new FakeChildProcess();
    const spawnProcess = vi.fn(() => child as unknown as ChildProcess);
    const server = new AgentTeamsMcpHttpServer({
      statePath,
      disableOrphanCleanup: true,
      resolveLaunchSpec: async () => currentLaunchSpec,
      allocatePort: async () => 41030,
      spawnProcess,
      waitForPort: vi.fn(async () => undefined),
    });

    try {
      const handle = await server.ensureStarted();

      expect(handle.port).toBe(41030);
      expect(handle.diagnostics).toContain('opencode_app_mcp_state_ignored:identity_mismatch');
      expect(spawnProcess).toHaveBeenCalledTimes(1);
    } finally {
      await rm(root, { recursive: true, force: true });
      vi.mocked(console.warn).mockClear();
    }
  });

  it('adopts a healthy matching MCP HTTP server on the configured stable port', async () => {
    const { root, statePath } = await createTempStatePath();
    const launchSpec = { command: 'node', args: ['mcp-server/dist/index.js'] };
    const port = 41023;
    const identity = buildIdentity({ port, launchSpec });
    const previousPortEnv = process.env.CLAUDE_TEAM_OPENCODE_MCP_HTTP_PORT;
    process.env.CLAUDE_TEAM_OPENCODE_MCP_HTTP_PORT = String(port);
    const spawnProcess = vi.fn();
    const server = new AgentTeamsMcpHttpServer({
      statePath,
      disableOrphanCleanup: true,
      resolveLaunchSpec: async () => launchSpec,
      spawnProcess: spawnProcess as AgentTeamsMcpHttpServerDeps['spawnProcess'],
      canListenOnPort: async () => false,
      probeHealth: vi.fn(async () => ({
        healthy: true,
        statusCode: 200,
        identity,
      })),
    });

    try {
      const handle = await server.ensureStarted();
      await server.stop();

      expect(handle).toMatchObject({
        port,
        pid: null,
        diagnostics: [`opencode_app_mcp_adopted_port_server:${port}`],
      });
      expect(spawnProcess).not.toHaveBeenCalled();
      expect(hoisted.killProcessTreeMock).not.toHaveBeenCalled();
    } finally {
      if (previousPortEnv === undefined) {
        delete process.env.CLAUDE_TEAM_OPENCODE_MCP_HTTP_PORT;
      } else {
        process.env.CLAUDE_TEAM_OPENCODE_MCP_HTTP_PORT = previousPortEnv;
      }
      await rm(root, { recursive: true, force: true });
      vi.mocked(console.warn).mockClear();
    }
  });

  it('reuses an existing handle only after its health check still passes', async () => {
    const child = new FakeChildProcess();
    const spawnProcess = vi.fn(() => child as unknown as ChildProcess);
    const waitForPort = vi.fn(async () => undefined);
    const server = new AgentTeamsMcpHttpServer({
      statePath: null,
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
    expect(waitForPort).toHaveBeenCalledWith('127.0.0.1', 41006, 10_000);
    expect(waitForPort).toHaveBeenCalledWith('127.0.0.1', 41006, 3_000);
    expect(hoisted.killProcessTreeMock).not.toHaveBeenCalled();
  });

  it('restarts a cached HTTP MCP server handle when the health check goes stale', async () => {
    const firstChild = new FakeChildProcess(43123);
    const secondChild = new FakeChildProcess(43124);
    const spawnProcess = vi
      .fn()
      .mockReturnValueOnce(firstChild as unknown as ChildProcess)
      .mockReturnValueOnce(secondChild as unknown as ChildProcess);
    const allocatePort = vi.fn().mockResolvedValueOnce(41007).mockResolvedValueOnce(41008);
    const waitForPort = vi.fn(async (_host: string, port: number, timeoutMs: number) => {
      if (port === 41007 && timeoutMs === 3_000) {
        throw new Error('stale health check');
      }
    });
    const server = new AgentTeamsMcpHttpServer({
      statePath: null,
      resolveLaunchSpec: async () => ({
        command: 'node',
        args: ['mcp-server/dist/index.js'],
      }),
      allocatePort,
      spawnProcess,
      waitForPort,
      canListenOnPort: async () => true,
      probeHealth: vi.fn(async () => ({ healthy: false, statusCode: null, identity: null })),
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
    expect(waitForPort).toHaveBeenCalledWith('127.0.0.1', 41007, 10_000);
    expect(waitForPort).toHaveBeenCalledWith('127.0.0.1', 41007, 3_000);
    expect(waitForPort).toHaveBeenCalledWith('127.0.0.1', 41007, 10_000);
    expect(vi.mocked(console.warn).mock.calls[0]?.join(' ')).toContain('failed health reuse check');
    expect(vi.mocked(console.warn).mock.calls[1]?.join(' ')).toContain(
      'opencode_app_mcp_restart_reason:health_reuse_failed'
    );
    vi.mocked(console.warn).mockClear();
  });

  it('falls back without killing unknown processes when the preferred restart port stays occupied', async () => {
    const firstChild = new FakeChildProcess(43123);
    const secondChild = new FakeChildProcess(43124);
    const blockedPort = 41041;
    const fallbackPort = 41042;
    const spawnProcess = vi
      .fn()
      .mockReturnValueOnce(firstChild as unknown as ChildProcess)
      .mockReturnValueOnce(secondChild as unknown as ChildProcess);
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
      statePath: null,
      resolveLaunchSpec: async () => ({
        command: 'node',
        args: ['mcp-server/dist/index.js'],
      }),
      allocatePort,
      spawnProcess,
      waitForPort,
      canListenOnPort: async (_host, port) => port !== blockedPort,
      probeHealth: vi.fn(async () => ({ healthy: false, statusCode: null, identity: null })),
    });

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
    vi.mocked(console.warn).mockClear();
  });

  it('cleans up a proven legacy orphan MCP HTTP process without live consumers', async () => {
    const { root, statePath } = await createTempStatePath();
    const child = new FakeChildProcess(43123);
    const orphanPort = 41031;
    const alivePids = new Set([9001, 9005]);
    const killProcess = vi.fn((pid: number) => {
      alivePids.delete(pid);
    });
    const command = `node /repo/mcp-server/src/index.ts --transport httpStream --host 127.0.0.1 --port ${orphanPort} --endpoint /mcp`;
    const rows = [
      { pid: 9001, ppid: 1, command },
      { pid: 9005, ppid: 9001, command },
      { pid: 43123, ppid: process.pid, command: 'current child' },
    ];
    const details = `${command} AGENT_TEAMS_MCP_CLAUDE_DIR=${getClaudeBasePath()} AGENT_TEAMS_MCP_TRANSPORT=httpStream AGENT_TEAMS_MCP_HTTP_HOST=127.0.0.1 AGENT_TEAMS_MCP_HTTP_PORT=${orphanPort} AGENT_TEAMS_MCP_HTTP_ENDPOINT=/mcp`;
    const server = new AgentTeamsMcpHttpServer({
      statePath,
      resolveLaunchSpec: async () => ({
        command: 'node',
        args: ['mcp-server/dist/index.js'],
      }),
      allocatePort: async () => 41030,
      spawnProcess: vi.fn(() => child as unknown as ChildProcess),
      waitForPort: vi.fn(async () => undefined),
      listProcessRows: async () => rows,
      readProcessDetails: async (pid) => (pid === 9001 || pid === 9005 ? details : null),
      readProcessStartTimeMs: async () => 0,
      killProcess,
      forceKillProcess: vi.fn(),
      isProcessAlive: (pid) => alivePids.has(pid),
      sleepMs: async () => undefined,
      probeHealth: vi.fn(async () => ({ healthy: true, statusCode: 200, identity: null })),
    });

    try {
      const handle = await server.ensureStarted();
      await flushAsyncCleanup();

      expect(killProcess).toHaveBeenNthCalledWith(1, 9005);
      expect(killProcess).toHaveBeenNthCalledWith(2, 9001);
      expect(handle.diagnostics).toContain(
        `opencode_app_mcp_legacy_orphan_cleaned:${orphanPort}`
      );
    } finally {
      await rm(root, { recursive: true, force: true });
      vi.mocked(console.warn).mockClear();
    }
  });

  it('keeps a proven legacy orphan MCP HTTP process when live consumers still reference it', async () => {
    const { root, statePath } = await createTempStatePath();
    const child = new FakeChildProcess(43123);
    const orphanPort = 41033;
    const url = `http://127.0.0.1:${orphanPort}/mcp`;
    const command = `node /repo/mcp-server/src/index.ts --transport httpStream --host 127.0.0.1 --port ${orphanPort} --endpoint /mcp`;
    const rows = [
      { pid: 9002, ppid: 1, command },
      { pid: 9003, ppid: 1, command: 'consumer process' },
      { pid: 43123, ppid: process.pid, command: 'current child' },
    ];
    const orphanDetails = `${command} AGENT_TEAMS_MCP_CLAUDE_DIR=${getClaudeBasePath()} AGENT_TEAMS_MCP_TRANSPORT=httpStream AGENT_TEAMS_MCP_HTTP_HOST=127.0.0.1 AGENT_TEAMS_MCP_HTTP_PORT=${orphanPort} AGENT_TEAMS_MCP_HTTP_ENDPOINT=/mcp`;
    const killProcess = vi.fn();
    const server = new AgentTeamsMcpHttpServer({
      statePath,
      resolveLaunchSpec: async () => ({
        command: 'node',
        args: ['mcp-server/dist/index.js'],
      }),
      allocatePort: async () => 41032,
      spawnProcess: vi.fn(() => child as unknown as ChildProcess),
      waitForPort: vi.fn(async () => undefined),
      listProcessRows: async () => rows,
      readProcessDetails: async (pid) =>
        pid === 9002
          ? orphanDetails
          : `CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL=${url}`,
      readProcessStartTimeMs: async () => 0,
      killProcess,
      isProcessAlive: () => false,
      sleepMs: async () => undefined,
      probeHealth: vi.fn(async () => ({ healthy: true, statusCode: 200, identity: null })),
    });

    try {
      const handle = await server.ensureStarted();
      await flushAsyncCleanup();

      expect(killProcess).not.toHaveBeenCalled();
      expect(handle.diagnostics).toContain(
        `opencode_app_mcp_legacy_orphan_kept_live_consumers:${orphanPort}`
      );
    } finally {
      await rm(root, { recursive: true, force: true });
      vi.mocked(console.warn).mockClear();
    }
  });

  it('does not clean up MCP-like processes that still have a live parent', async () => {
    const { root, statePath } = await createTempStatePath();
    const child = new FakeChildProcess(43123);
    const orphanPort = 41035;
    const command = `node /repo/mcp-server/src/index.ts --transport httpStream --host 127.0.0.1 --port ${orphanPort} --endpoint /mcp`;
    const killProcess = vi.fn();
    const server = new AgentTeamsMcpHttpServer({
      statePath,
      resolveLaunchSpec: async () => ({
        command: 'node',
        args: ['mcp-server/dist/index.js'],
      }),
      allocatePort: async () => 41034,
      spawnProcess: vi.fn(() => child as unknown as ChildProcess),
      waitForPort: vi.fn(async () => undefined),
      listProcessRows: async () => [
        { pid: 9004, ppid: 1234, command },
        { pid: 43123, ppid: process.pid, command: 'current child' },
      ],
      readProcessDetails: vi.fn(),
      readProcessStartTimeMs: vi.fn(),
      killProcess,
      isProcessAlive: (pid) => pid === 1234,
      sleepMs: async () => undefined,
    });

    try {
      await server.ensureStarted();
      await flushAsyncCleanup();

      expect(killProcess).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails startup promptly when the child exits before readiness', async () => {
    const child = new FakeChildProcess();
    const server = new AgentTeamsMcpHttpServer({
      statePath: null,
      resolveLaunchSpec: async () => ({
        command: 'node',
        args: ['mcp-server/dist/index.js'],
      }),
      allocatePort: async () => 41003,
      spawnProcess: vi.fn(() => child as unknown as ChildProcess),
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
      statePath: null,
      resolveLaunchSpec: async () => ({
        command: 'node',
        args: ['mcp-server/dist/index.js'],
      }),
      allocatePort: async () => 41004,
      spawnProcess: vi.fn(() => child as unknown as ChildProcess),
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
      return child as unknown as ChildProcess;
    });
    const server = new AgentTeamsMcpHttpServer({
      statePath: null,
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
