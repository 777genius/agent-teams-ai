// @vitest-environment node
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TeamDataService } from '../../../../src/main/services/team/TeamDataService';
import { TeamTaskReader } from '../../../../src/main/services/team/TeamTaskReader';
import { setClaudeBasePathOverride } from '../../../../src/main/utils/pathDecoder';

import {
  createOpenCodeLiveHarness,
  getRuntimeTranscript,
  waitForMemberInboxMessage,
  waitForOpenCodeLanesStopped,
  waitForOpenCodePeerRelay,
  waitUntil,
} from './openCodeLiveTestHarness';

import type { TeamProvisioningProgress } from '../../../../src/shared/types';

const liveDescribe = process.env.OPENCODE_PAID_PLAN_MIXED_E2E === '1' ? describe : describe.skip;
const MINIMAX_MODEL =
  process.env.OPENCODE_MINIMAX_E2E_MODEL?.trim() || 'minimax-coding-plan/MiniMax-M3';
const ZAI_MODEL = process.env.OPENCODE_ZAI_E2E_MODEL?.trim() || 'zai-coding-plan/glm-5.2';

liveDescribe('OpenCode paid-plan mixed team live e2e', () => {
  let tempDir: string;
  let projectPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-paid-plan-mixed-e2e-'));
    projectPath = path.join(tempDir, 'project');
    const tempClaudeRoot = path.join(tempDir, '.claude');
    await fs.mkdir(projectPath, { recursive: true });
    await fs.mkdir(tempClaudeRoot, { recursive: true });
    await fs.writeFile(
      path.join(projectPath, 'README.md'),
      '# OpenCode paid-plan mixed team live e2e\n\nThis is an isolated test project.\n',
      'utf8'
    );
    setClaudeBasePathOverride(tempClaudeRoot);
  });

  afterEach(async () => {
    setClaudeBasePathOverride(null);
    if (process.env.OPENCODE_E2E_KEEP_TEMP === '1') {
      process.stderr.write(`[OpenCodePaidPlanMixedTeam.live] preserved temp dir: ${tempDir}\n`);
    } else {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it(
    'runs one board task per teammate and proves bidirectional teammate communication',
    async () => {
      const { bridgeClient, svc, dispose } = await createOpenCodeLiveHarness({
        tempDir,
        selectedModel: MINIMAX_MODEL,
        projectPath,
      });
      const teamName = `opencode-paid-plan-mixed-${Date.now()}`;
      const progressEvents: TeamProvisioningProgress[] = [];
      const taskReader = new TeamTaskReader();
      const teamDataService = new TeamDataService();
      const aliceTaskMarker = `minimax-task-${Date.now()}`;
      const bobTaskMarker = `zai-task-${Date.now()}`;
      const alicePeerToken = `minimax-to-zai-${Date.now()}`;
      const bobPeerToken = `zai-to-minimax-${Date.now()}`;

      try {
        await svc.createTeam(
          {
            teamName,
            cwd: projectPath,
            providerId: 'opencode',
            model: MINIMAX_MODEL,
            skipPermissions: true,
            prompt: 'Keep all work minimal. Do not edit files.',
            members: [
              {
                name: 'alice',
                role: 'MiniMax teammate',
                providerId: 'opencode',
                model: MINIMAX_MODEL,
              },
              {
                name: 'bob',
                role: 'Z.AI teammate',
                providerId: 'opencode',
                model: ZAI_MODEL,
              },
            ],
          },
          (progress) => progressEvents.push(progress)
        );

        await waitUntil(async () => {
          const last = progressEvents.at(-1);
          if (last?.state === 'failed') {
            throw new Error(formatProgress(progressEvents));
          }
          return last?.state === 'ready';
        }, 300_000);

        const runtimeSnapshot = await svc.getTeamAgentRuntimeSnapshot(teamName);
        expect(runtimeSnapshot.members.alice).toMatchObject({
          alive: true,
          runtimeModel: MINIMAX_MODEL,
        });
        expect(runtimeSnapshot.members.bob).toMatchObject({
          alive: true,
          runtimeModel: ZAI_MODEL,
        });

        const [aliceTask, bobTask] = await Promise.all([
          teamDataService.createTask(teamName, {
            subject: `MiniMax board proof ${aliceTaskMarker}`,
            owner: 'alice',
            startImmediately: true,
            prompt: [
              'Do not edit files.',
              `Add one task comment containing exactly: ${aliceTaskMarker}:done`,
              `Send bob one team message whose full text is exactly: ${alicePeerToken}`,
              'Use agent-teams_message_send for the team message.',
              'Then complete this task with task_complete.',
            ].join('\n'),
          }),
          teamDataService.createTask(teamName, {
            subject: `Z.AI board proof ${bobTaskMarker}`,
            owner: 'bob',
            startImmediately: true,
            prompt: [
              'Do not edit files.',
              `Add one task comment containing exactly: ${bobTaskMarker}:done`,
              `Send alice one team message whose full text is exactly: ${bobPeerToken}`,
              'Use agent-teams_message_send for the team message.',
              'Then complete this task with task_complete.',
            ].join('\n'),
          }),
        ]);

        const [aliceRelay, bobRelay] = await Promise.all([
          svc.relayInboxFileToLiveRecipient(teamName, 'alice'),
          svc.relayInboxFileToLiveRecipient(teamName, 'bob'),
        ]);
        expect(isAcceptedRelay(aliceRelay)).toBe(true);
        expect(isAcceptedRelay(bobRelay)).toBe(true);

        await waitUntil(async () => {
          const tasks = await taskReader.getTasks(teamName);
          return [
            { taskId: aliceTask.id, marker: `${aliceTaskMarker}:done` },
            { taskId: bobTask.id, marker: `${bobTaskMarker}:done` },
          ].every(({ taskId, marker }) => {
            const task = tasks.find((candidate) => candidate.id === taskId);
            return (
              task?.status === 'completed' &&
              task.comments?.some((comment) => comment.text.includes(marker)) === true
            );
          });
        }, 300_000, 2_000, async () =>
          formatDiagnostics({
            bridgeClient,
            teamName,
            projectPath,
            taskReader,
          })
        );

        const [aliceToBob, bobToAlice] = await Promise.all([
          waitForMemberInboxMessage(teamName, 'bob', 'alice', alicePeerToken, 120_000),
          waitForMemberInboxMessage(teamName, 'alice', 'bob', bobPeerToken, 120_000),
        ]);

        await Promise.all([
          waitForOpenCodePeerRelay(svc, teamName, 'bob', aliceToBob.messageId, 180_000),
          waitForOpenCodePeerRelay(svc, teamName, 'alice', bobToAlice.messageId, 180_000),
        ]);

        await Promise.all([
          waitUntil(async () => {
            const transcript = await getRuntimeTranscript({
              bridgeClient,
              teamName,
              memberName: 'alice',
              projectPath,
            });
            return JSON.stringify(transcript).includes(bobPeerToken);
          }, 120_000),
          waitUntil(async () => {
            const transcript = await getRuntimeTranscript({
              bridgeClient,
              teamName,
              memberName: 'bob',
              projectPath,
            });
            return JSON.stringify(transcript).includes(alicePeerToken);
          }, 120_000),
        ]);
      } finally {
        await svc.stopTeam(teamName).catch(() => undefined);
        await dispose();
        await waitForOpenCodeLanesStopped(teamName);
      }
    },
    12 * 60_000
  );
});

function isAcceptedRelay(relay: Awaited<
  ReturnType<Awaited<ReturnType<typeof createOpenCodeLiveHarness>>['svc']['relayInboxFileToLiveRecipient']>
>): boolean {
  if (relay.kind === 'native_member_noop' || relay.relayed > 0) return true;
  return Boolean(
    relay.lastDelivery?.accepted === true ||
      relay.lastDelivery?.delivered === true ||
      relay.lastDelivery?.responsePending === true
  );
}

function formatProgress(events: readonly TeamProvisioningProgress[]): string {
  return events
    .map((event) => [event.state, event.message, event.error].filter(Boolean).join(' | '))
    .join('\n');
}

async function formatDiagnostics(input: {
  bridgeClient: Awaited<ReturnType<typeof createOpenCodeLiveHarness>>['bridgeClient'];
  teamName: string;
  projectPath: string;
  taskReader: TeamTaskReader;
}): Promise<string> {
  const [tasks, aliceTranscript, bobTranscript] = await Promise.all([
    input.taskReader.getTasks(input.teamName),
    getRuntimeTranscript({
      bridgeClient: input.bridgeClient,
      teamName: input.teamName,
      memberName: 'alice',
      projectPath: input.projectPath,
    }),
    getRuntimeTranscript({
      bridgeClient: input.bridgeClient,
      teamName: input.teamName,
      memberName: 'bob',
      projectPath: input.projectPath,
    }),
  ]);
  return JSON.stringify({ tasks, aliceTranscript, bobTranscript }, null, 2);
}
