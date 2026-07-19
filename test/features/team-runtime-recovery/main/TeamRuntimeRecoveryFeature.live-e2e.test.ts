import { constants as fsConstants, promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createTeamRuntimeRecoveryFeature } from '@features/team-runtime-recovery/main/composition/createTeamRuntimeRecoveryFeature';
import { applyOpenCodeAutoUpdatePolicy } from '@main/services/runtime/openCodeAutoUpdatePolicy';
import { OpenCodeBridgeCommandClient } from '@main/services/team/opencode/bridge/OpenCodeBridgeCommandClient';
import {
  createOpenCodeBridgeCommandLeaseStore,
  createOpenCodeBridgeCommandLedgerStore,
} from '@main/services/team/opencode/bridge/OpenCodeBridgeCommandLedgerStore';
import {
  createOpenCodeBridgeClientIdentity,
  OpenCodeBridgeCommandHandshakePort,
} from '@main/services/team/opencode/bridge/OpenCodeBridgeHandshakeClient';
import { OpenCodeReadinessBridge } from '@main/services/team/opencode/bridge/OpenCodeReadinessBridge';
import { OpenCodeStateChangingBridgeCommandService } from '@main/services/team/opencode/bridge/OpenCodeStateChangingBridgeCommandService';
import { OpenCodeTeamRuntimeAdapter } from '@main/services/team/runtime/OpenCodeTeamRuntimeAdapter';
import { TeamRuntimeAdapterRegistry } from '@main/services/team/runtime/TeamRuntimeAdapter';
import { TeamInboxReader } from '@main/services/team/TeamInboxReader';
import { TeamInboxWriter } from '@main/services/team/TeamInboxWriter';
import { resolveAgentTeamsMcpLaunchSpec } from '@main/services/team/TeamMcpConfigBuilder';
import { TeamProvisioningService } from '@main/services/team/TeamProvisioningService';
import { getTeamsBasePath, setClaudeBasePathOverride } from '@main/utils/pathDecoder';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { TeamRuntimeRecoveryFeatureFacade } from '@features/team-runtime-recovery/main/composition/createTeamRuntimeRecoveryFeature';
import type { RuntimeStoreManifestEvidence } from '@main/services/team/opencode/bridge/OpenCodeBridgeCommandContract';
import type { RuntimeStoreManifestReader } from '@main/services/team/opencode/bridge/OpenCodeStateChangingBridgeCommandService';
import type { OpenCodeBridgeCommandExecutor } from '@main/services/team/opencode/bridge/OpenCodeStateChangingBridgeCommandService';
import type { TeamNotificationPayload } from '@main/utils/teamNotificationBuilder';

const LIVE_ENABLED = process.env.TEAM_RUNTIME_RECOVERY_LIVE_E2E === '1';
const LIVE_PROJECT_PATH = process.env.TEAM_RUNTIME_RECOVERY_LIVE_PROJECT_PATH?.trim();
const DEFAULT_ORCHESTRATOR_CLI =
  '/Users/belief/dev/projects/claude/agent_teams_orchestrator/cli-source';
const DEFAULT_MODEL = 'github-copilot/gpt-4.1';
const SANDBOX_MARKER = 'Runtime recovery live smoke sandbox';

const liveDescribe = LIVE_ENABLED && LIVE_PROJECT_PATH ? describe : describe.skip;

liveDescribe('TeamRuntimeRecoveryFeature live provider E2E', () => {
  let tempDir: string;
  let tempClaudeRoot: string;
  let service: TeamProvisioningService | null;
  let readinessBridge: OpenCodeReadinessBridge | null;
  let feature: TeamRuntimeRecoveryFeatureFacade | null;
  let teamName: string | null;
  let logs: string[];

  beforeEach(async () => {
    await assertDisposableSandboxProject(LIVE_PROJECT_PATH!);
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'team-runtime-recovery-live-'));
    tempClaudeRoot = path.join(tempDir, '.claude');
    await fs.mkdir(tempClaudeRoot, { recursive: true });
    setClaudeBasePathOverride(tempClaudeRoot);
    service = null;
    readinessBridge = null;
    feature = null;
    teamName = null;
    logs = [];
  });

  afterEach(async () => {
    await feature?.dispose().catch(() => undefined);
    service?.setTeamChangeEmitter(null);
    if (service && teamName) {
      await service.stopTeam(teamName).catch(() => undefined);
    }
    if (readinessBridge) {
      await readinessBridge
        .cleanupOpenCodeHosts({
          reason: 'team-runtime-recovery-live-e2e-cleanup',
          mode: 'force',
          projectPath: LIVE_PROJECT_PATH!,
          staleAgeMs: null,
          leaseStaleAgeMs: null,
        })
        .catch(() => undefined);
    }
    setClaudeBasePathOverride(null);
    if (process.env.TEAM_RUNTIME_RECOVERY_LIVE_KEEP_TEMP === '1') {
      process.stderr.write(`[TeamRuntimeRecoveryFeature.live] preserved ${tempDir}\n`);
    } else {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }, 180_000);

  it('resumes a real OpenCode teammate after a structured 529 signal', async () => {
    const orchestratorCli =
      process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH?.trim() || DEFAULT_ORCHESTRATOR_CLI;
    const selectedModel = process.env.TEAM_RUNTIME_RECOVERY_LIVE_MODEL?.trim() || DEFAULT_MODEL;
    await fs.access(orchestratorCli, fsConstants.X_OK);

    const mcpLaunchSpec = await resolveAgentTeamsMcpLaunchSpec();
    const bridgeClient = new OpenCodeBridgeCommandClient({
      binaryPath: orchestratorCli,
      tempDirectory: path.join(tempDir, 'bridge-input'),
      env: {
        ...createStableBridgeEnv(),
        AGENT_TEAMS_MCP_CLAUDE_DIR: tempClaudeRoot,
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND: mcpLaunchSpec.command,
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY: mcpLaunchSpec.args[0] ?? '',
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ARGS_JSON: JSON.stringify(mcpLaunchSpec.args),
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENV_JSON: JSON.stringify(mcpLaunchSpec.env ?? {}),
      },
    });
    const stateChangingCommands = createStateChangingCommands({
      bridge: bridgeClient,
      controlDir: path.join(tempDir, 'control'),
    });
    readinessBridge = new OpenCodeReadinessBridge(bridgeClient, {
      stateChangingCommands,
      timeoutMs: 180_000,
      launchTimeoutMs: 180_000,
      reconcileTimeoutMs: 90_000,
      stopTimeoutMs: 90_000,
    });
    const runtimeAdapter = new OpenCodeTeamRuntimeAdapter(readinessBridge);
    service = new TeamProvisioningService();
    service.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([runtimeAdapter]));

    teamName = `runtime-recovery-live-${Date.now()}`;
    const { runId } = await service.createTeam(
      {
        teamName,
        cwd: LIVE_PROJECT_PATH!,
        providerId: 'opencode',
        model: selectedModel,
        skipPermissions: true,
        members: [
          {
            name: 'alice',
            role: 'Recovery smoke teammate. Do not modify files.',
            providerId: 'opencode',
            model: selectedModel,
          },
        ],
      },
      () => undefined
    );

    const snapshot = await service.getTeamAgentRuntimeSnapshot(teamName);
    expect(snapshot.runId).toBe(runId);
    expect(snapshot.members.alice).toMatchObject({
      alive: true,
      providerId: 'opencode',
      runtimeModel: selectedModel,
      historicalBootstrapConfirmed: true,
    });

    const inboxReader = new TeamInboxReader();
    const inboxWriter = new TeamInboxWriter();
    const notifications: TeamNotificationPayload[] = [];
    const relayResults: Array<
      Awaited<ReturnType<TeamProvisioningService['relayInboxFileToLiveRecipient']>>
    > = [];
    const configManager = {
      getConfig: () => ({
        teamRuntimeRecovery: {
          transientErrorsEnabled: true,
          rateLimitsEnabled: false,
          initialDelaySeconds: 15,
          maxAttempts: 2,
        },
      }),
      onConfigChanged: () => () => undefined,
    };
    feature = createTeamRuntimeRecoveryFeature({
      teamsBasePath: getTeamsBasePath(),
      configManager,
      getCurrentContextId: () => 'runtime-recovery-live-smoke',
      listActiveTeamNames: async () => service!.getAliveTeams(),
      isTeamActive: async (name) => service!.isTeamAlive(name),
      getRuntimeState: (name) => service!.getRuntimeState(name),
      getRuntimeSnapshot: (name) => service!.getTeamAgentRuntimeSnapshot(name),
      getLeadName: async () => 'team-lead',
      getTeamDisplayName: async (name) => name,
      getInboxMessages: (name, memberName) => inboxReader.getMessagesFor(name, memberName),
      inboxWriter,
      relay: async (name, memberName, options) => {
        const result = await service!.relayInboxFileToLiveRecipient(name, memberName, options);
        relayResults.push(result);
        return result;
      },
      getTask: async () => null,
      getMemberAdvisory: async () => null,
      getOpenCodeBusyStatus: (input) => service!.getOpenCodeMemberDeliveryBusyStatus(input),
      addNotification: async (payload) => {
        notifications.push(payload);
      },
      logger: {
        debug: (message, metadata) => logs.push(formatLog('debug', message, metadata)),
        warn: (message, metadata) => logs.push(formatLog('warn', message, metadata)),
        error: (message, metadata) => logs.push(formatLog('error', message, metadata)),
      },
    });
    service.setTeamChangeEmitter((event) => feature?.noteTeamChange(event));
    feature.start();

    const failureMessageId = `runtime-recovery-live-failure-${Date.now()}`;
    await inboxWriter.sendMessage(teamName, {
      member: 'team-lead',
      from: 'alice',
      to: 'team-lead',
      text: 'alice hit a mailbox turn execution error. API Error: 529 overloaded_error',
      source: 'system_notification',
      messageKind: 'agent_error',
      messageId: failureMessageId,
      timestamp: new Date().toISOString(),
      agentError: {
        schemaVersion: 1,
        type: 'api_error',
        phase: 'terminal',
        detail: 'API Error: 529 overloaded_error',
        failedMessageId: `runtime-recovery-live-original-${Date.now()}`,
        ...(snapshot.members.alice?.runtimeSessionId
          ? { runtimeSessionId: snapshot.members.alice.runtimeSessionId }
          : {}),
        bootstrapRunId: runId,
        innerRecoveryAttempts: 0,
      },
    });
    feature.noteTeamChange({ type: 'inbox', teamName });

    const completedJob = await waitForCompletedRecovery({
      statePath: path.join(getTeamsBasePath(), teamName, '.team-runtime-recovery', 'state.json'),
      failureMessageId,
      onPoll: () => feature?.noteTeamChange({ type: 'member-turn-settled', teamName: teamName! }),
      diagnostics: () => logs.join('\n'),
      timeoutMs: 600_000,
    });
    expect(completedJob.attempt).toBe(1);
    expect(completedJob.recoveryMessageId).toEqual(expect.any(String));

    const recoveryMessages = await inboxReader.getMessagesFor(teamName, 'alice');
    const recoveryMessage = recoveryMessages.find(
      (message) => message.messageId === completedJob.recoveryMessageId
    );
    expect(recoveryMessage).toMatchObject({
      messageKind: 'runtime_recovery_nudge',
      runtimeRecovery: {
        schemaVersion: 1,
        attempt: 1,
        reasonCode: 'provider_overloaded',
      },
    });

    const proof = relayResults.find(
      (result) => result.lastDelivery?.responseState?.startsWith('responded_') === true
    );
    expect(proof).toMatchObject({
      kind: 'opencode_member',
      lastDelivery: {
        delivered: true,
      },
    });
    if (!proof) {
      throw new Error('Live recovery relay did not produce response proof');
    }
    expect(proof.lastDelivery?.responseState).toMatch(/^responded_/u);
    expect(notifications.length).toBeGreaterThan(0);
  }, 900_000);
});

function createStateChangingCommands(input: {
  bridge: OpenCodeBridgeCommandExecutor;
  controlDir: string;
}): OpenCodeStateChangingBridgeCommandService {
  const clientIdentity = createOpenCodeBridgeClientIdentity({
    appVersion: '1.3.0-live-e2e',
    gitSha: null,
    buildId: 'team-runtime-recovery-live-e2e',
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

function createStableBridgeEnv(): NodeJS.ProcessEnv {
  const realHome = os.userInfo().homedir;
  return {
    ...applyOpenCodeAutoUpdatePolicy({ ...process.env }),
    HOME: realHome,
    USERPROFILE: realHome,
    OPENCODE_DISABLE_AUTOUPDATE: '1',
  };
}

async function assertDisposableSandboxProject(projectPath: string): Promise<void> {
  const [realProjectPath, realTempPath] = await Promise.all([
    fs.realpath(projectPath),
    fs.realpath(os.tmpdir()),
  ]);
  if (
    realProjectPath !== realTempPath &&
    !realProjectPath.startsWith(`${realTempPath}${path.sep}`)
  ) {
    throw new Error(`Live recovery smoke project must be inside ${realTempPath}`);
  }
  const marker = await fs.readFile(path.join(realProjectPath, 'README.md'), 'utf8');
  if (!marker.includes(SANDBOX_MARKER)) {
    throw new Error(`Live recovery smoke project is missing marker: ${SANDBOX_MARKER}`);
  }
}

interface PersistedRecoveryJob {
  signal?: { sourceMessageId?: string };
  status?: string;
  attempt?: number;
  recoveryMessageId?: string;
}

async function waitForCompletedRecovery(input: {
  statePath: string;
  failureMessageId: string;
  timeoutMs: number;
  onPoll(): void;
  diagnostics(): string;
}): Promise<Required<Pick<PersistedRecoveryJob, 'attempt' | 'recoveryMessageId'>>> {
  const deadline = Date.now() + input.timeoutMs;
  let lastState = 'state file not created';
  let lastReconcileAt = 0;
  while (Date.now() < deadline) {
    if (Date.now() - lastReconcileAt >= 10_000) {
      lastReconcileAt = Date.now();
      input.onPoll();
    }
    try {
      const parsed = JSON.parse(await fs.readFile(input.statePath, 'utf8')) as {
        jobs?: PersistedRecoveryJob[];
      };
      lastState = JSON.stringify(parsed);
      const job = parsed.jobs?.find(
        (candidate) => candidate.signal?.sourceMessageId === input.failureMessageId
      );
      if (
        job?.status === 'completed' &&
        typeof job.attempt === 'number' &&
        typeof job.recoveryMessageId === 'string'
      ) {
        return { attempt: job.attempt, recoveryMessageId: job.recoveryMessageId };
      }
      if (job?.status === 'failed_terminal' || job?.status === 'outcome_unknown') {
        throw new Error(`Recovery reached terminal status ${job.status}: ${lastState}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(
    `Timed out waiting for live recovery completion. Last state: ${lastState}\n${input.diagnostics()}`
  );
}

function formatLog(level: string, message: string, metadata?: Record<string, unknown>): string {
  return `${level}: ${message}${metadata ? ` ${JSON.stringify(metadata)}` : ''}`;
}
