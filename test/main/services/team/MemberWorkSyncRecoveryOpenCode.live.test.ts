import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
import { createTestWorkSyncIdentity } from '../../../features/member-work-sync/helpers/createTestWorkSyncIdentity';

import {
  formatProgressDump,
  readMemberWorkSyncOutboxItems,
  waitUntil,
} from './memberWorkSyncLiveHarness';
import {
  createOpenCodeLiveHarness,
  type OpenCodeLiveHarness,
  waitForOpenCodeLanesStopped,
} from './openCodeLiveTestHarness';

import type { TeamChangeEvent, TeamProvisioningProgress } from '../../../../src/shared/types';

const liveDescribe = process.env.MEMBER_WORK_SYNC_RECOVERY_LIVE === '1' ? describe : describe.skip;
const DEFAULT_MODEL = 'opencode/big-pickle';

if (process.env.MEMBER_WORK_SYNC_RECOVERY_LIVE === '1') {
  process.env.OPENCODE_E2E_USE_REAL_APP_CREDENTIALS ??= '1';
}

liveDescribe('Member work sync recovery OpenCode live canary', () => {
  let tempDir: string;
  let feature: MemberWorkSyncFeatureFacade | null;
  let harness: OpenCodeLiveHarness | null;
  let teamName: string | null;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'member-work-sync-recovery-opencode-'));
    const tempClaudeRoot = path.join(tempDir, '.claude');
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
    harness = await createOpenCodeLiveHarness({
      tempDir,
      selectedModel,
      projectPath,
      configureServices: (svc) => {
        feature = createMemberWorkSyncFeature({
          lifecycleIdentity: createTestWorkSyncIdentity('inc-a'),
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
        throw new Error(formatProgressDump(progressEvents));
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
      lifecycleIdentity: createTestWorkSyncIdentity('inc-a'),
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
});
