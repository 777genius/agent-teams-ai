import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { startWorkspaceGatewayNodeServer } from '@terminal-platform/workspace-gateway-node';

import type {
  TerminalWorkspaceBootstrap,
  TerminalWorkspaceBootstrapRequest,
} from '../../contracts';
import type { Logger } from '@shared/utils/logger';
import type { WorkspacePaneHistoryRequestOptions } from '@terminal-platform/workspace-contracts';
import type {
  WorkspaceGatewayNodeServerHandle,
  WorkspaceRuntimeClientPort,
} from '@terminal-platform/workspace-gateway-node';
import type { TerminalNodeClient as TerminalNodeClientInstance } from 'terminal-platform-node';

const READY_TIMEOUT_MS = 15_000;
const READY_POLL_MS = 200;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const TERMINAL_PLATFORM_ROOT_ENV = 'CLAUDE_TERMINAL_PLATFORM_ROOT';
const LEGACY_TERMINAL_PLATFORM_ROOT_ENV = 'TERMINAL_PLATFORM_ROOT';
const TERMINAL_DAEMON_BINARY_ENV = 'CLAUDE_TERMINAL_DAEMON_BINARY';
const BUNDLED_TERMINAL_PLATFORM_DIR_NAME = 'terminal-platform';
const TERMINAL_PLATFORM_NODE_PACKAGE_DIR_NAME = 'terminal-platform-node';
const TERMINAL_NODE_STUB_UNAVAILABLE_MESSAGE =
  'terminal-platform-node native runtime is not installed';

type TerminalDaemonChildProcess = ReturnType<typeof spawn>;

interface TerminalNodeClientConstructor {
  fromRuntimeSlug(runtimeSlug: string): TerminalNodeClientInstance;
}

interface TerminalNodeHandshakeInfo {
  handshake: Awaited<ReturnType<WorkspaceRuntimeClientPort['handshake']>>;
}

type TerminalNodeCreatedSession = Awaited<ReturnType<WorkspaceRuntimeClientPort['createSession']>>;

interface TerminalWorkspaceFeatureDeps {
  teamsBasePath: string;
  logger: Logger;
}

interface TerminalRuntimeRecord {
  runtimeSlug: string;
  teamName: string;
  projectPath: string | null;
  daemon: TeamTerminalDaemonSupervisor;
  gateway: WorkspaceGatewayNodeServerHandle;
}

let terminalNodeClientConstructorPromise: Promise<TerminalNodeClientConstructor> | null = null;

export interface TerminalWorkspaceFeatureFacade {
  getBootstrap(request: TerminalWorkspaceBootstrapRequest): Promise<TerminalWorkspaceBootstrap>;
  stopTeamRuntime(teamName: string): Promise<void>;
  dispose(): Promise<void>;
}

export function createTerminalWorkspaceFeature(
  deps: TerminalWorkspaceFeatureDeps
): TerminalWorkspaceFeatureFacade {
  const records = new Map<string, TerminalRuntimeRecord>();
  const pending = new Map<string, Promise<TerminalRuntimeRecord>>();
  const cancelledStarts = new WeakSet<Promise<TerminalRuntimeRecord>>();

  async function getBootstrap(
    request: TerminalWorkspaceBootstrapRequest
  ): Promise<TerminalWorkspaceBootstrap> {
    const key = request.teamName;
    const existing = records.get(key);
    if (existing) {
      return toBootstrap(existing);
    }

    let startPromise = pending.get(key);
    if (!startPromise) {
      startPromise = startRuntime(request, deps);
      pending.set(key, startPromise);
    }

    try {
      const record = await startPromise;
      if (cancelledStarts.has(startPromise)) {
        throw new Error('Terminal runtime start was cancelled');
      }
      records.set(key, record);
      return toBootstrap(record);
    } finally {
      if (pending.get(key) === startPromise) {
        pending.delete(key);
      }
    }
  }

  async function stopTeamRuntime(teamName: string): Promise<void> {
    const pendingStart = pending.get(teamName);
    if (pendingStart) {
      cancelledStarts.add(pendingStart);
      const record = await pendingStart;
      records.delete(teamName);
      await disposeRecord(record, deps.logger);
      if (pending.get(teamName) === pendingStart) {
        pending.delete(teamName);
      }
      return;
    }

    const record = records.get(teamName);
    if (!record) {
      return;
    }

    records.delete(teamName);
    await disposeRecord(record, deps.logger);
  }

  async function dispose(): Promise<void> {
    const pendingStarts = [...pending.values()];
    for (const pendingStart of pendingStarts) {
      cancelledStarts.add(pendingStart);
    }

    const allRecords = [
      ...records.values(),
      ...(await Promise.allSettled(pendingStarts)).flatMap((result) =>
        result.status === 'fulfilled' ? [result.value] : []
      ),
    ];
    records.clear();
    pending.clear();
    await Promise.allSettled(allRecords.map((record) => disposeRecord(record, deps.logger)));
  }

  return {
    getBootstrap,
    stopTeamRuntime,
    dispose,
  };
}

async function startRuntime(
  request: TerminalWorkspaceBootstrapRequest,
  deps: TerminalWorkspaceFeatureDeps
): Promise<TerminalRuntimeRecord> {
  const runtimeSlug = buildRuntimeSlug(request.teamName);
  const storeDir = path.join(deps.teamsBasePath, request.teamName, 'terminal-platform');
  const sessionStorePath = path.join(storeDir, 'session.sqlite');
  await fs.mkdir(storeDir, { recursive: true });

  const daemon = new TeamTerminalDaemonSupervisor({
    runtimeSlug,
    sessionStorePath,
    logger: deps.logger,
  });
  try {
    await daemon.ensureRunning();

    const TerminalNodeClient = await loadTerminalNodeClientConstructor();
    const client = TerminalNodeClient.fromRuntimeSlug(runtimeSlug);
    const projectPath = await resolveExistingDirectory(request.projectPath);
    await ensureInitialNativeSession(client, {
      title: request.teamDisplayName ?? request.teamName,
      cwd: projectPath,
    });

    const gateway = await startWorkspaceGatewayNodeServer({
      runtime: createRuntimeClientPort(client),
      logger: {
        warn: (message, context) => deps.logger.warn(message, context),
        error: (message, context) => deps.logger.error(message, context),
      },
    });

    return {
      runtimeSlug,
      teamName: request.teamName,
      projectPath,
      daemon,
      gateway,
    };
  } catch (error) {
    await daemon.dispose().catch((disposeError: unknown) => {
      deps.logger.warn('terminal workspace daemon cleanup failed after bootstrap error', {
        disposeError,
        error,
        runtimeSlug,
        teamName: request.teamName,
      });
    });
    throw error;
  }
}

function toBootstrap(record: TerminalRuntimeRecord): TerminalWorkspaceBootstrap {
  return {
    teamName: record.teamName,
    runtimeSlug: record.runtimeSlug,
    controlPlaneUrl: record.gateway.controlUrl,
    sessionStreamUrl: record.gateway.streamUrl,
    projectPath: record.projectPath,
    defaultShell: resolveDefaultShell(),
  };
}

async function disposeRecord(record: TerminalRuntimeRecord, logger: Logger): Promise<void> {
  const results = await Promise.allSettled([record.gateway.dispose(), record.daemon.dispose()]);
  for (const result of results) {
    if (result.status === 'rejected') {
      logger.warn('terminal workspace dispose failed', result.reason);
    }
  }
}

class TeamTerminalDaemonSupervisor {
  readonly #runtimeSlug: string;
  readonly #sessionStorePath: string;
  readonly #logger: Logger;
  #child: TerminalDaemonChildProcess | null = null;
  #ownsProcess = false;

  constructor(options: { runtimeSlug: string; sessionStorePath: string; logger: Logger }) {
    this.#runtimeSlug = options.runtimeSlug;
    this.#sessionStorePath = options.sessionStorePath;
    this.#logger = options.logger;
  }

  async ensureRunning(): Promise<void> {
    if (await this.isReady()) {
      return;
    }

    const daemonBinaryPath = await resolveDaemonBinaryPath();
    const child = spawn(
      daemonBinaryPath,
      ['--runtime-slug', this.#runtimeSlug, '--session-store', this.#sessionStorePath],
      {
        cwd: resolveDaemonWorkingDirectory(daemonBinaryPath),
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      }
    );
    this.#child = child;
    this.#ownsProcess = true;

    child.stdout?.on('data', (chunk: Buffer) => {
      this.#logger.info(`[terminal-daemon:${this.#runtimeSlug}] ${chunk.toString().trimEnd()}`);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      this.#logger.warn(`[terminal-daemon:${this.#runtimeSlug}] ${chunk.toString().trimEnd()}`);
    });

    await this.waitUntilReady();
  }

  async dispose(): Promise<void> {
    if (!this.#child || !this.#ownsProcess) {
      return;
    }

    const child = this.#child;
    this.#child = null;
    if (!isChildRunning(child)) {
      return;
    }

    const exited = new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
    });
    child.kill('SIGTERM');
    await Promise.race([exited, sleep(SHUTDOWN_TIMEOUT_MS)]);

    if (isChildRunning(child)) {
      child.kill('SIGKILL');
    }
  }

  private async waitUntilReady(): Promise<void> {
    const startedAt = Date.now();
    let lastError: unknown = null;

    while (Date.now() - startedAt < READY_TIMEOUT_MS) {
      if (this.#child && this.#child.exitCode !== null) {
        throw new Error(`terminal-daemon exited before ready with code ${this.#child.exitCode}`);
      }

      const readiness = await this.checkReadiness();
      if (readiness.ready) {
        return;
      }
      lastError = readiness.error;
      if (readiness.fatal) {
        throw readiness.error;
      }

      await sleep(READY_POLL_MS);
    }

    throw new Error(
      lastError instanceof Error
        ? `Timed out waiting for terminal-daemon: ${lastError.message}`
        : 'Timed out waiting for terminal-daemon'
    );
  }

  private async isReady(): Promise<boolean> {
    const readiness = await this.checkReadiness();
    if (readiness.fatal) {
      throw readiness.error;
    }
    return readiness.ready;
  }

  private async checkReadiness(): Promise<{
    error?: unknown;
    fatal: boolean;
    ready: boolean;
  }> {
    return probeTerminalNodeClientReadiness(loadTerminalNodeClientConstructor, this.#runtimeSlug);
  }
}

function isTerminalNodeStubUnavailableError(error: unknown): boolean {
  return (
    error instanceof Error &&
    typeof error.message === 'string' &&
    error.message.includes(TERMINAL_NODE_STUB_UNAVAILABLE_MESSAGE)
  );
}

function createTerminalNodeClientReadinessError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(
    `${message}. Set ${TERMINAL_PLATFORM_ROOT_ENV} to a built terminal-platform checkout, stage bundled resources/terminal-platform for production builds, or keep a built ../terminal-platform sibling checkout for local development.`
  );
}

function isFatalTerminalNodeReadinessError(error: unknown): boolean {
  return isTerminalNodeStubUnavailableError(error);
}

async function probeTerminalNodeClientReadiness(
  loadClient: () => Promise<TerminalNodeClientConstructor>,
  runtimeSlug: string
): Promise<{
  error?: unknown;
  fatal: boolean;
  ready: boolean;
}> {
  try {
    const TerminalNodeClient = await loadClient();
    const client = TerminalNodeClient.fromRuntimeSlug(runtimeSlug);
    await client.handshakeInfo();
    await client.close().catch(() => undefined);
    return { fatal: false, ready: true };
  } catch (error) {
    if (isFatalTerminalNodeReadinessError(error)) {
      return {
        error: createTerminalNodeClientReadinessError(error),
        fatal: true,
        ready: false,
      };
    }
    return { error, fatal: false, ready: false };
  }
}

async function ensureInitialNativeSession(
  client: TerminalNodeClientInstance,
  input: { title: string; cwd: string | null }
): Promise<void> {
  const sessions = await client.listSessions();
  if (sessions.length > 0) {
    return;
  }

  await client.createNativeSession({
    title: input.title,
    launch: {
      program: resolveDefaultShell(),
      args: [],
      cwd: input.cwd,
    },
  });
}

function createRuntimeClientPort(client: TerminalNodeClientInstance): WorkspaceRuntimeClientPort {
  return {
    async handshake() {
      return ((await client.handshakeInfo()) as TerminalNodeHandshakeInfo).handshake;
    },
    listSessions: () => client.listSessions(),
    listSavedSessions: () => client.listSavedSessions(),
    listCommandHistory: (sessionId, limit) =>
      client.commandHistory(sessionId ?? null, limit ?? null),
    getPaneHistory: (
      sessionId: string,
      paneId: string,
      options?: WorkspacePaneHistoryRequestOptions
    ) =>
      client.paneHistory(
        sessionId,
        paneId,
        toNullableSafeInteger(options?.fromEventSeq, 'pane history fromEventSeq'),
        toNullableSafeInteger(options?.maxSegments, 'pane history maxSegments'),
        toNullableSafeInteger(options?.maxBytes, 'pane history maxBytes')
      ),
    discoverSessions: (backend) => client.discoverSessions(backend),
    getBackendCapabilities: (backend) => client.backendCapabilities(backend),
    async createSession(backend, request) {
      if (backend !== 'native') {
        throw new Error(`Unsupported terminal backend ${backend}`);
      }
      return (await client.createNativeSession(request)) as TerminalNodeCreatedSession;
    },
    importSession: (route, title) => client.importSession(route, title ?? null),
    getSavedSession: (sessionId) => client.savedSession(sessionId),
    deleteSavedSession: (sessionId) => client.deleteSavedSession(sessionId),
    pruneSavedSessions: (keepLatest) => client.pruneSavedSessions(keepLatest),
    restoreSavedSession: (sessionId) => client.restoreSavedSession(sessionId),
    attachSession: (sessionId) => client.attachSession(sessionId),
    getTopologySnapshot: (sessionId) => client.topologySnapshot(sessionId),
    getScreenSnapshot: (sessionId, paneId) => client.screenSnapshot(sessionId, paneId),
    getScreenDelta: (sessionId, paneId, fromSequence) => {
      if (fromSequence > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error('screen delta sequence exceeds native client safe integer range');
      }
      return client.screenDelta(sessionId, paneId, Number(fromSequence));
    },
    dispatchMuxCommand: (sessionId, command) => client.dispatchMuxCommand(sessionId, command),
    async openSubscription(sessionId, spec) {
      const subscription = await client.openSubscription(sessionId, spec);
      return {
        meta: () => ({
          subscription_id: subscription.subscriptionId,
        }),
        nextEvent: () => subscription.nextEvent(),
        close: () => subscription.close(),
      };
    },
    async close() {
      await client.close().catch(() => undefined);
    },
  };
}

function toNullableSafeInteger(
  value: bigint | number | null | undefined,
  label: string
): number | null {
  if (value == null) {
    return null;
  }

  if (typeof value === 'bigint') {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new Error(`${label} exceeds native client safe integer range`);
    }
    return Number(value);
  }

  if (!Number.isSafeInteger(value)) {
    throw new Error(`${label} must be a safe integer`);
  }

  return value;
}

function buildRuntimeSlug(teamName: string): string {
  return `agent-teams-terminal-${createHash('sha256').update(teamName).digest('hex').slice(0, 16)}`;
}

async function loadTerminalNodeClientConstructor(): Promise<TerminalNodeClientConstructor> {
  terminalNodeClientConstructorPromise ??= importTerminalNodeClientConstructor();
  return terminalNodeClientConstructorPromise;
}

async function importTerminalNodeClientConstructor(): Promise<TerminalNodeClientConstructor> {
  const specifier = resolveTerminalNodePackageSpecifier();
  const module = (await import(specifier)) as {
    TerminalNodeClient?: TerminalNodeClientConstructor;
    default?: { TerminalNodeClient?: TerminalNodeClientConstructor };
  };
  const TerminalNodeClient = module.TerminalNodeClient ?? module.default?.TerminalNodeClient;
  if (!TerminalNodeClient) {
    throw new Error(`terminal-platform-node did not export TerminalNodeClient from ${specifier}`);
  }
  return TerminalNodeClient;
}

function resolveTerminalNodePackageSpecifier(): string {
  const localPackagePath = resolveTerminalNodeLocalPackagePath();
  if (localPackagePath) {
    return pathToFileURL(localPackagePath).href;
  }

  return 'terminal-platform-node';
}

function resolveTerminalNodeLocalPackagePath(): string | null {
  const explicitRoot = resolveExplicitTerminalPlatformRoot();
  if (explicitRoot) {
    const explicitCandidate = path.join(
      explicitRoot,
      'crates',
      'terminal-node-napi',
      'package',
      'artifacts',
      'local',
      'index.mjs'
    );
    return fsSync.existsSync(explicitCandidate) ? explicitCandidate : null;
  }

  const bundledRoot = resolveBundledTerminalPlatformRoot();
  if (bundledRoot) {
    const bundledCandidate = path.join(
      bundledRoot,
      TERMINAL_PLATFORM_NODE_PACKAGE_DIR_NAME,
      'index.mjs'
    );
    if (fsSync.existsSync(bundledCandidate)) {
      return bundledCandidate;
    }
  }

  const checkoutCandidate = path.join(
    resolveDefaultTerminalPlatformCheckoutRoot(),
    'crates',
    'terminal-node-napi',
    'package',
    'artifacts',
    'local',
    'index.mjs'
  );
  return fsSync.existsSync(checkoutCandidate) ? checkoutCandidate : null;
}

async function resolveExistingDirectory(value: string | null | undefined): Promise<string | null> {
  const candidate = value?.trim();
  if (!candidate) {
    return null;
  }

  try {
    const stat = await fs.stat(candidate);
    return stat.isDirectory() ? candidate : null;
  } catch {
    return null;
  }
}

async function resolveDaemonBinaryPath(): Promise<string> {
  const explicit = process.env[TERMINAL_DAEMON_BINARY_ENV]?.trim();
  if (explicit) {
    await assertExecutableExists(explicit, TERMINAL_DAEMON_BINARY_ENV);
    return explicit;
  }

  const explicitRoot = resolveExplicitTerminalPlatformRoot();
  if (explicitRoot) {
    const explicitRootBinaryPath = path.join(explicitRoot, 'target', 'debug', daemonBinaryName());
    await assertExecutableExists(explicitRootBinaryPath, TERMINAL_PLATFORM_ROOT_ENV);
    return explicitRootBinaryPath;
  }

  const bundledRoot = resolveBundledTerminalPlatformRoot();
  if (bundledRoot) {
    const bundledBinaryPath = path.join(bundledRoot, daemonBinaryName());
    if (await fileExists(bundledBinaryPath)) {
      return bundledBinaryPath;
    }
  }

  const checkoutBinaryPath = path.join(
    resolveDefaultTerminalPlatformCheckoutRoot(),
    'target',
    'debug',
    daemonBinaryName()
  );
  if (await fileExists(checkoutBinaryPath)) {
    return checkoutBinaryPath;
  }

  throw new Error(
    `terminal-daemon binary not found. Set ${TERMINAL_DAEMON_BINARY_ENV}, set ${TERMINAL_PLATFORM_ROOT_ENV} to a built terminal-platform checkout, or stage bundled resources/terminal-platform.`
  );
}

async function assertExecutableExists(binaryPath: string, source: string): Promise<void> {
  try {
    await fs.access(binaryPath);
  } catch {
    throw new Error(
      `terminal-daemon binary not found at ${binaryPath}. Build terminal-platform or update ${source}.`
    );
  }
}

async function fileExists(value: string): Promise<boolean> {
  try {
    const stat = await fs.stat(value);
    return stat.isFile();
  } catch {
    return false;
  }
}

function resolveDaemonWorkingDirectory(binaryPath: string): string {
  const bundledRoot = resolveBundledTerminalPlatformRoot();
  if (bundledRoot && isPathInside(binaryPath, bundledRoot)) {
    return bundledRoot;
  }

  const explicitRoot = resolveExplicitTerminalPlatformRoot();
  if (explicitRoot) {
    return explicitRoot;
  }

  const checkoutRoot = resolveDefaultTerminalPlatformCheckoutRoot();
  if (isPathInside(binaryPath, checkoutRoot)) {
    return checkoutRoot;
  }

  return path.dirname(binaryPath);
}

function resolveBundledTerminalPlatformRoot(): string | null {
  const candidates = [
    process.resourcesPath
      ? path.join(process.resourcesPath, BUNDLED_TERMINAL_PLATFORM_DIR_NAME)
      : null,
    path.join(process.cwd(), 'resources', BUNDLED_TERMINAL_PLATFORM_DIR_NAME),
  ];

  for (const candidate of candidates) {
    if (candidate && fsSync.existsSync(candidate) && fsSync.statSync(candidate).isDirectory()) {
      return candidate;
    }
  }

  return null;
}

function resolveDefaultTerminalPlatformCheckoutRoot(): string {
  return path.resolve(process.cwd(), '../terminal-platform');
}

function resolveExplicitTerminalPlatformRoot(): string | null {
  const explicit =
    process.env[TERMINAL_PLATFORM_ROOT_ENV]?.trim() ||
    process.env[LEGACY_TERMINAL_PLATFORM_ROOT_ENV]?.trim();
  return explicit ? path.resolve(explicit) : null;
}

function daemonBinaryName(): string {
  return process.platform === 'win32' ? 'terminal-daemon.exe' : 'terminal-daemon';
}

function isPathInside(value: string, parent: string): boolean {
  const relative = path.relative(parent, value);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveDefaultShell(): string {
  if (process.platform === 'win32') {
    return process.env.COMSPEC || 'powershell.exe';
  }
  return process.env.SHELL || '/bin/bash';
}

function isChildRunning(child: TerminalDaemonChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const terminalWorkspaceFeatureTestInternals = {
  createTerminalNodeClientReadinessError,
  isTerminalNodeStubUnavailableError,
  probeTerminalNodeClientReadiness,
  resolveBundledTerminalPlatformRoot,
  resolveDaemonBinaryPath,
  resolveTerminalNodePackageSpecifier,
};
