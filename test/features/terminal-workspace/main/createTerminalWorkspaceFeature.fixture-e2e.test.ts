// @vitest-environment node
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const compositionFixture = vi.hoisted(() => ({
  children: [] as FakeChildProcess[],
  clients: [] as FakeTerminalClient[],
  gatewayHandles: [] as FakeGatewayHandle[],
  gatewayStartDeferred: null as Deferred<FakeGatewayHandle> | null,
  sessionsBySlug: new Map<string, FakeSession[]>(),
  spawnedSlugs: new Set<string>(),
  spawn: vi.fn(),
  startWorkspaceGatewayNodeServer: vi.fn(),
}));

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    spawn: (...args: unknown[]) => compositionFixture.spawn(...args),
  };
});

vi.mock('@terminal-platform/workspace-gateway-node', () => ({
  startWorkspaceGatewayNodeServer: (...args: unknown[]) =>
    compositionFixture.startWorkspaceGatewayNodeServer(...args),
}));

vi.mock('terminal-platform-node', () => ({
  TerminalNodeClient: {
    fromRuntimeSlug: (runtimeSlug: string) => createFakeTerminalClient(runtimeSlug),
  },
}));

import {
  createTerminalWorkspaceFeature,
  terminalWorkspaceFeatureTestInternals,
} from '@features/terminal-workspace/main/composition/createTerminalWorkspaceFeature';

import type { Logger } from '@shared/utils/logger';

describe('terminal workspace feature composition fixture-e2e', () => {
  let tempRoot: string;
  let teamsBasePath: string;
  let sandboxProjectPath: string;
  let daemonBinaryPath: string;
  let logger: Pick<Logger, 'info' | 'warn' | 'error'>;
  let originalShell: string | undefined;
  let originalDaemonBinary: string | undefined;
  let originalTerminalPlatformRoot: string | undefined;
  let originalLegacyTerminalPlatformRoot: string | undefined;
  let originalProcessResourcesPath: string | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    compositionFixture.children.length = 0;
    compositionFixture.clients.length = 0;
    compositionFixture.gatewayHandles.length = 0;
    compositionFixture.gatewayStartDeferred = null;
    compositionFixture.sessionsBySlug.clear();
    compositionFixture.spawnedSlugs.clear();

    originalShell = process.env.SHELL;
    originalDaemonBinary = process.env.CLAUDE_TERMINAL_DAEMON_BINARY;
    originalTerminalPlatformRoot = process.env.CLAUDE_TERMINAL_PLATFORM_ROOT;
    originalLegacyTerminalPlatformRoot = process.env.TERMINAL_PLATFORM_ROOT;
    originalProcessResourcesPath = processWithResourcesPath().resourcesPath;

    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'terminal-workspace-feature-'));
    teamsBasePath = path.join(tempRoot, 'teams');
    sandboxProjectPath = path.join(tempRoot, 'sandbox-project');
    daemonBinaryPath = path.join(tempRoot, 'terminal-daemon');
    await fs.mkdir(teamsBasePath, { recursive: true });
    await fs.mkdir(sandboxProjectPath, { recursive: true });
    await fs.writeFile(daemonBinaryPath, '#!/bin/sh\n');
    process.env.CLAUDE_TERMINAL_DAEMON_BINARY = daemonBinaryPath;
    process.env.CLAUDE_TERMINAL_PLATFORM_ROOT = path.join(tempRoot, 'missing-terminal-platform');
    delete process.env.TERMINAL_PLATFORM_ROOT;
    process.env.SHELL = '/bin/zsh';

    compositionFixture.spawn.mockImplementation((_command: string, args: string[]) => {
      const runtimeSlug = readRuntimeSlug(args);
      compositionFixture.spawnedSlugs.add(runtimeSlug);
      const child = createFakeChildProcess(runtimeSlug);
      compositionFixture.children.push(child);
      return child;
    });
    compositionFixture.startWorkspaceGatewayNodeServer.mockImplementation(() => {
      const handle = createGatewayHandle(compositionFixture.gatewayHandles.length + 1);
      compositionFixture.gatewayHandles.push(handle);
      const deferred = compositionFixture.gatewayStartDeferred;
      if (!deferred) {
        return Promise.resolve(handle);
      }
      deferred.resolve(handle);
      compositionFixture.gatewayStartDeferred = null;
      return deferred.promise;
    });

    logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
    restoreEnv('SHELL', originalShell);
    restoreEnv('CLAUDE_TERMINAL_DAEMON_BINARY', originalDaemonBinary);
    restoreEnv('CLAUDE_TERMINAL_PLATFORM_ROOT', originalTerminalPlatformRoot);
    restoreEnv('TERMINAL_PLATFORM_ROOT', originalLegacyTerminalPlatformRoot);
    restoreProcessResourcesPath(originalProcessResourcesPath);
  });

  it('bootstraps a team daemon, native session, and gateway without touching real projects', async () => {
    const feature = createTerminalWorkspaceFeature({ teamsBasePath, logger: logger as Logger });

    const bootstrap = await feature.getBootstrap({
      projectPath: sandboxProjectPath,
      teamDisplayName: 'Terminal Fixture',
      teamName: 'terminal-fixture',
    });

    expect(bootstrap).toMatchObject({
      controlPlaneUrl: 'ws://fixture-control-1',
      defaultShell: '/bin/zsh',
      projectPath: sandboxProjectPath,
      sessionStreamUrl: 'ws://fixture-stream-1',
      teamName: 'terminal-fixture',
    });
    expect(bootstrap.runtimeSlug).toMatch(/^agent-teams-terminal-[a-f0-9]{16}$/u);
    expect(compositionFixture.spawn).toHaveBeenCalledWith(
      daemonBinaryPath,
      [
        '--runtime-slug',
        bootstrap.runtimeSlug,
        '--session-store',
        path.join(teamsBasePath, 'terminal-fixture', 'terminal-platform', 'session.sqlite'),
      ],
      expect.objectContaining({
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    );
    expect(getCreateNativeSessionCalls(bootstrap.runtimeSlug)).toContainEqual({
      title: 'Terminal Fixture',
      launch: {
        args: [],
        cwd: sandboxProjectPath,
        program: '/bin/zsh',
      },
    });
    expect(compositionFixture.startWorkspaceGatewayNodeServer).toHaveBeenCalledTimes(1);

    await feature.dispose();
  });

  it('coalesces concurrent bootstrap requests into one daemon, session, and gateway', async () => {
    compositionFixture.gatewayStartDeferred = createDeferred<FakeGatewayHandle>();
    const feature = createTerminalWorkspaceFeature({ teamsBasePath, logger: logger as Logger });

    const first = feature.getBootstrap({
      projectPath: sandboxProjectPath,
      teamDisplayName: 'Terminal Fixture',
      teamName: 'terminal-fixture',
    });
    const second = feature.getBootstrap({
      projectPath: sandboxProjectPath,
      teamDisplayName: 'Terminal Fixture',
      teamName: 'terminal-fixture',
    });

    const bootstraps = await Promise.all([first, second]);

    expect(bootstraps[0]).toEqual(bootstraps[1]);
    expect(compositionFixture.spawn).toHaveBeenCalledTimes(1);
    expect(compositionFixture.startWorkspaceGatewayNodeServer).toHaveBeenCalledTimes(1);
    expect(getCreateNativeSessionCalls(bootstraps[0].runtimeSlug)).toHaveLength(1);

    await feature.dispose();
  });

  it('reuses cached runtime records and fully disposes them on stop', async () => {
    const feature = createTerminalWorkspaceFeature({ teamsBasePath, logger: logger as Logger });

    const first = await feature.getBootstrap({
      projectPath: sandboxProjectPath,
      teamDisplayName: 'Terminal Fixture',
      teamName: 'terminal-fixture',
    });
    const second = await feature.getBootstrap({
      projectPath: sandboxProjectPath,
      teamDisplayName: 'Terminal Fixture',
      teamName: 'terminal-fixture',
    });

    expect(second).toEqual(first);
    expect(compositionFixture.spawn).toHaveBeenCalledTimes(1);

    await feature.stopTeamRuntime('terminal-fixture');

    expect(compositionFixture.gatewayHandles[0]?.dispose).toHaveBeenCalledOnce();
    expect(compositionFixture.children[0]?.kill).toHaveBeenCalledWith('SIGTERM');

    const restarted = await feature.getBootstrap({
      projectPath: sandboxProjectPath,
      teamDisplayName: 'Terminal Fixture',
      teamName: 'terminal-fixture',
    });

    expect(restarted.controlPlaneUrl).toBe('ws://fixture-control-2');
    expect(compositionFixture.spawn).toHaveBeenCalledTimes(2);

    await feature.dispose();
  });

  it('does not create a duplicate initial session when the runtime already has one', async () => {
    const feature = createTerminalWorkspaceFeature({ teamsBasePath, logger: logger as Logger });
    const teamName = 'terminal-fixture';

    const bootstrap = await feature.getBootstrap({
      projectPath: sandboxProjectPath,
      teamDisplayName: 'Terminal Fixture',
      teamName,
    });
    await feature.stopTeamRuntime(teamName);
    compositionFixture.sessionsBySlug.set(bootstrap.runtimeSlug, [
      {
        session_id: 'existing-session',
        title: 'Existing',
      },
    ]);

    await feature.getBootstrap({
      projectPath: sandboxProjectPath,
      teamDisplayName: 'Terminal Fixture',
      teamName,
    });

    expect(getCreateNativeSessionCalls(bootstrap.runtimeSlug)).toHaveLength(1);

    await feature.dispose();
  });

  it('falls back to shell default cwd when the requested project path is missing', async () => {
    const feature = createTerminalWorkspaceFeature({ teamsBasePath, logger: logger as Logger });
    const missingProjectPath = path.join(tempRoot, 'missing-project');

    const bootstrap = await feature.getBootstrap({
      projectPath: missingProjectPath,
      teamDisplayName: 'Terminal Fixture',
      teamName: 'terminal-fixture',
    });

    expect(bootstrap.projectPath).toBeNull();
    expect(getCreateNativeSessionCalls(bootstrap.runtimeSlug)).toContainEqual(
      expect.objectContaining({
        launch: expect.objectContaining({
          cwd: null,
        }),
      })
    );

    await feature.dispose();
  });

  it('cancels an in-flight bootstrap when the team runtime is stopped before gateway readiness', async () => {
    compositionFixture.gatewayStartDeferred = createDeferred<FakeGatewayHandle>();
    const feature = createTerminalWorkspaceFeature({ teamsBasePath, logger: logger as Logger });

    const bootstrapPromise = feature.getBootstrap({
      projectPath: sandboxProjectPath,
      teamDisplayName: 'Terminal Fixture',
      teamName: 'terminal-fixture',
    });
    const stopPromise = feature.stopTeamRuntime('terminal-fixture');

    await expect(bootstrapPromise).rejects.toThrow('Terminal runtime start was cancelled');
    await expect(stopPromise).resolves.toBeUndefined();
    expect(compositionFixture.gatewayHandles[0]?.dispose).toHaveBeenCalledOnce();

    const restarted = await feature.getBootstrap({
      projectPath: sandboxProjectPath,
      teamDisplayName: 'Terminal Fixture',
      teamName: 'terminal-fixture',
    });

    expect(restarted.controlPlaneUrl).toBe('ws://fixture-control-2');
    expect(compositionFixture.spawn).toHaveBeenCalledTimes(2);

    await feature.dispose();
  });

  it('cleans up the daemon and retries cleanly when gateway startup fails', async () => {
    compositionFixture.startWorkspaceGatewayNodeServer.mockRejectedValueOnce(
      new Error('gateway bind failed')
    );
    const feature = createTerminalWorkspaceFeature({ teamsBasePath, logger: logger as Logger });

    await expect(
      feature.getBootstrap({
        projectPath: sandboxProjectPath,
        teamDisplayName: 'Terminal Fixture',
        teamName: 'terminal-fixture',
      })
    ).rejects.toThrow('gateway bind failed');

    expect(compositionFixture.children[0]?.kill).toHaveBeenCalledWith('SIGTERM');
    expect(compositionFixture.spawnedSlugs.size).toBe(0);

    const restarted = await feature.getBootstrap({
      projectPath: sandboxProjectPath,
      teamDisplayName: 'Terminal Fixture',
      teamName: 'terminal-fixture',
    });

    expect(restarted.controlPlaneUrl).toBe('ws://fixture-control-1');
    expect(compositionFixture.spawn).toHaveBeenCalledTimes(2);
    expect(compositionFixture.startWorkspaceGatewayNodeServer).toHaveBeenCalledTimes(2);

    await feature.dispose();
  });

  it('cancels pending bootstraps during facade disposal and does not cache disposed runtimes', async () => {
    compositionFixture.gatewayStartDeferred = createDeferred<FakeGatewayHandle>();
    const feature = createTerminalWorkspaceFeature({ teamsBasePath, logger: logger as Logger });

    const bootstrapPromise = feature.getBootstrap({
      projectPath: sandboxProjectPath,
      teamDisplayName: 'Terminal Fixture',
      teamName: 'terminal-fixture',
    });
    const disposePromise = feature.dispose();

    await expect(bootstrapPromise).rejects.toThrow('Terminal runtime start was cancelled');
    await expect(disposePromise).resolves.toBeUndefined();
    expect(compositionFixture.gatewayHandles[0]?.dispose).toHaveBeenCalledOnce();
    expect(compositionFixture.children[0]?.kill).toHaveBeenCalledWith('SIGTERM');

    const restarted = await feature.getBootstrap({
      projectPath: sandboxProjectPath,
      teamDisplayName: 'Terminal Fixture',
      teamName: 'terminal-fixture',
    });

    expect(restarted.controlPlaneUrl).toBe('ws://fixture-control-2');
    expect(compositionFixture.spawn).toHaveBeenCalledTimes(2);

    await feature.dispose();
  });

  it('resolves a built terminal-platform checkout instead of the install-time node stub', async () => {
    const terminalNodePackagePath = path.join(
      tempRoot,
      'terminal-platform',
      'crates',
      'terminal-node-napi',
      'package',
      'artifacts',
      'local',
      'index.mjs'
    );
    await fs.mkdir(path.dirname(terminalNodePackagePath), { recursive: true });
    await fs.writeFile(terminalNodePackagePath, 'export const TerminalNodeClient = {};\n');
    process.env.CLAUDE_TERMINAL_PLATFORM_ROOT = path.join(tempRoot, 'terminal-platform');

    expect(terminalWorkspaceFeatureTestInternals.resolveTerminalNodePackageSpecifier()).toBe(
      `file://${terminalNodePackagePath}`
    );
  });

  it('resolves bundled terminal-platform resources for packaged builds', async () => {
    const resourcesPath = path.join(tempRoot, 'electron-resources');
    const bundledRoot = path.join(resourcesPath, 'terminal-platform');
    const terminalNodePackagePath = path.join(bundledRoot, 'terminal-platform-node', 'index.mjs');
    const daemonPath = path.join(
      bundledRoot,
      process.platform === 'win32' ? 'terminal-daemon.exe' : 'terminal-daemon'
    );
    await fs.mkdir(path.join(bundledRoot, 'terminal-platform-node', 'native'), { recursive: true });
    await fs.writeFile(terminalNodePackagePath, 'export const TerminalNodeClient = {};\n');
    await fs.writeFile(
      path.join(bundledRoot, 'terminal-platform-node', 'native', 'manifest.json'),
      '{}\n'
    );
    await fs.writeFile(path.join(bundledRoot, 'VERSION'), '0.2.0\n');
    await fs.writeFile(daemonPath, '#!/bin/sh\n');
    delete process.env.CLAUDE_TERMINAL_DAEMON_BINARY;
    delete process.env.CLAUDE_TERMINAL_PLATFORM_ROOT;
    delete process.env.TERMINAL_PLATFORM_ROOT;
    setProcessResourcesPath(resourcesPath);

    expect(terminalWorkspaceFeatureTestInternals.resolveBundledTerminalPlatformRoot()).toBe(
      bundledRoot
    );
    expect(terminalWorkspaceFeatureTestInternals.resolveTerminalNodePackageSpecifier()).toBe(
      `file://${terminalNodePackagePath}`
    );
    await expect(terminalWorkspaceFeatureTestInternals.resolveDaemonBinaryPath()).resolves.toBe(
      daemonPath
    );
  });

  it('fails daemon readiness fast when only the terminal-platform-node install-time stub is available', async () => {
    const loadStubClient = async () =>
      ({
        fromRuntimeSlug: () =>
          ({
            close: vi.fn().mockResolvedValue(undefined),
            handshakeInfo: vi
              .fn()
              .mockRejectedValue(
                new Error(
                  'terminal-platform-node native runtime is not installed. Set CLAUDE_TERMINAL_PLATFORM_ROOT to a built terminal-platform checkout.'
                )
              ),
          }) as TerminalNodeClientLike,
      }) as unknown as Awaited<
        ReturnType<
          Parameters<
            typeof terminalWorkspaceFeatureTestInternals.probeTerminalNodeClientReadiness
          >[0]
        >
      >;
    const readiness = await terminalWorkspaceFeatureTestInternals.probeTerminalNodeClientReadiness(
      loadStubClient,
      'agent-teams-terminal-fixture'
    );

    expect(readiness).toMatchObject({
      fatal: true,
      ready: false,
    });
    expect(readiness.error).toBeInstanceOf(Error);
    expect((readiness.error as Error).message).toContain('CLAUDE_TERMINAL_PLATFORM_ROOT');
    expect((readiness.error as Error).message).not.toContain('Timed out waiting');
  });
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

interface FakeSession {
  session_id: string;
  title: string;
}

interface FakeTerminalClient {
  runtimeSlug: string;
  attachSession: ReturnType<typeof vi.fn>;
  backendCapabilities: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  commandHistory: ReturnType<typeof vi.fn>;
  createNativeSession: ReturnType<typeof vi.fn>;
  deleteSavedSession: ReturnType<typeof vi.fn>;
  discoverSessions: ReturnType<typeof vi.fn>;
  dispatchMuxCommand: ReturnType<typeof vi.fn>;
  handshakeInfo: ReturnType<typeof vi.fn>;
  importSession: ReturnType<typeof vi.fn>;
  listSavedSessions: ReturnType<typeof vi.fn>;
  listSessions: ReturnType<typeof vi.fn>;
  openSubscription: ReturnType<typeof vi.fn>;
  paneHistory: ReturnType<typeof vi.fn>;
  pruneSavedSessions: ReturnType<typeof vi.fn>;
  restoreSavedSession: ReturnType<typeof vi.fn>;
  savedSession: ReturnType<typeof vi.fn>;
  screenDelta: ReturnType<typeof vi.fn>;
  screenSnapshot: ReturnType<typeof vi.fn>;
  topologySnapshot: ReturnType<typeof vi.fn>;
}

interface TerminalNodeClientLike {
  close(): Promise<void>;
  handshakeInfo(): Promise<unknown>;
}

interface FakeGatewayHandle {
  controlUrl: string;
  streamUrl: string;
  dispose: ReturnType<typeof vi.fn>;
}

interface FakeChildProcess extends EventEmitter {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
}

function createFakeTerminalClient(runtimeSlug: string): FakeTerminalClient {
  const sessions = ensureSessions(runtimeSlug);
  const client: FakeTerminalClient = {
    runtimeSlug,
    attachSession: vi.fn().mockResolvedValue({}),
    backendCapabilities: vi.fn().mockResolvedValue({}),
    close: vi.fn().mockResolvedValue(undefined),
    commandHistory: vi.fn().mockResolvedValue([]),
    createNativeSession: vi.fn().mockImplementation(async (request: { title: string }) => {
      const session = {
        session_id: `session-${sessions.length + 1}`,
        title: request.title,
      };
      sessions.push(session);
      return session;
    }),
    deleteSavedSession: vi.fn().mockResolvedValue(undefined),
    discoverSessions: vi.fn().mockResolvedValue([]),
    dispatchMuxCommand: vi.fn().mockResolvedValue(undefined),
    handshakeInfo: vi.fn().mockImplementation(async () => {
      if (!compositionFixture.spawnedSlugs.has(runtimeSlug)) {
        throw new Error(`runtime ${runtimeSlug} is not ready`);
      }
      return {
        handshake: {
          protocol_version: 1,
          runtime_slug: runtimeSlug,
        },
      };
    }),
    importSession: vi.fn().mockResolvedValue({}),
    listSavedSessions: vi.fn().mockResolvedValue([]),
    listSessions: vi.fn().mockImplementation(async () => [...sessions]),
    openSubscription: vi.fn().mockResolvedValue({
      subscriptionId: 'subscription-1',
      nextEvent: vi.fn().mockResolvedValue(null),
      close: vi.fn().mockResolvedValue(undefined),
    }),
    paneHistory: vi.fn().mockResolvedValue([]),
    pruneSavedSessions: vi.fn().mockResolvedValue(undefined),
    restoreSavedSession: vi.fn().mockResolvedValue({}),
    savedSession: vi.fn().mockResolvedValue(null),
    screenDelta: vi.fn().mockResolvedValue(null),
    screenSnapshot: vi.fn().mockResolvedValue(null),
    topologySnapshot: vi.fn().mockResolvedValue(null),
  };
  compositionFixture.clients.push(client);
  return client;
}

function createFakeChildProcess(runtimeSlug: string): FakeChildProcess {
  const child = new EventEmitter() as FakeChildProcess;
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn((signal: NodeJS.Signals) => {
    child.signalCode = signal;
    compositionFixture.spawnedSlugs.delete(runtimeSlug);
    queueMicrotask(() => {
      child.emit('exit', null, signal);
    });
    return true;
  });
  return child;
}

function createGatewayHandle(index: number): FakeGatewayHandle {
  return {
    controlUrl: `ws://fixture-control-${index}`,
    streamUrl: `ws://fixture-stream-${index}`,
    dispose: vi.fn().mockResolvedValue(undefined),
  };
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function ensureSessions(runtimeSlug: string): FakeSession[] {
  let sessions = compositionFixture.sessionsBySlug.get(runtimeSlug);
  if (!sessions) {
    sessions = [];
    compositionFixture.sessionsBySlug.set(runtimeSlug, sessions);
  }
  return sessions;
}

function getCreateNativeSessionCalls(runtimeSlug: string): unknown[] {
  return compositionFixture.clients
    .filter((candidate) => candidate.runtimeSlug === runtimeSlug)
    .flatMap((client) => client.createNativeSession.mock.calls.map((call) => call[0]));
}

function readRuntimeSlug(args: string[]): string {
  const index = args.indexOf('--runtime-slug');
  if (index === -1 || !args[index + 1]) {
    throw new Error(`Missing --runtime-slug in ${JSON.stringify(args)}`);
  }
  return args[index + 1];
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function processWithResourcesPath(): NodeJS.Process & { resourcesPath?: string } {
  return process as NodeJS.Process & { resourcesPath?: string };
}

function setProcessResourcesPath(value: string): void {
  Object.defineProperty(processWithResourcesPath(), 'resourcesPath', {
    configurable: true,
    value,
    writable: true,
  });
}

function restoreProcessResourcesPath(value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(processWithResourcesPath(), 'resourcesPath');
    return;
  }
  setProcessResourcesPath(value);
}
