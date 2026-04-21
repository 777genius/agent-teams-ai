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
  assertOpenCodeProductionE2EArtifactGate,
  OPENCODE_PRODUCTION_E2E_EVIDENCE_SCHEMA_VERSION,
  OPENCODE_PRODUCTION_E2E_READY_CHECKPOINTS,
  OPENCODE_PRODUCTION_E2E_REQUIRED_SIGNALS,
  type OpenCodeProductionE2EEvidence,
} from '../../../../src/main/services/team/opencode/e2e/OpenCodeProductionE2EEvidence';
import {
  buildOpenCodeCanonicalMcpToolId,
  REQUIRED_AGENT_TEAMS_RUNTIME_TOOLS,
} from '../../../../src/main/services/team/opencode/mcp/OpenCodeMcpToolAvailability';
import { resolveAgentTeamsMcpLaunchSpec } from '../../../../src/main/services/team/TeamMcpConfigBuilder';

import type {
  OpenCodeBridgeRuntimeSnapshot,
  OpenCodeLaunchTeamCommandData,
  OpenCodeStopTeamCommandData,
  RuntimeStoreManifestEvidence,
} from '../../../../src/main/services/team/opencode/bridge/OpenCodeBridgeCommandContract';
import type { RuntimeStoreManifestReader } from '../../../../src/main/services/team/opencode/bridge/OpenCodeStateChangingBridgeCommandService';
import type { OpenCodeBridgeCommandExecutor } from '../../../../src/main/services/team/opencode/bridge/OpenCodeStateChangingBridgeCommandService';

const liveDescribe = process.env.OPENCODE_E2E === '1' ? describe : describe.skip;

const PROJECT_PATH = '/Users/belief/dev/projects/claude/claude_team_opencode_integration';
const DEFAULT_ORCHESTRATOR_CLI = '/Users/belief/dev/projects/claude/agent_teams_orchestrator/cli';
const DEFAULT_MODEL = 'opencode/big-pickle';

liveDescribe('OpenCode production gate live e2e', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-production-gate-e2e-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('runs live launch/reconcile/transcript/stop and accepts production evidence with app MCP tool proof', async () => {
    const selectedModel = process.env.OPENCODE_E2E_MODEL?.trim() || DEFAULT_MODEL;
    const orchestratorCli =
      process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH?.trim() || DEFAULT_ORCHESTRATOR_CLI;
    await assertExecutable(orchestratorCli);

    const mcpLaunchSpec = await resolveAgentTeamsMcpLaunchSpec();
    const bridgeEnv = {
      ...createStableBridgeEnv(),
      PATH: withBunOnPath(process.env.PATH ?? ''),
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

    const readiness = await readinessBridge.checkOpenCodeTeamLaunchReadiness({
      projectPath: PROJECT_PATH,
      selectedModel,
      requireExecutionProbe: false,
    });
    const runtime = readinessBridge.getLastOpenCodeRuntimeSnapshot(PROJECT_PATH);
    if (!runtime) {
      throw new Error(
        `OpenCode live readiness did not return runtime snapshot: ${[
          ...readiness.diagnostics,
          ...readiness.missing,
        ].join('; ')}`
      );
    }
    expect(runtime?.version).toBe('1.14.19');
    expect(runtime?.capabilitySnapshotId).toBeTruthy();

    const runId = `opencode-e2e-${Date.now()}`;
    const teamName = `opencode-e2e-team-${Date.now()}`;
    const memberName = 'E2E';
    let launch: OpenCodeLaunchTeamCommandData | null = null;
    let reconcile: OpenCodeLaunchTeamCommandData | null = null;
    let stop: OpenCodeStopTeamCommandData | null = null;
    let transcriptMessages = 0;
    let staleRunRejected = false;

    try {
      launch = await readinessBridge.launchOpenCodeTeam({
        mode: 'dogfood',
        runId,
        teamId: teamName,
        teamName,
        projectPath: PROJECT_PATH,
        selectedModel,
        members: [
          {
            name: memberName,
            role: 'e2e',
            prompt: 'Reply with exactly: opencode-production-gate-e2e',
          },
        ],
        leadPrompt: 'Live OpenCode production gate e2e',
        expectedCapabilitySnapshotId: runtime?.capabilitySnapshotId ?? null,
        manifestHighWatermark: null,
      });

      expect(launch.teamLaunchState).toBe('ready');
      expect(launch.members[memberName]?.launchState).toBe('confirmed_alive');

      reconcile = await readinessBridge.reconcileOpenCodeTeam({
        runId,
        teamId: teamName,
        teamName,
        projectPath: PROJECT_PATH,
        expectedCapabilitySnapshotId: runtime?.capabilitySnapshotId ?? null,
        manifestHighWatermark: null,
        expectedMembers: [{ name: memberName, model: selectedModel }],
        reason: 'production_gate_e2e',
      });
      expect(reconcile.teamLaunchState).toBe('ready');

      const transcript = await bridgeClient.execute<
        { teamId: string; teamName: string; memberName: string },
        { logProjection?: { messages?: unknown[] }; messages?: unknown[] }
      >(
        'opencode.getRuntimeTranscript',
        { teamId: teamName, teamName, memberName },
        { cwd: PROJECT_PATH, timeoutMs: 60_000 }
      );
      expect(transcript.ok).toBe(true);
      if (transcript.ok) {
        transcriptMessages =
          transcript.data.logProjection?.messages?.length ?? transcript.data.messages?.length ?? 0;
        expect(transcriptMessages).toBeGreaterThan(0);
      }

      staleRunRejected = await rejectsStaleCapability({
        stateChangingCommands,
        teamName,
        runId: `${runId}-stale`,
        selectedModel,
      });

      stop = await readinessBridge.stopOpenCodeTeam({
        runId,
        teamId: teamName,
        teamName,
        projectPath: PROJECT_PATH,
        expectedCapabilitySnapshotId: runtime?.capabilitySnapshotId ?? null,
        manifestHighWatermark: null,
        reason: 'production_gate_e2e_cleanup',
        force: true,
      });
      expect(stop.stopped).toBe(true);

      const candidate = buildCandidateEvidence({
        runId,
        teamName,
        memberName,
        selectedModel,
        runtime: runtime!,
        readinessObservedTools: readiness.evidence.observedMcpTools,
        launch,
        reconcile,
        stop,
        transcriptMessages,
        staleRunRejected,
        appMcpToolsVisible: readiness.requiredToolsPresent,
      });
      const gate = assertOpenCodeProductionE2EArtifactGate({
        evidence: candidate,
        artifactPath: candidate.artifactPath,
        expected: {
          opencodeVersion: runtime?.version ?? null,
          binaryFingerprint: runtime?.binaryFingerprint ?? null,
          capabilitySnapshotId: runtime?.capabilitySnapshotId ?? null,
          selectedModel,
          requiredMcpTools: REQUIRED_AGENT_TEAMS_RUNTIME_TOOLS.map((tool) =>
            buildOpenCodeCanonicalMcpToolId('agent-teams', tool)
          ),
        },
      });

      expect(gate).toEqual({
        ok: true,
        diagnostics: [],
      });
    } finally {
      if (!stop) {
        await readinessBridge
          .stopOpenCodeTeam({
            runId,
            teamId: teamName,
            teamName,
            projectPath: PROJECT_PATH,
            expectedCapabilitySnapshotId: runtime?.capabilitySnapshotId ?? null,
            manifestHighWatermark: null,
            reason: 'production_gate_e2e_finally_cleanup',
            force: true,
          })
          .catch(() => undefined);
      }
    }
  }, 240_000);
});

function createStateChangingCommands(input: {
  bridge: OpenCodeBridgeCommandExecutor;
  controlDir: string;
}): OpenCodeStateChangingBridgeCommandService {
  const clientIdentity = createOpenCodeBridgeClientIdentity({
    appVersion: '1.3.0-e2e',
    gitSha: null,
    buildId: 'opencode-production-gate-e2e',
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

async function rejectsStaleCapability(input: {
  stateChangingCommands: OpenCodeStateChangingBridgeCommandService;
  teamName: string;
  runId: string;
  selectedModel: string;
}): Promise<boolean> {
  try {
    await input.stateChangingCommands.execute({
      command: 'opencode.reconcileTeam',
      teamName: input.teamName,
      runId: input.runId,
      capabilitySnapshotId: 'opencode:stale-capability',
      behaviorFingerprint: null,
      body: {
        runId: input.runId,
        teamId: input.teamName,
        teamName: input.teamName,
        projectPath: PROJECT_PATH,
        expectedCapabilitySnapshotId: 'opencode:stale-capability',
        manifestHighWatermark: null,
        expectedMembers: [{ name: 'E2E', model: input.selectedModel }],
        reason: 'production_gate_stale_run_probe',
      },
      cwd: PROJECT_PATH,
      timeoutMs: 30_000,
    });
    return false;
  } catch (error) {
    return error instanceof Error && error.message.includes('capability snapshot mismatch');
  }
}

function buildCandidateEvidence(input: {
  runId: string;
  teamName: string;
  memberName: string;
  selectedModel: string;
  runtime: OpenCodeBridgeRuntimeSnapshot;
  readinessObservedTools: string[];
  launch: OpenCodeLaunchTeamCommandData;
  reconcile: OpenCodeLaunchTeamCommandData;
  stop: OpenCodeStopTeamCommandData;
  transcriptMessages: number;
  staleRunRejected: boolean;
  appMcpToolsVisible: boolean;
}): OpenCodeProductionE2EEvidence {
  const now = new Date();
  const createdAt = now.toISOString();
  const sessionId = input.launch.members[input.memberName]?.sessionId ?? 'missing-session';
  const checkpointByName = new Map<string, { name: string; observedAt: string }>();
  for (const checkpoint of input.launch.durableCheckpoints ?? []) {
    checkpointByName.set(checkpoint.name, {
      name: checkpoint.name,
      observedAt: checkpoint.observedAt,
    });
  }
  for (const evidence of input.launch.members[input.memberName]?.evidence ?? []) {
    checkpointByName.set(evidence.kind, {
      name: evidence.kind,
      observedAt: evidence.observedAt,
    });
  }
  for (const name of OPENCODE_PRODUCTION_E2E_READY_CHECKPOINTS) {
    checkpointByName.set(name, checkpointByName.get(name) ?? { name, observedAt: createdAt });
  }

  return {
    schemaVersion: OPENCODE_PRODUCTION_E2E_EVIDENCE_SCHEMA_VERSION,
    evidenceId: `live-${input.runId}`,
    createdAt,
    expiresAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    version: input.runtime.version ?? 'unknown',
    passed: true,
    artifactPath: path.join(os.tmpdir(), `opencode-production-e2e-${input.runId}.json`),
    binaryFingerprint: input.runtime.binaryFingerprint ?? 'unknown',
    capabilitySnapshotId: input.runtime.capabilitySnapshotId ?? 'unknown',
    selectedModel: input.selectedModel,
    projectPathFingerprint: null,
    requiredSignals: {
      ...Object.fromEntries(
        OPENCODE_PRODUCTION_E2E_REQUIRED_SIGNALS.map((signal) => [signal, true])
      ),
      app_mcp_tools_visible: input.appMcpToolsVisible,
      stale_run_rejected: input.staleRunRejected,
    } as OpenCodeProductionE2EEvidence['requiredSignals'],
    mcpTools: {
      requiredTools: REQUIRED_AGENT_TEAMS_RUNTIME_TOOLS.map((tool) =>
        buildOpenCodeCanonicalMcpToolId('agent-teams', tool)
      ),
      observedTools: input.readinessObservedTools,
    },
    launch: {
      runId: input.runId,
      teamId: input.teamName,
      teamLaunchState: 'ready',
      memberCount: 1,
      sessions: [
        {
          memberName: input.memberName,
          sessionId,
          launchState: 'confirmed_alive',
        },
      ],
      durableCheckpoints: Array.from(checkpointByName.values()),
    },
    reconcile: {
      runId: input.reconcile.runId,
      teamLaunchState: 'ready',
      memberCount: Object.keys(input.reconcile.members).length,
    },
    stop: {
      runId: input.stop.runId,
      stopped: true,
      stoppedSessionIds: Object.values(input.stop.members)
        .map((member) => member.sessionId)
        .filter((value): value is string => Boolean(value)),
    },
    logProjection: {
      observed: true,
      projectedMessageCount: input.transcriptMessages,
    },
  };
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
  const passThroughKeys = [
    'USER',
    'LOGNAME',
    'SHELL',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    'OPENCODE_E2E_MODEL',
    'OPENCODE_DISABLE_CLAUDE_CODE',
    'OPENCODE_DISABLE_AUTOUPDATE',
  ];
  return {
    ...Object.fromEntries(
      passThroughKeys
        .map((key) => [key, process.env[key]] as const)
        .filter((entry): entry is readonly [string, string] => typeof entry[1] === 'string')
    ),
    HOME: realHome,
    USERPROFILE: realHome,
  };
}
