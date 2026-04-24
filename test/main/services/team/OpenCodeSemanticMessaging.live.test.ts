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
import { readOpenCodeRuntimeLaneIndex } from '../../../../src/main/services/team/opencode/store/OpenCodeRuntimeManifestEvidenceReader';
import { applyOpenCodeAutoUpdatePolicy } from '../../../../src/main/services/runtime/openCodeAutoUpdatePolicy';
import { OpenCodeTeamRuntimeAdapter } from '../../../../src/main/services/team/runtime/OpenCodeTeamRuntimeAdapter';
import { TeamRuntimeAdapterRegistry } from '../../../../src/main/services/team/runtime/TeamRuntimeAdapter';
import { resolveAgentTeamsMcpLaunchSpec } from '../../../../src/main/services/team/TeamMcpConfigBuilder';
import { TeamProvisioningService } from '../../../../src/main/services/team/TeamProvisioningService';
import {
  getClaudeBasePath,
  getTeamsBasePath,
  setClaudeBasePathOverride,
} from '../../../../src/main/utils/pathDecoder';

import type { OpenCodeBridgeCommandExecutor } from '../../../../src/main/services/team/opencode/bridge/OpenCodeStateChangingBridgeCommandService';
import type { RuntimeStoreManifestEvidence } from '../../../../src/main/services/team/opencode/bridge/OpenCodeBridgeCommandContract';
import type { RuntimeStoreManifestReader } from '../../../../src/main/services/team/opencode/bridge/OpenCodeStateChangingBridgeCommandService';
import type { TeamProvisioningProgress } from '../../../../src/shared/types';

const liveDescribe =
  process.env.OPENCODE_E2E === '1' && process.env.OPENCODE_E2E_SEMANTIC_MESSAGING === '1'
    ? describe
    : describe.skip;

const PROJECT_PATH = process.env.OPENCODE_E2E_PROJECT_PATH?.trim() || process.cwd();
const DEFAULT_ORCHESTRATOR_CLI = '/Users/belief/dev/projects/claude/agent_teams_orchestrator/cli';
const DEFAULT_MODEL = 'opencode/big-pickle';

interface InboxMessage {
  from?: string;
  to?: string;
  text?: string;
  messageId?: string;
  read?: boolean;
}

liveDescribe('OpenCode semantic messaging live e2e', () => {
  let tempDir: string;
  let tempClaudeRoot: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-semantic-message-e2e-'));
    tempClaudeRoot = path.join(tempDir, '.claude');
    await fs.mkdir(tempClaudeRoot, { recursive: true });
    setClaudeBasePathOverride(tempClaudeRoot);
  });

  afterEach(async () => {
    setClaudeBasePathOverride(null);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it(
    'delivers a desktop message to an OpenCode member and records the reply through agent-teams_message_send',
    async () => {
      const { bridgeClient, selectedModel, svc } = await createOpenCodeLiveHarness(tempDir);

      const teamName = `opencode-semantic-message-${Date.now()}`;
      const memberName = 'bob';
      const expectedReply = `opencode-semantic-message-e2e-${Date.now()}`;
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
                name: memberName,
                role: 'Developer',
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
        expect(runtimeSnapshot.members[memberName]).toMatchObject({
          alive: true,
          runtimeModel: selectedModel,
        });
        await expect(readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)).resolves.toMatchObject({
          lanes: {
            primary: {
              state: 'active',
            },
          },
        });

        const delivery = await svc.deliverOpenCodeMemberMessage(teamName, {
          memberName,
          messageId: `ui-message-${Date.now()}`,
          replyRecipient: 'user',
          text: [
            `Reply to the app Messages UI with exactly: ${expectedReply}`,
            'Use agent-teams_message_send with to="user" and from="bob".',
            'Do not answer only as plain assistant text.',
          ].join('\n'),
        });

        if (!delivery.delivered) {
          throw new Error(`OpenCode runtime delivery failed: ${JSON.stringify(delivery, null, 2)}`);
        }

        let reply: InboxMessage;
        try {
          reply = await waitForUserInboxReply(teamName, memberName, expectedReply, 90_000);
        } catch (error) {
          const transcript = await getRuntimeTranscript(bridgeClient, teamName, memberName);
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}\nTranscript: ${JSON.stringify(
              transcript,
              null,
              2
            )}`
          );
        }
        expect(reply).toMatchObject({
          from: memberName,
          to: 'user',
        });
        expect(reply.text).toContain(expectedReply);
      } finally {
        svc.stopTeam(teamName);
        await waitUntil(async () => {
          const laneIndex = await readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName);
          return Object.keys(laneIndex.lanes).length === 0;
        }, 90_000).catch(() => undefined);
      }
    },
    300_000
  );

  it(
    'relays an OpenCode teammate message into another OpenCode member runtime and records the reply',
    async () => {
      const { bridgeClient, selectedModel, svc } = await createOpenCodeLiveHarness(tempDir);

      const teamName = `opencode-peer-message-${Date.now()}`;
      const senderName = 'bob';
      const recipientName = 'jack';
      const peerToken = `opencode-peer-inbox-e2e-${Date.now()}`;
      const replyToken = `opencode-peer-reply-e2e-${Date.now()}`;
      const peerInstructionText = [
        `Peer relay token: ${peerToken}.`,
        `${recipientName}, call agent-teams_message_send with teamName="${teamName}", to="user", from="${recipientName}", text exactly "${replyToken}", and summary "peer reply".`,
      ].join(' ');
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
                name: senderName,
                role: 'Developer',
                providerId: 'opencode',
                model: selectedModel,
              },
              {
                name: recipientName,
                role: 'Developer',
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
        expect(runtimeSnapshot.members[senderName]).toMatchObject({
          alive: true,
          runtimeModel: selectedModel,
        });
        expect(runtimeSnapshot.members[recipientName]).toMatchObject({
          alive: true,
          runtimeModel: selectedModel,
        });

        const senderDelivery = await svc.deliverOpenCodeMemberMessage(teamName, {
          memberName: senderName,
          messageId: `ui-peer-message-${Date.now()}`,
          replyRecipient: recipientName,
          text: [
            `Send ${recipientName} a team message by calling agent-teams_message_send exactly once.`,
            `Set to="${recipientName}" and from="${senderName}".`,
            'Use this exact message text, with no extra text:',
            peerInstructionText,
            `Use agent-teams_message_send with to="${recipientName}" and from="${senderName}".`,
            'Do not reply to user instead of sending the team message.',
          ].join('\n'),
        });

        if (!senderDelivery.delivered) {
          throw new Error(
            `OpenCode sender delivery failed: ${JSON.stringify(senderDelivery, null, 2)}`
          );
        }

        let peerMessage: InboxMessage & { messageId: string };
        try {
          peerMessage = await waitForMemberInboxMessage(
            teamName,
            recipientName,
            senderName,
            [peerToken, replyToken],
            90_000
          );
        } catch (error) {
          const transcript = await getRuntimeTranscript(bridgeClient, teamName, senderName);
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}\n${senderName} transcript: ${JSON.stringify(
              transcript,
              null,
              2
            )}`
          );
        }

        const relay = await svc.relayOpenCodeMemberInboxMessages(teamName, recipientName, {
          onlyMessageId: peerMessage.messageId,
          source: 'manual',
          deliveryMetadata: {
            replyRecipient: 'user',
          },
        });
        if (relay.delivered < 1) {
          throw new Error(`OpenCode peer relay failed: ${JSON.stringify(relay, null, 2)}`);
        }

        let reply: InboxMessage;
        try {
          reply = await waitForUserInboxReply(teamName, recipientName, replyToken, 120_000);
        } catch (error) {
          const [senderTranscript, recipientTranscript] = await Promise.all([
            getRuntimeTranscript(bridgeClient, teamName, senderName),
            getRuntimeTranscript(bridgeClient, teamName, recipientName),
          ]);
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}\n${senderName} transcript: ${JSON.stringify(
              senderTranscript,
              null,
              2
            )}\n${recipientName} transcript: ${JSON.stringify(recipientTranscript, null, 2)}`
          );
        }
        expect(reply).toMatchObject({
          from: recipientName,
          to: 'user',
        });
        expect(reply.text).toContain(replyToken);
      } finally {
        svc.stopTeam(teamName);
        await waitUntil(async () => {
          const laneIndex = await readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName);
          return Object.keys(laneIndex.lanes).length === 0;
        }, 90_000).catch(() => undefined);
      }
    },
    360_000
  );
});

async function waitForUserInboxReply(
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

async function waitForMemberInboxMessage(
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

async function readInboxMessages(inboxPath: string): Promise<InboxMessage[]> {
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

async function createOpenCodeLiveHarness(tempDir: string): Promise<{
  bridgeClient: OpenCodeBridgeCommandClient;
  selectedModel: string;
  svc: TeamProvisioningService;
}> {
  const selectedModel = process.env.OPENCODE_E2E_MODEL?.trim() || DEFAULT_MODEL;
  const orchestratorCli =
    process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH?.trim() || DEFAULT_ORCHESTRATOR_CLI;
  await assertExecutable(orchestratorCli);

  const mcpLaunchSpec = await resolveAgentTeamsMcpLaunchSpec();
  const bridgeEnv = {
    ...createStableBridgeEnv(),
    PATH: withBunOnPath(process.env.PATH ?? ''),
    XDG_DATA_HOME: path.join(tempDir, 'xdg-data'),
    AGENT_TEAMS_MCP_CLAUDE_DIR: getClaudeBasePath(),
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
  return { bridgeClient, selectedModel, svc };
}

async function getRuntimeTranscript(
  bridgeClient: OpenCodeBridgeCommandClient,
  teamName: string,
  memberName: string
): Promise<unknown> {
  return bridgeClient
    .execute<
      { teamId: string; teamName: string; laneId: string; memberName: string },
      { logProjection?: { messages?: unknown[] }; messages?: unknown[] }
    >(
      'opencode.getRuntimeTranscript',
      { teamId: teamName, teamName, laneId: 'primary', memberName },
      { cwd: PROJECT_PATH, timeoutMs: 60_000 }
    )
    .catch((transcriptError) => ({
      ok: false as const,
      error: String(transcriptError),
    }));
}

function createStateChangingCommands(input: {
  bridge: OpenCodeBridgeCommandExecutor;
  controlDir: string;
}): OpenCodeStateChangingBridgeCommandService {
  const clientIdentity = createOpenCodeBridgeClientIdentity({
    appVersion: '1.3.0-e2e',
    gitSha: null,
    buildId: 'opencode-semantic-message-e2e',
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
