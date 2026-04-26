import { constants as fsConstants, promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import Fastify from 'fastify';

import { registerTeamRoutes } from '../../../../src/main/http/teams';
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
import type { RuntimeStoreManifestEvidence } from '../../../../src/main/services/team/opencode/bridge/OpenCodeBridgeCommandContract';
import { OpenCodeReadinessBridge } from '../../../../src/main/services/team/opencode/bridge/OpenCodeReadinessBridge';
import {
  OpenCodeStateChangingBridgeCommandService,
  type OpenCodeBridgeCommandExecutor,
  type RuntimeStoreManifestReader,
} from '../../../../src/main/services/team/opencode/bridge/OpenCodeStateChangingBridgeCommandService';
import { readOpenCodeRuntimeLaneIndex } from '../../../../src/main/services/team/opencode/store/OpenCodeRuntimeManifestEvidenceReader';
import { OpenCodeTeamRuntimeAdapter } from '../../../../src/main/services/team/runtime/OpenCodeTeamRuntimeAdapter';
import { TeamRuntimeAdapterRegistry } from '../../../../src/main/services/team/runtime/TeamRuntimeAdapter';
import { resolveAgentTeamsMcpLaunchSpec } from '../../../../src/main/services/team/TeamMcpConfigBuilder';
import { TeamProvisioningService } from '../../../../src/main/services/team/TeamProvisioningService';
import { getClaudeBasePath, getTeamsBasePath } from '../../../../src/main/utils/pathDecoder';

import type { HttpServices } from '../../../../src/main/http';
import type { TaskRef } from '../../../../src/shared/types';

const DEFAULT_ORCHESTRATOR_CLI = '/Users/belief/dev/projects/claude/agent_teams_orchestrator/cli';

export interface InboxMessage {
  from?: string;
  to?: string;
  text?: string;
  messageId?: string;
  read?: boolean;
  taskRefs?: TaskRef[];
  source?: string;
}

export interface OpenCodeLiveHarness {
  bridgeClient: OpenCodeBridgeCommandClient;
  selectedModel: string;
  svc: TeamProvisioningService;
  dispose: () => Promise<void>;
}

export async function createOpenCodeLiveHarness(input: {
  tempDir: string;
  selectedModel: string;
  projectPath?: string;
}): Promise<OpenCodeLiveHarness> {
  const orchestratorCli =
    process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH?.trim() || DEFAULT_ORCHESTRATOR_CLI;
  await assertExecutable(orchestratorCli);

  const svc = new TeamProvisioningService();
  const controlApi = await startLiveTeamControlApi(svc);
  svc.setControlApiBaseUrlResolver(async () => controlApi.baseUrl);

  const mcpLaunchSpec = await resolveAgentTeamsMcpLaunchSpec();
  const stableBridgeEnv = createStableBridgeEnv();
  const bridgeEnv: NodeJS.ProcessEnv = {
    ...stableBridgeEnv,
    PATH: withBunOnPath(process.env.PATH ?? ''),
    AGENT_TEAMS_MCP_CLAUDE_DIR: getClaudeBasePath(),
    CLAUDE_TEAM_CONTROL_URL: controlApi.baseUrl,
    CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND: mcpLaunchSpec.command,
    CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY: mcpLaunchSpec.args[0] ?? '',
  };
  if (process.env.OPENCODE_E2E_USE_REAL_APP_CREDENTIALS !== '1') {
    bridgeEnv.XDG_DATA_HOME = path.join(input.tempDir, 'xdg-data');
  } else if (stableBridgeEnv.XDG_DATA_HOME) {
    bridgeEnv.XDG_DATA_HOME = stableBridgeEnv.XDG_DATA_HOME;
  } else {
    delete bridgeEnv.XDG_DATA_HOME;
  }
  const bridgeClient = new OpenCodeBridgeCommandClient({
    binaryPath: orchestratorCli,
    tempDirectory: path.join(input.tempDir, 'bridge-input'),
    env: bridgeEnv,
  });
  const stateChangingCommands = createStateChangingCommands({
    bridge: bridgeClient,
    controlDir: path.join(input.tempDir, 'control'),
  });
  const readinessBridge = new OpenCodeReadinessBridge(bridgeClient, {
    stateChangingCommands,
    timeoutMs: 180_000,
    launchTimeoutMs: 180_000,
    reconcileTimeoutMs: 90_000,
    stopTimeoutMs: 90_000,
  });
  const adapter = new OpenCodeTeamRuntimeAdapter(readinessBridge);
  svc.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
  return {
    bridgeClient,
    selectedModel: input.selectedModel,
    svc,
    dispose: async () => {
      svc.setControlApiBaseUrlResolver(null);
      if (input.projectPath?.trim()) {
        await readinessBridge
          .cleanupOpenCodeHosts({
            reason: 'test-harness-dispose',
            mode: 'force',
            projectPath: input.projectPath,
            staleAgeMs: null,
            leaseStaleAgeMs: null,
          })
          .catch(() => undefined);
      }
      await controlApi.close();
    },
  };
}

export async function waitForUserInboxReply(
  teamName: string,
  from: string,
  expectedText: string,
  timeoutMs: number
): Promise<InboxMessage> {
  const deadline = Date.now() + timeoutMs;
  const inboxPath = path.join(getTeamsBasePath(), teamName, 'inboxes', 'user.json');
  let lastMessages: InboxMessage[] = [];

  while (Date.now() < deadline) {
    lastMessages = await readInboxMessages(inboxPath);
    const match = lastMessages.find(
      (message) =>
        message.from === from &&
        message.to === 'user' &&
        typeof message.text === 'string' &&
        message.text.includes(expectedText)
    );
    if (match) {
      return match;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }

  throw new Error(
    `Timed out waiting for OpenCode reply in ${inboxPath}. Last messages: ${JSON.stringify(
      lastMessages,
      null,
      2
    )}`
  );
}

export async function waitForMemberInboxMessage(
  teamName: string,
  memberName: string,
  from: string,
  expectedText: string | string[],
  timeoutMs: number
): Promise<InboxMessage & { messageId: string }> {
  const deadline = Date.now() + timeoutMs;
  const inboxPath = path.join(getTeamsBasePath(), teamName, 'inboxes', `${memberName}.json`);
  let lastMessages: InboxMessage[] = [];
  const expectedTexts = Array.isArray(expectedText) ? expectedText : [expectedText];

  while (Date.now() < deadline) {
    lastMessages = await readInboxMessages(inboxPath);
    const match = lastMessages.find(
      (message): message is InboxMessage & { messageId: string; text: string } => {
        if (message.from !== from || message.to !== memberName) return false;
        if (typeof message.messageId !== 'string' || !message.messageId.trim()) return false;
        const text = message.text;
        if (typeof text !== 'string') return false;
        return expectedTexts.every((expected) => text.includes(expected));
      }
    );
    if (match) {
      return match;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }

  throw new Error(
    `Timed out waiting for OpenCode member message in ${inboxPath}. Last messages: ${JSON.stringify(
      lastMessages,
      null,
      2
    )}`
  );
}

export async function waitForOpenCodePeerRelay(
  svc: TeamProvisioningService,
  teamName: string,
  memberName: string,
  messageId: string,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastRelay: Awaited<ReturnType<TeamProvisioningService['relayOpenCodeMemberInboxMessages']>> | null =
    null;

  while (Date.now() < deadline) {
    lastRelay = await svc.relayOpenCodeMemberInboxMessages(teamName, memberName, {
      onlyMessageId: messageId,
      source: 'manual',
      deliveryMetadata: {
        replyRecipient: 'user',
      },
    });
    if (lastRelay.delivered >= 1) {
      return;
    }
    if (lastRelay.failed > 0 && lastRelay.lastDelivery?.responsePending !== true) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }

  throw new Error(`OpenCode peer relay failed: ${JSON.stringify(lastRelay, null, 2)}`);
}

export async function readInboxMessages(inboxPath: string): Promise<InboxMessage[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(inboxPath, 'utf8'));
    return Array.isArray(parsed) ? (parsed as InboxMessage[]) : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

export async function waitUntil(
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

export async function waitForOpenCodeLanesStopped(
  teamName: string,
  timeoutMs = 90_000
): Promise<void> {
  await waitUntil(async () => {
    const laneIndex = await readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName);
    return Object.keys(laneIndex.lanes).length === 0;
  }, timeoutMs).catch(() => undefined);
}

export async function getRuntimeTranscript(input: {
  bridgeClient: OpenCodeBridgeCommandClient;
  teamName: string;
  memberName: string;
  projectPath: string;
}): Promise<unknown> {
  return input.bridgeClient
    .execute<
      { teamId: string; teamName: string; laneId: string; memberName: string },
      { logProjection?: { messages?: unknown[] }; messages?: unknown[] }
    >(
      'opencode.getRuntimeTranscript',
      {
        teamId: input.teamName,
        teamName: input.teamName,
        laneId: 'primary',
        memberName: input.memberName,
      },
      { cwd: input.projectPath, timeoutMs: 60_000 }
    )
    .catch((transcriptError) => ({
      ok: false as const,
      error: String(transcriptError),
    }));
}

export async function waitForOpenCodeMemberIdle(input: {
  bridgeClient: OpenCodeBridgeCommandClient;
  teamName: string;
  memberName: string;
  projectPath: string;
  timeoutMs: number;
}): Promise<void> {
  const deadline = Date.now() + input.timeoutMs;
  let lastState: string | null = null;

  while (Date.now() < deadline) {
    const transcript = await getRuntimeTranscript(input);
    lastState = getTranscriptDurableState(transcript);
    if (lastState === 'idle') {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }

  throw new Error(
    `Timed out waiting for OpenCode member ${input.memberName} to become idle. Last durableState: ${
      lastState ?? 'unknown'
    }`
  );
}

function getTranscriptDurableState(transcript: unknown): string | null {
  if (!transcript || typeof transcript !== 'object') {
    return null;
  }
  const data = (transcript as { data?: unknown }).data;
  if (!data || typeof data !== 'object') {
    return null;
  }
  const durableState = (data as { durableState?: unknown }).durableState;
  return typeof durableState === 'string' ? durableState : null;
}

async function startLiveTeamControlApi(svc: TeamProvisioningService): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const app = Fastify({ logger: false });
  registerTeamRoutes(app, {
    teamProvisioningService: svc,
  } as HttpServices);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (!address || typeof address === 'string') {
    await app.close();
    throw new Error('Failed to start live team control API');
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await app.close();
    },
  };
}

function createStateChangingCommands(input: {
  bridge: OpenCodeBridgeCommandExecutor;
  controlDir: string;
}): OpenCodeStateChangingBridgeCommandService {
  const clientIdentity = createOpenCodeBridgeClientIdentity({
    appVersion: '1.3.0-e2e',
    gitSha: null,
    buildId: 'opencode-semantic-model-matrix-e2e',
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
