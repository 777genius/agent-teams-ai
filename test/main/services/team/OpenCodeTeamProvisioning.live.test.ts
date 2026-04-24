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
import { TeamProvisioningService } from '../../../../src/main/services/team/TeamProvisioningService';
import { TeamRuntimeAdapterRegistry } from '../../../../src/main/services/team/runtime/TeamRuntimeAdapter';
import { OpenCodeTeamRuntimeAdapter } from '../../../../src/main/services/team/runtime/OpenCodeTeamRuntimeAdapter';
import { resolveAgentTeamsMcpLaunchSpec } from '../../../../src/main/services/team/TeamMcpConfigBuilder';
import { readOpenCodeRuntimeLaneIndex } from '../../../../src/main/services/team/opencode/store/OpenCodeRuntimeManifestEvidenceReader';
import { applyOpenCodeAutoUpdatePolicy } from '../../../../src/main/services/runtime/openCodeAutoUpdatePolicy';
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
const DEFAULT_ORCHESTRATOR_CLI = '/Users/belief/dev/projects/claude/agent_teams_orchestrator/cli';
const DEFAULT_MODEL = 'opencode/big-pickle';

liveDescribe('OpenCode team provisioning live e2e', () => {
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

      const runtimeSnapshot = await svc.getTeamAgentRuntimeSnapshot(teamName);
      expect(runtimeSnapshot.members.alice).toMatchObject({
        alive: true,
        runtimeModel: selectedModel,
      });
      expect(runtimeSnapshot.members.bob).toMatchObject({
        alive: true,
        runtimeModel: selectedModel,
      });
      await expect(
        readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)
      ).resolves.toMatchObject({
        lanes: {
          primary: {
            state: 'active',
          },
        },
      });

      svc.stopTeam(teamName);
      await waitUntil(async () => {
        const laneIndex = await readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName);
        return Object.keys(laneIndex.lanes).length === 0;
      }, 90_000);
    } finally {
      svc.stopTeam(teamName);
    }
  }, 300_000);
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
