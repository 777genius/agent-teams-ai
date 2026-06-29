import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createMemberWorkSyncFeature,
  type MemberWorkSyncFeatureFacade,
} from '../../../../src/features/member-work-sync/main';
import { RUNTIME_TURN_SETTLED_SPOOL_ROOT_ENV } from '../../../../src/features/member-work-sync/main/infrastructure/runtimeTurnSettledEnvironment';
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
const execFileAsync = promisify(execFile);

const idleLiveIt =
  process.env.OPENCODE_E2E === '1' &&
  process.env.OPENCODE_E2E_MEMBER_WORK_SYNC === '1' &&
  process.env.OPENCODE_E2E_MEMBER_WORK_SYNC_IDLE === '1'
    ? it
    : it.skip;

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

  idleLiveIt(
    'bridges a real OpenCode idle turn-settled event into work-sync recovery',
    async () => {
      const selectedModel = process.env.OPENCODE_E2E_MODEL?.trim() || DEFAULT_MODEL;
      const projectPath = path.join(tempDir, 'idle-project');
      await fs.mkdir(projectPath, { recursive: true });
      await fs.writeFile(
        path.join(projectPath, 'README.md'),
        '# Member work sync OpenCode idle live smoke\n',
        'utf8'
      );

      const memberName = 'bob';
      teamName = `member-work-sync-opencode-idle-${Date.now()}`;
      const taskId = 'task-opencode-idle';
      feature = createMemberWorkSyncFeature({
        teamsBasePath: getTeamsBasePath(),
        configReader: {
          getConfig: async () => ({
            name: teamName!,
            members: [{ name: memberName, role: 'Developer', providerId: 'opencode' }],
          }),
        } as never,
        taskReader: {
          getTasks: async () => [
            {
              id: taskId,
              displayId: '11111111',
              subject: 'Recover after real OpenCode idle turn',
              status: 'pending',
              owner: memberName,
            },
          ],
        } as never,
        kanbanManager: {
          getState: async () => ({ teamName: teamName!, reviewers: [], tasks: {} }),
        } as never,
        membersMetaStore: {
          getMembers: async () => [],
        } as never,
        isTeamActive: async () => true,
        queueQuietWindowMs: 1,
        resolveControlUrl: async () => 'http://127.0.0.1:43123',
      });

      await seedShadowReadyMetrics({ teamName, memberName });
      feature.noteTeamChange({ type: 'task', teamName, taskId });

      const inboxPath = path.join(getTeamsBasePath(), teamName, 'inboxes', `${memberName}.json`);
      await waitUntil(async () => {
        const inbox = await readInboxMessages(inboxPath);
        return inbox.some((message) => message.messageKind === 'member_work_sync_nudge');
      }, 60_000);

      const env = await feature.buildRuntimeTurnSettledEnvironment({ provider: 'opencode' });
      const spoolRoot = env?.[RUNTIME_TURN_SETTLED_SPOOL_ROOT_ENV];
      expect(spoolRoot).toBeTruthy();
      const smoke = await runOpenCodeIdleTurnSettledSmoke({
        tempDir,
        selectedModel,
        projectPath,
        spoolRoot: spoolRoot!,
        teamName,
        memberName,
      });
      expect(smoke.eventOutcome).toBe('idle_without_assistant_activity');
      expect(smoke.runtimePromptMessageId).toMatch(/^msg_/);

      await waitUntil(async () => {
        await feature!.drainRuntimeTurnSettledEvents();
        const status = await feature!.getStatus({ teamName: teamName!, memberName });
        const inbox = await readInboxMessages(inboxPath);
        const nudges = inbox.filter(
          (message) => message.messageKind === 'member_work_sync_nudge'
        );
        return (
          status.diagnostics.includes('runtime_stall:same_agenda_still_needs_sync') &&
          nudges.length >= 2 &&
          nudges.some((message) => message.messageId?.includes('status-only'))
        );
      }, 60_000);

      const metas = await readRuntimeTurnSettledProcessedMetas(getTeamsBasePath());
      expect(
        metas.some(({ meta }) => {
          const event = meta.event as Record<string, unknown> | undefined;
          return (
            meta.outcome === 'enqueued' &&
            event?.provider === 'opencode' &&
            event.teamName === teamName &&
            event.memberName === memberName &&
            event.outcome === 'idle_without_assistant_activity'
          );
        })
      ).toBe(true);
    },
    180_000
  );
});

async function runOpenCodeIdleTurnSettledSmoke(input: {
  tempDir: string;
  selectedModel: string;
  projectPath: string;
  spoolRoot: string;
  teamName: string;
  memberName: string;
}): Promise<{
  eventOutcome: string;
  runtimePromptMessageId: string;
}> {
  const runtimeRoot =
    process.env.CLAUDE_DEV_RUNTIME_ROOT?.trim() ||
    path.resolve(process.cwd(), '..', 'agent_teams_orchestrator');
  await fs.access(path.join(runtimeRoot, 'src/services/opencode/OpenCodeSessionBridge.ts'));

  const script = `
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { openCodeHostManager } from "./src/services/opencode/OpenCodeHostManager.js";
import { openCodeInventoryService } from "./src/services/opencode/OpenCodeInventoryService.js";
import { FileOpenCodeRuntimeTurnSettledEmitter, RUNTIME_TURN_SETTLED_SPOOL_ROOT_ENV } from "./src/services/opencode/OpenCodeRuntimeTurnSettledEmitter.js";
import { openCodeSessionBridge } from "./src/services/opencode/OpenCodeSessionBridge.js";
import { openCodeSessionStore } from "./src/services/opencode/OpenCodeSessionStore.js";
import { OpenCodeTurnSettledEmissionCoordinator } from "./src/services/opencode/OpenCodeTurnSettledEmissionCoordinator.js";

const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(name + " is required");
  return value;
};
const projectPath = required("OPENCODE_IDLE_SMOKE_PROJECT_PATH");
const spoolRoot = required("OPENCODE_IDLE_SMOKE_SPOOL_ROOT");
const teamName = required("OPENCODE_IDLE_SMOKE_TEAM_NAME");
const memberName = required("OPENCODE_IDLE_SMOKE_MEMBER_NAME");
const selectedModel = required("OPENCODE_IDLE_SMOKE_MODEL");
const laneId = "secondary:opencode:" + memberName;
let record;
try {
  await writeFile(path.join(projectPath, "README.md"), "# OpenCode idle turn-settled smoke\\n", "utf8");
  const inventory = await openCodeInventoryService.probe();
  if (!inventory.detected) throw new Error("OpenCode CLI unavailable");
  if (!inventory.models.includes(selectedModel)) {
    throw new Error("OpenCode model unavailable: " + selectedModel);
  }
  record = await openCodeSessionBridge.ensureSession({
    teamId: teamName,
    laneId,
    memberName,
    selectedModel,
    projectPath,
  });
  const prompted = await openCodeSessionBridge.promptAsyncWithTurnSettled(record, {
    text: "Wait silently for 20 seconds before replying. Do not write any text before the wait.",
    agent: "teammate",
    timeoutMs: 750,
    idleTimeoutMs: 250,
  });
  if (prompted.turnSettled.outcome !== "idle_without_assistant_activity") {
    throw new Error("Expected idle_without_assistant_activity, got " + prompted.turnSettled.outcome);
  }
  const coordinator = new OpenCodeTurnSettledEmissionCoordinator({
    now: () => new Date("2026-04-29T12:00:00.000Z"),
    emitter: new FileOpenCodeRuntimeTurnSettledEmitter({
      [RUNTIME_TURN_SETTLED_SPOOL_ROOT_ENV]: spoolRoot,
    }),
  });
  await coordinator.emitDelivery({
    record,
    runtimePromptMessageId: prompted.runtimePromptMessageId,
    turnSettled: prompted.turnSettled,
    reconcileSummary: null,
  });
  const files = await readdir(path.join(spoolRoot, "incoming"));
  const event = JSON.parse(await readFile(path.join(spoolRoot, "incoming", files.sort().at(-1)), "utf8"));
  console.log(JSON.stringify({
    eventOutcome: event.outcome,
    runtimePromptMessageId: event.runtimePromptMessageId,
  }));
} finally {
  await openCodeHostManager.reconcilePersistentHosts({
    mode: "force",
    reason: "member_work_sync_opencode_idle_live_smoke_cleanup",
    projectPath,
    staleAgeMs: 0,
    leaseStaleAgeMs: 0,
    preflightLeaseStaleAgeMs: 0,
  }).catch(() => undefined);
  if (record) await openCodeSessionBridge.releaseSession(record).catch(() => undefined);
  await openCodeSessionStore.delete(teamName, laneId, memberName).catch(() => undefined);
}
`;

  const { stdout } = await execFileAsync('bun', ['-e', script], {
    cwd: runtimeRoot,
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
    env: {
      ...process.env,
      OPENCODE_IDLE_SMOKE_PROJECT_PATH: input.projectPath,
      OPENCODE_IDLE_SMOKE_SPOOL_ROOT: input.spoolRoot,
      OPENCODE_IDLE_SMOKE_TEAM_NAME: input.teamName,
      OPENCODE_IDLE_SMOKE_MEMBER_NAME: input.memberName,
      OPENCODE_IDLE_SMOKE_MODEL: input.selectedModel,
    },
  });
  return JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}') as {
    eventOutcome: string;
    runtimePromptMessageId: string;
  };
}

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
