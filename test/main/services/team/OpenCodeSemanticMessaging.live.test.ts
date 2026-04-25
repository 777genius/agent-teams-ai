import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readOpenCodeRuntimeLaneIndex } from '../../../../src/main/services/team/opencode/store/OpenCodeRuntimeManifestEvidenceReader';
import { getTeamsBasePath, setClaudeBasePathOverride } from '../../../../src/main/utils/pathDecoder';
import {
  createOpenCodeLiveHarness,
  getRuntimeTranscript,
  type InboxMessage,
  waitForMemberInboxMessage,
  waitForOpenCodeLanesStopped,
  waitForOpenCodePeerRelay,
  waitForUserInboxReply,
} from './openCodeLiveTestHarness';

import type { TeamProvisioningProgress } from '../../../../src/shared/types';

const liveDescribe =
  process.env.OPENCODE_E2E === '1' && process.env.OPENCODE_E2E_SEMANTIC_MESSAGING === '1'
    ? describe
    : describe.skip;

const PROJECT_PATH = process.env.OPENCODE_E2E_PROJECT_PATH?.trim() || process.cwd();
const DEFAULT_MODEL = 'opencode/big-pickle';

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
      const { bridgeClient, selectedModel, svc, dispose } = await createOpenCodeLiveHarness({
        tempDir,
        selectedModel: process.env.OPENCODE_E2E_MODEL?.trim() || DEFAULT_MODEL,
      });

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
          const transcript = await getRuntimeTranscript({
            bridgeClient,
            teamName,
            memberName,
            projectPath: PROJECT_PATH,
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
    },
    300_000
  );

  it(
    'relays an OpenCode teammate message into another OpenCode member runtime and records the reply',
    async () => {
      const { bridgeClient, selectedModel, svc, dispose } = await createOpenCodeLiveHarness({
        tempDir,
        selectedModel: process.env.OPENCODE_E2E_MODEL?.trim() || DEFAULT_MODEL,
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
            projectPath: PROJECT_PATH,
          });
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}\n${senderName} transcript: ${JSON.stringify(
              transcript,
              null,
              2
            )}`
          );
        }

        await waitForOpenCodePeerRelay(
          svc,
          teamName,
          recipientName,
          peerMessage.messageId,
          180_000
        );

        let reply: InboxMessage;
        try {
          reply = await waitForUserInboxReply(teamName, recipientName, replyToken, 120_000);
        } catch (error) {
          const [senderTranscript, recipientTranscript] = await Promise.all([
            getRuntimeTranscript({
              bridgeClient,
              teamName,
              memberName: senderName,
              projectPath: PROJECT_PATH,
            }),
            getRuntimeTranscript({
              bridgeClient,
              teamName,
              memberName: recipientName,
              projectPath: PROJECT_PATH,
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
    },
    360_000
  );
});
