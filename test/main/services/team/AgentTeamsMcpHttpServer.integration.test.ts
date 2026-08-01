// @vitest-environment node
/* eslint-disable security/detect-non-literal-fs-filename, sonarjs/publicly-writable-directories */
import { chmod, copyFile, link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import Module from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { ensureAgentTeamsMcpLocalLaunchEnv } from '@main/services/runtime/agentTeamsMcpLaunchEnv';
import { AgentTeamsMcpHttpServer } from '@main/services/team/AgentTeamsMcpHttpServer';
import { OpenCodeBridgeCommandClient } from '@main/services/team/opencode/bridge/OpenCodeBridgeCommandClient';
import { clearResolvedNodePathForTests } from '@main/services/team/TeamMcpConfigBuilder';
import { setAppDataBasePath } from '@main/utils/pathDecoder';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const FAKE_MCP_HTTP_SERVER_SOURCE = String.raw`
const fs = require('node:fs');
const http = require('node:http');

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

const host = readArg('--host') || '127.0.0.1';
const endpoint = readArg('--endpoint') || '/mcp';
const port = Number(readArg('--port'));
const controlFile = process.env.AGENT_TEAMS_MCP_TEST_CONTROL_FILE;
const healthIdentity =
  process.env.AGENT_TEAMS_MCP_HTTP_IDENTITY_SERVICE === 'agent-teams-mcp-http' &&
  process.env.AGENT_TEAMS_MCP_HTTP_CLAUDE_DIR_HASH &&
  process.env.AGENT_TEAMS_MCP_HTTP_LAUNCH_SPEC_HASH &&
  process.env.AGENT_TEAMS_MCP_HTTP_OWNER_INSTANCE_ID
    ? {
        schemaVersion: 1,
        service: 'agent-teams-mcp-http',
        transport: 'httpStream',
        host,
        port,
        endpoint,
        claudeDirHash: process.env.AGENT_TEAMS_MCP_HTTP_CLAUDE_DIR_HASH,
        launchSpecHash: process.env.AGENT_TEAMS_MCP_HTTP_LAUNCH_SPEC_HASH,
        ownerInstanceId: process.env.AGENT_TEAMS_MCP_HTTP_OWNER_INSTANCE_ID,
      }
    : null;

function readControl() {
  if (!controlFile) {
    return 'healthy';
  }
  try {
    return fs.readFileSync(controlFile, 'utf8').trim() || 'healthy';
  } catch {
    return 'healthy';
  }
}

function isUnhealthy() {
  const control = readControl();
  if (control === 'unhealthy-once:' + port) {
    try {
      fs.writeFileSync(controlFile, 'healthy');
    } catch {}
    return true;
  }
  if (control === 'unhealthy-pid:' + process.pid) {
    return true;
  }
  return control === 'unhealthy-all' || control === 'unhealthy-port:' + port;
}

const server = http.createServer((request, response) => {
  if (request.url === '/health') {
    if (isUnhealthy()) {
      response.writeHead(503, { 'content-type': 'text/plain' });
      response.end('unhealthy');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end(healthIdentity ? JSON.stringify(healthIdentity) : 'ok');
    return;
  }

  if (request.url === endpoint) {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"jsonrpc":"2.0","result":{}}');
    return;
  }

  response.writeHead(404, { 'content-type': 'text/plain' });
  response.end('not found');
});

server.listen(port, host);

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
`;

const FAKE_OPENCODE_BRIDGE_BINARY_SOURCE = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const http = require('node:http');

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function readHealthStatus(url) {
  return new Promise((resolve) => {
    if (!url) {
      resolve(null);
      return;
    }
    const target = new URL(url);
    target.pathname = '/health';
    target.search = '';
    target.hash = '';
    const request = http.get(
      {
        host: target.hostname,
        port: Number(target.port),
        path: target.pathname,
        timeout: 750,
      },
      (response) => {
        response.resume();
        resolve(response.statusCode || null);
      }
    );
    request.once('timeout', () => {
      request.destroy();
      resolve(null);
    });
    request.once('error', () => resolve(null));
  });
}

async function main() {
  const inputPath = readArg('--input');
  if (!inputPath) {
    console.error('missing --input');
    process.exit(64);
  }

  const envelope = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const mcpUrl = process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL || null;
  const healthStatus = await readHealthStatus(mcpUrl);
  if (healthStatus !== 200) {
    console.error(
      JSON.stringify({
        kind: 'mcp_unreachable',
        mcpUrl,
        healthStatus,
      })
    );
    process.exit(7);
  }

  process.stdout.write(
    JSON.stringify({
      ok: true,
      schemaVersion: envelope.schemaVersion,
      requestId: envelope.requestId,
      command: envelope.command,
      completedAt: new Date().toISOString(),
      durationMs: 1,
      runtime: {
        providerId: 'opencode',
        binaryPath: process.argv[1],
        binaryFingerprint: 'fake-runtime',
        version: 'fake-opencode-bridge-e2e',
        capabilitySnapshotId: 'fake-capabilities',
      },
      diagnostics: [],
      data: {
        runId: envelope.body && envelope.body.runId ? envelope.body.runId : null,
        observedMcpUrl: mcpUrl,
        healthStatus,
      },
    }) + '\n'
  );
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
`;

const describePosix = process.platform === 'win32' ? describe.skip : describe;

async function allocateLoopbackPort(excluded: Set<number> = new Set<number>()): Promise<number> {
  while (true) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = net.createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') {
          server.close(() => reject(new Error('Failed to allocate test port')));
          return;
        }
        server.close(() => resolve(address.port));
      });
    });
    if (!excluded.has(port)) {
      excluded.add(port);
      return port;
    }
  }
}

async function readHealthStatus(url: string): Promise<number | null> {
  const target = new URL(url);
  target.pathname = '/health';
  target.search = '';
  target.hash = '';

  return new Promise((resolve) => {
    const request = http.get(
      {
        host: target.hostname,
        port: Number(target.port),
        path: target.pathname,
        timeout: 500,
      },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? null);
      }
    );
    request.once('timeout', () => {
      request.destroy();
      resolve(null);
    });
    request.once('error', () => resolve(null));
  });
}

async function waitForHealthDown(url: string): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5_000) {
    if ((await readHealthStatus(url)) !== 200) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Expected ${url} health endpoint to go down`);
}

async function writeFakeMcpHttpServer(tempDir: string): Promise<string> {
  const scriptDir = path.join(tempDir, 'fake-mcp');
  const scriptPath = path.join(scriptDir, 'server.cjs');
  await mkdir(scriptDir, { recursive: true });
  await writeFile(scriptPath, FAKE_MCP_HTTP_SERVER_SOURCE, 'utf8');
  return scriptPath;
}

async function writeFakeOpenCodeBridgeBinary(tempDir: string): Promise<string> {
  const scriptDir = path.join(tempDir, 'fake-runtime');
  const scriptPath = path.join(scriptDir, 'claude-multimodel-fake');
  await mkdir(scriptDir, { recursive: true });
  await writeFile(scriptPath, FAKE_OPENCODE_BRIDGE_BINARY_SOURCE, 'utf8');
  await chmod(scriptPath, 0o755);
  return scriptPath;
}

describe('packaged Agent Teams MCP launch integration', () => {
  let tempDir: string | null = null;
  let server: AgentTeamsMcpHttpServer | null = null;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'agent-teams-packaged-mcp-integration-'));
  });

  afterEach(async () => {
    await server?.stop();
    server = null;
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it('carries a packaged Electron MCP launch through runtime env into a healthy child', async () => {
    type ModuleLoad = (request: string, parent: NodeModule | undefined, isMain: boolean) => unknown;
    const moduleInternal = Module as unknown as { _load: ModuleLoad };
    const originalModuleLoad = moduleInternal._load;
    const originalExecPathDescriptor = Object.getOwnPropertyDescriptor(process, 'execPath');
    const originalResourcesPathDescriptor = Object.getOwnPropertyDescriptor(
      process,
      'resourcesPath'
    );
    const nodeBinary = process.execPath;
    const installDir = path.join(tempDir!, 'Program Files', 'Agent Teams AI');
    const resourcesDir = path.join(installDir, 'resources');
    const packagedServerDir = path.join(resourcesDir, 'mcp-server');
    const electronBinary = path.join(
      installDir,
      process.platform === 'win32' ? 'agent-teams-ai.exe' : 'agent-teams-ai'
    );
    const appDataDir = path.join(
      tempDir!,
      'Users',
      'Test User',
      'AppData',
      'Roaming',
      'agent-teams-ai'
    );

    await mkdir(packagedServerDir, { recursive: true });
    await writeFile(path.join(packagedServerDir, 'index.js'), FAKE_MCP_HTTP_SERVER_SOURCE, 'utf8');
    await writeFile(
      path.join(packagedServerDir, 'package.json'),
      JSON.stringify({ name: 'agent-teams-mcp-e2e', private: true }),
      'utf8'
    );
    try {
      await symlink(nodeBinary, electronBinary, 'file');
    } catch {
      try {
        await link(nodeBinary, electronBinary);
      } catch {
        await copyFile(nodeBinary, electronBinary);
      }
    }
    if (process.platform !== 'win32') {
      await chmod(electronBinary, 0o755);
    }

    try {
      moduleInternal._load = ((request, parent, isMain) => {
        if (request === 'electron') {
          return {
            app: {
              isPackaged: true,
              getVersion: () => '2.11.0-e2e',
            },
          };
        }
        return originalModuleLoad(request, parent, isMain);
      }) as ModuleLoad;
      Object.defineProperty(process, 'execPath', {
        value: electronBinary,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(process, 'resourcesPath', {
        value: resourcesDir,
        configurable: true,
        writable: true,
      });
      setAppDataBasePath(appDataDir);
      clearResolvedNodePathForTests();

      const entryOnlyEnv: NodeJS.ProcessEnv = {};
      await ensureAgentTeamsMcpLocalLaunchEnv(entryOnlyEnv, () =>
        Promise.reject(new Error('simulated full launch spec failure'))
      );
      const expectedEntry = path.join(appDataDir, 'mcp-server', '2.11.0-e2e', 'index.js');
      expect(entryOnlyEnv.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY).toBe(expectedEntry);
      expect(entryOnlyEnv.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND).toBeUndefined();
      expect(entryOnlyEnv.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ARGS_JSON).toBeUndefined();
      vi.mocked(console.warn).mockClear();

      server = new AgentTeamsMcpHttpServer({
        statePath: path.join(tempDir!, 'packaged-entry-fallback-mcp-http-state.json'),
        disableOrphanCleanup: true,
        resolveLaunchSpec: () =>
          Promise.resolve({
            command: nodeBinary,
            args: [expectedEntry],
          }),
      });
      const fallbackHandle = await server.ensureStarted();
      expect(fallbackHandle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
      expect(await readHealthStatus(fallbackHandle.url)).toBe(200);
      await server.stop();
      server = null;

      const serializedEnv: NodeJS.ProcessEnv = {};
      await ensureAgentTeamsMcpLocalLaunchEnv(serializedEnv);

      const command = serializedEnv.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND;
      const entry = serializedEnv.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY;
      const argsJson = serializedEnv.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ARGS_JSON;
      const childEnvJson = serializedEnv.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENV_JSON;
      expect(command).toBe(electronBinary);
      expect(entry).toBe(expectedEntry);
      expect(argsJson).toBeTruthy();
      expect(childEnvJson).toBeTruthy();
      if (!command || !entry || !argsJson || !childEnvJson) {
        throw new Error('Packaged MCP launch env was incomplete');
      }

      const args = JSON.parse(argsJson) as string[];
      const childEnv = JSON.parse(childEnvJson) as Record<string, string>;
      expect(args).toEqual([entry]);
      expect(childEnv).toEqual({ ELECTRON_RUN_AS_NODE: '1' });

      server = new AgentTeamsMcpHttpServer({
        statePath: path.join(tempDir!, 'packaged-env-mcp-http-state.json'),
        disableOrphanCleanup: true,
        resolveLaunchSpec: () =>
          Promise.resolve({
            command,
            args,
            env: childEnv,
          }),
      });

      const handle = await server.ensureStarted();
      expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
      expect(await readHealthStatus(handle.url)).toBe(200);
    } finally {
      clearResolvedNodePathForTests();
      setAppDataBasePath(null);
      moduleInternal._load = originalModuleLoad;
      if (originalExecPathDescriptor) {
        Object.defineProperty(process, 'execPath', originalExecPathDescriptor);
      }
      if (originalResourcesPathDescriptor) {
        Object.defineProperty(process, 'resourcesPath', originalResourcesPathDescriptor);
      } else {
        Reflect.deleteProperty(process, 'resourcesPath');
      }
    }
  });
});

describePosix('AgentTeamsMcpHttpServer integration', () => {
  let tempDir: string | null = null;
  let originalControlFileEnv: string | undefined;
  let originalMcpHttpPortEnv: string | undefined;
  const servers: AgentTeamsMcpHttpServer[] = [];

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'agent-teams-mcp-http-integration-'));
    originalControlFileEnv = process.env.AGENT_TEAMS_MCP_TEST_CONTROL_FILE;
    originalMcpHttpPortEnv = process.env.CLAUDE_TEAM_OPENCODE_MCP_HTTP_PORT;
  });

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.stop()));
    vi.mocked(console.warn).mockClear();
    if (originalControlFileEnv === undefined) {
      delete process.env.AGENT_TEAMS_MCP_TEST_CONTROL_FILE;
    } else {
      process.env.AGENT_TEAMS_MCP_TEST_CONTROL_FILE = originalControlFileEnv;
    }
    if (originalMcpHttpPortEnv === undefined) {
      delete process.env.CLAUDE_TEAM_OPENCODE_MCP_HTTP_PORT;
    } else {
      process.env.CLAUDE_TEAM_OPENCODE_MCP_HTTP_PORT = originalMcpHttpPortEnv;
    }
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  function createControlledServer(input: {
    scriptPath: string;
    controlFile: string;
    allocatePort?: () => Promise<number>;
    statePath?: string;
  }): AgentTeamsMcpHttpServer {
    const server = new AgentTeamsMcpHttpServer({
      statePath: input.statePath ?? path.join(tempDir!, `mcp-http-state-${servers.length}.json`),
      disableOrphanCleanup: true,
      resolveLaunchSpec: () =>
        Promise.resolve({
          command: process.execPath,
          args: [input.scriptPath],
        }),
      allocatePort: input.allocatePort,
    });
    servers.push(server);

    process.env.AGENT_TEAMS_MCP_TEST_CONTROL_FILE = input.controlFile;
    return server;
  }

  it('starts the actual Agent Teams MCP HTTP server and proves its health endpoint', async () => {
    const server = new AgentTeamsMcpHttpServer({
      statePath: path.join(tempDir!, 'actual-mcp-http-state.json'),
      disableOrphanCleanup: true,
    });
    servers.push(server);

    const handle = await server.ensureStarted();

    expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(handle.pid).toEqual(expect.any(Number));
    expect(await readHealthStatus(handle.url)).toBe(200);
  });

  it('reuses a healthy cached bridge URL after a real loopback health recheck', async () => {
    const scriptPath = await writeFakeMcpHttpServer(tempDir!);
    const controlFile = path.join(tempDir!, 'health-control.txt');
    await writeFile(controlFile, 'healthy', 'utf8');
    const server = createControlledServer({ scriptPath, controlFile });

    const first = await server.ensureStarted();
    const warnCountAfterFirstStart = vi.mocked(console.warn).mock.calls.length;
    const second = await server.ensureStarted();

    expect(second).toEqual(first);
    expect(await readHealthStatus(first.url)).toBe(200);
    expect(vi.mocked(console.warn).mock.calls.slice(warnCountAfterFirstStart)).toEqual([]);
  });

  it('adopts a healthy MCP HTTP child from persistent state across server managers', async () => {
    const scriptPath = await writeFakeMcpHttpServer(tempDir!);
    const controlFile = path.join(tempDir!, 'health-control.txt');
    const statePath = path.join(tempDir!, 'shared-mcp-http-state.json');
    await writeFile(controlFile, 'healthy', 'utf8');
    const firstServer = createControlledServer({ scriptPath, controlFile, statePath });

    const first = await firstServer.ensureStarted();
    const secondServer = createControlledServer({ scriptPath, controlFile, statePath });
    const second = await secondServer.ensureStarted();

    expect(second.port).toBe(first.port);
    expect(second.pid).toBe(first.pid);
    expect(second.diagnostics).toContain(`opencode_app_mcp_adopted_state_server:${first.port}`);
    expect(await readHealthStatus(second.url)).toBe(200);
  });

  it('falls back from an unknown healthy stable-port server and leaves it alive', async () => {
    const scriptPath = await writeFakeMcpHttpServer(tempDir!);
    const controlFile = path.join(tempDir!, 'health-control.txt');
    await writeFile(controlFile, 'healthy', 'utf8');

    let unknownServer: http.Server | null = null;
    let stablePort = 0;
    let fallbackPort = 0;
    for (let candidate = 43_100; candidate < 65_534; candidate += 1) {
      const stableCandidate = http.createServer((request, response) => {
        if (request.url === '/health') {
          response.writeHead(200, { 'content-type': 'text/plain' });
          response.end('unknown-ok');
          return;
        }
        response.writeHead(404);
        response.end('not found');
      });
      const fallbackProbe = net.createServer();
      try {
        await new Promise<void>((resolve, reject) => {
          stableCandidate.once('error', reject);
          stableCandidate.listen(candidate, '127.0.0.1', () => resolve());
        });
        await new Promise<void>((resolve, reject) => {
          fallbackProbe.once('error', reject);
          fallbackProbe.listen(candidate + 1, '127.0.0.1', () => resolve());
        });
        await new Promise<void>((resolve) => fallbackProbe.close(() => resolve()));
        unknownServer = stableCandidate;
        stablePort = candidate;
        fallbackPort = candidate + 1;
        break;
      } catch {
        await new Promise<void>((resolve) => fallbackProbe.close(() => resolve())).catch(
          () => undefined
        );
        await new Promise<void>((resolve) => stableCandidate.close(() => resolve())).catch(
          () => undefined
        );
      }
    }
    if (!unknownServer) {
      throw new Error('Failed to reserve contiguous ports for unknown stable-port test');
    }

    process.env.CLAUDE_TEAM_OPENCODE_MCP_HTTP_PORT = String(stablePort);
    const server = createControlledServer({ scriptPath, controlFile });

    try {
      const handle = await server.ensureStarted();

      expect(handle.port).toBe(fallbackPort);
      expect(handle.diagnostics).toContain(`opencode_app_mcp_port_occupied_unknown:${stablePort}`);
      expect(handle.diagnostics).toContain(
        `opencode_app_mcp_preferred_port_unavailable:${stablePort}`
      );
      expect(await readHealthStatus(`http://127.0.0.1:${stablePort}/mcp`)).toBe(200);
      expect(await readHealthStatus(handle.url)).toBe(200);
    } finally {
      await new Promise<void>((resolve) => unknownServer?.close(() => resolve()));
      vi.mocked(console.warn).mockClear();
    }
  });

  it('restarts a stale but still-running MCP HTTP child when cached URL health turns unhealthy', async () => {
    const scriptPath = await writeFakeMcpHttpServer(tempDir!);
    const controlFile = path.join(tempDir!, 'health-control.txt');
    const usedPorts = new Set<number>();
    await writeFile(controlFile, 'healthy', 'utf8');
    const server = createControlledServer({
      scriptPath,
      controlFile,
      allocatePort: () => allocateLoopbackPort(usedPorts),
    });

    const first = await server.ensureStarted();
    expect(first.pid).toEqual(expect.any(Number));
    await writeFile(controlFile, `unhealthy-pid:${first.pid}`, 'utf8');

    const second = await server.ensureStarted();

    expect(second.port).toBe(first.port);
    expect(second.url).toBe(first.url);
    expect(second.pid).not.toBe(first.pid);
    expect(await readHealthStatus(second.url)).toBe(200);
    expect(vi.mocked(console.warn).mock.calls[0]?.join(' ')).toContain('failed health reuse check');
    vi.mocked(console.warn).mockClear();
  });

  it('recovers when the cached MCP HTTP child dies and the old URL refuses connections', async () => {
    const scriptPath = await writeFakeMcpHttpServer(tempDir!);
    const controlFile = path.join(tempDir!, 'health-control.txt');
    const usedPorts = new Set<number>();
    await writeFile(controlFile, 'healthy', 'utf8');
    const server = createControlledServer({
      scriptPath,
      controlFile,
      allocatePort: () => allocateLoopbackPort(usedPorts),
    });

    const first = await server.ensureStarted();
    expect(first.pid).toEqual(expect.any(Number));
    process.kill(first.pid!, 'SIGTERM');
    await waitForHealthDown(first.url);

    const second = await server.ensureStarted();

    expect(second.port).not.toBe(first.port);
    expect(second.pid).not.toBe(first.pid);
    expect(await readHealthStatus(second.url)).toBe(200);
  });

  it('passes a refreshed healthy MCP URL into a real bridge child process after cached health goes stale', async () => {
    const scriptPath = await writeFakeMcpHttpServer(tempDir!);
    const bridgeBinaryPath = await writeFakeOpenCodeBridgeBinary(tempDir!);
    const controlFile = path.join(tempDir!, 'health-control.txt');
    const usedPorts = new Set<number>();
    await writeFile(controlFile, 'healthy', 'utf8');
    const server = createControlledServer({
      scriptPath,
      controlFile,
      allocatePort: () => allocateLoopbackPort(usedPorts),
    });
    const bridgeEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
    };
    let requestIdCounter = 0;
    const client = new OpenCodeBridgeCommandClient({
      binaryPath: bridgeBinaryPath,
      tempDirectory: path.join(tempDir!, 'bridge-input'),
      env: bridgeEnv,
      envProvider: async () => {
        const mcpHttpServer = await server.ensureStarted();
        bridgeEnv.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL = mcpHttpServer.url;
        return {
          ...bridgeEnv,
          CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL: mcpHttpServer.url,
        };
      },
      requestIdFactory: () => {
        requestIdCounter += 1;
        return `req-refresh-${requestIdCounter}`;
      },
    });

    const firstResult = await client.execute<{ runId: string }, { observedMcpUrl: string }>(
      'opencode.launchTeam',
      { runId: 'run-1' },
      {
        cwd: tempDir!,
        timeoutMs: 5_000,
      }
    );

    expect(firstResult.ok).toBe(true);
    if (!firstResult.ok) {
      throw new Error(firstResult.error.message);
    }
    const firstHandle = server.getCurrentHandle();
    expect(firstHandle?.pid).toEqual(expect.any(Number));
    await writeFile(controlFile, `unhealthy-pid:${firstHandle?.pid}`, 'utf8');

    const secondResult = await client.execute<{ runId: string }, { observedMcpUrl: string }>(
      'opencode.launchTeam',
      { runId: 'run-2' },
      {
        cwd: tempDir!,
        timeoutMs: 5_000,
      }
    );

    expect(secondResult.ok).toBe(true);
    if (!secondResult.ok) {
      throw new Error(secondResult.error.message);
    }
    expect(secondResult.data.observedMcpUrl).toBe(firstResult.data.observedMcpUrl);
    expect(await readHealthStatus(secondResult.data.observedMcpUrl)).toBe(200);
  });

  it('fails closed when a bridge child receives an unreachable MCP URL without env refresh', async () => {
    const scriptPath = await writeFakeMcpHttpServer(tempDir!);
    const bridgeBinaryPath = await writeFakeOpenCodeBridgeBinary(tempDir!);
    const controlFile = path.join(tempDir!, 'health-control.txt');
    await writeFile(controlFile, 'healthy', 'utf8');
    const server = createControlledServer({ scriptPath, controlFile });

    const first = await server.ensureStarted();
    await server.stop();
    await waitForHealthDown(first.url);

    const client = new OpenCodeBridgeCommandClient({
      binaryPath: bridgeBinaryPath,
      tempDirectory: path.join(tempDir!, 'bridge-input-stale'),
      env: {
        PATH: process.env.PATH,
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL: first.url,
      },
      requestIdFactory: () => 'req-stale-mcp',
    });

    const result = await client.execute<{ runId: string }, { observedMcpUrl: string }>(
      'opencode.launchTeam',
      { runId: 'run-stale' },
      {
        cwd: tempDir!,
        timeoutMs: 5_000,
      }
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('Expected stale MCP URL to fail');
    }
    expect(result.error.kind).toBe('provider_error');
    expect(result.error.details?.stderr).toContain('mcp_unreachable');
    expect(result.error.details?.stderr).toContain(first.url);
  });
});
