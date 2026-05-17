import { applyAgentTeamsIdentityEnv } from '@main/services/identity/AgentTeamsIdentityStore';
import { killProcessTree, spawnCli } from '@main/utils/childProcess';
import { getClaudeBasePath } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';
import { type ChildProcess } from 'child_process';
import http from 'http';
import net from 'net';

import { type McpLaunchSpec, resolveAgentTeamsMcpLaunchSpec } from './TeamMcpConfigBuilder';

const logger = createLogger('Service:AgentTeamsMcpHttpServer');
const MCP_HTTP_HOST = '127.0.0.1';
const MCP_HTTP_ENDPOINT = '/mcp';
const MCP_HTTP_READY_TIMEOUT_MS = 5_000;
const MCP_HTTP_READY_POLL_MS = 100;

export interface AgentTeamsMcpHttpServerHandle {
  url: string;
  port: number;
  pid: number | null;
}

export interface AgentTeamsMcpHttpServerDeps {
  resolveLaunchSpec?: () => Promise<McpLaunchSpec>;
  allocatePort?: () => Promise<number>;
  spawnProcess?: (command: string, args: string[], env: NodeJS.ProcessEnv) => ChildProcess;
  waitForPort?: (host: string, port: number, timeoutMs: number) => Promise<void>;
}

async function allocateLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, MCP_HTTP_HOST, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to allocate Agent Teams MCP HTTP port')));
        return;
      }

      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
  });
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function isHealthReady(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const request = http.get(
      {
        host,
        port,
        path: '/health',
        timeout: MCP_HTTP_READY_POLL_MS,
      },
      (response) => {
        response.resume();
        resolve((response.statusCode ?? 500) >= 200 && (response.statusCode ?? 500) < 300);
      }
    );
    request.once('timeout', () => {
      request.destroy();
      resolve(false);
    });
    request.once('error', () => {
      resolve(false);
    });
  });
}

async function waitForLoopbackPort(host: string, port: number, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await isHealthReady(host, port)) {
      return;
    }
    await sleep(MCP_HTTP_READY_POLL_MS);
  }
  throw new Error(
    `Agent Teams MCP HTTP server did not become healthy at ${host}:${port} in ${timeoutMs}ms`
  );
}

function defaultSpawnProcess(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv
): ChildProcess {
  return spawnCli(command, args, {
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
}

function buildHttpServerArgs(launchSpec: McpLaunchSpec, port: number): string[] {
  return [
    ...launchSpec.args,
    '--transport',
    'httpStream',
    '--host',
    MCP_HTTP_HOST,
    '--port',
    String(port),
    '--endpoint',
    MCP_HTTP_ENDPOINT,
  ];
}

export class AgentTeamsMcpHttpServer {
  private startPromise: Promise<AgentTeamsMcpHttpServerHandle> | null = null;
  private child: ChildProcess | null = null;
  private handle: AgentTeamsMcpHttpServerHandle | null = null;

  constructor(private readonly deps: AgentTeamsMcpHttpServerDeps = {}) {}

  async ensureStarted(): Promise<AgentTeamsMcpHttpServerHandle> {
    if (this.handle) {
      return this.handle;
    }
    if (this.startPromise) {
      return this.startPromise;
    }

    this.startPromise = this.startOnce().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.handle = null;
    if (child) {
      killProcessTree(child, 'SIGKILL');
    }
  }

  private async startOnce(): Promise<AgentTeamsMcpHttpServerHandle> {
    const resolveLaunchSpec = this.deps.resolveLaunchSpec ?? resolveAgentTeamsMcpLaunchSpec;
    const allocatePort = this.deps.allocatePort ?? allocateLoopbackPort;
    const spawnProcess = this.deps.spawnProcess ?? defaultSpawnProcess;
    const waitForPort = this.deps.waitForPort ?? waitForLoopbackPort;
    const launchSpec = await resolveLaunchSpec();
    const port = await allocatePort();
    const args = buildHttpServerArgs(launchSpec, port);
    const childEnv = applyAgentTeamsIdentityEnv({
      ...process.env,
      AGENT_TEAMS_MCP_CLAUDE_DIR: getClaudeBasePath(),
      AGENT_TEAMS_MCP_TRANSPORT: 'httpStream',
      AGENT_TEAMS_MCP_HTTP_HOST: MCP_HTTP_HOST,
      AGENT_TEAMS_MCP_HTTP_PORT: String(port),
      AGENT_TEAMS_MCP_HTTP_ENDPOINT: MCP_HTTP_ENDPOINT,
    });
    const child = spawnProcess(launchSpec.command, args, childEnv);

    const clearIfCurrent = (): void => {
      if (this.child === child) {
        this.child = null;
        this.handle = null;
      }
    };
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim();
      if (text) {
        logger.debug(`Agent Teams MCP HTTP stderr: ${text.slice(0, 1000)}`);
      }
    });
    this.child = child;

    let startupSettled = false;
    const startupFailure = new Promise<never>((_, reject) => {
      child.once('exit', (code, signal) => {
        clearIfCurrent();
        const codeSuffix = typeof code === 'number' ? ` with code ${code}` : '';
        const signalSuffix = signal ? ` (${signal})` : '';
        const message = `Agent Teams MCP HTTP server exited before startup completed${codeSuffix}${signalSuffix}`;
        if (!startupSettled) {
          reject(new Error(message));
        }
        logger.warn(message);
      });
      child.once('error', (error) => {
        clearIfCurrent();
        const message = `Agent Teams MCP HTTP server process error: ${
          error instanceof Error ? error.message : String(error)
        }`;
        if (!startupSettled) {
          reject(error instanceof Error ? error : new Error(message));
        }
        logger.warn(message);
      });
    });

    try {
      await Promise.race([
        waitForPort(MCP_HTTP_HOST, port, MCP_HTTP_READY_TIMEOUT_MS),
        startupFailure,
      ]);
      if (this.child !== child) {
        throw new Error('Agent Teams MCP HTTP server exited before startup completed');
      }
    } catch (error) {
      startupSettled = true;
      if (this.child === child) {
        this.child = null;
        this.handle = null;
      }
      killProcessTree(child, 'SIGKILL');
      throw error;
    }

    startupSettled = true;
    this.handle = {
      url: `http://${MCP_HTTP_HOST}:${port}${MCP_HTTP_ENDPOINT}`,
      port,
      pid: child.pid ?? null,
    };
    logger.info(`Agent Teams MCP HTTP server running at ${this.handle.url}`);
    return this.handle;
  }
}

export const agentTeamsMcpHttpServer = new AgentTeamsMcpHttpServer();
