import { constants as fsConstants, promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyOpenCodeAutoUpdatePolicy } from '../../../../src/main/services/runtime/openCodeAutoUpdatePolicy';
import { OpenCodeBridgeCommandClient } from '../../../../src/main/services/team/opencode/bridge/OpenCodeBridgeCommandClient';
import {
  createOpenCodeBridgeCommandLeaseStore,
  createOpenCodeBridgeCommandLedgerStore,
} from '../../../../src/main/services/team/opencode/bridge/OpenCodeBridgeCommandLedgerStore';
import {
  createOpenCodeBridgeClientIdentity,
  OpenCodeBridgeCommandHandshakePort,
} from '../../../../src/main/services/team/opencode/bridge/OpenCodeBridgeHandshakeClient';
import { OpenCodeReadinessBridge } from '../../../../src/main/services/team/opencode/bridge/OpenCodeReadinessBridge';
import { OpenCodeStateChangingBridgeCommandService } from '../../../../src/main/services/team/opencode/bridge/OpenCodeStateChangingBridgeCommandService';
import { readOpenCodeRuntimeLaneIndex } from '../../../../src/main/services/team/opencode/store/OpenCodeRuntimeManifestEvidenceReader';
import { OpenCodeTeamRuntimeAdapter } from '../../../../src/main/services/team/runtime/OpenCodeTeamRuntimeAdapter';
import { TeamRuntimeAdapterRegistry } from '../../../../src/main/services/team/runtime/TeamRuntimeAdapter';
import { resolveAgentTeamsMcpLaunchSpec } from '../../../../src/main/services/team/TeamMcpConfigBuilder';
import { TeamProvisioningService } from '../../../../src/main/services/team/TeamProvisioningService';
import {
  getTeamsBasePath,
  setClaudeBasePathOverride,
} from '../../../../src/main/utils/pathDecoder';

import type { RuntimeStoreManifestEvidence } from '../../../../src/main/services/team/opencode/bridge/OpenCodeBridgeCommandContract';
import type { RuntimeStoreManifestReader } from '../../../../src/main/services/team/opencode/bridge/OpenCodeStateChangingBridgeCommandService';
import type { OpenCodeBridgeCommandExecutor } from '../../../../src/main/services/team/opencode/bridge/OpenCodeStateChangingBridgeCommandService';
import type { TeamProvisioningProgress } from '../../../../src/shared/types';

const liveDescribe =
  process.env.OPENCODE_E2E === '1' && process.env.OPENCODE_E2E_TEAM_PROVISIONING === '1'
    ? describe
    : describe.skip;

const PROJECT_PATH = process.env.OPENCODE_E2E_PROJECT_PATH?.trim() || process.cwd();
const DEFAULT_ORCHESTRATOR_CLI = '/Users/belief/dev/projects/claude/agent_teams_orchestrator/cli-source';
const DEFAULT_MODEL = 'opencode/big-pickle';

liveDescribe('OpenCode team provisioning live e2e', () => {
  const liveDefaultModelIt =
    process.env.OPENCODE_E2E_DEFAULT_MODEL_LAUNCH === '1' ? it : it.skip;
  let tempDir: string;
  let tempClaudeRoot: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-team-provisioning-e2e-'));
    tempClaudeRoot = path.join(tempDir, '.claude');
    await fs.mkdir(tempClaudeRoot, { recursive: true });
    setClaudeBasePathOverride(tempClaudeRoot);
  });

  afterEach(async () => {
    setClaudeBasePathOverride(null);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('creates and stops a pure OpenCode team through TeamProvisioningService using the live runtime adapter', async () => {
    const selectedModel = process.env.OPENCODE_E2E_MODEL?.trim() || DEFAULT_MODEL;
    const orchestratorCli =
      process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH?.trim() || DEFAULT_ORCHESTRATOR_CLI;
    await assertExecutable(orchestratorCli);

    const mcpLaunchSpec = await resolveAgentTeamsMcpLaunchSpec();
    const bridgeEnv = {
      ...createStableBridgeEnv(),
      PATH: withBunOnPath(process.env.PATH ?? ''),
      XDG_DATA_HOME: path.join(tempDir, 'xdg-data'),
      AGENT_TEAMS_MCP_CLAUDE_DIR: tempClaudeRoot,
      CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND: mcpLaunchSpec.command,
      CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY: mcpLaunchSpec.args[0] ?? '',
      CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ARGS_JSON: JSON.stringify(mcpLaunchSpec.args),
    };
    const bridgeClient = new OpenCodeBridgeCommandClient({
      binaryPath: orchestratorCli,
      tempDirectory: path.join(tempDir, 'bridge-input'),
      env: bridgeEnv,
    });
    const stateChangingCommands = createStateChangingCommands({
      bridge: bridgeClient,
      controlDir: path.join(tempDir, 'control'),
    });
    const readinessBridge = new OpenCodeReadinessBridge(bridgeClient, {
      stateChangingCommands,
      timeoutMs: 180_000,
      launchTimeoutMs: 180_000,
      reconcileTimeoutMs: 90_000,
      stopTimeoutMs: 90_000,
    });
    const adapter = new OpenCodeTeamRuntimeAdapter(readinessBridge);
    const svc = new TeamProvisioningService();
    svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

    const teamName = `opencode-team-provisioning-${Date.now()}`;
    const progressEvents: TeamProvisioningProgress[] = [];

    try {
      const { runId } = await svc.createTeam(
        {
          teamName,
          cwd: PROJECT_PATH,
          providerId: 'opencode',
          model: selectedModel,
          skipPermissions: true,
          members: [
            {
              name: 'alice',
              role: 'Developer',
              providerId: 'opencode',
              model: selectedModel,
            },
            {
              name: 'bob',
              role: 'Reviewer',
              providerId: 'opencode',
              model: selectedModel,
            },
          ],
        },
        (progress) => {
          progressEvents.push(progress);
        }
      );

      expect(runId).toBeTruthy();
      const progressDump = progressEvents
        .map((progress) =>
          [
            progress.state,
            progress.message,
            progress.messageSeverity,
            progress.error,
            progress.cliLogsTail,
          ]
            .filter(Boolean)
            .join(' | ')
        )
        .join('\n');
      expect(
        progressEvents.some((progress) =>
          progress.message.includes('OpenCode team launch is ready')
        ),
        progressDump
      ).toBe(true);
      expect(
        progressEvents.some((progress) =>
          progress.message.includes('Validating OpenCode team launch gate')
        ),
        progressDump
      ).toBe(true);
      expect(
        progressEvents.some((progress) =>
          progress.message.includes('Starting OpenCode sessions through runtime adapter')
        ),
        progressDump
      ).toBe(true);
      expect(progressDump).not.toContain('Starting Claude CLI process for team launch');
      expect(progressDump).not.toContain('OpenCode team launch is not enabled');

      const runtimeSnapshot = await svc.getTeamAgentRuntimeSnapshot(teamName);
      expect(runtimeSnapshot.runId).toBe(runId);
      expect(runtimeSnapshot.members.alice).toMatchObject({
        alive: true,
        providerId: 'opencode',
        laneId: 'primary',
        laneKind: 'primary',
        runtimeModel: selectedModel,
        historicalBootstrapConfirmed: true,
      });
      expect(runtimeSnapshot.members.bob).toMatchObject({
        alive: true,
        providerId: 'opencode',
        laneId: 'primary',
        laneKind: 'primary',
        runtimeModel: selectedModel,
        historicalBootstrapConfirmed: true,
      });
      expect(hasOpenCodeRuntimeHandle(runtimeSnapshot.members.alice)).toBe(true);
      expect(hasOpenCodeRuntimeHandle(runtimeSnapshot.members.bob)).toBe(true);
      await expect(
        readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)
      ).resolves.toMatchObject({
        lanes: {
          primary: {
            state: 'active',
          },
        },
      });

      await svc.stopTeam(teamName);
      await waitUntil(async () => {
        const laneIndex = await readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName);
        return Object.keys(laneIndex.lanes).length === 0;
      }, 90_000);
    } finally {
      await svc.stopTeam(teamName).catch(() => undefined);
      await readinessBridge
        .cleanupOpenCodeHosts({
          reason: 'opencode-team-provisioning-live-e2e-cleanup',
          mode: 'force',
          projectPath: PROJECT_PATH,
          staleAgeMs: null,
          leaseStaleAgeMs: null,
        })
        .catch(() => undefined);
    }
  }, 300_000);

  liveDefaultModelIt(
    'creates and stops a pure OpenCode team when all OpenCode model selections are Default',
    async () => {
      const orchestratorCli =
        process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH?.trim() || DEFAULT_ORCHESTRATOR_CLI;
      await assertExecutable(orchestratorCli);
      const projectPath = path.join(tempDir, 'default-model-project');
      await fs.mkdir(projectPath, { recursive: true });
      await fs.writeFile(
        path.join(projectPath, 'opencode.json'),
        `${JSON.stringify({ model: DEFAULT_MODEL, small_model: DEFAULT_MODEL }, null, 2)}\n`
      );

      const mcpLaunchSpec = await resolveAgentTeamsMcpLaunchSpec();
      const bridgeEnv = {
        ...createStableBridgeEnv(),
        PATH: withBunOnPath(process.env.PATH ?? ''),
        XDG_DATA_HOME: path.join(tempDir, 'xdg-data-default-model'),
        AGENT_TEAMS_MCP_CLAUDE_DIR: tempClaudeRoot,
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND: mcpLaunchSpec.command,
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY: mcpLaunchSpec.args[0] ?? '',
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ARGS_JSON: JSON.stringify(mcpLaunchSpec.args),
      };
      const bridgeClient = new OpenCodeBridgeCommandClient({
        binaryPath: orchestratorCli,
        tempDirectory: path.join(tempDir, 'bridge-input-default-model'),
        env: bridgeEnv,
      });
      const stateChangingCommands = createStateChangingCommands({
        bridge: bridgeClient,
        controlDir: path.join(tempDir, 'control-default-model'),
      });
      const readinessBridge = new OpenCodeReadinessBridge(bridgeClient, {
        stateChangingCommands,
        timeoutMs: 180_000,
        launchTimeoutMs: 180_000,
        reconcileTimeoutMs: 90_000,
        stopTimeoutMs: 90_000,
      });
      const adapter = new OpenCodeTeamRuntimeAdapter(readinessBridge);
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

      const teamName = `opencode-team-default-model-${Date.now()}`;
      const progressEvents: TeamProvisioningProgress[] = [];

      try {
        const { runId } = await svc.createTeam(
          {
            teamName,
            cwd: projectPath,
            providerId: 'opencode',
            skipPermissions: true,
            members: [
              {
                name: 'atlas',
                role: 'Developer',
                providerId: 'opencode',
              },
            ],
          },
          (progress) => {
            progressEvents.push(progress);
          }
        );

        expect(runId).toBeTruthy();
        const progressDump = progressEvents
          .map((progress) =>
            [
              progress.state,
              progress.message,
              progress.messageSeverity,
              progress.error,
              progress.cliLogsTail,
            ]
              .filter(Boolean)
              .join(' | ')
          )
          .join('\n');
        expect(
          progressEvents.some((progress) =>
            progress.message.includes('OpenCode team launch is ready')
          ),
          progressDump
        ).toBe(true);
        expect(progressDump).not.toContain('OpenCode launch requires a selected raw model id');
        expect(progressDump).not.toContain('Failed to parse runtime default model list');
        expect(progressDump).not.toContain('Failed to load runtime default model list');

        const runtimeSnapshot = await svc.getTeamAgentRuntimeSnapshot(teamName);
        expect(runtimeSnapshot.runId).toBe(runId);
        expect(runtimeSnapshot.members.atlas).toMatchObject({
          alive: true,
          providerId: 'opencode',
          laneId: 'primary',
          laneKind: 'primary',
          runtimeModel: DEFAULT_MODEL,
          historicalBootstrapConfirmed: true,
        });
        expect(hasOpenCodeRuntimeHandle(runtimeSnapshot.members.atlas)).toBe(true);

        await svc.stopTeam(teamName);
        await waitUntil(async () => {
          const laneIndex = await readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName);
          return Object.keys(laneIndex.lanes).length === 0;
        }, 90_000);

        const relaunchProgressEvents: TeamProvisioningProgress[] = [];
        const { runId: relaunchRunId } = await svc.launchTeam(
          {
            teamName,
            cwd: projectPath,
            providerId: 'opencode',
            skipPermissions: true,
          },
          (progress) => {
            relaunchProgressEvents.push(progress);
          }
        );
        expect(relaunchRunId).toBeTruthy();
        expect(relaunchRunId).not.toBe(runId);
        const relaunchProgressDump = relaunchProgressEvents
          .map((progress) =>
            [
              progress.state,
              progress.message,
              progress.messageSeverity,
              progress.error,
              progress.cliLogsTail,
            ]
              .filter(Boolean)
              .join(' | ')
          )
          .join('\n');
        expect(
          relaunchProgressEvents.some((progress) =>
            progress.message.includes('OpenCode team launch is ready')
          ),
          relaunchProgressDump
        ).toBe(true);
        expect(relaunchProgressDump).not.toContain(
          'OpenCode launch requires a selected raw model id'
        );
        expect(relaunchProgressDump).not.toContain('No OpenCode model is available');
        expect(relaunchProgressDump).not.toContain('Failed to parse runtime default model list');
        expect(relaunchProgressDump).not.toContain('Failed to load runtime default model list');

        const relaunchedSnapshot = await svc.getTeamAgentRuntimeSnapshot(teamName);
        expect(relaunchedSnapshot.runId).toBe(relaunchRunId);
        expect(relaunchedSnapshot.members.atlas).toMatchObject({
          alive: true,
          providerId: 'opencode',
          laneId: 'primary',
          laneKind: 'primary',
          runtimeModel: DEFAULT_MODEL,
          historicalBootstrapConfirmed: true,
        });
        expect(hasOpenCodeRuntimeHandle(relaunchedSnapshot.members.atlas)).toBe(true);

        await svc.stopTeam(teamName);
        await waitUntil(async () => {
          const laneIndex = await readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName);
          return Object.keys(laneIndex.lanes).length === 0;
        }, 90_000);
      } finally {
        await svc.stopTeam(teamName).catch(() => undefined);
        await readinessBridge
          .cleanupOpenCodeHosts({
            reason: 'opencode-team-default-model-live-e2e-cleanup',
            mode: 'force',
            projectPath,
            staleAgeMs: null,
            leaseStaleAgeMs: null,
          })
          .catch(() => undefined);
      }
    },
    300_000
  );
});

function createStateChangingCommands(input: {
  bridge: OpenCodeBridgeCommandExecutor;
  controlDir: string;
}): OpenCodeStateChangingBridgeCommandService {
  const clientIdentity = createOpenCodeBridgeClientIdentity({
    appVersion: '1.3.0-e2e',
    gitSha: null,
    buildId: 'opencode-team-provisioning-e2e',
  });

  return new OpenCodeStateChangingBridgeCommandService({
    expectedClientIdentity: clientIdentity,
    handshakePort: new OpenCodeBridgeCommandHandshakePort({
      bridge: input.bridge,
      clientIdentity,
    }),
    leaseStore: createOpenCodeBridgeCommandLeaseStore({
      filePath: path.join(input.controlDir, 'leases.json'),
    }),
    ledger: createOpenCodeBridgeCommandLedgerStore({
      filePath: path.join(input.controlDir, 'ledger.json'),
    }),
    bridge: input.bridge,
    manifestReader: new StaticManifestReader(),
  });
}

class StaticManifestReader implements RuntimeStoreManifestReader {
  async read(): Promise<RuntimeStoreManifestEvidence> {
    return {
      highWatermark: 0,
      activeRunId: null,
      capabilitySnapshotId: null,
    };
  }
}

async function waitUntil(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  pollMs = 500
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
}

async function assertExecutable(filePath: string): Promise<void> {
  await fs.access(filePath, fsConstants.X_OK);
}

function withBunOnPath(pathValue: string): string {
  const bunDir = '/Users/belief/.bun/bin';
  return pathValue.split(path.delimiter).includes(bunDir)
    ? pathValue
    : `${bunDir}${path.delimiter}${pathValue}`;
}

function createStableBridgeEnv(): NodeJS.ProcessEnv {
  const realHome = os.userInfo().homedir;
  const env = applyOpenCodeAutoUpdatePolicy({ ...process.env });
  return {
    ...env,
    HOME: realHome,
    USERPROFILE: realHome,
  };
}

function hasOpenCodeRuntimeHandle(member: {
  readonly pid?: number;
  readonly runtimePid?: number;
  readonly runtimeSessionId?: string;
}): boolean {
  return (
    (typeof member.pid === 'number' && member.pid > 0) ||
    (typeof member.runtimePid === 'number' && member.runtimePid > 0) ||
    (typeof member.runtimeSessionId === 'string' && member.runtimeSessionId.trim().length > 0)
  );
}
