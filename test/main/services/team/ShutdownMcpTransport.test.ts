// @vitest-environment node
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyAgentTeamsMcpAppContext } from '@main/services/runtime/agentTeamsMcpLaunchEnv';
import {
  AgentTeamsMcpHttpServer,
  agentTeamsMcpHttpServer as server,
} from '@main/services/team/AgentTeamsMcpHttpServer';
import { OpenCodeBridgeCommandClient } from '@main/services/team/opencode/bridge/OpenCodeBridgeCommandClient';
import { buildOpenCodeAppScopedMcpUrl } from '@main/services/team/opencode/bridge/OpenCodeMcpBridgeEnv';
import { getClaudeBasePath } from '@main/utils/pathDecoder';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

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
  const node = sourceNode('resolveBridgeCommandEnv') as ts.VariableDeclaration;
  return compileExpression(node.initializer!.getText(mainSource), {
    bridgeEnv: env,
    useHttpMcpBridge: true,
    agentTeamsMcpHttpServer: server,
    ensureOpenCodeRuntimeBinaryEnv: vi.fn().mockResolvedValue(undefined),
    ensureOpenCodeLocalMcpLaunchEnv: vi.fn().mockResolvedValue(undefined),
    buildOpenCodeAppScopedMcpUrl,
    openCodeManagedHostInstanceId: 'review-host',
    profileScope: profile,
    applyAgentTeamsMcpAppContext,
    logger: { warn: vi.fn() },
    ...overrides,
  });
}

describe('shutdown MCP transport authority', () => {
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
    const noOp = vi.fn();
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
      revokeMcpAppContext: revoke,
      logger: { info: noOp },
      announcementsLifecycle: { dispose: noOp },
      runShutdownStep: async (_name: string, step: () => unknown) => await step(),
      clearStartupTimers: noOp,
      clearInboxNotifyTimers: noOp,
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
    await owned.stop({ preventRestart: true });
    ready();
    await rejected;
    expect(owned.getCurrentHandle()).toBeNull();
    expect(
      owned.appContext.read(getClaudeBasePath())?.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL
    ).toBeUndefined();
    revoke();
  });
});
