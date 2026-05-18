import { applyAgentTeamsIdentityEnv } from '@main/services/identity/AgentTeamsIdentityStore';
import { killProcessTree, spawnCli } from '@main/utils/childProcess';
import { getClaudeBasePath } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';
import { type ChildProcess } from 'child_process';
import { createHash } from 'crypto';
import http from 'http';
import net from 'net';

import { type McpLaunchSpec, resolveAgentTeamsMcpLaunchSpec } from './TeamMcpConfigBuilder';

const logger = createLogger('Service:AgentTeamsMcpHttpServer');
const MCP_HTTP_HOST = '127.0.0.1';
const MCP_HTTP_ENDPOINT = '/mcp';
const MCP_HTTP_READY_TIMEOUT_MS = 5_000;
const MCP_HTTP_EXISTING_HANDLE_READY_TIMEOUT_MS = 3_000;
const MCP_HTTP_READY_POLL_MS = 100;
const MCP_HTTP_PORT_RELEASE_TIMEOUT_MS = 3_000;
const MCP_HTTP_STABLE_PORT_BASE = 43_100;
const MCP_HTTP_STABLE_PORT_SPAN = 700;
const MCP_HTTP_STABLE_PORT_SCAN_LIMIT = 20;
const MCP_HTTP_PORT_ENV = 'CLAUDE_TEAM_OPENCODE_MCP_HTTP_PORT';

export interface AgentTeamsMcpHttpTransportEvidence {
  schemaVersion: 1;
  transport: 'httpStream';
  host: string;
  port: number;
  endpoint: string;
  url: string;
  urlHash: string;
  generation: number;
  observedAt: string;
}

export interface AgentTeamsMcpHttpServerHandle {
  url: string;
  port: number;
  pid: number | null;
  generation: number;
  urlHash: string;
  transportEvidence: AgentTeamsMcpHttpTransportEvidence;
  diagnostics: string[];
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

async function canListenOnLoopbackPort(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => {
      resolve(false);
    });
    server.listen(port, host, () => {
      server.close(() => resolve(true));
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

async function waitForLoopbackPortAvailable(
  host: string,
  port: number,
  timeoutMs: number
): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await canListenOnLoopbackPort(host, port)) {
      return true;
    }
    await sleep(MCP_HTTP_READY_POLL_MS);
  }
  return await canListenOnLoopbackPort(host, port);
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

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function parseConfiguredStablePort(value: string | undefined): number | null {
  if (!value?.trim()) {
    return null;
  }
  const parsed = Number(value.trim());
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65_535) {
    logger.warn(`Ignoring invalid ${MCP_HTTP_PORT_ENV} value: ${value}`);
    return null;
  }
  return parsed;
}

function resolveDefaultStablePort(): number {
  const configured = parseConfiguredStablePort(process.env[MCP_HTTP_PORT_ENV]);
  if (configured) {
    return configured;
  }
  const basis = `${getClaudeBasePath()}|agent-teams-opencode-mcp-http`;
  const hashPrefix = sha256Hex(basis).slice(0, 8);
  const offset = Number.parseInt(hashPrefix, 16) % MCP_HTTP_STABLE_PORT_SPAN;
  return MCP_HTTP_STABLE_PORT_BASE + offset;
}

function buildTransportEvidence(
  port: number,
  generation: number
): AgentTeamsMcpHttpTransportEvidence {
  const url = `http://${MCP_HTTP_HOST}:${port}${MCP_HTTP_ENDPOINT}`;
  return {
    schemaVersion: 1,
    transport: 'httpStream',
    host: MCP_HTTP_HOST,
    port,
    endpoint: MCP_HTTP_ENDPOINT,
    url,
    urlHash: sha256Hex(url),
    generation,
    observedAt: new Date().toISOString(),
  };
}

export class AgentTeamsMcpHttpServer {
  private startPromise: Promise<AgentTeamsMcpHttpServerHandle> | null = null;
  private child: ChildProcess | null = null;
  private handle: AgentTeamsMcpHttpServerHandle | null = null;
  private generation = 0;
  private readonly expectedStopChildren = new WeakSet<ChildProcess>();

  constructor(private readonly deps: AgentTeamsMcpHttpServerDeps = {}) {}

  async ensureStarted(): Promise<AgentTeamsMcpHttpServerHandle> {
    if (this.startPromise) {
      return this.startPromise;
    }

    this.startPromise = (
      this.handle ? this.reuseOrRestartExistingHandle(this.handle) : this.startOnce()
    ).finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  async stop(): Promise<void> {
    const child = this.child;
    const releasePort = this.handle?.port ?? null;
    this.child = null;
    this.handle = null;
    if (child) {
      this.expectedStopChildren.add(child);
      killProcessTree(child, 'SIGKILL');
    }
    if (releasePort) {
      await waitForLoopbackPortAvailable(
        MCP_HTTP_HOST,
        releasePort,
        MCP_HTTP_PORT_RELEASE_TIMEOUT_MS
      );
    }
  }

  getCurrentHandle(): AgentTeamsMcpHttpServerHandle | null {
    return this.handle;
  }

  private async reuseOrRestartExistingHandle(
    handle: AgentTeamsMcpHttpServerHandle
  ): Promise<AgentTeamsMcpHttpServerHandle> {
    const waitForPort = this.deps.waitForPort ?? waitForLoopbackPort;
    try {
      await waitForPort(MCP_HTTP_HOST, handle.port, MCP_HTTP_EXISTING_HANDLE_READY_TIMEOUT_MS);
      if (this.handle === handle) {
        return handle;
      }
    } catch (error) {
      if (this.handle === handle) {
        logger.warn(
          `Agent Teams MCP HTTP server at ${handle.url} failed health reuse check, restarting: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        const restartPort = handle.port;
        const previousUrlHash = handle.urlHash;
        await this.stop();
        return this.startOnce({
          preferredPort: restartPort,
          previousUrlHash,
          reason: 'health_reuse_failed',
        });
      }
    }

    return this.startOnce();
  }

  private async resolveStartPort(preferredPort?: number | null): Promise<{
    port: number;
    diagnostics: string[];
  }> {
    const diagnostics: string[] = [];
    if (preferredPort && (await canListenOnLoopbackPort(MCP_HTTP_HOST, preferredPort))) {
      return { port: preferredPort, diagnostics };
    }
    if (preferredPort) {
      diagnostics.push(`opencode_app_mcp_preferred_port_unavailable:${preferredPort}`);
    }

    if (this.deps.allocatePort && (!preferredPort || diagnostics.length > 0)) {
      return { port: await this.deps.allocatePort(), diagnostics };
    }

    const stablePort = resolveDefaultStablePort();
    for (let offset = 0; offset < MCP_HTTP_STABLE_PORT_SCAN_LIMIT; offset += 1) {
      const candidate = stablePort + offset;
      if (candidate > 65_535) {
        break;
      }
      if (preferredPort === candidate) {
        continue;
      }
      if (await canListenOnLoopbackPort(MCP_HTTP_HOST, candidate)) {
        if (candidate !== stablePort) {
          diagnostics.push(`opencode_app_mcp_preferred_port_unavailable:${stablePort}`);
        }
        return { port: candidate, diagnostics };
      }
    }

    const allocatePort = this.deps.allocatePort ?? allocateLoopbackPort;
    const port = await allocatePort();
    diagnostics.push('opencode_app_mcp_stable_port_range_unavailable');
    return { port, diagnostics };
  }

  private async startOnce(
    input: {
      preferredPort?: number | null;
      previousUrlHash?: string | null;
      reason?: string;
    } = {}
  ): Promise<AgentTeamsMcpHttpServerHandle> {
    const resolveLaunchSpec = this.deps.resolveLaunchSpec ?? resolveAgentTeamsMcpLaunchSpec;
    const spawnProcess = this.deps.spawnProcess ?? defaultSpawnProcess;
    const waitForPort = this.deps.waitForPort ?? waitForLoopbackPort;
    const launchSpec = await resolveLaunchSpec();
    const selectedPort = await this.resolveStartPort(input.preferredPort ?? null);
    const port = selectedPort.port;
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
        const expectedStop = this.expectedStopChildren.delete(child);
        clearIfCurrent();
        const codeSuffix = typeof code === 'number' ? ` with code ${code}` : '';
        const signalSuffix = signal ? ` (${signal})` : '';
        const message = `Agent Teams MCP HTTP server exited before startup completed${codeSuffix}${signalSuffix}`;
        if (!startupSettled && !expectedStop) {
          reject(new Error(message));
          logger.warn(message);
          return;
        }
        if (startupSettled && !expectedStop) {
          logger.warn(
            `Agent Teams MCP HTTP server exited after startup${codeSuffix}${signalSuffix}`
          );
        }
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
      this.expectedStopChildren.add(child);
      killProcessTree(child, 'SIGKILL');
      throw error;
    }

    startupSettled = true;
    const generation = this.generation + 1;
    const transportEvidence = buildTransportEvidence(port, generation);
    this.generation = generation;
    const diagnostics = [...selectedPort.diagnostics];
    if (input.previousUrlHash && input.previousUrlHash !== transportEvidence.urlHash) {
      diagnostics.push('opencode_app_mcp_public_url_changed');
    }
    if (input.reason) {
      diagnostics.push(`opencode_app_mcp_restart_reason:${input.reason}`);
    }
    this.handle = {
      url: transportEvidence.url,
      port,
      pid: child.pid ?? null,
      generation,
      urlHash: transportEvidence.urlHash,
      transportEvidence,
      diagnostics,
    };
    logger.info(`Agent Teams MCP HTTP server running at ${this.handle.url}`);
    for (const diagnostic of diagnostics) {
      logger.warn(`Agent Teams MCP HTTP diagnostic: ${diagnostic}`);
    }
    return this.handle;
  }
}

export const agentTeamsMcpHttpServer = new AgentTeamsMcpHttpServer();

export function getCurrentAgentTeamsMcpHttpTransportEvidence(): AgentTeamsMcpHttpTransportEvidence | null {
  return agentTeamsMcpHttpServer.getCurrentHandle()?.transportEvidence ?? null;
}
