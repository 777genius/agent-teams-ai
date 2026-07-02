import { type ChildProcess, execFile, type ExecFileException } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import * as path from 'node:path';

import { type RuntimeProcessTableRow } from '@features/tmux-installer/main';
import { applyAgentTeamsIdentityEnv } from '@main/services/identity/AgentTeamsIdentityStore';
import { atomicWriteAsync } from '@main/utils/atomicWrite';
import { killProcessTree, spawnCli, untrackCliProcess } from '@main/utils/childProcess';
import { ensureMinimumNodeOldSpaceEnv } from '@main/utils/nodeOptions';
import { getAppDataPath, getClaudeBasePath } from '@main/utils/pathDecoder';
import { killProcessByPid } from '@main/utils/processKill';
import { createLogger } from '@shared/utils/logger';

import { type FileLockOptions, withFileLock } from './fileLock';
import { type McpLaunchSpec, resolveAgentTeamsMcpLaunchSpec } from './TeamMcpConfigBuilder';

const logger = createLogger('Service:AgentTeamsMcpHttpServer');
const MCP_HTTP_HOST = '127.0.0.1';
const MCP_HTTP_ENDPOINT = '/mcp';
const MCP_HTTP_READY_TIMEOUT_MS = 60_000;
const MCP_HTTP_EXISTING_HANDLE_READY_TIMEOUT_MS = 3_000;
const MCP_HTTP_READY_POLL_MS = 100;
const MCP_HTTP_PORT_RELEASE_TIMEOUT_MS = 3_000;
const MCP_HTTP_STABLE_PORT_BASE = 43_100;
const MCP_HTTP_STABLE_PORT_SPAN = 700;
const MCP_HTTP_STABLE_PORT_SCAN_LIMIT = 20;
const MCP_HTTP_PORT_ENV = 'CLAUDE_TEAM_OPENCODE_MCP_HTTP_PORT';
const MCP_HTTP_HEALTH_BODY_MAX_BYTES = 8 * 1024;
const MCP_HTTP_IDENTITY_SERVICE = 'agent-teams-mcp-http';
const MCP_HTTP_IDENTITY_SERVICE_ENV = 'AGENT_TEAMS_MCP_HTTP_IDENTITY_SERVICE';
const MCP_HTTP_CLAUDE_DIR_HASH_ENV = 'AGENT_TEAMS_MCP_HTTP_CLAUDE_DIR_HASH';
const MCP_HTTP_LAUNCH_SPEC_HASH_ENV = 'AGENT_TEAMS_MCP_HTTP_LAUNCH_SPEC_HASH';
const MCP_HTTP_OWNER_INSTANCE_ID_ENV = 'AGENT_TEAMS_MCP_HTTP_OWNER_INSTANCE_ID';
const MCP_HTTP_STATE_DIR = 'mcp-http-server';
const MCP_HTTP_STATE_FILE = 'state.json';
const MCP_HTTP_STATE_LOCK_OPTIONS: FileLockOptions = {
  acquireTimeoutMs: 5_000,
  staleTimeoutMs: 30_000,
  retryIntervalMs: 25,
};
const MCP_HTTP_CLEANUP_DISABLED_ENV = 'CLAUDE_TEAM_DISABLE_MCP_ORPHAN_CLEANUP';
const MCP_HTTP_ORPHAN_TERMINATE_GRACE_MS = 250;

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

export interface AgentTeamsMcpHttpIdentity {
  schemaVersion: 1;
  service: typeof MCP_HTTP_IDENTITY_SERVICE;
  transport: 'httpStream';
  host: string;
  port: number;
  endpoint: string;
  claudeDirHash: string;
  launchSpecHash: string;
  ownerInstanceId: string;
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

export interface AgentTeamsMcpHttpHealthProbe {
  healthy: boolean;
  statusCode: number | null;
  identity: AgentTeamsMcpHttpIdentity | null;
}

export interface AgentTeamsMcpHttpServerDeps {
  resolveLaunchSpec?: () => Promise<McpLaunchSpec>;
  allocatePort?: () => Promise<number>;
  spawnProcess?: (command: string, args: string[], env: NodeJS.ProcessEnv) => ChildProcess;
  waitForPort?: (host: string, port: number, timeoutMs: number) => Promise<void>;
  probeHealth?: (host: string, port: number) => Promise<AgentTeamsMcpHttpHealthProbe>;
  canListenOnPort?: (host: string, port: number) => Promise<boolean>;
  statePath?: string | null;
  withStateLock?: <T>(
    filePath: string,
    fn: () => Promise<T>,
    options?: FileLockOptions
  ) => Promise<T>;
  disableOrphanCleanup?: boolean;
  listProcessRows?: () => Promise<RuntimeProcessTableRow[]>;
  readProcessDetails?: (pid: number) => Promise<string | null>;
  readProcessStartTimeMs?: (pid: number) => Promise<number | null>;
  killProcess?: (pid: number) => void;
  forceKillProcess?: (pid: number) => void;
  isProcessAlive?: (pid: number) => boolean;
  sleepMs?: (ms: number) => Promise<void>;
}

interface AgentTeamsMcpExpectedHttpIdentity {
  service: typeof MCP_HTTP_IDENTITY_SERVICE;
  transport: 'httpStream';
  host: string;
  endpoint: string;
  claudeDirHash: string;
  launchSpecHash: string;
  ownerInstanceId: string;
}

interface AgentTeamsMcpHttpState {
  schemaVersion: 1;
  service: typeof MCP_HTTP_IDENTITY_SERVICE;
  transport: 'httpStream';
  host: string;
  port: number;
  endpoint: string;
  url: string;
  urlHash: string;
  pid: number | null;
  claudeDirHash: string;
  launchSpecHash: string;
  ownerInstanceId: string;
  startedAt: string;
  updatedAt: string;
}

type PortClassification =
  | { kind: 'available' }
  | { kind: 'owned'; identity: AgentTeamsMcpHttpIdentity }
  | { kind: 'occupied_unknown'; healthy: boolean };

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
      try {
        server.close(() => resolve(false));
      } catch {
        resolve(false);
      }
    });
    server.listen(port, host, () => {
      server.close(() => resolve(true));
    });
  });
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function asPort(value: unknown): number | null {
  return Number.isInteger(value) && Number(value) > 0 && Number(value) <= 65_535
    ? Number(value)
    : null;
}

function asPositiveInteger(value: unknown): number | null {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function parseHealthIdentity(raw: string): AgentTeamsMcpHttpIdentity | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{')) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!isRecord(parsed)) {
      return null;
    }

    const service = parsed.service;
    const transport = parsed.transport;
    const host = asString(parsed.host);
    const port = asPort(parsed.port);
    const endpoint = asString(parsed.endpoint);
    const claudeDirHash = asString(parsed.claudeDirHash);
    const launchSpecHash = asString(parsed.launchSpecHash);
    const ownerInstanceId = asString(parsed.ownerInstanceId);
    if (
      parsed.schemaVersion !== 1 ||
      service !== MCP_HTTP_IDENTITY_SERVICE ||
      transport !== 'httpStream' ||
      !host ||
      port === null ||
      !endpoint ||
      !claudeDirHash ||
      !launchSpecHash ||
      !ownerInstanceId
    ) {
      return null;
    }

    return {
      schemaVersion: 1,
      service: MCP_HTTP_IDENTITY_SERVICE,
      transport: 'httpStream',
      host,
      port,
      endpoint,
      claudeDirHash,
      launchSpecHash,
      ownerInstanceId,
    };
  } catch {
    return null;
  }
}

async function probeLoopbackHealth(
  host: string,
  port: number
): Promise<AgentTeamsMcpHttpHealthProbe> {
  return new Promise((resolve) => {
    let settled = false;
    let body = '';
    const finish = (probe: AgentTeamsMcpHttpHealthProbe): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(probe);
    };

    const request = http.get(
      {
        host,
        port,
        path: '/health',
        timeout: MCP_HTTP_READY_POLL_MS,
      },
      (response) => {
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          if (body.length >= MCP_HTTP_HEALTH_BODY_MAX_BYTES) {
            return;
          }
          body += chunk.slice(0, MCP_HTTP_HEALTH_BODY_MAX_BYTES - body.length);
        });
        response.on('end', () => {
          const statusCode = response.statusCode ?? null;
          const healthy = statusCode !== null && statusCode >= 200 && statusCode < 300;
          finish({
            healthy,
            statusCode,
            identity: healthy ? parseHealthIdentity(body) : null,
          });
        });
      }
    );
    request.once('timeout', () => {
      request.destroy();
      finish({ healthy: false, statusCode: null, identity: null });
    });
    request.once('error', () => {
      finish({ healthy: false, statusCode: null, identity: null });
    });
  });
}

async function waitForLoopbackPort(host: string, port: number, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if ((await probeLoopbackHealth(host, port)).healthy) {
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
  const child = spawnCli(command, args, {
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  untrackCliProcess(child);
  return child;
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

function buildStatePath(): string {
  return path.join(getAppDataPath(), MCP_HTTP_STATE_DIR, MCP_HTTP_STATE_FILE);
}

function buildLaunchSpecHash(launchSpec: McpLaunchSpec): string {
  const env = launchSpec.env
    ? Object.fromEntries(
        Object.entries(launchSpec.env).sort(([left], [right]) => left.localeCompare(right))
      )
    : {};
  return sha256Hex(JSON.stringify({ command: launchSpec.command, args: launchSpec.args, env }));
}

function buildExpectedIdentity(
  launchSpec: McpLaunchSpec,
  ownerInstanceId: string
): AgentTeamsMcpExpectedHttpIdentity {
  return {
    service: MCP_HTTP_IDENTITY_SERVICE,
    transport: 'httpStream',
    host: MCP_HTTP_HOST,
    endpoint: MCP_HTTP_ENDPOINT,
    claudeDirHash: sha256Hex(getClaudeBasePath()),
    launchSpecHash: buildLaunchSpecHash(launchSpec),
    ownerInstanceId,
  };
}

function identityMatchesExpected(
  identity: AgentTeamsMcpHttpIdentity,
  expected: AgentTeamsMcpExpectedHttpIdentity,
  port?: number
): boolean {
  return (
    identity.service === expected.service &&
    identity.transport === expected.transport &&
    identity.host === expected.host &&
    identity.endpoint === expected.endpoint &&
    identity.claudeDirHash === expected.claudeDirHash &&
    identity.launchSpecHash === expected.launchSpecHash &&
    (port === undefined || identity.port === port)
  );
}

function buildState(
  handle: AgentTeamsMcpHttpServerHandle,
  identity: AgentTeamsMcpHttpIdentity,
  pid: number | null,
  startedAt: string
): AgentTeamsMcpHttpState {
  return {
    schemaVersion: 1,
    service: MCP_HTTP_IDENTITY_SERVICE,
    transport: 'httpStream',
    host: MCP_HTTP_HOST,
    port: handle.port,
    endpoint: MCP_HTTP_ENDPOINT,
    url: handle.url,
    urlHash: handle.urlHash,
    pid,
    claudeDirHash: identity.claudeDirHash,
    launchSpecHash: identity.launchSpecHash,
    ownerInstanceId: identity.ownerInstanceId,
    startedAt,
    updatedAt: new Date().toISOString(),
  };
}

function parseState(raw: string): AgentTeamsMcpHttpState | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return null;
    }

    const host = asString(parsed.host);
    const port = asPort(parsed.port);
    const endpoint = asString(parsed.endpoint);
    const url = asString(parsed.url);
    const urlHash = asString(parsed.urlHash);
    const pid = parsed.pid === null ? null : asPositiveInteger(parsed.pid);
    const claudeDirHash = asString(parsed.claudeDirHash);
    const launchSpecHash = asString(parsed.launchSpecHash);
    const ownerInstanceId = asString(parsed.ownerInstanceId);
    const startedAt = asString(parsed.startedAt);
    const updatedAt = asString(parsed.updatedAt);
    if (
      parsed.schemaVersion !== 1 ||
      parsed.service !== MCP_HTTP_IDENTITY_SERVICE ||
      parsed.transport !== 'httpStream' ||
      !host ||
      port === null ||
      !endpoint ||
      !url ||
      !urlHash ||
      (pid === null && parsed.pid !== null) ||
      !claudeDirHash ||
      !launchSpecHash ||
      !ownerInstanceId ||
      !startedAt ||
      !updatedAt
    ) {
      return null;
    }

    return {
      schemaVersion: 1,
      service: MCP_HTTP_IDENTITY_SERVICE,
      transport: 'httpStream',
      host,
      port,
      endpoint,
      url,
      urlHash,
      pid,
      claudeDirHash,
      launchSpecHash,
      ownerInstanceId,
      startedAt,
      updatedAt,
    };
  } catch {
    return null;
  }
}

function stateMatchesExpected(
  state: AgentTeamsMcpHttpState,
  expected: AgentTeamsMcpExpectedHttpIdentity
): boolean {
  return (
    state.service === expected.service &&
    state.transport === expected.transport &&
    state.host === expected.host &&
    state.endpoint === expected.endpoint &&
    state.url === `http://${MCP_HTTP_HOST}:${state.port}${MCP_HTTP_ENDPOINT}` &&
    state.urlHash === sha256Hex(state.url) &&
    state.claudeDirHash === expected.claudeDirHash &&
    state.launchSpecHash === expected.launchSpecHash
  );
}

function isFileLockTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('File lock timeout:');
}

function diagnostic(message: string, diagnostics: string[]): void {
  diagnostics.push(message);
}

function emitDiagnostics(diagnostics: readonly string[]): void {
  for (const item of diagnostics) {
    logger.warn(`Agent Teams MCP HTTP diagnostic: ${item}`);
  }
}

function parseCommandArg(command: string, flag: string): string | null {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\s)${escaped}(?:=|\\s+)(?:"([^"]+)"|'([^']+)'|(\\S+))`).exec(
    command
  );
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

function parseCommandPort(command: string): number | null {
  const raw = parseCommandArg(command, '--port');
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : null;
}

function commandArgEquals(command: string, flag: string, expected: string): boolean {
  return parseCommandArg(command, flag) === expected;
}

function isMcpHttpServerCommand(command: string): boolean {
  const normalized = command.trim();
  return (
    /mcp-server[/\\](?:src[/\\]index\.ts|dist[/\\]index\.js|index\.js)(?=\s|$)/.test(normalized) &&
    commandArgEquals(normalized, '--transport', 'httpStream') &&
    commandArgEquals(normalized, '--host', MCP_HTTP_HOST) &&
    commandArgEquals(normalized, '--endpoint', MCP_HTTP_ENDPOINT) &&
    parseCommandPort(normalized) !== null
  );
}

function processDetailsIncludeMarker(details: string, marker: string): boolean {
  return new RegExp(`(^|\\s)${marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$)`).test(
    details
  );
}

function hasManagedMcpDetails(details: string, port: number): boolean {
  return (
    processDetailsIncludeMarker(details, 'AGENT_TEAMS_MCP_TRANSPORT=httpStream') &&
    processDetailsIncludeMarker(details, `AGENT_TEAMS_MCP_HTTP_HOST=${MCP_HTTP_HOST}`) &&
    processDetailsIncludeMarker(details, `AGENT_TEAMS_MCP_HTTP_PORT=${port}`) &&
    processDetailsIncludeMarker(details, `AGENT_TEAMS_MCP_HTTP_ENDPOINT=${MCP_HTTP_ENDPOINT}`) &&
    processDetailsIncludeMarker(details, `AGENT_TEAMS_MCP_CLAUDE_DIR=${getClaudeBasePath()}`)
  );
}

function isNativeProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function readNativeProcessCommandWithEnv(pid: number): Promise<string | null> {
  return execFileText('ps', ['eww', '-p', String(pid), '-o', 'command='], 2_000, 2 * 1024 * 1024);
}

async function readNativeProcessStartTimeMs(pid: number): Promise<number | null> {
  const output = await execFileText('ps', ['-p', String(pid), '-o', 'lstart='], 2_000, 64 * 1024);
  if (!output) {
    return null;
  }
  const parsed = Date.parse(output.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function parseNativeProcessRows(output: string): RuntimeProcessTableRow[] {
  const rows: RuntimeProcessTableRow[] = [];
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) {
      continue;
    }
    const pid = Number.parseInt(match[1], 10);
    const ppid = Number.parseInt(match[2], 10);
    const command = match[3]?.trim() ?? '';
    if (pid > 0 && ppid >= 0 && command.length > 0) {
      rows.push({ pid, ppid, command });
    }
  }
  return rows;
}

async function listNativeProcessRows(): Promise<RuntimeProcessTableRow[]> {
  if (process.platform === 'win32') {
    return [];
  }
  const output = await execFileText(
    'ps',
    ['-ax', '-o', 'pid=,ppid=,command='],
    2_000,
    4 * 1024 * 1024
  );
  return output ? parseNativeProcessRows(output) : [];
}

function execFileText(
  command: string,
  args: string[],
  timeout: number,
  maxBuffer: number
): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        encoding: 'utf8',
        timeout,
        maxBuffer,
        windowsHide: true,
      },
      (error: ExecFileException | null, stdout: string | Buffer) => {
        if (error) {
          resolve(null);
          return;
        }
        resolve(String(stdout));
      }
    );
  });
}

export class AgentTeamsMcpHttpServer {
  private startPromise: Promise<AgentTeamsMcpHttpServerHandle> | null = null;
  private child: ChildProcess | null = null;
  private handle: AgentTeamsMcpHttpServerHandle | null = null;
  private generation = 0;
  private readonly expectedStopChildren = new WeakSet<ChildProcess>();
  private readonly ownerInstanceId = randomUUID();
  private readonly startedAtMs = Date.now();
  private preventFutureStarts = false;

  constructor(private readonly deps: AgentTeamsMcpHttpServerDeps = {}) {}

  async ensureStarted(): Promise<AgentTeamsMcpHttpServerHandle> {
    this.throwIfStartsPrevented();
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

  async stop(input: { preventRestart?: boolean } = {}): Promise<void> {
    if (input.preventRestart) {
      this.preventFutureStarts = true;
    }
    const child = this.child;
    const handle = this.handle;
    const releasePort = child ? (handle?.port ?? null) : null;
    this.child = null;
    this.handle = null;
    if (child) {
      this.expectedStopChildren.add(child);
      killProcessTree(child, 'SIGKILL');
      if (handle) {
        await this.clearStateForOwnedHandle(handle);
      }
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

  private resolveStatePath(): string | null {
    if (this.deps.statePath === null) {
      return null;
    }
    return this.deps.statePath ?? buildStatePath();
  }

  private throwIfStartsPrevented(): void {
    if (this.preventFutureStarts) {
      throw new Error('Agent Teams MCP HTTP server startup is disabled during shutdown');
    }
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

  private async readStateSafe(
    statePath: string,
    diagnostics: string[]
  ): Promise<AgentTeamsMcpHttpState | null> {
    try {
      const raw = await fs.promises.readFile(statePath, 'utf8');
      const parsed = parseState(raw);
      if (!parsed) {
        diagnostic('opencode_app_mcp_state_ignored:parse_failed', diagnostics);
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        diagnostic('opencode_app_mcp_state_ignored:read_failed', diagnostics);
      }
      return null;
    }
  }

  private async writeStateSafe(
    statePath: string | null,
    state: AgentTeamsMcpHttpState,
    diagnostics: string[]
  ): Promise<void> {
    if (!statePath) {
      return;
    }
    try {
      await atomicWriteAsync(statePath, `${JSON.stringify(state, null, 2)}\n`);
    } catch {
      diagnostic('opencode_app_mcp_state_ignored:write_failed', diagnostics);
    }
  }

  private async clearStateForOwnedHandle(handle: AgentTeamsMcpHttpServerHandle): Promise<void> {
    const statePath = this.resolveStatePath();
    if (!statePath) {
      return;
    }
    const lock = this.deps.withStateLock ?? withFileLock;
    try {
      await lock(
        statePath,
        async () => {
          const diagnostics: string[] = [];
          const state = await this.readStateSafe(statePath, diagnostics);
          if (
            state &&
            state.port === handle.port &&
            state.urlHash === handle.urlHash &&
            state.ownerInstanceId === this.ownerInstanceId
          ) {
            await fs.promises.rm(statePath, { force: true });
          }
        },
        MCP_HTTP_STATE_LOCK_OPTIONS
      );
    } catch {
      logger.warn('Agent Teams MCP HTTP diagnostic: opencode_app_mcp_state_ignored:clear_failed');
    }
  }

  private async classifyPort(
    port: number,
    expectedIdentity: AgentTeamsMcpExpectedHttpIdentity
  ): Promise<PortClassification> {
    const canListen = this.deps.canListenOnPort ?? canListenOnLoopbackPort;
    if (await canListen(MCP_HTTP_HOST, port)) {
      return { kind: 'available' };
    }

    const probeHealth = this.deps.probeHealth ?? probeLoopbackHealth;
    const probe = await probeHealth(MCP_HTTP_HOST, port);
    if (
      probe.healthy &&
      probe.identity &&
      identityMatchesExpected(probe.identity, expectedIdentity, port)
    ) {
      return { kind: 'owned', identity: probe.identity };
    }

    return { kind: 'occupied_unknown', healthy: probe.healthy };
  }

  private async tryAdoptStateHandle(
    statePath: string,
    expectedIdentity: AgentTeamsMcpExpectedHttpIdentity,
    diagnostics: string[]
  ): Promise<AgentTeamsMcpHttpServerHandle | null> {
    const state = await this.readStateSafe(statePath, diagnostics);
    if (!state) {
      return null;
    }
    if (!stateMatchesExpected(state, expectedIdentity)) {
      diagnostic('opencode_app_mcp_state_ignored:identity_mismatch', diagnostics);
      return null;
    }

    const probeHealth = this.deps.probeHealth ?? probeLoopbackHealth;
    const probe = await probeHealth(MCP_HTTP_HOST, state.port);
    if (!probe.healthy) {
      diagnostic('opencode_app_mcp_state_ignored:unhealthy', diagnostics);
      return null;
    }
    if (!probe.identity || !identityMatchesExpected(probe.identity, expectedIdentity, state.port)) {
      diagnostic('opencode_app_mcp_state_ignored:identity_mismatch', diagnostics);
      return null;
    }

    return this.adoptHandle({
      identity: probe.identity,
      pid: state.pid,
      diagnostics,
      diagnosticMessage: `opencode_app_mcp_adopted_state_server:${state.port}`,
      statePath,
    });
  }

  private async tryAdoptPortHandle(
    port: number,
    expectedIdentity: AgentTeamsMcpExpectedHttpIdentity,
    statePath: string | null,
    diagnostics: string[]
  ): Promise<AgentTeamsMcpHttpServerHandle | null> {
    const classification = await this.classifyPort(port, expectedIdentity);
    if (classification.kind === 'available') {
      return null;
    }
    if (classification.kind === 'owned') {
      return this.adoptHandle({
        identity: classification.identity,
        pid: null,
        diagnostics,
        diagnosticMessage: `opencode_app_mcp_adopted_port_server:${port}`,
        statePath,
      });
    }
    diagnostic(`opencode_app_mcp_port_occupied_unknown:${port}`, diagnostics);
    return null;
  }

  private async adoptHandle(input: {
    identity: AgentTeamsMcpHttpIdentity;
    pid: number | null;
    diagnostics: string[];
    diagnosticMessage: string;
    statePath: string | null;
  }): Promise<AgentTeamsMcpHttpServerHandle> {
    diagnostic(input.diagnosticMessage, input.diagnostics);
    const generation = this.generation + 1;
    const transportEvidence = buildTransportEvidence(input.identity.port, generation);
    this.generation = generation;
    this.child = null;
    this.handle = {
      url: transportEvidence.url,
      port: input.identity.port,
      pid: input.pid,
      generation,
      urlHash: transportEvidence.urlHash,
      transportEvidence,
      diagnostics: input.diagnostics,
    };
    await this.writeStateSafe(
      input.statePath,
      buildState(this.handle, input.identity, input.pid, new Date().toISOString()),
      input.diagnostics
    );
    logger.info(`Agent Teams MCP HTTP server adopted at ${this.handle.url}`);
    emitDiagnostics(input.diagnostics);
    this.scheduleOrphanCleanup(input.identity, this.handle);
    return this.handle;
  }

  private async resolveStartTarget(
    preferredPort: number | null | undefined,
    expectedIdentity: AgentTeamsMcpExpectedHttpIdentity,
    statePath: string | null,
    diagnostics: string[]
  ): Promise<
    { kind: 'port'; port: number } | { kind: 'handle'; handle: AgentTeamsMcpHttpServerHandle }
  > {
    const canListen = this.deps.canListenOnPort ?? canListenOnLoopbackPort;
    if (preferredPort) {
      if (await canListen(MCP_HTTP_HOST, preferredPort)) {
        return { kind: 'port', port: preferredPort };
      }
      const adopted = await this.tryAdoptPortHandle(
        preferredPort,
        expectedIdentity,
        statePath,
        diagnostics
      );
      if (adopted) {
        return { kind: 'handle', handle: adopted };
      }
      diagnostic(`opencode_app_mcp_preferred_port_unavailable:${preferredPort}`, diagnostics);
    }

    if (this.deps.allocatePort && (!preferredPort || diagnostics.length > 0)) {
      return { kind: 'port', port: await this.deps.allocatePort() };
    }

    const stablePort = resolveDefaultStablePort();
    let stablePortUnavailable = false;
    for (let offset = 0; offset < MCP_HTTP_STABLE_PORT_SCAN_LIMIT; offset += 1) {
      const candidate = stablePort + offset;
      if (candidate > 65_535) {
        break;
      }
      if (preferredPort === candidate) {
        continue;
      }
      const classification = await this.classifyPort(candidate, expectedIdentity);
      if (classification.kind === 'available') {
        if (candidate !== stablePort || stablePortUnavailable) {
          diagnostic(`opencode_app_mcp_preferred_port_unavailable:${stablePort}`, diagnostics);
        }
        return { kind: 'port', port: candidate };
      }
      if (classification.kind === 'owned') {
        return {
          kind: 'handle',
          handle: await this.adoptHandle({
            identity: classification.identity,
            pid: null,
            diagnostics,
            diagnosticMessage: `opencode_app_mcp_adopted_port_server:${candidate}`,
            statePath,
          }),
        };
      }
      stablePortUnavailable = stablePortUnavailable || candidate === stablePort;
      diagnostic(`opencode_app_mcp_port_occupied_unknown:${candidate}`, diagnostics);
    }

    const allocatePort = this.deps.allocatePort ?? allocateLoopbackPort;
    const port = await allocatePort();
    diagnostic('opencode_app_mcp_stable_port_range_unavailable', diagnostics);
    return { kind: 'port', port };
  }

  private async startOnce(
    input: {
      preferredPort?: number | null;
      previousUrlHash?: string | null;
      reason?: string;
    } = {}
  ): Promise<AgentTeamsMcpHttpServerHandle> {
    this.throwIfStartsPrevented();
    const resolveLaunchSpec = this.deps.resolveLaunchSpec ?? resolveAgentTeamsMcpLaunchSpec;
    const launchSpec = await resolveLaunchSpec();
    this.throwIfStartsPrevented();
    const expectedIdentity = buildExpectedIdentity(launchSpec, this.ownerInstanceId);
    const statePath = this.resolveStatePath();
    const startUnlocked = async (effectiveStatePath: string | null, diagnostics: string[]) =>
      this.startOnceUnlocked(input, launchSpec, expectedIdentity, effectiveStatePath, diagnostics);

    if (!statePath) {
      return startUnlocked(null, []);
    }

    const lock = this.deps.withStateLock ?? withFileLock;
    try {
      return await lock(statePath, () => startUnlocked(statePath, []), MCP_HTTP_STATE_LOCK_OPTIONS);
    } catch (error) {
      if (!isFileLockTimeoutError(error)) {
        throw error;
      }
      const diagnostics = ['opencode_app_mcp_state_ignored:lock_failed'];
      return startUnlocked(null, diagnostics);
    }
  }

  private async startOnceUnlocked(
    input: {
      preferredPort?: number | null;
      previousUrlHash?: string | null;
      reason?: string;
    },
    launchSpec: McpLaunchSpec,
    expectedIdentity: AgentTeamsMcpExpectedHttpIdentity,
    statePath: string | null,
    initialDiagnostics: string[]
  ): Promise<AgentTeamsMcpHttpServerHandle> {
    const diagnostics = [...initialDiagnostics];
    const spawnProcess = this.deps.spawnProcess ?? defaultSpawnProcess;
    const waitForPort = this.deps.waitForPort ?? waitForLoopbackPort;
    this.throwIfStartsPrevented();

    if (statePath) {
      const adopted = await this.tryAdoptStateHandle(statePath, expectedIdentity, diagnostics);
      if (adopted) {
        return adopted;
      }
    }

    const selectedTarget = await this.resolveStartTarget(
      input.preferredPort ?? null,
      expectedIdentity,
      statePath,
      diagnostics
    );
    this.throwIfStartsPrevented();
    if (selectedTarget.kind === 'handle') {
      return selectedTarget.handle;
    }

    const port = selectedTarget.port;
    const args = buildHttpServerArgs(launchSpec, port);
    const childIdentity: AgentTeamsMcpHttpIdentity = {
      schemaVersion: 1,
      service: MCP_HTTP_IDENTITY_SERVICE,
      transport: 'httpStream',
      host: MCP_HTTP_HOST,
      port,
      endpoint: MCP_HTTP_ENDPOINT,
      claudeDirHash: expectedIdentity.claudeDirHash,
      launchSpecHash: expectedIdentity.launchSpecHash,
      ownerInstanceId: expectedIdentity.ownerInstanceId,
    };
    const childEnv = applyAgentTeamsIdentityEnv({
      ...process.env,
      ...launchSpec.env,
      AGENT_TEAMS_MCP_CLAUDE_DIR: getClaudeBasePath(),
      AGENT_TEAMS_MCP_TRANSPORT: 'httpStream',
      AGENT_TEAMS_MCP_HTTP_HOST: MCP_HTTP_HOST,
      AGENT_TEAMS_MCP_HTTP_PORT: String(port),
      AGENT_TEAMS_MCP_HTTP_ENDPOINT: MCP_HTTP_ENDPOINT,
      [MCP_HTTP_IDENTITY_SERVICE_ENV]: MCP_HTTP_IDENTITY_SERVICE,
      [MCP_HTTP_CLAUDE_DIR_HASH_ENV]: expectedIdentity.claudeDirHash,
      [MCP_HTTP_LAUNCH_SPEC_HASH_ENV]: expectedIdentity.launchSpecHash,
      [MCP_HTTP_OWNER_INSTANCE_ID_ENV]: expectedIdentity.ownerInstanceId,
    });
    ensureMinimumNodeOldSpaceEnv(childEnv);
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
    if (input.previousUrlHash && input.previousUrlHash !== transportEvidence.urlHash) {
      diagnostic('opencode_app_mcp_public_url_changed', diagnostics);
    }
    if (input.reason) {
      diagnostic(`opencode_app_mcp_restart_reason:${input.reason}`, diagnostics);
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
    await this.writeStateSafe(
      statePath,
      buildState(this.handle, childIdentity, child.pid ?? null, new Date().toISOString()),
      diagnostics
    );
    logger.info(`Agent Teams MCP HTTP server running at ${this.handle.url}`);
    emitDiagnostics(diagnostics);
    this.scheduleOrphanCleanup(childIdentity, this.handle);
    return this.handle;
  }

  private scheduleOrphanCleanup(
    expectedIdentity: AgentTeamsMcpHttpIdentity,
    currentHandle: AgentTeamsMcpHttpServerHandle
  ): void {
    if (
      this.deps.disableOrphanCleanup ||
      this.resolveStatePath() === null ||
      process.env[MCP_HTTP_CLEANUP_DISABLED_ENV] === '1'
    ) {
      return;
    }

    void this.tryCleanupOwnedOrphans(expectedIdentity, currentHandle).catch(() => {
      logger.warn('Agent Teams MCP HTTP diagnostic: opencode_app_mcp_orphan_cleanup_failed');
    });
  }

  private async tryCleanupOwnedOrphans(
    expectedIdentity: AgentTeamsMcpHttpIdentity,
    currentHandle: AgentTeamsMcpHttpServerHandle
  ): Promise<void> {
    const listRows = this.deps.listProcessRows ?? listNativeProcessRows;
    const readDetails =
      this.deps.readProcessDetails ??
      (process.platform === 'win32' ? async () => null : readNativeProcessCommandWithEnv);
    const readStartTimeMs =
      this.deps.readProcessStartTimeMs ??
      (process.platform === 'win32' ? async () => null : readNativeProcessStartTimeMs);
    const killProcess = this.deps.killProcess ?? killProcessByPid;
    const forceKillProcess =
      this.deps.forceKillProcess ?? ((pid: number) => process.kill(pid, 'SIGKILL'));
    const isProcessAlive = this.deps.isProcessAlive ?? isNativeProcessAlive;
    const sleepMs = this.deps.sleepMs ?? sleep;
    const probeHealth = this.deps.probeHealth ?? probeLoopbackHealth;

    const rows = await listRows();
    for (const row of rows) {
      if (row.pid === currentHandle.pid || row.pid === process.pid) {
        continue;
      }
      if (!isMcpHttpServerCommand(row.command)) {
        continue;
      }
      const port = parseCommandPort(row.command);
      if (!port || port === currentHandle.port) {
        continue;
      }

      const parentMayStillOwnProcess =
        process.platform === 'win32' ? row.ppid > 0 && isProcessAlive(row.ppid) : row.ppid !== 1;
      if (parentMayStillOwnProcess) {
        continue;
      }

      const startedAtMs = await readStartTimeMs(row.pid);
      if (
        !Number.isFinite(startedAtMs) ||
        startedAtMs === null ||
        startedAtMs >= this.startedAtMs
      ) {
        continue;
      }

      const details = await readDetails(row.pid);
      if (!details || !hasManagedMcpDetails(details, port)) {
        continue;
      }

      const probe = await probeHealth(MCP_HTTP_HOST, port);
      const hasMatchingIdentity =
        probe.identity !== null && identityMatchesExpected(probe.identity, expectedIdentity, port);
      if (probe.identity && !hasMatchingIdentity) {
        continue;
      }

      const ownedPids = await this.collectOwnedMcpProcessTreePids(rows, row.pid, port, readDetails);
      const ownedPidSet = new Set(ownedPids);

      if (await this.hasLiveMcpConsumers(rows, ownedPidSet, port, readDetails)) {
        this.recordCleanupDiagnostic(
          currentHandle,
          `opencode_app_mcp_legacy_orphan_kept_live_consumers:${port}`
        );
        continue;
      }

      try {
        let cleanupFailed = false;
        for (const pid of [...ownedPids].reverse()) {
          if (!isProcessAlive(pid)) {
            continue;
          }
          try {
            killProcess(pid);
          } catch {
            cleanupFailed = cleanupFailed || isProcessAlive(pid);
          }
        }
        await sleepMs(MCP_HTTP_ORPHAN_TERMINATE_GRACE_MS);
        for (const pid of [...ownedPids].reverse()) {
          if (!isProcessAlive(pid)) {
            continue;
          }
          try {
            forceKillProcess(pid);
          } catch {
            cleanupFailed = true;
          }
        }
        if (ownedPids.some((pid) => isProcessAlive(pid))) {
          cleanupFailed = true;
        }
        if (cleanupFailed) {
          this.recordCleanupDiagnostic(
            currentHandle,
            `opencode_app_mcp_state_ignored:cleanup_failed`
          );
          continue;
        }
        this.recordCleanupDiagnostic(
          currentHandle,
          `opencode_app_mcp_legacy_orphan_cleaned:${port}`
        );
      } catch {
        this.recordCleanupDiagnostic(
          currentHandle,
          `opencode_app_mcp_state_ignored:cleanup_failed`
        );
      }
    }
  }

  private async collectOwnedMcpProcessTreePids(
    rows: readonly RuntimeProcessTableRow[],
    rootPid: number,
    port: number,
    readDetails: (pid: number) => Promise<string | null>
  ): Promise<number[]> {
    const ownedPids = [rootPid];
    const visited = new Set(ownedPids);
    for (const parentPid of ownedPids) {
      for (const row of rows) {
        if (row.ppid !== parentPid || visited.has(row.pid)) {
          continue;
        }
        if (!isMcpHttpServerCommand(row.command) || parseCommandPort(row.command) !== port) {
          continue;
        }
        const details = await readDetails(row.pid);
        if (!details || !hasManagedMcpDetails(details, port)) {
          continue;
        }
        visited.add(row.pid);
        ownedPids.push(row.pid);
      }
    }
    return ownedPids;
  }

  private async hasLiveMcpConsumers(
    rows: readonly RuntimeProcessTableRow[],
    candidatePids: ReadonlySet<number>,
    port: number,
    readDetails: (pid: number) => Promise<string | null>
  ): Promise<boolean> {
    const url = `http://${MCP_HTTP_HOST}:${port}${MCP_HTTP_ENDPOINT}`;
    const urlHash = sha256Hex(url);
    for (const row of rows) {
      if (candidatePids.has(row.pid)) {
        continue;
      }
      const details = (await readDetails(row.pid)) ?? row.command;
      if (
        processDetailsIncludeMarker(details, `CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL=${url}`) ||
        processDetailsIncludeMarker(
          details,
          `CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL_HASH=${urlHash}`
        )
      ) {
        return true;
      }
    }
    return false;
  }

  private recordCleanupDiagnostic(
    handle: AgentTeamsMcpHttpServerHandle,
    diagnosticMessage: string
  ): void {
    handle.diagnostics.push(diagnosticMessage);
    logger.warn(`Agent Teams MCP HTTP diagnostic: ${diagnosticMessage}`);
  }
}

export const agentTeamsMcpHttpServer = new AgentTeamsMcpHttpServer();

export function getCurrentAgentTeamsMcpHttpTransportEvidence(): AgentTeamsMcpHttpTransportEvidence | null {
  return agentTeamsMcpHttpServer.getCurrentHandle()?.transportEvidence ?? null;
}
