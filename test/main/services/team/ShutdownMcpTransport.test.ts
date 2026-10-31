// @vitest-environment node
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  configureDesktopMcpEnvironment,
  createDesktopExternalAgentConnection,
  getDesktopMcpChildEnvironment,
  isDesktopMcpEnvironmentBound,
  type NativeRendererCdp,
} from '@features/external-agent-connection/main';
import * as memberWorkSync from '@features/member-work-sync/main';
import { applyAgentTeamsMcpAppContext } from '@main/services/runtime/agentTeamsMcpLaunchEnv';
import {
  AgentTeamsMcpHttpServer,
  agentTeamsMcpHttpServer as server,
} from '@main/services/team/AgentTeamsMcpHttpServer';
import {
  OpenCodeBridgeCommandClient,
  type OpenCodeBridgeProcessRunInput,
} from '@main/services/team/opencode/bridge/OpenCodeBridgeCommandClient';
import { buildOpenCodeAppScopedMcpUrl } from '@main/services/team/opencode/bridge/OpenCodeMcpBridgeEnv';
import { OpenCodeReadinessBridge } from '@main/services/team/opencode/bridge/OpenCodeReadinessBridge';
import {
  composeExternalAgentConnection,
  refreshDesktopBridgeEnvironment,
} from '@main/startExternalAgentConnection';
import { startPreparedMemberWorkSyncFeature } from '@main/startMemberWorkSyncFeature';
import * as pathDecoder from '@main/utils/pathDecoder';
import { getClaudeBasePath } from '@main/utils/pathDecoder';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

import type { OpenCodeBridgeCommandName } from '@main/services/team/opencode/bridge/OpenCodeBridgeCommandContract';

vi.mock('electron', () => ({
  app: { getPath: () => '/sandbox/shutdown-profile', getVersion: () => 'test' },
}));

// Execute exact source boundaries without booting Electron, discovering binaries,
// or contacting providers. Extract AST nodes, not a rewritten algorithm.
const mainSource = ts.createSourceFile(
  'main.ts',
  readFileSync('src/main/index.ts', 'utf8'),
  ts.ScriptTarget.Latest,
  true
);
function sourceNode(name: string): ts.Node {
  let found: ts.Node | undefined;
  function visit(node: ts.Node) {
    if (
      (ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) &&
      node.name?.getText(mainSource) === name
    )
      found = node;
    ts.forEachChild(node, visit);
  }
  visit(mainSource);
  if (!found) throw new Error(`Source boundary missing: ${name}`);
  return found;
}
function compileExpression(expression: string, ports: Record<string, unknown>): unknown {
  const js = ts.transpileModule(`const boundary = ${expression};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  // Execute only checked-in source AST with test-owned ports, never user input.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, sonarjs/code-eval
  return Function(...Object.keys(ports), `${js}; return boundary;`)(...Object.values(ports));
}
const profile = 'a'.repeat(64);
const hostEnv = () => ({
  AGENT_TEAMS_MCP_CLAUDE_DIR: getClaudeBasePath(),
  CLAUDE_TEAM_APP_INSTANCE_ID: 'review-host',
  CLAUDE_TEAM_APP_PROFILE_SCOPE: profile,
  CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND: '/sandbox/node',
  CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY: '/sandbox/mcp.js',
  CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ARGS_JSON: '["/sandbox/mcp.js"]',
  CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENV_JSON: JSON.stringify({
    CLAUDE_TEAM_APP_INSTANCE_ID: 'review-host',
    CLAUDE_TEAM_APP_PROFILE_SCOPE: profile,
  }),
});
const handle: NonNullable<ReturnType<typeof server.getCurrentHandle>> = {
  url: 'http://127.0.0.1:41001/mcp',
  port: 41001,
  urlHash: 'review-hash',
  pid: 123,
  generation: 1,
  diagnostics: [],
  transportEvidence: {
    schemaVersion: 1,
    transport: 'httpStream',
    host: '127.0.0.1',
    port: 41001,
    endpoint: '/mcp',
    url: 'http://127.0.0.1:41001/mcp',
    urlHash: 'review-hash',
    generation: 1,
    observedAt: '2026-09-10T00:00:00.000Z',
  },
};
function bridgeResolver(env: Record<string, string>, overrides: Record<string, unknown> = {}) {
  const node = sourceNode('bridgeClient') as ts.VariableDeclaration;
  const constructor = node.initializer;
  if (!constructor || !ts.isNewExpression(constructor))
    throw new Error('Bridge client constructor missing');
  const options = constructor.arguments?.[0];
  if (!options || !ts.isObjectLiteralExpression(options))
    throw new Error('Bridge client options missing');
  const provider = options.properties.find(
    (property): property is ts.PropertyAssignment =>
      ts.isPropertyAssignment(property) && property.name.getText(mainSource) === 'envProvider'
  );
  if (!provider || !ts.isArrowFunction(provider.initializer))
    throw new Error('Bridge client environment provider missing');
  return compileExpression(provider.initializer.getText(mainSource), {
    bridgeEnv: env,
    getTeamControlApiBaseUrl: () => 'http://127.0.0.1:41000',
    useHttpMcpBridge: true,
    agentTeamsMcpHttpServer: server,
    ensureOpenCodeRuntimeBinaryEnv: vi.fn().mockResolvedValue(undefined),
    ensureOpenCodeLocalMcpLaunchEnv: vi.fn().mockResolvedValue(undefined),
    buildOpenCodeAppScopedMcpUrl,
    openCodeManagedHostInstanceId: 'review-host',
    profileScope: profile,
    refreshDesktopBridgeEnvironment: async (nextEnv: NodeJS.ProcessEnv) =>
      applyAgentTeamsMcpAppContext(nextEnv),
    logger: { warn: vi.fn() },
    ...overrides,
  });
}

describe('shutdown MCP transport authority', () => {
  it.each([false, true])(
    'dispatches startup retirement without control, but refuses launch (HTTP=%s)',
    async (useHttpMcpBridge) => {
      const directory = await mkdtemp(join(tmpdir(), 'startup-no-control-'));
      const unavailable = vi.fn(() => {
        throw new Error('Desktop MCP control context is unavailable');
      });
      const revoke = configureDesktopMcpEnvironment(unavailable, () => false);
      const env = {
        ...hostEnv(),
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL: 'http://127.0.0.1:49999/mcp',
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL_HASH: 'stale-http-hash',
        AGENT_TEAMS_BOUND_CONTROL_URL: 'http://127.0.0.1:49999',
        AGENT_TEAMS_BOUND_CONTEXT_JSON: '{"stale":true}',
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENV_JSON: JSON.stringify({
          ...JSON.parse(hostEnv().CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENV_JSON),
          AGENT_TEAMS_BOUND_CONTROL_URL: 'http://127.0.0.1:49999',
          AGENT_TEAMS_BOUND_CONTEXT_JSON: '{"stale":true}',
        }),
      };
      const resolveEnv = bridgeResolver(env, {
        useHttpMcpBridge,
        getTeamControlApiBaseUrl: () => null,
        refreshDesktopBridgeEnvironment,
      }) as NonNullable<
        ConstructorParameters<typeof OpenCodeBridgeCommandClient>[0]['envProvider']
      >;
      const run = vi.fn(async (_input: OpenCodeBridgeProcessRunInput) => ({
        stdout: JSON.stringify({
          ok: true,
          schemaVersion: 1,
          requestId: 'cleanup-test',
          command: 'opencode.cleanupStartupHosts',
          completedAt: '2026-10-11T00:00:00.000Z',
          durationMs: 1,
          runtime: {
            providerId: 'opencode',
            binaryPath: '/sandbox/opencode',
            binaryFingerprint: 'test-bin',
            version: '1.0.0',
            capabilitySnapshotId: 'test-cap',
          },
          diagnostics: [],
          data: {
            cleaned: 0,
            remaining: 0,
            hosts: [],
            diagnostics: [],
            startupCleanup: { completion: 'drained', coverage: 'partial', survivingPids: [] },
          },
        }),
        stderr: '',
        exitCode: 0,
        timedOut: false,
      }));
      const client = new OpenCodeBridgeCommandClient({
        binaryPath: '/sandbox/cli',
        tempDirectory: directory,
        envProvider: resolveEnv,
        requestIdFactory: () => 'cleanup-test',
        processRunner: { run },
      });
      try {
        expect(
          (
            await client.execute(
              'opencode.cleanupStartupHosts',
              {},
              { cwd: directory, timeoutMs: 100 }
            )
          ).ok
        ).toBe(true);
        expect(run).toHaveBeenCalledTimes(1);
        expect(unavailable).not.toHaveBeenCalled();
        const cleanupEnv = run.mock.calls[0][0].env;
        expect(cleanupEnv.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL).toBeUndefined();
        expect(cleanupEnv.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL_HASH).toBeUndefined();
        expect(cleanupEnv.AGENT_TEAMS_BOUND_CONTROL_URL).toBeUndefined();
        expect(cleanupEnv.AGENT_TEAMS_BOUND_CONTEXT_JSON).toBeUndefined();
        expect(
          JSON.parse(cleanupEnv.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENV_JSON!)
        ).not.toHaveProperty('AGENT_TEAMS_BOUND_CONTROL_URL');
        expect(
          JSON.parse(cleanupEnv.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENV_JSON!)
        ).not.toHaveProperty('AGENT_TEAMS_BOUND_CONTEXT_JSON');
        await expect(
          client.execute('opencode.launchTeam', {}, { cwd: directory, timeoutMs: 100 })
        ).rejects.toThrow(
          useHttpMcpBridge
            ? 'Desktop MCP control server is not ready'
            : 'Desktop MCP control context is unavailable'
        );
        expect(run).toHaveBeenCalledTimes(1);
      } finally {
        revoke();
        await rm(directory, { recursive: true, force: true });
      }
    }
  );

  it('drains admitted mutations and tears down transport when native run shutdown fails', async () => {
    const connection = composeExternalAgentConnection({
      appInstanceId: 'sandbox-native-stop-failure',
      nativeRun: [{ getProviderStatus: vi.fn() }, () => undefined],
      cdp: {
        read: async () => ({ cdp: { status: 'disabled' }, reason: null }),
      } as unknown as NativeRendererCdp,
      getMainContents: () => null,
      isLocalContext: () => true,
      getControlUrl: () => 'http://127.0.0.1:41000',
      startControl: async () => undefined,
      reconfigureRoot: async () => undefined,
    });
    const stopError = new Error('owned native process could not be stopped');
    const nativeStop = vi.spyOn(connection.directRun, 'shutdown').mockRejectedValue(stopError);
    const transportStop = vi.spyOn(server, 'stop').mockImplementation(async () => {
      expect(server.appContext.read(getClaudeBasePath())).toBeNull();
    });
    let finishMutation!: () => void;
    const mutationDone = new Promise<void>((resolve) => {
      finishMutation = resolve;
    });
    let mutation: Promise<void> | undefined;
    let closing: Promise<void> | undefined;
    let closeSettled = false;
    try {
      const { context } = await connection.getConnectionInfo();
      mutation = connection.withExpectedContext(context, () => mutationDone);
      closing = connection.closeAdmission();
      const closeFailure = expect(closing).rejects.toBe(stopError);
      void closing.then(
        () => {
          closeSettled = true;
        },
        () => {
          closeSettled = true;
        }
      );
      // Allow the native rejection to propagate without releasing the admitted mutation.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(nativeStop).toHaveBeenCalledExactlyOnceWith();
      expect(closeSettled).toBe(false);
      expect(transportStop).not.toHaveBeenCalled();
      await expect(connection.withExpectedContext(context, async () => undefined)).rejects.toThrow(
        'APP_CONTEXT_MISMATCH'
      );
      expect(server.appContext.read(getClaudeBasePath())).not.toBeNull();
      expect(isDesktopMcpEnvironmentBound()).toBe(true);
      finishMutation();
      await mutation;
      await closeFailure;
      await expect(connection.shutdown()).rejects.toBe(stopError);
      expect(transportStop).toHaveBeenCalledExactlyOnceWith({ preventRestart: true });
      expect(server.appContext.read(getClaudeBasePath())).toBeNull();
      expect(isDesktopMcpEnvironmentBound()).toBe(false);
    } finally {
      finishMutation();
      await mutation;
      await closing?.catch(() => undefined);
      await connection.shutdown().catch(() => undefined);
      nativeStop.mockRestore();
      transportStop.mockRestore();
    }
  });

  it('binds before the first bridge consumer and refuses pre-control startup without spawning', async () => {
    const initialize = sourceNode('initializeServices') as ts.FunctionDeclaration;
    const boundaries = initialize.body!.statements.filter((statement) => {
      const text = statement.getText(mainSource);
      return (
        text.startsWith('externalAgentConnection = composeExternalAgentConnection(') ||
        text.startsWith('const runtimeAdapterRegistry = await startupStage(') ||
        text.startsWith('teamProvisioningService.setRuntimeAdapterRegistry(') ||
        text.startsWith('await startPreparedMemberWorkSyncFeature(') ||
        text.startsWith('await externalAgentConnection.start()') ||
        text.startsWith('memberWorkSyncFeature?.startBackground()') ||
        text.startsWith('teamRuntimeRecoveryFeature.start()')
      );
    });
    let controlUrl: string | null = null;
    let currentHandle: typeof handle | null = null;
    const spawnedEnvironments: NodeJS.ProcessEnv[] = [];
    const start = vi.spyOn(server, 'ensureStarted').mockImplementation(async () => {
      if (!currentHandle) {
        spawnedEnvironments.push(getDesktopMcpChildEnvironment());
        currentHandle = handle;
      }
      return currentHandle;
    });
    const live = vi.spyOn(server, 'getCurrentHandle').mockImplementation(() => currentHandle);
    const stop = vi.spyOn(server, 'stop').mockResolvedValue(undefined);
    const resolveEnv = bridgeResolver(hostEnv(), {
      getTeamControlApiBaseUrl: () => controlUrl,
      refreshDesktopBridgeEnvironment,
    }) as () => Promise<NodeJS.ProcessEnv>;
    const pendingConsumers: Promise<NodeJS.ProcessEnv>[] = [];
    const restore = vi.fn(async () => {
      expect(controlUrl).toBeNull();
      expect(start).not.toHaveBeenCalled();
    });
    const startBackground = vi.fn(() => {
      expect(controlUrl).toBe('http://127.0.0.1:41000');
      pendingConsumers.push(resolveEnv());
    });
    let connection: ReturnType<typeof createDesktopExternalAgentConnection> | undefined;
    const gatewayLaunchRuntime = {};
    const initializeBoundary = compileExpression(
      `async () => { let externalAgentConnection = null, memberWorkSyncFeature = null; ${boundaries.map((node) => node.getText(mainSource)).join('\n')} }`,
      {
        composeExternalAgentConnection: (
          options: Parameters<typeof createDesktopExternalAgentConnection>[0]
        ) => {
          connection = createDesktopExternalAgentConnection({
            ...options,
            userDataPath: '/sandbox/app-profile',
            getRoot: getClaudeBasePath,
            getAppVersion: () => 'test',
            getCdpEnabled: () => false,
            mcp: server,
            httpEnabled: true,
          });
          return { ...connection, start: () => connection!.retryConnection() };
        },
        teamDataService: {},
        gatewayLaunchRuntime,
        cliInstallerService: { getProviderStatus: vi.fn() },
        codexAccountFeature: undefined,
        forwardTeamChangeToRendererAndHttp: vi.fn(),
        initializedBackupOwner: { initialize: restore },
        preparedMemberWorkSyncFeature: { startBackground, dispose: vi.fn() },
        startPreparedMemberWorkSyncFeature,
        memberWorkSyncStallObservation: { attach: vi.fn() },
        mainWindow: null,
        openCodeManagedHostInstanceId: 'review-host',
        nativeRendererCdp: {
          read: async () => ({ cdp: { status: 'disabled' }, reason: null }),
        } as unknown as NativeRendererCdp,
        contextRegistry: { getActiveContextId: () => 'local' },
        sshConnectionManager: { getStatus: () => ({ state: 'disconnected' }) },
        getTeamControlApiBaseUrl: () => controlUrl,
        startHttpServer: async () => {
          controlUrl = 'http://127.0.0.1:41000';
        },
        handleModeSwitch: vi.fn(),
        startupStage: (operation: () => unknown) => operation(),
        createOpenCodeRuntimeAdapterRegistry: async (
          _publish: unknown,
          gatewayRuntime: unknown
        ) => {
          expect(gatewayRuntime).toBe(gatewayLaunchRuntime);
          // An early env request must fail without touching the unbound supervisor.
          await expect(resolveEnv()).rejects.toThrow('Desktop MCP control server is not ready');
          expect(start).not.toHaveBeenCalled();
          expect(server.appContext.read(getClaudeBasePath())).toMatchObject({
            CLAUDE_TEAM_APP_INSTANCE_ID: 'review-host',
          });
          return {};
        },
        publishStartupStatus: vi.fn(),
        assertStartupActive: vi.fn(),
        isShutdownStarted: () => false,
        teamProvisioningService: { setRuntimeAdapterRegistry: vi.fn() },
        teamRuntimeRecoveryFeature: { start: () => pendingConsumers.push(resolveEnv()) },
      }
    ) as () => Promise<void>;
    try {
      await initializeBoundary();
      await Promise.all(pendingConsumers);
      expect(restore).toHaveBeenCalledExactlyOnceWith(expect.any(Function));
      expect(startBackground).toHaveBeenCalledExactlyOnceWith();
      expect(pendingConsumers).toHaveLength(2);
      expect(spawnedEnvironments).toHaveLength(1);
      expect(spawnedEnvironments[0]).toMatchObject({
        AGENT_TEAMS_BOUND_CONTROL_URL: 'http://127.0.0.1:41000',
        AGENT_TEAMS_MCP_CLAUDE_DIR: getClaudeBasePath(),
      });
      expect(JSON.parse(spawnedEnvironments[0].AGENT_TEAMS_BOUND_CONTEXT_JSON!)).toMatchObject({
        appInstanceId: 'review-host',
        // Preparing the bridge now binds the listener before its first MCP spawn.
        connectionGeneration: 1,
      });
    } finally {
      await connection?.shutdown();
      stop.mockRestore();
      start.mockRestore();
      live.mockRestore();
    }
  });

  it('retains matching Stop authority through both cleanup phases and revokes at teardown', async () => {
    const env = hostEnv();
    const revoke = server.appContext.bind(env, true);
    const directory = await mkdtemp(join(tmpdir(), 'shutdown-mcp-'));
    const live = vi.spyOn(server, 'getCurrentHandle').mockReturnValue(handle);
    const start = vi.spyOn(server, 'ensureStarted').mockResolvedValue(handle);
    const resolveEnv = bridgeResolver(env) as () => Promise<NodeJS.ProcessEnv>;
    const accepted = new Error('authorized Stop intercepted; no subprocess');
    let acceptedStops = 0;
    const expectedUrl = `http://127.0.0.1:41001/mcp#agent-teams-app-instance=review-host&agent-teams-app-profile=${profile}`;
    const client = new OpenCodeBridgeCommandClient({
      binaryPath: '/sandbox/cli',
      tempDirectory: directory,
      env,
      envProvider: resolveEnv,
      processRunner: {
        run(input) {
          const child = JSON.parse(input.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENV_JSON!);
          // Reject mismatched current transport/authority, as a retaining non-Cursor
          // Stop probe does. Never manufacture a successful bridge response.
          if (
            server.getCurrentHandle() !== handle ||
            input.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL !== expectedUrl ||
            input.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL_HASH !== handle.urlHash ||
            input.env.CLAUDE_TEAM_APP_INSTANCE_ID !== 'review-host' ||
            input.env.CLAUDE_TEAM_APP_PROFILE_SCOPE !== profile ||
            child.CLAUDE_TEAM_APP_INSTANCE_ID !== 'review-host' ||
            child.CLAUDE_TEAM_APP_PROFILE_SCOPE !== profile ||
            child.AGENT_TEAMS_MCP_CLAUDE_DIR !== getClaudeBasePath()
          ) {
            throw new Error('retaining Stop rejected: current MCP transport/authority mismatch');
          }
          acceptedStops += 1;
          return Promise.reject(accepted);
        },
      },
    });
    const stop = async () => {
      await expect(
        client.execute(
          'opencode.stopTeam',
          {
            teamId: 'sandbox-team',
            laneId: 'primary',
            runId: 'sandbox-run',
          },
          { cwd: directory, timeoutMs: 1000 }
        )
      ).rejects.toBe(accepted);
    };
    const finished = new Error('bounded shutdown completed MCP teardown');
    const stopStartupAdmission = vi.fn();
    const disposeTokenUsage = vi.fn();
    const prepareShutdownStop = vi.fn();
    const openShutdownStop = vi.fn();
    const releaseShutdownStop = vi.fn(() => null);
    const drainCatalog = vi.fn(async () => {});
    const closeAdmission = vi.fn(() => {
      expect(prepareShutdownStop).toHaveBeenCalledExactlyOnceWith();
    });
    const noOp = vi.fn();
    const stopContinuityScan = vi.fn();
    const teardown = vi.spyOn(server, 'stop').mockImplementation(() => {
      // Revocation must already hold on entry, even when server.stop is slow.
      expect(server.appContext.read(getClaudeBasePath())).toBeNull();
      live.mockReturnValue(null);
      start.mockRejectedValue(new Error('startup disabled during shutdown'));
      return Promise.resolve();
    });
    const shutdown = compileExpression(sourceNode('shutdownServices').getText(mainSource), {
      shutdownPromise: null,
      stopAdmittingOpenCodeStartupCleanup: stopStartupAdmission,
      openCodeLifecycleBridge: { prepareShutdownStop, openShutdownStop, releaseShutdownStop },
      runtimeProviderManagementFeature: { shutdown: drainCatalog },
      externalAgentConnection: {
        closeAdmission,
        shutdown: async () => {
          revoke();
          await server.stop({ preventRestart: true });
        },
      },
      removeExternalAgentConnectionIpc: noOp,
      ipcMain: {},
      logger: { info: noOp, diagnostic: noOp },
      announcementsLifecycle: { dispose: noOp },
      tokenUsageFeature: { dispose: disposeTokenUsage },
      runShutdownStep: async (_name: string, step: () => unknown) => {
        // Polling must stop before the first async cleanup can yield, and stay stopped.
        expect(disposeTokenUsage).toHaveBeenCalledExactlyOnceWith();
        expect(stopContinuityScan).toHaveBeenCalledExactlyOnceWith();
        return await step();
      },
      clearStartupTimers: noOp,
      clearInboxNotifyTimers: noOp,
      rendererRecoveryController: null,
      openCodePromptDeliveryContinuityScan: { stop: stopContinuityScan },
      stopPeriodicOpenCodeHostStartupLockPurge: null,
      teamRuntimeRecoveryFeature: null,
      teamProvisioningService: { setRuntimeRecoveryFailureObserver: noOp, stopAllTeams: stop },
      cleanupOpenCodeHostsForLifecycle: stop,
      agentTeamsMcpHttpServer: server,
      killTrackedCliProcesses: () => {
        throw finished;
      },
    }) as () => Promise<void>;
    try {
      expect((await resolveEnv()).CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL).toBe(expectedUrl);
      let resume!: (value: typeof handle) => void;
      start.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resume = resolve;
          })
      );
      const late = resolveEnv();
      await vi.waitFor(() => expect(resume).toBeTypeOf('function'));
      await expect(shutdown()).rejects.toBe(finished);
      expect(stopStartupAdmission).toHaveBeenCalledExactlyOnceWith();
      expect(closeAdmission).toHaveBeenCalledExactlyOnceWith();
      expect(drainCatalog).toHaveBeenCalledExactlyOnceWith();
      expect(drainCatalog.mock.invocationCallOrder[0]).toBeLessThan(
        closeAdmission.mock.invocationCallOrder[0]
      );
      expect(prepareShutdownStop.mock.invocationCallOrder[0]).toBeLessThan(
        closeAdmission.mock.invocationCallOrder[0]
      );
      expect(openShutdownStop).toHaveBeenCalledExactlyOnceWith();
      expect(releaseShutdownStop).toHaveBeenCalledExactlyOnceWith();
      expect(acceptedStops).toBe(2);
      expect(teardown).toHaveBeenCalledExactlyOnceWith({ preventRestart: true });
      const after = await resolveEnv();
      expect(after.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL).toBeUndefined();
      expect(after.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL_HASH).toBeUndefined();
      expect(after.CLAUDE_TEAM_APP_INSTANCE_ID).toBeUndefined();
      expect(after.CLAUDE_TEAM_APP_PROFILE_SCOPE).toBeUndefined();
      expect(JSON.parse(after.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENV_JSON!)).not.toHaveProperty(
        'CLAUDE_TEAM_APP_INSTANCE_ID'
      );
      // A resolver suspended before teardown must also project revocation when resumed.
      resume(handle);
      expect((await late).CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL).toBeUndefined();
      expect(server.appContext.read(getClaudeBasePath())).toBeNull();
    } finally {
      revoke();
      start.mockRestore();
      live.mockRestore();
      teardown.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(['settles', 'fails', 'times out'] as const)(
    'lends the pre-drain binding only to Stop children inside stop all teams (step %s)',
    async (outcome) => {
      const refused = 'Desktop MCP control context is unavailable';
      const directory = await mkdtemp(join(tmpdir(), 'shutdown-stop-env-'));
      const live = vi.spyOn(server, 'getCurrentHandle').mockReturnValue(handle);
      const start = vi.spyOn(server, 'ensureStarted').mockResolvedValue(handle);
      const teardown = vi.spyOn(server, 'stop').mockResolvedValue(undefined);
      const connection = createDesktopExternalAgentConnection({
        appInstanceId: 'review-host',
        userDataPath: '/sandbox/app-profile',
        cdp: {
          read: async () => ({ cdp: { status: 'disabled' }, reason: null }),
        } as unknown as NativeRendererCdp,
        getRoot: getClaudeBasePath,
        getMainContents: () => null,
        getCdpEnabled: () => false,
        getAppVersion: () => 'test',
        isLocalContext: () => true,
        getControlUrl: () => 'http://127.0.0.1:41000',
        startControl: async () => undefined,
        reconfigureRoot: async () => undefined,
        mcp: server,
        httpEnabled: true,
      });
      const children: { command: string; runId?: string; env: NodeJS.ProcessEnv }[] = [];
      let finishHungChild!: () => void;
      const hungChild = new Promise<void>((resolve) => {
        finishHungChild = resolve;
      });
      const client = new OpenCodeBridgeCommandClient({
        binaryPath: '/sandbox/cli',
        tempDirectory: directory,
        env: hostEnv(),
        envProvider: bridgeResolver(hostEnv(), { refreshDesktopBridgeEnvironment }) as NonNullable<
          ConstructorParameters<typeof OpenCodeBridgeCommandClient>[0]['envProvider']
        >,
        processRunner: {
          async run(input) {
            const envelope = JSON.parse(await readFile(input.args[4], 'utf8')) as {
              requestId: string;
              command: string;
              body?: { runId?: string };
            };
            const runId = envelope.body?.runId;
            children.push({ command: envelope.command, runId, env: input.env });
            if (runId === 'hung-run') {
              reachedHold();
              await hungChild;
            }
            return {
              stdout: JSON.stringify({
                ok: true,
                schemaVersion: 1,
                requestId: envelope.requestId,
                command: envelope.command,
                completedAt: '2026-10-31T00:00:00.000Z',
                durationMs: 1,
                runtime: {
                  providerId: 'opencode',
                  binaryPath: '/sandbox/opencode',
                  binaryFingerprint: 'test-bin',
                  version: '1.0.0',
                  capabilitySnapshotId: 'test-cap',
                },
                diagnostics: [],
                data:
                  envelope.command === 'opencode.stopTeam'
                    ? { runId, stopped: true, members: {}, warnings: [], diagnostics: [] }
                    : { runId },
              }),
              stderr: '',
              exitCode: 0,
              timedOut: false,
            };
          },
        },
      });
      const bridge = new OpenCodeReadinessBridge(client);
      const stopLane = (runId: string) =>
        bridge.stopOpenCodeTeam({
          runId,
          laneId: 'lane-a',
          teamId: 'sandbox-team',
          teamName: 'sandbox-team',
          projectPath: directory,
          reason: 'user_requested',
          force: true,
        });
      const execute = (command: OpenCodeBridgeCommandName, body: unknown) =>
        client.execute(command, body, { cwd: directory, timeoutMs: 1000 });
      const logger = { info: vi.fn(), warn: vi.fn(), diagnostic: vi.fn() };
      const realRunShutdownStep = compileExpression(
        sourceNode('runShutdownStep').getText(mainSource),
        { logger, SHUTDOWN_STEP_TIMEOUT_MS: 10_000 }
      ) as (label: string, action: () => unknown, timeoutMs?: number) => Promise<void>;
      const prepare = vi.spyOn(bridge, 'prepareShutdownStop');
      const open = vi.spyOn(bridge, 'openShutdownStop');
      const release = vi.spyOn(bridge, 'releaseShutdownStop');
      const closeAdmission = vi.fn(() => connection.closeAdmission());
      const order: string[] = [];
      let reachedHold!: () => void;
      const holding = new Promise<void>((resolve) => {
        reachedHold = resolve;
      });
      let finishHold!: () => void;
      const hold = new Promise<void>((resolve) => {
        finishHold = resolve;
      });
      let stopAllTeamsRun: Promise<void> | undefined;
      let lateLaneStop: Promise<unknown> | undefined;
      const stopAllTeams = async () => {
        order.push('stop all teams');
        for (const [command, body] of [
          ['opencode.launchTeam', { runId: 'late-launch' }],
          ['opencode.sendMessage', { runId: 'run-1' }],
          ['opencode.handshake', { requiredCommand: 'opencode.launchTeam' }],
        ] as const) {
          await expect(execute(command, body)).rejects.toThrow(refused);
        }
        expect(
          await execute('opencode.handshake', { requiredCommand: 'opencode.stopTeam' })
        ).toMatchObject({ ok: true });
        // The first pass and the "Shutdown follow-up" pass share one window.
        expect(await stopLane('run-1')).toMatchObject({ stopped: true });
        expect(await stopLane('run-2')).toMatchObject({ stopped: true });
        if (outcome === 'fails') throw new Error('stop all teams failed');
        if (outcome === 'times out') {
          // Still running when the step is abandoned: counted as pending.
          lateLaneStop = stopLane('hung-run');
          await hold;
          await expect(stopLane('after-timeout')).rejects.toThrow(refused);
        }
      };
      const finished = new Error('bounded shutdown reached subprocess cleanup');
      const shutdown = compileExpression(sourceNode('shutdownServices').getText(mainSource), {
        shutdownPromise: null,
        stopAdmittingOpenCodeStartupCleanup: vi.fn(),
        openCodeLifecycleBridge: bridge,
        runtimeProviderManagementFeature: null,
        externalAgentConnection: { ...connection, closeAdmission },
        removeExternalAgentConnectionIpc: vi.fn(),
        ipcMain: {},
        logger,
        announcementsLifecycle: {
          dispose: async () => {
            order.push('announcements');
            // Captured before the drain, but not lent before the stop step.
            await expect(stopLane('before-window')).rejects.toThrow(refused);
          },
        },
        tokenUsageFeature: null,
        rendererRecoveryController: null,
        openCodePromptDeliveryContinuityScan: null,
        stopPeriodicOpenCodeHostStartupLockPurge: null,
        clearStartupTimers: vi.fn(),
        clearInboxNotifyTimers: vi.fn(),
        runShutdownStep: (label: string, step: () => unknown, timeoutMs?: number) =>
          label === 'stop all teams' ? realRunShutdownStep(label, step, timeoutMs) : step(),
        teamRuntimeRecoveryFeature: null,
        teamProvisioningService: {
          setRuntimeRecoveryFailureObserver: vi.fn(),
          stopAllTeams: () => (stopAllTeamsRun = stopAllTeams()),
        },
        cleanupOpenCodeHostsForLifecycle: async () => {
          order.push('host registry cleanup');
          await expect(execute('opencode.stopTeam', { runId: 'run-1' })).rejects.toThrow(refused);
          if (outcome === 'times out') {
            // The abandoned step resumes only after the window closed behind it.
            finishHold();
            await stopAllTeamsRun;
          }
        },
        agentTeamsMcpHttpServer: server,
        killTrackedCliProcesses: () => {
          throw finished;
        },
      }) as () => Promise<void>;
      if (outcome === 'times out') vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        expect(await execute('opencode.launchTeam', { runId: 'run-1' })).toMatchObject({
          ok: true,
        });
        const binding = getDesktopMcpChildEnvironment();
        const launched = children.length;
        const shutting = shutdown();
        if (outcome === 'times out') {
          await holding;
          await vi.advanceTimersByTimeAsync(10_000);
        }
        await expect(shutting).rejects.toBe(finished);
        expect(order).toEqual(['announcements', 'stop all teams', 'host registry cleanup']);
        expect(prepare.mock.invocationCallOrder[0]).toBeLessThan(
          closeAdmission.mock.invocationCallOrder[0]
        );
        expect(open).toHaveBeenCalledOnce();
        expect(release).toHaveBeenCalledOnce();
        expect(open.mock.invocationCallOrder[0]).toBeLessThan(release.mock.invocationCallOrder[0]);
        if (outcome === 'fails')
          expect(logger.warn).toHaveBeenCalledWith(
            'Shutdown step failed (stop all teams): stop all teams failed'
          );
        expect(logger.diagnostic).toHaveBeenCalledExactlyOnceWith(
          expect.stringMatching(
            new RegExp(
              `^Shutdown stop all teams took \\d+ms; OpenCode lane stops confirmed=2 unconfirmed=0 pending=${
                outcome === 'times out' ? 1 : 0
              } capturedStopAuthority=true$`
            )
          )
        );
        if (outcome === 'times out') {
          finishHungChild();
          expect(await lateLaneStop).toMatchObject({ stopped: true });
        }
        const lent = children.slice(launched);
        expect(lent.map(({ command, runId }) => [command, runId])).toEqual([
          ['opencode.handshake', undefined],
          ['opencode.stopTeam', 'run-1'],
          ['opencode.stopTeam', 'run-2'],
          ...(outcome === 'times out' ? [['opencode.stopTeam', 'hung-run']] : []),
        ]);
        for (const { env } of lent) {
          expect(env).toMatchObject({
            AGENT_TEAMS_BOUND_CONTROL_URL: binding.AGENT_TEAMS_BOUND_CONTROL_URL,
            AGENT_TEAMS_BOUND_CONTEXT_JSON: binding.AGENT_TEAMS_BOUND_CONTEXT_JSON,
            AGENT_TEAMS_MCP_CLAUDE_DIR: binding.AGENT_TEAMS_MCP_CLAUDE_DIR,
            CLAUDE_TEAM_APP_INSTANCE_ID: 'review-host',
            CLAUDE_TEAM_APP_PROFILE_SCOPE: binding.CLAUDE_TEAM_APP_PROFILE_SCOPE,
          });
          expect(JSON.parse(env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENV_JSON!)).toMatchObject({
            AGENT_TEAMS_BOUND_CONTEXT_JSON: binding.AGENT_TEAMS_BOUND_CONTEXT_JSON,
          });
        }
        expect(teardown).toHaveBeenCalledExactlyOnceWith({ preventRestart: true });
      } finally {
        vi.useRealTimers();
        finishHungChild();
        finishHold();
        await stopAllTeamsRun?.catch(() => undefined);
        await connection.shutdown().catch(() => undefined);
        teardown.mockRestore();
        start.mockRestore();
        live.mockRestore();
        await rm(directory, { recursive: true, force: true });
      }
    }
  );

  it.each([true, false])(
    'refreshes a new main command spool with current authority=%s',
    async (bound) => {
      const old = hostEnv();
      old.AGENT_TEAMS_MCP_CLAUDE_DIR = '/sandbox/old';
      const command = { ...old, AGENT_TEAMS_RUNTIME_TURN_SETTLED_SPOOL_ROOT: '/sandbox/old/spool' };
      const current = {
        ...hostEnv(),
        AGENT_TEAMS_MCP_CLAUDE_DIR: '/sandbox/new',
        CLAUDE_TEAM_APP_PROFILE_SCOPE: 'b'.repeat(64),
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENV_JSON: undefined,
      };
      const root = vi.spyOn(pathDecoder, 'getClaudeBasePath').mockReturnValue('/sandbox/new');
      const teams = vi.spyOn(pathDecoder, 'getTeamsBasePath').mockReturnValue('/sandbox/new/teams');
      const spool = vi
        .spyOn(memberWorkSync, 'buildMemberWorkSyncRuntimeTurnSettledEnvironment')
        .mockResolvedValue({ AGENT_TEAMS_RUNTIME_TURN_SETTLED_SPOOL_ROOT: '/sandbox/new/spool' });
      const revoke = bound ? server.appContext.bind(current, true) : () => undefined;
      try {
        // The generic validator still rejects the stale child; only this trusted copy is refreshed.
        if (bound)
          expect(() => applyAgentTeamsMcpAppContext({ ...command })).toThrow(
            'Foreign Host MCP child context'
          );
        await refreshDesktopBridgeEnvironment(command);
        expect(command.AGENT_TEAMS_MCP_CLAUDE_DIR).toBe('/sandbox/new');
        expect(command.AGENT_TEAMS_RUNTIME_TURN_SETTLED_SPOOL_ROOT).toBe('/sandbox/new/spool');
        expect(JSON.parse(command.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENV_JSON)).toMatchObject({
          ...(bound ? { CLAUDE_TEAM_APP_PROFILE_SCOPE: 'b'.repeat(64) } : {}),
          AGENT_TEAMS_MCP_CLAUDE_DIR: '/sandbox/new',
        });
        expect(old.AGENT_TEAMS_MCP_CLAUDE_DIR).toBe('/sandbox/old');
        expect(
          JSON.parse(old.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENV_JSON).CLAUDE_TEAM_APP_PROFILE_SCOPE
        ).toBe(profile);
        expect(spool).toHaveBeenCalledWith({
          teamsBasePath: '/sandbox/new/teams',
          provider: 'opencode',
        });
      } finally {
        revoke();
        spool.mockRestore();
        teams.mockRestore();
        root.mockRestore();
      }
    }
  );

  it('does not publish a stopped in-flight child when readiness completes late', async () => {
    const child = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), pid: undefined });
    let ready!: () => void;
    const owned = new AgentTeamsMcpHttpServer({
      statePath: null,
      resolveLaunchSpec: () =>
        Promise.resolve({ command: '/sandbox/node', args: ['/sandbox/mcp.js'] }),
      allocatePort: () => Promise.resolve(41002),
      spawnProcess: () => child as never,
      waitForPort: () =>
        new Promise<void>((resolve) => {
          ready = resolve;
        }),
    });
    const revoke = owned.appContext.bind(hostEnv(), true);
    const pending = owned.ensureStarted();
    const rejected = expect(pending).rejects.toThrow('exited before startup completed');
    await vi.waitFor(() => expect(ready).toBeTypeOf('function'));
    const stopping = owned.stop({ preventRestart: true });
    ready();
    await stopping;
    await rejected;
    expect(owned.getCurrentHandle()).toBeNull();
    expect(
      owned.appContext.read(getClaudeBasePath())?.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL
    ).toBeUndefined();
    revoke();
  });
});
