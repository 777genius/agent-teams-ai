import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createMemberWorkSyncFeature,
  type MemberWorkSyncFeatureFacade,
} from '../../../../src/features/member-work-sync/main';
import { TeamConfigReader } from '../../../../src/main/services/team/TeamConfigReader';
import { TeamDataService } from '../../../../src/main/services/team/TeamDataService';
import { TeamKanbanManager } from '../../../../src/main/services/team/TeamKanbanManager';
import { TeamMembersMetaStore } from '../../../../src/main/services/team/TeamMembersMetaStore';
import { TeamTaskReader } from '../../../../src/main/services/team/TeamTaskReader';
import {
  getTeamsBasePath,
  setClaudeBasePathOverride,
} from '../../../../src/main/utils/pathDecoder';

import {
  formatMemberWorkSyncDiagnostics,
  formatProgressDump,
  readRuntimeTurnSettledProcessedMetas,
  waitUntil,
} from './memberWorkSyncLiveHarness';
import {
  createOpenCodeLiveHarness,
  type OpenCodeLiveHarness,
  readInboxMessages,
  waitForOpenCodeLanesStopped,
} from './openCodeLiveTestHarness';

import type { TeamChangeEvent, TeamProvisioningProgress } from '../../../../src/shared/types';

const liveDescribe =
  process.env.OPENCODE_E2E === '1' && process.env.OPENCODE_E2E_MEMBER_WORK_SYNC === '1'
    ? describe
    : describe.skip;

const DEFAULT_MODEL = 'opencode/gpt-5-nano';

liveDescribe('Member work sync OpenCode live e2e', () => {
  let tempDir: string;
  let tempClaudeRoot: string;
  let feature: MemberWorkSyncFeatureFacade | null;
  let harness: OpenCodeLiveHarness | null;
  let teamName: string | null;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'member-work-sync-opencode-live-'));
    tempClaudeRoot = path.join(tempDir, '.claude');
    await fs.mkdir(tempClaudeRoot, { recursive: true });
    setClaudeBasePathOverride(tempClaudeRoot);
    feature = null;
    harness = null;
    teamName = null;
  });

  afterEach(async () => {
    if (harness && teamName) {
      await harness.svc.stopTeam(teamName).catch(() => undefined);
      await waitForOpenCodeLanesStopped(teamName);
    }
    await feature?.dispose().catch(() => undefined);
    await harness?.dispose().catch(() => undefined);
    setClaudeBasePathOverride(null);
    if (process.env.OPENCODE_E2E_KEEP_TEMP === '1') {
      console.info(`[MemberWorkSyncOpenCode.live] preserved temp dir: ${tempDir}`);
    } else {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }, 90_000);

  it(
    'delivers a work-sync nudge to a real OpenCode member and accepts its still-working report',
    async () => {
      const selectedModel = process.env.OPENCODE_E2E_MODEL?.trim() || DEFAULT_MODEL;
      const projectPath = path.join(tempDir, 'project');
      await fs.mkdir(projectPath, { recursive: true });
      await fs.writeFile(
        path.join(projectPath, 'README.md'),
        '# Member work sync OpenCode live e2e\n\nKeep this project intentionally tiny.\n',
        'utf8'
      );

      let activeService: OpenCodeLiveHarness['svc'] | null = null;
      harness = await createOpenCodeLiveHarness({
        tempDir,
        selectedModel,
        projectPath,
        configureServices: (svc) => {
          activeService = svc;
          const configReader = new TeamConfigReader();
          feature = createMemberWorkSyncFeature({
            teamsBasePath: getTeamsBasePath(),
            configReader,
            taskReader: new TeamTaskReader(),
            kanbanManager: new TeamKanbanManager(),
            membersMetaStore: new TeamMembersMetaStore(),
            isTeamActive: (name) => svc.isTeamAlive(name) || svc.hasProvisioningRun(name),
            listLifecycleActiveTeamNames: async () => (teamName ? [teamName] : []),
            queueQuietWindowMs: 1,
          });
          svc.setTeamChangeEmitter((event: TeamChangeEvent) => feature!.noteTeamChange(event));
          svc.setRuntimeTurnSettledEnvironmentProvider((input) =>
            feature!.buildRuntimeTurnSettledEnvironment(input)
          );
          return { memberWorkSyncFeature: feature! };
        },
      });
      expect(activeService).toBe(harness.svc);

      const memberName = 'bob';
      const marker = `member-work-sync-opencode-live-${Date.now()}`;
      teamName = `member-work-sync-opencode-${Date.now()}`;
      const progressEvents: TeamProvisioningProgress[] = [];

      await harness.svc.createTeam(
        {
          teamName,
          cwd: projectPath,
          providerId: 'opencode',
          model: selectedModel,
          skipPermissions: true,
          prompt: [
            'Keep launch work minimal.',
            'If you receive a member_work_sync_nudge, call member_work_sync_status first.',
            'Then call member_work_sync_report with state "still_working", the returned agendaFingerprint/reportToken, and taskIds from the nudge.',
            'Do not complete the task and do not reply only with acknowledgement.',
          ].join(' '),
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

      await waitUntil(async () => {
        const last = progressEvents.at(-1);
        if (last?.state === 'failed') {
          throw new Error(formatProgressDump(progressEvents));
        }
        return progressEvents.some((progress) =>
          progress.message.includes('OpenCode team launch is ready')
        );
      }, 240_000);

      await seedShadowReadyMetrics({ teamName, memberName });
      const task = await new TeamDataService().createTask(teamName, {
        subject: `Member work sync OpenCode live nudge ${marker}`,
        owner: memberName,
        startImmediately: false,
        prompt: [
          `This is a live member-work-sync OpenCode validation task. Marker: ${marker}.`,
          'Do not edit files and do not complete this task.',
          'Only report still_working if member-work-sync asks you to synchronize.',
        ].join('\n'),
      });
      feature!.noteTeamChange({ type: 'task', teamName, taskId: task.id });

      const inboxPath = path.join(getTeamsBasePath(), teamName, 'inboxes', `${memberName}.json`);
      await waitUntil(async () => {
        const status = await feature!.getStatus({ teamName: teamName!, memberName });
        const inbox = await readInboxMessages(inboxPath);
        return (
          status.agenda.items.some((item) => item.taskId === task.id) &&
          inbox.some(
            (message) =>
              message.messageKind === 'member_work_sync_nudge' &&
              typeof message.messageId === 'string'
          )
        );
      }, 60_000, 500, async () =>
        formatMemberWorkSyncDiagnostics({
          feature: feature!,
          teamName: teamName!,
          memberName,
          taskId: task.id,
        })
      );

      const nudge = (await readInboxMessages(inboxPath)).find(
        (message) => message.messageKind === 'member_work_sync_nudge'
      );
      expect(nudge?.messageId).toBeTruthy();

      let lastRelay: Awaited<
        ReturnType<OpenCodeLiveHarness['svc']['relayOpenCodeMemberInboxMessages']>
      > | null = null;
      await waitUntil(async () => {
        lastRelay = await harness!.svc.relayOpenCodeMemberInboxMessages(teamName!, memberName, {
          onlyMessageId: nudge!.messageId,
          source: 'manual',
          deliveryMetadata: {
            replyRecipient: 'user',
          },
        });
        return Boolean(lastRelay.lastDelivery?.delivered);
      }, 120_000);

      await waitUntil(async () => {
        const status = await feature!.getStatus({ teamName: teamName!, memberName });
        return status.report?.accepted === true && status.report.state === 'still_working';
      }, 180_000, 2_000, async () =>
        [
          `Last OpenCode relay: ${JSON.stringify(lastRelay, null, 2)}`,
          await formatMemberWorkSyncDiagnostics({
            feature: feature!,
            teamName: teamName!,
            memberName,
            taskId: task.id,
          }),
        ].join('\n')
      );

      await waitUntil(async () => {
        await feature!.drainRuntimeTurnSettledEvents();
        const metas = await readRuntimeTurnSettledProcessedMetas(getTeamsBasePath());
        return metas.some(({ meta }) => {
          const event = meta.event as Record<string, unknown> | undefined;
          return event?.provider === 'opencode' && event.teamName === teamName;
        });
      }, 60_000);

      await expect(feature!.dispatchDueNudges([teamName])).resolves.toMatchObject({
        claimed: 0,
        delivered: 0,
      });
    },
    420_000
  );
});

async function seedShadowReadyMetrics(input: {
  teamName: string;
  memberName: string;
}): Promise<void> {
  const metricsPath = path.join(
    getTeamsBasePath(),
    input.teamName,
    '.member-work-sync',
    'indexes',
    'metrics.json'
  );
  const startMs = Date.now() - 2 * 60 * 60_000;
  await fs.mkdir(path.dirname(metricsPath), { recursive: true });
  await fs.writeFile(
    metricsPath,
    `${JSON.stringify(
      {
        schemaVersion: 2,
        members: {
          [input.memberName]: {
            memberName: input.memberName,
            state: 'caught_up',
            agendaFingerprint: 'agenda:v1:seed',
            actionableCount: 0,
            evaluatedAt: new Date(startMs).toISOString(),
            providerId: 'opencode',
          },
        },
        recentEvents: Array.from({ length: 24 }, (_, index) => ({
          id: `seed-status-${index}`,
          teamName: input.teamName,
          memberName: input.memberName,
          kind: 'status_evaluated',
          state: 'caught_up',
          agendaFingerprint: `agenda:v1:seed-${index}`,
          recordedAt: new Date(startMs + index * 6 * 60_000).toISOString(),
          actionableCount: 0,
          providerId: 'opencode',
        })),
      },
      null,
      2
    )}\n`,
    'utf8'
  );
}
