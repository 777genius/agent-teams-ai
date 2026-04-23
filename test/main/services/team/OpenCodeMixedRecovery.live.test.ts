import { constants as fsConstants, promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
import {
  getTeamBootstrapStatePath,
} from '../../../../src/main/services/team/TeamBootstrapStateReader';
import { TeamMembersMetaStore } from '../../../../src/main/services/team/TeamMembersMetaStore';
import { TeamMetaStore } from '../../../../src/main/services/team/TeamMetaStore';
import { TeamProvisioningService } from '../../../../src/main/services/team/TeamProvisioningService';
import { TeamRuntimeAdapterRegistry } from '../../../../src/main/services/team/runtime/TeamRuntimeAdapter';
import { OpenCodeTeamRuntimeAdapter } from '../../../../src/main/services/team/runtime/OpenCodeTeamRuntimeAdapter';
import { resolveAgentTeamsMcpLaunchSpec } from '../../../../src/main/services/team/TeamMcpConfigBuilder';
import {
  readOpenCodeRuntimeLaneIndex,
  upsertOpenCodeRuntimeLaneIndexEntry,
} from '../../../../src/main/services/team/opencode/store/OpenCodeRuntimeManifestEvidenceReader';
import { applyOpenCodeAutoUpdatePolicy } from '../../../../src/main/services/runtime/openCodeAutoUpdatePolicy';
import {
  getTeamsBasePath,
  setClaudeBasePathOverride,
} from '../../../../src/main/utils/pathDecoder';

import type {
  TeamRuntimeLaunchInput,
  TeamRuntimeStopInput,
} from '../../../../src/main/services/team/runtime/TeamRuntimeAdapter';
import type { RuntimeStoreManifestEvidence } from '../../../../src/main/services/team/opencode/bridge/OpenCodeBridgeCommandContract';
import type { RuntimeStoreManifestReader } from '../../../../src/main/services/team/opencode/bridge/OpenCodeStateChangingBridgeCommandService';
import type { OpenCodeBridgeCommandExecutor } from '../../../../src/main/services/team/opencode/bridge/OpenCodeStateChangingBridgeCommandService';

const liveDescribe =
  process.env.OPENCODE_E2E === '1' && process.env.OPENCODE_E2E_MIXED_RECOVERY === '1'
    ? describe
    : describe.skip;
const liveMultiLaneIt = process.env.OPENCODE_E2E_MIXED_RECOVERY_MULTI === '1' ? it : it.skip;

const PROJECT_PATH = process.env.OPENCODE_E2E_PROJECT_PATH?.trim() || process.cwd();
const DEFAULT_ORCHESTRATOR_CLI = '/Users/belief/dev/projects/claude/agent_teams_orchestrator/cli';
const DEFAULT_MODEL = 'opencode/big-pickle';

liveDescribe('OpenCode mixed recovery live e2e', () => {
  let tempDir: string;
  let tempClaudeRoot: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-mixed-recovery-e2e-'));
    tempClaudeRoot = path.join(tempDir, '.claude');
    await fs.mkdir(tempClaudeRoot, { recursive: true });
    setClaudeBasePathOverride(tempClaudeRoot);
  });

  afterEach(async () => {
    setClaudeBasePathOverride(null);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it(
    'recovers active mixed OpenCode side lanes from live runtime reconcile instead of marking them never spawned',
    async () => {
      const selectedModel = process.env.OPENCODE_E2E_MODEL?.trim() || DEFAULT_MODEL;
      const orchestratorCli =
        process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH?.trim() || DEFAULT_ORCHESTRATOR_CLI;
      await assertExecutable(orchestratorCli);

      const mcpLaunchSpec = await resolveAgentTeamsMcpLaunchSpec();
      const bridgeEnv = {
        ...createStableBridgeEnv(),
        PATH: withBunOnPath(process.env.PATH ?? ''),
        XDG_DATA_HOME: path.join(tempDir, 'xdg-data-single'),
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND: mcpLaunchSpec.command,
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY: mcpLaunchSpec.args[0] ?? '',
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
      const adapter = new OpenCodeTeamRuntimeAdapter(readinessBridge, {
        launchMode: 'dogfood',
      });
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

      const teamName = `mixed-opencode-recovery-${Date.now()}`;
      const launchedLanes: TeamRuntimeLaunchInput[] = [];

      await writeMixedRecoveryFixtures({
        teamName,
        projectPath: PROJECT_PATH,
        secondaryMembers: ['bob'],
      });

      try {
        const launchInput = createSecondaryLaneLaunchInput({
          teamName,
          laneId: 'secondary:opencode:bob',
          memberName: 'bob',
          selectedModel,
        });
        launchedLanes.push(launchInput);
        const launchResult = await adapter.launch(launchInput);
        expect(launchResult.teamLaunchState).toBe('clean_success');
        expect(launchResult.members.bob).toMatchObject({
          launchState: 'confirmed_alive',
          runtimeAlive: true,
          bootstrapConfirmed: true,
        });

        await upsertOpenCodeRuntimeLaneIndexEntry({
          teamsBasePath: getTeamsBasePath(),
          teamName,
          laneId: launchInput.laneId ?? 'secondary:opencode:bob',
          state: 'active',
        });

        const result = await svc.getMemberSpawnStatuses(teamName);

        expect(result.expectedMembers).toEqual(expect.arrayContaining(['alice', 'bob']));
        expect(result.statuses.bob).toMatchObject({
          status: 'online',
          launchState: 'confirmed_alive',
        });
        expect(result.statuses.bob.error).toBeUndefined();
        await expect(readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)).resolves.toMatchObject(
          {
            lanes: {
              [launchInput.laneId ?? 'secondary:opencode:bob']: {
                state: 'active',
              },
            },
          }
        );
      } finally {
        for (const launchInput of launchedLanes) {
          await adapter
            .stop({
              runId: launchInput.runId,
              laneId: launchInput.laneId,
              teamName,
              cwd: PROJECT_PATH,
              providerId: 'opencode',
              reason: 'cleanup',
              previousLaunchState: null,
              force: true,
            } satisfies TeamRuntimeStopInput)
            .catch(() => undefined);
        }
      }
    },
    240_000
  );

  liveMultiLaneIt(
    'recovers multiple active mixed OpenCode side lanes from live runtime reconcile',
    async () => {
      const selectedModel = process.env.OPENCODE_E2E_MODEL?.trim() || DEFAULT_MODEL;
      const orchestratorCli =
        process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH?.trim() || DEFAULT_ORCHESTRATOR_CLI;
      await assertExecutable(orchestratorCli);

      const mcpLaunchSpec = await resolveAgentTeamsMcpLaunchSpec();
      const bridgeEnv = {
        ...createStableBridgeEnv(),
        PATH: withBunOnPath(process.env.PATH ?? ''),
        XDG_DATA_HOME: path.join(tempDir, 'xdg-data-multi'),
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND: mcpLaunchSpec.command,
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY: mcpLaunchSpec.args[0] ?? '',
      };
      const bridgeClient = new OpenCodeBridgeCommandClient({
        binaryPath: orchestratorCli,
        tempDirectory: path.join(tempDir, 'bridge-input-multi'),
        env: bridgeEnv,
      });
      const stateChangingCommands = createStateChangingCommands({
        bridge: bridgeClient,
        controlDir: path.join(tempDir, 'control-multi'),
      });
      const readinessBridge = new OpenCodeReadinessBridge(bridgeClient, {
        stateChangingCommands,
        timeoutMs: 180_000,
        launchTimeoutMs: 180_000,
        reconcileTimeoutMs: 90_000,
        stopTimeoutMs: 90_000,
      });
      const adapter = new OpenCodeTeamRuntimeAdapter(readinessBridge, {
        launchMode: 'dogfood',
      });
      const svc = new TeamProvisioningService();
      svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));

      const teamName = `mixed-opencode-recovery-multi-${Date.now()}`;
      const sideMembers = ['bob', 'jack', 'tom'] as const;
      const launchedLanes: TeamRuntimeLaunchInput[] = [];

      await writeMixedRecoveryFixtures({
        teamName,
        projectPath: PROJECT_PATH,
        secondaryMembers: [...sideMembers],
      });

      try {
        for (const memberName of sideMembers) {
          const launchInput = createSecondaryLaneLaunchInput({
            teamName,
            laneId: `secondary:opencode:${memberName}`,
            memberName,
            selectedModel,
          });
          launchedLanes.push(launchInput);
          const launchResult = await adapter.launch(launchInput);
          expect(launchResult.teamLaunchState).toBe('clean_success');
          expect(launchResult.members[memberName]).toMatchObject({
            launchState: 'confirmed_alive',
            runtimeAlive: true,
            bootstrapConfirmed: true,
          });
          await upsertOpenCodeRuntimeLaneIndexEntry({
            teamsBasePath: getTeamsBasePath(),
            teamName,
            laneId: launchInput.laneId ?? `secondary:opencode:${memberName}`,
            state: 'active',
          });
        }

        const result = await svc.getMemberSpawnStatuses(teamName);

        expect(result.expectedMembers).toEqual(
          expect.arrayContaining(['alice', 'bob', 'jack', 'tom'])
        );
        for (const memberName of sideMembers) {
          expect(result.statuses[memberName]).toMatchObject({
            status: 'online',
            launchState: 'confirmed_alive',
          });
          expect(result.statuses[memberName]?.error).toBeUndefined();
        }
        await expect(readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)).resolves.toMatchObject(
          {
            lanes: Object.fromEntries(
              sideMembers.map((memberName) => [
                `secondary:opencode:${memberName}`,
                { state: 'active' },
              ])
            ),
          }
        );
      } finally {
        for (const launchInput of launchedLanes) {
          await adapter
            .stop({
              runId: launchInput.runId,
              laneId: launchInput.laneId,
              teamName,
              cwd: PROJECT_PATH,
              providerId: 'opencode',
              reason: 'cleanup',
              previousLaunchState: null,
              force: true,
            } satisfies TeamRuntimeStopInput)
            .catch(() => undefined);
        }
      }
    },
    420_000
  );
});

function createSecondaryLaneLaunchInput(input: {
  teamName: string;
  laneId: string;
  memberName: string;
  selectedModel: string;
}): TeamRuntimeLaunchInput {
  return {
    runId: `mixed-opencode-recovery-${Date.now()}`,
    laneId: input.laneId,
    teamName: input.teamName,
    cwd: PROJECT_PATH,
    prompt: 'Mixed OpenCode recovery live e2e',
    providerId: 'opencode',
    model: input.selectedModel,
    skipPermissions: true,
    expectedMembers: [
      {
        name: input.memberName,
        role: 'Developer',
        providerId: 'opencode',
        model: input.selectedModel,
        cwd: PROJECT_PATH,
      },
    ],
    previousLaunchState: null,
  };
}

async function writeMixedRecoveryFixtures(input: {
  teamName: string;
  projectPath: string;
  secondaryMembers: string[];
}): Promise<void> {
  const teamDir = path.join(getTeamsBasePath(), input.teamName);
  await fs.mkdir(teamDir, { recursive: true });

  await new TeamMetaStore().writeMeta(input.teamName, {
    cwd: input.projectPath,
    providerId: 'codex',
    providerBackendId: 'codex-native',
    model: 'gpt-5.4',
    createdAt: Date.now(),
  });
  await new TeamMembersMetaStore().writeMembers(
    input.teamName,
    [
      {
        name: 'alice',
        role: 'Reviewer',
        providerId: 'codex',
        model: 'gpt-5.4-mini',
      },
      ...input.secondaryMembers.map((memberName) => ({
        name: memberName,
        role: 'Developer',
        providerId: 'opencode' as const,
        model: process.env.OPENCODE_E2E_MODEL?.trim() || DEFAULT_MODEL,
      })),
    ],
    {
      providerBackendId: 'codex-native',
    }
  );
  await fs.writeFile(
    path.join(teamDir, 'config.json'),
    `${JSON.stringify(
      {
        name: input.teamName,
        projectPath: input.projectPath,
        leadSessionId: 'lead-session',
        members: [
          { name: 'team-lead', agentType: 'team-lead' },
          { name: 'alice' },
        ],
      },
      null,
      2
    )}\n`,
    'utf8'
  );
  await fs.writeFile(
    getTeamBootstrapStatePath(input.teamName),
    `${JSON.stringify(
      {
        version: 1,
        teamName: input.teamName,
        updatedAt: new Date().toISOString(),
        phase: 'completed',
        members: [
          {
            name: 'alice',
            status: 'registered',
            lastAttemptAt: Date.now(),
            lastObservedAt: Date.now(),
          },
        ],
        terminal: {
          status: 'completed',
        },
      },
      null,
      2
    )}\n`,
    'utf8'
  );
}

function createStateChangingCommands(input: {
  bridge: OpenCodeBridgeCommandExecutor;
  controlDir: string;
}): OpenCodeStateChangingBridgeCommandService {
  const clientIdentity = createOpenCodeBridgeClientIdentity({
    appVersion: '1.3.0-e2e',
    gitSha: null,
    buildId: 'opencode-mixed-recovery-e2e',
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
