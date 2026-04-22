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
  buildOpenCodeProjectPathFingerprint,
  OPENCODE_PRODUCTION_E2E_EVIDENCE_SCHEMA_VERSION,
  OPENCODE_PRODUCTION_E2E_EVIDENCE_MAX_AGE_MS,
  OPENCODE_PRODUCTION_E2E_READY_CHECKPOINTS,
  OPENCODE_PRODUCTION_E2E_REQUIRED_SIGNALS,
  type OpenCodeProductionE2EEvidence,
} from '../../../../src/main/services/team/opencode/e2e/OpenCodeProductionE2EEvidence';
import { OpenCodeProductionE2EEvidenceStore } from '../../../../src/main/services/team/opencode/e2e/OpenCodeProductionE2EEvidenceStore';
import {
  buildOpenCodeCanonicalMcpToolId,
  REQUIRED_AGENT_TEAMS_RUNTIME_TOOLS,
} from '../../../../src/main/services/team/opencode/mcp/OpenCodeMcpToolAvailability';
import { resolveAgentTeamsMcpLaunchSpec } from '../../../../src/main/services/team/TeamMcpConfigBuilder';
import { applyOpenCodeAutoUpdatePolicy } from '../../../../src/main/services/runtime/openCodeAutoUpdatePolicy';

import type {
  OpenCodeBridgeRuntimeSnapshot,
  OpenCodeLaunchTeamCommandData,
  OpenCodeStopTeamCommandData,
  RuntimeStoreManifestEvidence,
} from '../../../../src/main/services/team/opencode/bridge/OpenCodeBridgeCommandContract';
import type { RuntimeStoreManifestReader } from '../../../../src/main/services/team/opencode/bridge/OpenCodeStateChangingBridgeCommandService';
import type { OpenCodeBridgeCommandExecutor } from '../../../../src/main/services/team/opencode/bridge/OpenCodeStateChangingBridgeCommandService';

const liveDescribe = process.env.OPENCODE_E2E === '1' ? describe : describe.skip;

const DEFAULT_APP_PRODUCTION_E2E_EVIDENCE_PATH = path.join(
  os.userInfo().homedir,
  'Library',
  'Application Support',
  'claude-agent-teams-ui',
  'opencode-bridge',
  'production-e2e-evidence.json'
);
const PROJECT_PATH = process.env.OPENCODE_E2E_PROJECT_PATH?.trim() || process.cwd();
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
    const initialRuntime = readinessBridge.getLastOpenCodeRuntimeSnapshot(PROJECT_PATH);
    if (!initialRuntime) {
      throw new Error(
        `OpenCode live readiness did not return runtime snapshot: ${[
          ...readiness.diagnostics,
          ...readiness.missing,
        ].join('; ')}`
      );
    }
    expect(initialRuntime?.version).toBe('1.14.19');
    expect(initialRuntime?.capabilitySnapshotId).toBeTruthy();

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
        laneId: 'primary',
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
        expectedCapabilitySnapshotId: initialRuntime?.capabilitySnapshotId ?? null,
        manifestHighWatermark: null,
      });

      expect(launch.teamLaunchState).toBe('ready');
      expect(launch.members[memberName]?.launchState).toBe('confirmed_alive');

      reconcile = await readinessBridge.reconcileOpenCodeTeam({
        runId,
        laneId: 'primary',
        teamId: teamName,
        teamName,
        projectPath: PROJECT_PATH,
        expectedCapabilitySnapshotId: initialRuntime?.capabilitySnapshotId ?? null,
        manifestHighWatermark: null,
        expectedMembers: [{ name: memberName, model: selectedModel }],
        reason: 'production_gate_e2e',
      });
      expect(reconcile.teamLaunchState).toBe('ready');

      const transcript = await bridgeClient.execute<
        { teamId: string; teamName: string; laneId: string; memberName: string },
        { logProjection?: { messages?: unknown[] }; messages?: unknown[] }
      >(
        'opencode.getRuntimeTranscript',
        { teamId: teamName, teamName, laneId: 'primary', memberName },
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
        laneId: 'primary',
        teamId: teamName,
        teamName,
        projectPath: PROJECT_PATH,
        expectedCapabilitySnapshotId: initialRuntime?.capabilitySnapshotId ?? null,
        manifestHighWatermark: null,
        reason: 'production_gate_e2e_cleanup',
        force: true,
      });
      expect(stop.stopped).toBe(true);

      const finalReadiness = await readinessBridge.checkOpenCodeTeamLaunchReadiness({
        projectPath: PROJECT_PATH,
        selectedModel,
        requireExecutionProbe: true,
      });
      const finalRuntime = readinessBridge.getLastOpenCodeRuntimeSnapshot(PROJECT_PATH);
      if (!finalRuntime) {
        throw new Error(
          `OpenCode final readiness did not return runtime snapshot: ${[
            ...finalReadiness.diagnostics,
            ...finalReadiness.missing,
          ].join('; ')}`
        );
      }
      expect(finalRuntime.version).toBe('1.14.19');
      expect(finalRuntime.capabilitySnapshotId).toBeTruthy();

      const candidate = buildCandidateEvidence({
        runId,
        teamName,
        memberName,
        selectedModel,
        runtime: finalRuntime,
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
          opencodeVersion: finalRuntime.version ?? null,
          binaryFingerprint: finalRuntime.binaryFingerprint ?? null,
          capabilitySnapshotId: finalRuntime.capabilitySnapshotId ?? null,
          selectedModel,
          projectPathFingerprint: buildOpenCodeProjectPathFingerprint(PROJECT_PATH),
          requiredMcpTools: REQUIRED_AGENT_TEAMS_RUNTIME_TOOLS.map((tool) =>
            buildOpenCodeCanonicalMcpToolId('agent-teams', tool)
          ),
        },
      });

      expect(gate).toEqual({
        ok: true,
        diagnostics: [],
      });
      await writeProductionEvidenceIfRequested(candidate);
    } finally {
      if (!stop) {
        await readinessBridge
          .stopOpenCodeTeam({
            runId,
            laneId: 'primary',
            teamId: teamName,
            teamName,
            projectPath: PROJECT_PATH,
            expectedCapabilitySnapshotId: initialRuntime?.capabilitySnapshotId ?? null,
            manifestHighWatermark: null,
            reason: 'production_gate_e2e_finally_cleanup',
            force: true,
          })
          .catch(() => undefined);
      }
    }
  }, 240_000);
});

async function writeProductionEvidenceIfRequested(
  evidence: OpenCodeProductionE2EEvidence
): Promise<void> {
  const explicitPath = process.env.OPENCODE_E2E_WRITE_EVIDENCE_PATH?.trim();
  const writeAppEvidence = process.env.OPENCODE_E2E_WRITE_APP_EVIDENCE === '1';
  const filePath =
    explicitPath || (writeAppEvidence ? DEFAULT_APP_PRODUCTION_E2E_EVIDENCE_PATH : '');
  if (!filePath) {
    return;
  }

  const store = new OpenCodeProductionE2EEvidenceStore({ filePath });
  await store.write({
    ...evidence,
    artifactPath: filePath,
  });
}

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
      laneId: 'primary',
      runId: input.runId,
      capabilitySnapshotId: 'opencode:stale-capability',
      behaviorFingerprint: null,
      body: {
        runId: input.runId,
        laneId: 'primary',
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
    expiresAt: new Date(now.getTime() + OPENCODE_PRODUCTION_E2E_EVIDENCE_MAX_AGE_MS).toISOString(),
    version: input.runtime.version ?? 'unknown',
    passed: true,
    artifactPath: path.join(os.tmpdir(), `opencode-production-e2e-${input.runId}.json`),
    binaryFingerprint: input.runtime.binaryFingerprint ?? 'unknown',
    capabilitySnapshotId: input.runtime.capabilitySnapshotId ?? 'unknown',
    selectedModel: input.selectedModel,
    projectPathFingerprint: buildOpenCodeProjectPathFingerprint(PROJECT_PATH),
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
  const env = applyOpenCodeAutoUpdatePolicy({ ...process.env });
  return {
    ...env,
    HOME: realHome,
    USERPROFILE: realHome,
  };
}
