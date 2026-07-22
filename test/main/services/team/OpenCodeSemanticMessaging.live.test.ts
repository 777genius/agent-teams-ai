import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readOpenCodeRuntimeLaneIndex } from '../../../../src/main/services/team/opencode/store/OpenCodeRuntimeManifestEvidenceReader';
import { TeamInboxWriter } from '../../../../src/main/services/team/TeamInboxWriter';
import {
  getTeamsBasePath,
  setClaudeBasePathOverride,
} from '../../../../src/main/utils/pathDecoder';

import {
  createOpenCodeLiveHarness,
  getRuntimeTranscript,
  type InboxMessage,
  waitForMemberInboxMessage,
  waitForOpenCodeLanesStopped,
  waitForOpenCodePeerRelay,
  waitForUserInboxReply,
  waitUntil,
} from './openCodeLiveTestHarness';

import type { TeamProvisioningProgress } from '../../../../src/shared/types';

const liveDescribe =
  process.env.OPENCODE_E2E === '1' && process.env.OPENCODE_E2E_SEMANTIC_MESSAGING === '1'
    ? describe
    : describe.skip;

const DEFAULT_MODEL = 'opencode/big-pickle';

liveDescribe('OpenCode semantic messaging live e2e', () => {
  let tempDir: string;
  let tempClaudeRoot: string;
  let projectPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-semantic-message-e2e-'));
    tempClaudeRoot = path.join(tempDir, '.claude');
    projectPath = await resolveIsolatedSemanticProjectPath(
      tempDir,
      process.env.OPENCODE_E2E_PROJECT_PATH
    );
    await fs.mkdir(tempClaudeRoot, { recursive: true });
    setClaudeBasePathOverride(tempClaudeRoot);
  });

  afterEach(async () => {
    setClaudeBasePathOverride(null);
    if (process.env.OPENCODE_E2E_KEEP_TEMP === '1') {
      console.info(`[OpenCodeSemanticMessaging.live] preserved temp dir: ${tempDir}`);
    } else {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('delivers a desktop message to an OpenCode member and records the reply through agent-teams_message_send', async () => {
    const { bridgeClient, selectedModel, svc, dispose } = await createOpenCodeLiveHarness({
      tempDir,
      selectedModel: process.env.OPENCODE_E2E_MODEL?.trim() || DEFAULT_MODEL,
      projectPath,
    });

    const teamName = `opencode-semantic-message-${Date.now()}`;
    const memberName = 'bob';
    const expectedReply = `opencode-semantic-message-e2e-${Date.now()}`;
    const progressEvents: TeamProvisioningProgress[] = [];

    try {
      const { runId } = await svc.createTeam(
        {
          teamName,
          cwd: projectPath,
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
      await expect(
        readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName)
      ).resolves.toMatchObject({
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
        const transcript = await getRuntimeTranscript({
          bridgeClient,
          teamName,
          memberName,
          projectPath,
        });
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
      await svc.stopTeam(teamName).catch(() => undefined);
      await dispose();
      await waitForOpenCodeLanesStopped(teamName);
    }
  }, 300_000);

  it('delivers concurrent desktop messages to OpenCode members sharing one primary lane', async () => {
    const { bridgeClient, selectedModel, svc, dispose } = await createOpenCodeLiveHarness({
      tempDir,
      selectedModel: process.env.OPENCODE_E2E_MODEL?.trim() || DEFAULT_MODEL,
      projectPath,
    });

    const teamName = `opencode-concurrent-lane-message-${Date.now()}`;
    const aliceMessageId = `ui-concurrent-alice-${Date.now()}`;
    const bobMessageId = `ui-concurrent-bob-${Date.now()}`;
    const aliceToken = `opencode-concurrent-alice-token-${Date.now()}`;
    const bobToken = `opencode-concurrent-bob-token-${Date.now()}`;
    const progressEvents: TeamProvisioningProgress[] = [];

    try {
      const { runId } = await svc.createTeam(
        {
          teamName,
          cwd: projectPath,
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

      const [aliceDelivery, bobDelivery] = await Promise.all([
        svc.deliverOpenCodeMemberMessage(teamName, {
          memberName: 'alice',
          messageId: aliceMessageId,
          replyRecipient: 'user',
          text: `This is a concurrent delivery smoke. Remember token ${aliceToken}. No user-visible reply is required.`,
        }),
        svc.deliverOpenCodeMemberMessage(teamName, {
          memberName: 'bob',
          messageId: bobMessageId,
          replyRecipient: 'user',
          text: `This is a concurrent delivery smoke. Remember token ${bobToken}. No user-visible reply is required.`,
        }),
      ]);

      for (const delivery of [aliceDelivery, bobDelivery]) {
        expect(delivery.delivered).toBe(true);
        expect(delivery.diagnostics?.join('\n') ?? '').not.toContain(
          'OpenCode bridge command lease already active'
        );
      }

      await Promise.all([
        waitUntil(async () => {
          const transcript = await getRuntimeTranscript({
            bridgeClient,
            teamName,
            memberName: 'alice',
            projectPath,
          });
          return JSON.stringify(transcript).includes(aliceToken);
        }, 30_000),
        waitUntil(async () => {
          const transcript = await getRuntimeTranscript({
            bridgeClient,
            teamName,
            memberName: 'bob',
            projectPath,
          });
          return JSON.stringify(transcript).includes(bobToken);
        }, 30_000),
      ]);
    } finally {
      await svc.stopTeam(teamName).catch(() => undefined);
      await dispose();
      await waitForOpenCodeLanesStopped(teamName);
    }
  }, 300_000);

  it('relays a desktop inbox message to the OpenCode lead session and records the lead reply', async () => {
    const { bridgeClient, selectedModel, svc, dispose } = await createOpenCodeLiveHarness({
      tempDir,
      selectedModel: process.env.OPENCODE_E2E_MODEL?.trim() || DEFAULT_MODEL,
      projectPath,
    });

    const teamName = `opencode-lead-message-${Date.now()}`;
    const leadName = 'team-lead';
    const memberName = 'bob';
    const expectedReply = `opencode-lead-message-e2e-${Date.now()}`;
    const progressEvents: TeamProvisioningProgress[] = [];

    try {
      const { runId } = await svc.createTeam(
        {
          teamName,
          cwd: projectPath,
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
      expect(runtimeSnapshot.members[leadName]).toMatchObject({
        alive: true,
        runtimeModel: selectedModel,
      });

      const written = await new TeamInboxWriter().sendMessage(teamName, {
        member: leadName,
        from: 'user',
        to: leadName,
        source: 'user_sent',
        text: [
          `Reply to the app Messages UI with exactly: ${expectedReply}`,
          `Use agent-teams_message_send with to="user" and from="${leadName}".`,
          'Do not answer only as plain assistant text.',
        ].join('\n'),
      });

      let lastRelay: Awaited<ReturnType<typeof svc.relayInboxFileToLiveRecipient>> | null = null;
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        lastRelay = await svc.relayInboxFileToLiveRecipient(teamName, leadName, {
          onlyMessageId: written.messageId,
          source: 'ui-send',
          deliveryMetadata: { replyRecipient: 'user' },
        });
        if (lastRelay.relayed >= 1) {
          break;
        }
        if (
          lastRelay.lastDelivery?.delivered === false &&
          lastRelay.lastDelivery.responsePending !== true
        ) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 3_000));
      }

      expect(lastRelay).toMatchObject({
        kind: 'opencode_member',
        relayed: 1,
      });

      let reply: InboxMessage;
      try {
        reply = await waitForUserInboxReply(teamName, leadName, expectedReply, 90_000);
      } catch (error) {
        const transcript = await getRuntimeTranscript({
          bridgeClient,
          teamName,
          memberName: leadName,
          projectPath,
        });
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}\nLast relay: ${JSON.stringify(
            lastRelay,
            null,
            2
          )}\nTranscript: ${JSON.stringify(transcript, null, 2)}`
        );
      }
      expect(reply).toMatchObject({
        from: leadName,
        to: 'user',
      });
      expect(reply.text).toContain(expectedReply);
    } finally {
      await svc.stopTeam(teamName).catch(() => undefined);
      await dispose();
      await waitForOpenCodeLanesStopped(teamName);
    }
  }, 300_000);

  it('relays an OpenCode teammate message into another OpenCode member runtime and records the reply', async () => {
    const { bridgeClient, selectedModel, svc, dispose } = await createOpenCodeLiveHarness({
      tempDir,
      selectedModel: process.env.OPENCODE_E2E_MODEL?.trim() || DEFAULT_MODEL,
      projectPath,
    });

    const teamName = `opencode-peer-message-${Date.now()}`;
    const senderName = 'bob';
    const recipientName = 'jack';
    const peerToken = `opencode-peer-inbox-e2e-${Date.now()}`;
    const replyToken = `opencode-peer-reply-e2e-${Date.now()}`;
    const peerInstructionText = [
      `Peer relay token: ${peerToken}.`,
      `Jack, reply to the app user with exactly ${replyToken}.`,
      `Use agent-teams_message_send to user from ${recipientName} with summary "peer reply".`,
    ].join(' ');
    const progressEvents: TeamProvisioningProgress[] = [];

    try {
      const { runId } = await svc.createTeam(
        {
          teamName,
          cwd: projectPath,
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
          `Send one team message to ${recipientName}.`,
          'Use the exact message text below and no extra commentary:',
          peerInstructionText,
          `Call agent-teams_message_send with to="${recipientName}", from="${senderName}", text set to the exact message text above, and summary "peer relay".`,
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
          replyToken,
          180_000
        );
      } catch (error) {
        const transcript = await getRuntimeTranscript({
          bridgeClient,
          teamName,
          memberName: senderName,
          projectPath,
        });
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}\n${senderName} transcript: ${JSON.stringify(
            transcript,
            null,
            2
          )}`
        );
      }

      await waitForOpenCodePeerRelay(svc, teamName, recipientName, peerMessage.messageId, 180_000);

      let reply: InboxMessage;
      try {
        reply = await waitForUserInboxReply(teamName, recipientName, replyToken, 120_000);
      } catch (error) {
        const [senderTranscript, recipientTranscript] = await Promise.all([
          getRuntimeTranscript({
            bridgeClient,
            teamName,
            memberName: senderName,
            projectPath,
          }),
          getRuntimeTranscript({
            bridgeClient,
            teamName,
            memberName: recipientName,
            projectPath,
          }),
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
      await svc.stopTeam(teamName).catch(() => undefined);
      await dispose();
      await waitForOpenCodeLanesStopped(teamName);
    }
  }, 360_000);
});

describe('OpenCode semantic messaging sandbox safety', () => {
  it('creates the default project inside the per-test temp directory', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-semantic-safety-'));

    try {
      const projectPath = await resolveIsolatedSemanticProjectPath(tempDir);
      const realTempDir = await fs.realpath(tempDir);

      expect(path.relative(realTempDir, projectPath)).toBe('sandbox-project');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects an explicitly configured project outside the system temp directory', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-semantic-safety-'));

    try {
      await expect(resolveIsolatedSemanticProjectPath(tempDir, process.cwd())).rejects.toThrow(
        'must resolve inside the system temp directory'
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});

async function resolveIsolatedSemanticProjectPath(
  tempDir: string,
  configuredProjectPath?: string
): Promise<string> {
  const candidate = configuredProjectPath?.trim()
    ? path.resolve(configuredProjectPath.trim())
    : path.join(tempDir, 'sandbox-project');
  const lexicalTempRoot = path.resolve(os.tmpdir());
  assertPathInsideSystemTemp(lexicalTempRoot, candidate);
  await fs.mkdir(candidate, { recursive: true });

  const [realTempRoot, realCandidate] = await Promise.all([
    fs.realpath(os.tmpdir()),
    fs.realpath(candidate),
  ]);
  assertPathInsideSystemTemp(realTempRoot, realCandidate);

  return realCandidate;
}

function assertPathInsideSystemTemp(tempRoot: string, candidate: string): void {
  const relative = path.relative(tempRoot, candidate);
  const isInsideTempRoot =
    relative.length > 0 && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);

  if (!isInsideTempRoot) {
    throw new Error(
      `OPENCODE_E2E_PROJECT_PATH must resolve inside the system temp directory (${tempRoot}); received ${candidate}`
    );
  }
}
