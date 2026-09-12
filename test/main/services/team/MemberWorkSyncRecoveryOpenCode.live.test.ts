import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createMemberWorkSyncFeature,
  MEMBER_WORK_SYNC_PRODUCTION_RECOVERY,
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
  createOwnedWorkSyncIdentity,
  type OwnedWorkSyncIdentity,
} from '../../../features/member-work-sync/helpers/createOwnedWorkSyncIdentity';

import {
  FatalWaitError,
  formatMemberWorkSyncDiagnostics,
  formatProgressDump,
  readMemberWorkSyncOutboxItems,
  readRuntimeTurnSettledProcessedMetas,
  waitUntil,
} from './memberWorkSyncLiveHarness';
import {
  createOpenCodeLiveHarness,
  type OpenCodeLiveHarness,
  readInboxMessages,
  waitForOpenCodeLanesStopped,
  waitForOpenCodePeerRelay,
} from './openCodeLiveTestHarness';

import type { TeamChangeEvent, TeamProvisioningProgress } from '../../../../src/shared/types';

const liveDescribe = process.env.MEMBER_WORK_SYNC_RECOVERY_LIVE === '1' ? describe : describe.skip;
const remainingWorkIt =
  process.env.MEMBER_WORK_SYNC_RECOVERY_LIVE === '1' &&
  process.env.MEMBER_WORK_SYNC_RECOVERY_LIVE_REMAINING === '1'
    ? it
    : it.skip;
const DEFAULT_MODEL = 'opencode/big-pickle';

if (process.env.MEMBER_WORK_SYNC_RECOVERY_LIVE === '1') {
  process.env.OPENCODE_E2E_USE_REAL_APP_CREDENTIALS ??= '1';
}

liveDescribe('Member work sync recovery OpenCode live canary', () => {
  let tempDir: string;
  let feature: MemberWorkSyncFeatureFacade | null;
  let harness: OpenCodeLiveHarness | null;
  let teamName: string | null;
  let owned: OwnedWorkSyncIdentity | null;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'member-work-sync-recovery-opencode-'));
    const tempClaudeRoot = path.join(tempDir, '.claude');
    await fs.mkdir(tempClaudeRoot, { recursive: true });
    setClaudeBasePathOverride(tempClaudeRoot);
    feature = null;
    harness = null;
    teamName = null;
    owned = await createOwnedWorkSyncIdentity();
  });

  afterEach(async () => {
    if (harness && teamName) {
      await harness.svc.stopTeam(teamName).catch(() => undefined);
      await waitForOpenCodeLanesStopped(teamName);
    }
    await feature?.dispose().catch(() => undefined);
    await harness?.dispose().catch(() => undefined);
    await owned?.dispose().catch(() => undefined);
    owned = null;
    setClaudeBasePathOverride(null);
    const warn = vi.mocked(console.warn);
    if (warn.mock) {
      for (let index = warn.mock.calls.length - 1; index >= 0; index -= 1) {
        const rendered = warn.mock.calls[index]?.map((arg) => String(arg)).join(' ') ?? '';
        if (
          rendered.includes('OpenCode inbox relay failed') ||
          rendered.includes('delivery watchdog relay diagnostics') ||
          rendered.includes('opencode_primary_runtime_not_deliverable')
        ) {
          warn.mock.calls.splice(index, 1);
        }
      }
    }
    if (process.env.MEMBER_WORK_SYNC_RECOVERY_KEEP_TEMP === '1') {
      console.info(`[MemberWorkSyncRecoveryOpenCode.live] preserved temp dir: ${tempDir}`);
    } else {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }, 90_000);

  it('keeps D0 off and a user stop latch across feature restart on a live OpenCode teammate', async () => {
    const selectedModel = process.env.OPENCODE_E2E_MODEL?.trim() || DEFAULT_MODEL;
    const projectPath = path.join(tempDir, 'project');
    await fs.mkdir(projectPath, { recursive: true });
    await fs.writeFile(
      path.join(projectPath, 'README.md'),
      '# Member work sync recovery OpenCode live canary\n\nDisposable sandbox only.\n',
      'utf8'
    );

    const memberName = 'bob';
    teamName = `member-work-sync-recovery-opencode-${Date.now()}`;
    const lifecycleIdentity = owned!.identity;
    harness = await createOpenCodeLiveHarness({
      tempDir,
      selectedModel,
      projectPath,
      configureServices: (svc) => {
        feature = createMemberWorkSyncFeature({
          lifecycleIdentity,
          teamsBasePath: getTeamsBasePath(),
          recoveryAllocation: { enabled: false },
          configReader: new TeamConfigReader(),
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
          'Do not edit files.',
          'If you receive a task, wait for instructions and do not complete it.',
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
        throw new FatalWaitError(formatProgressDump(progressEvents));
      }
      return progressEvents.some((progress) =>
        progress.message.includes('OpenCode team launch is ready')
      );
    }, 240_000);

    const task = await new TeamDataService().createTask(teamName, {
      subject: `Recovery OpenCode live canary ${Date.now()}`,
      owner: memberName,
      startImmediately: false,
      prompt: 'Do not complete this task. Wait for operator instructions.',
    });
    feature!.noteTeamChange({ type: 'task', teamName, taskId: task.id });

    const status = await feature!.refreshStatus({ teamName, memberName });
    expect(status.providerId).toBe('opencode');
    expect(status.agenda.items.some((item) => item.taskId === task.id)).toBe(true);

    await feature!.stopAutoResume({ teamName, memberName, reason: 'user_stop' });
    await feature!.dispose();
    feature = createMemberWorkSyncFeature({
      lifecycleIdentity,
      teamsBasePath: getTeamsBasePath(),
      recoveryAllocation: { enabled: false },
      configReader: new TeamConfigReader(),
      taskReader: new TeamTaskReader(),
      kanbanManager: new TeamKanbanManager(),
      membersMetaStore: new TeamMembersMetaStore(),
      isTeamActive: (name) =>
        harness!.svc.isTeamAlive(name) || harness!.svc.hasProvisioningRun(name),
      listLifecycleActiveTeamNames: async () => [teamName!],
      queueQuietWindowMs: 1,
    });
    harness.svc.setTeamChangeEmitter((event: TeamChangeEvent) => feature!.noteTeamChange(event));
    feature.noteTeamChange({ type: 'task', teamName, taskId: task.id });

    const restarted = await feature.getStatus({ teamName, memberName });
    expect(restarted.recoveryHealth?.autoResumeStopLatch?.reason).toBe('user_stop');
    expect(
      Object.values(await readMemberWorkSyncOutboxItems(teamName, memberName)).filter(
        (item) => item.payload?.workSyncIntentKey
      )
    ).toEqual([]);
    await expect(
      feature.continueManually({ teamName, memberName, idempotencyKey: 'live-canary' })
    ).rejects.toThrow(/member_stopped/);

    await feature.prepareTeamDeletion(teamName);
    feature.completeTeamDeletion(teamName);
  }, 600_000);

  it('restores the same OpenCode recovery intent after a crash between inbox write and restart (D)', async () => {
    const selectedModel = process.env.OPENCODE_E2E_MODEL?.trim() || DEFAULT_MODEL;
    const memberName = 'bob';
    const projectPath = path.join(tempDir, 'project');
    await fs.mkdir(projectPath, { recursive: true });
    await fs.writeFile(
      path.join(projectPath, 'README.md'),
      '# Member work sync recovery OpenCode live crash canary\n\nDisposable sandbox only.\n',
      'utf8'
    );

    teamName = `member-work-sync-recovery-opencode-d-${Date.now()}`;
    const inboxPath = path.join(getTeamsBasePath(), teamName, 'inboxes', `${memberName}.json`);
    const createFeature = (svc: OpenCodeLiveHarness['svc']) =>
      createMemberWorkSyncFeature({
        lifecycleIdentity: owned!.identity,
        teamsBasePath: getTeamsBasePath(),
        ...MEMBER_WORK_SYNC_PRODUCTION_RECOVERY,
        configReader: new TeamConfigReader(),
        taskReader: new TeamTaskReader(),
        kanbanManager: new TeamKanbanManager(),
        membersMetaStore: new TeamMembersMetaStore(),
        isTeamActive: (name) => svc.isTeamAlive(name) || svc.hasProvisioningRun(name),
        listLifecycleActiveTeamNames: async () => (teamName ? [teamName] : []),
        queueQuietWindowMs: 500,
      });

    harness = await createOpenCodeLiveHarness({
      tempDir,
      selectedModel,
      projectPath,
      timeoutMs: 360_000,
      launchTimeoutMs: 360_000,
      configureServices: (svc) => {
        feature = createFeature(svc);
        svc.setTeamChangeEmitter((event: TeamChangeEvent) => feature!.noteTeamChange(event));
        svc.setRuntimeTurnSettledEnvironmentProvider((input) =>
          feature!.buildRuntimeTurnSettledEnvironment(input)
        );
        return { memberWorkSyncFeature: feature! };
      },
    });

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
          'Do not edit files.',
          'If you receive a task, wait for instructions and do not complete it.',
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
        throw new FatalWaitError(formatProgressDump(progressEvents));
      }
      return progressEvents.some((progress) =>
        progress.message.includes('OpenCode team launch is ready')
      );
    }, 240_000);
    expect(harness.svc.isTeamAlive(teamName)).toBe(true);

    await seedOpenCodeShadowReadyMetrics({ teamName, memberName });
    const task = await new TeamDataService().createTask(teamName, {
      subject: `Recovery OpenCode live crash canary ${Date.now()}`,
      owner: memberName,
      startImmediately: false,
      prompt: 'Do not complete this task. Wait for operator instructions.',
    });
    feature!.noteTeamChange({ type: 'task', teamName, taskId: task.id });

    await waitUntil(
      async () => {
        const inbox = await readInboxMessages(inboxPath);
        return inbox.some(
          (message) =>
            message.messageKind === 'member_work_sync_nudge' &&
            typeof message.messageId === 'string'
        );
      },
      60_000,
      500
    );
    const messageIdsBeforeCrash = (await readInboxMessages(inboxPath))
      .filter((message) => message.messageKind === 'member_work_sync_nudge')
      .map((message) => message.messageId)
      .filter((value): value is string => Boolean(value))
      .sort();
    expect(messageIdsBeforeCrash.length).toBeGreaterThanOrEqual(1);
    const recoveryIdsBeforeCrash = Object.values(
      await readMemberWorkSyncOutboxItems(teamName, memberName)
    )
      .map((item) => item.payload?.workSyncIntentKey)
      .filter((value): value is string => Boolean(value))
      .sort();

    await feature!.dispose();
    feature = createFeature(harness.svc);
    harness.svc.setTeamChangeEmitter((event: TeamChangeEvent) => feature!.noteTeamChange(event));
    harness.svc.setRuntimeTurnSettledEnvironmentProvider((input) =>
      feature!.buildRuntimeTurnSettledEnvironment(input)
    );
    feature.noteTeamChange({ type: 'task', teamName, taskId: task.id });

    await waitUntil(async () => {
      const inbox = await readInboxMessages(inboxPath);
      return inbox.some((message) => message.messageKind === 'member_work_sync_nudge');
    }, 30_000);
    expect(
      (await readInboxMessages(inboxPath))
        .filter((message) => message.messageKind === 'member_work_sync_nudge')
        .map((message) => message.messageId)
        .filter((value): value is string => Boolean(value))
        .sort()
    ).toEqual(messageIdsBeforeCrash);
    expect(
      Object.values(await readMemberWorkSyncOutboxItems(teamName, memberName))
        .map((item) => item.payload?.workSyncIntentKey)
        .filter((value): value is string => Boolean(value))
        .sort()
    ).toEqual(recoveryIdsBeforeCrash);

    await feature.prepareTeamDeletion(teamName);
    feature.completeTeamDeletion(teamName);
  }, 420_000);

  remainingWorkIt(
    'continues remaining OpenCode work after a settled status-only turn (A/B/C)',
    async () => {
      const selectedModel = process.env.OPENCODE_E2E_MODEL?.trim() || DEFAULT_MODEL;
      const marker = `recovery-live-opencode-a-${Date.now()}`;
      const memberName = 'bob';
      const projectPath = path.join(tempDir, 'project');
      const canaryPath = path.join(projectPath, 'CANARY.txt');
      await fs.mkdir(projectPath, { recursive: true });
      await fs.writeFile(
        path.join(projectPath, 'README.md'),
        '# Member work sync recovery OpenCode live progress canary\n\nDisposable sandbox only.\n',
        'utf8'
      );

      teamName = `member-work-sync-recovery-opencode-progress-${Date.now()}`;
      const inboxPath = path.join(getTeamsBasePath(), teamName, 'inboxes', `${memberName}.json`);
      const createFeature = (svc: OpenCodeLiveHarness['svc'], busy = false) =>
        createMemberWorkSyncFeature({
          lifecycleIdentity: owned!.identity,
          teamsBasePath: getTeamsBasePath(),
          ...MEMBER_WORK_SYNC_PRODUCTION_RECOVERY,
          configReader: new TeamConfigReader(),
          taskReader: new TeamTaskReader(),
          kanbanManager: new TeamKanbanManager(),
          membersMetaStore: new TeamMembersMetaStore(),
          isTeamActive: (name) => svc.isTeamAlive(name) || svc.hasProvisioningRun(name),
          listLifecycleActiveTeamNames: async () => (teamName ? [teamName] : []),
          queueQuietWindowMs: 500,
          ...(busy
            ? {
                priorityBusySignals: [
                  {
                    isBusy: async () => ({ busy: true, reason: 'approval_pending' }),
                  },
                ],
              }
            : {}),
        });

      harness = await createOpenCodeLiveHarness({
        tempDir,
        selectedModel,
        projectPath,
        timeoutMs: 360_000,
        launchTimeoutMs: 360_000,
        configureServices: (svc) => {
          feature = createFeature(svc);
          svc.setTeamChangeEmitter((event: TeamChangeEvent) => feature!.noteTeamChange(event));
          svc.setRuntimeTurnSettledEnvironmentProvider((input) =>
            feature!.buildRuntimeTurnSettledEnvironment(input)
          );
          return { memberWorkSyncFeature: feature! };
        },
      });

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
            'Do not edit files.',
            'If you receive a task, wait for instructions and do not complete it.',
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
          throw new FatalWaitError(formatProgressDump(progressEvents));
        }
        return progressEvents.some((progress) =>
          progress.message.includes('OpenCode team launch is ready')
        );
      }, 240_000);
      expect(harness.svc.isTeamAlive(teamName)).toBe(true);

      await seedOpenCodeShadowReadyMetrics({ teamName, memberName });
      const task = await new TeamDataService().createTask(teamName, {
        subject: `Write CANARY.txt ${marker}`,
        owner: memberName,
        startImmediately: false,
        prompt: [
          `This is a live recovery canary. Marker: ${marker}.`,
          'Do not edit files and do not complete this task on the first still_working turn.',
          'If you receive a member_work_sync_nudge, call member_work_sync_status first.',
          'Then call member_work_sync_report with state "still_working", the returned agendaFingerprint/reportToken, and taskIds from the nudge.',
          'Do not write CANARY.txt in that first report turn.',
          'Only after a later member_work_sync_nudge for remaining work, write CANARY.txt in the project root with exactly: done',
        ].join('\n'),
      });
      feature!.noteTeamChange({ type: 'task', teamName, taskId: task.id });
      await feature!.refreshStatus({ teamName, memberName });

      const busyFeature = createFeature(harness.svc, true);
      try {
        await expect(
          busyFeature.continueManually({
            teamName,
            memberName,
            idempotencyKey: 'live-approval',
          })
        ).rejects.toThrow(/member_busy/);
      } finally {
        await busyFeature.dispose();
      }

      await waitUntil(
        async () => {
          const inbox = await readInboxMessages(inboxPath);
          return inbox.some(
            (message) =>
              message.messageKind === 'member_work_sync_nudge' &&
              typeof message.messageId === 'string'
          );
        },
        60_000,
        500
      );
      const firstNudge = [...(await readInboxMessages(inboxPath))]
        .reverse()
        .find(
          (message) =>
            message.messageKind === 'member_work_sync_nudge' &&
            typeof message.messageId === 'string'
        );
      expect(firstNudge?.messageId).toBeTruthy();
      await waitForOpenCodePeerRelay(
        harness.svc,
        teamName,
        memberName,
        firstNudge!.messageId,
        180_000
      );

      await waitUntil(
        async () => {
          await feature!.replayPendingReports([teamName!]);
          await feature!.drainRuntimeTurnSettledEvents();
          const status = await feature!.getStatus({ teamName: teamName!, memberName });
          return status.report?.accepted === true && status.report.state === 'still_working';
        },
        240_000,
        2_000,
        async () =>
          formatMemberWorkSyncDiagnostics({
            feature: feature!,
            teamName: teamName!,
            memberName,
            taskId: task.id,
          })
      );

      const processedBeforeSettled = new Set(
        (await readRuntimeTurnSettledProcessedMetas(getTeamsBasePath())).map(
          ({ filePath }) => filePath
        )
      );
      await waitUntil(
        async () => {
          await feature!.drainRuntimeTurnSettledEvents();
          const metas = await readRuntimeTurnSettledProcessedMetas(getTeamsBasePath());
          return metas.some(({ filePath, meta }) => {
            const event = meta.event as Record<string, unknown> | undefined;
            return (
              !processedBeforeSettled.has(filePath) &&
              event?.provider === 'opencode' &&
              (event.teamName === teamName || meta.teamName === teamName)
            );
          });
        },
        60_000,
        2_000
      ).catch(() => undefined);
      expect((await fs.readFile(canaryPath, 'utf8').catch(() => '')).trim()).not.toMatch(/^done$/i);

      await expireOpenCodeAcceptedReportLease({ teamName, memberName });
      await feature!.refreshStatus({ teamName, memberName });
      const recoveryIdsBeforeAttention = Object.values(
        await readMemberWorkSyncOutboxItems(teamName, memberName)
      )
        .map((item) => item.payload?.workSyncIntentKey)
        .filter((value): value is string => Boolean(value))
        .sort();
      await backdateOpenCodeRecoveryEpisode({ teamName, memberName });
      const attention = await feature!.refreshStatus({ teamName, memberName });
      expect(attention.recoveryHealth?.episodes[0]?.phase).toBe('attention');
      expect(attention.recoveryHealth?.attentionAt).toBeTruthy();
      expect(
        Object.values(await readMemberWorkSyncOutboxItems(teamName, memberName))
          .map((item) => item.payload?.workSyncIntentKey)
          .filter((value): value is string => Boolean(value))
          .sort()
      ).toEqual(recoveryIdsBeforeAttention);

      const inboxBeforeContinue = await readInboxMessages(inboxPath);
      const nudgeIdsBeforeContinue = new Set(
        inboxBeforeContinue
          .map((message) => message.messageId)
          .filter((value): value is string => Boolean(value))
      );
      await waitUntil(
        async () => {
          await feature!.drainRuntimeTurnSettledEvents();
          try {
            await feature!.continueManually({
              teamName: teamName!,
              memberName,
              idempotencyKey: 'live-progress',
            });
            return true;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (/member_busy|status_not_nudgeable|payload_conflict/.test(message)) {
              await expireOpenCodeAcceptedReportLease({ teamName: teamName!, memberName });
              await feature!.refreshStatus({ teamName: teamName!, memberName });
              return false;
            }
            throw error;
          }
        },
        180_000,
        2_000,
        async () => {
          const status = await feature!.getStatus({ teamName: teamName!, memberName });
          return [
            await formatMemberWorkSyncDiagnostics({
              feature: feature!,
              teamName: teamName!,
              memberName,
              taskId: task.id,
            }),
            `recoveryHealth=${JSON.stringify(status.recoveryHealth ?? null)}`,
            `wouldNudge=${String(status.shadow?.wouldNudge)}`,
            `state=${status.state}`,
          ].join('\n');
        }
      );
      await feature!.dispatchDueNudges([teamName]);
      const relayedContinuationIds = new Set<string>();

      await waitUntil(
        async () => {
          await feature!.dispatchDueNudges([teamName!]);
          await feature!.drainRuntimeTurnSettledEvents();
          const inbox = await readInboxMessages(inboxPath);
          const continuation = [...inbox]
            .reverse()
            .find(
              (message) =>
                message.messageKind === 'member_work_sync_nudge' &&
                typeof message.messageId === 'string' &&
                !nudgeIdsBeforeContinue.has(message.messageId)
            );
          if (continuation?.messageId && !relayedContinuationIds.has(continuation.messageId)) {
            relayedContinuationIds.add(continuation.messageId);
            await waitForOpenCodePeerRelay(
              harness!.svc,
              teamName!,
              memberName,
              continuation.messageId,
              120_000
            );
          }
          const canary = await fs.readFile(canaryPath, 'utf8').catch(() => '');
          return /^\s*done\s*$/i.test(canary);
        },
        240_000,
        2_000,
        async () =>
          formatMemberWorkSyncDiagnostics({
            feature: feature!,
            teamName: teamName!,
            memberName,
            taskId: task.id,
          })
      );

      await feature!.prepareTeamDeletion(teamName);
      feature!.completeTeamDeletion(teamName);
    },
    1_200_000
  );
});

function memberStatusPath(teamName: string, memberName: string): string {
  return path.join(
    getTeamsBasePath(),
    teamName,
    'members',
    memberName,
    '.member-work-sync',
    'status.json'
  );
}

async function readStoredMemberStatus(
  teamName: string,
  memberName: string
): Promise<{
  status?: {
    report?: { expiresAt?: string };
    lastAcceptedReport?: { expiresAt?: string };
    recoveryHealth?: {
      episodes?: Array<{ firstObservedAt?: string; dueAt?: string }>;
      attentionAt?: string;
    };
  };
}> {
  const raw = await fs.readFile(memberStatusPath(teamName, memberName), 'utf8');
  return JSON.parse(raw) as Awaited<ReturnType<typeof readStoredMemberStatus>>;
}

async function seedOpenCodeShadowReadyMetrics(input: {
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

async function backdateOpenCodeRecoveryEpisode(input: {
  teamName: string;
  memberName: string;
}): Promise<void> {
  const stored = await readStoredMemberStatus(input.teamName, input.memberName);
  const health = stored.status?.recoveryHealth;
  const observed = health?.episodes?.[0]?.firstObservedAt;
  if (!observed || !health?.episodes?.[0]) {
    throw new Error('recovery episode missing before attention backdate');
  }
  health.episodes[0].firstObservedAt = new Date(Date.parse(observed) - 21 * 60_000).toISOString();
  health.episodes[0].dueAt = observed;
  await fs.writeFile(
    memberStatusPath(input.teamName, input.memberName),
    `${JSON.stringify(stored)}\n`,
    'utf8'
  );
}

async function expireOpenCodeAcceptedReportLease(input: {
  teamName: string;
  memberName: string;
}): Promise<void> {
  const stored = await readStoredMemberStatus(input.teamName, input.memberName);
  const expiredAt = new Date(Date.now() - 60_000).toISOString();
  if (stored.status?.report) {
    stored.status.report.expiresAt = expiredAt;
  }
  if (stored.status?.lastAcceptedReport) {
    stored.status.lastAcceptedReport.expiresAt = expiredAt;
  }
  await fs.writeFile(
    memberStatusPath(input.teamName, input.memberName),
    `${JSON.stringify(stored)}\n`,
    'utf8'
  );
}
