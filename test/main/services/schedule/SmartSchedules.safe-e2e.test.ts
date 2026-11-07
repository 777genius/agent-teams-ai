/**
 * Filesystem integration: real Croner + SchedulerService + JSON repository + smart
 * dispatch, with provider/process side effects replaced by deterministic ports.
 * Runs without credentials, installed agent CLI, or network access.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { setClaudeBasePathOverride } from '@main/utils/pathDecoder';

import { JsonScheduleRepository } from '../../../../src/main/services/schedule/JsonScheduleRepository';
import { SchedulerService } from '../../../../src/main/services/schedule/SchedulerService';
import {
  SmartScheduleDispatcher,
  type SmartScheduleRuntimePort,
} from '../../../../src/main/services/schedule/SmartScheduleDispatcher';

import type { ScheduledTaskExecutor } from '../../../../src/main/services/schedule/ScheduledTaskExecutor';
import type { Schedule, TeamTask } from '@shared/types';

describe('Smart schedules filesystem safe E2E', () => {
  let basePath: string;
  let repository: JsonScheduleRepository;
  let oneShot: ReturnType<typeof vi.fn>;
  let port: SmartScheduleRuntimePort;
  let scheduler: SchedulerService;

  beforeEach(async () => {
    basePath = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-schedules-safe-e2e-'));
    setClaudeBasePathOverride(basePath);
    repository = new JsonScheduleRepository();

    oneShot = vi.fn(async () => ({
      exitCode: 0,
      stdout: 'standalone executed',
      stderr: '',
      summary: 'standalone executed',
      durationMs: 12,
    }));
    const saved = {
      teamName: 'e2e-team',
      cwd: path.join(basePath, 'saved-project'),
      providerId: 'anthropic' as const,
      model: 'sonnet',
      members: [{ name: 'alice' }],
    };
    let running = true;
    port = {
      isTeamAlive: vi.fn(() => running),
      isTeamLaunching: vi.fn(() => false),
      getRuntime: vi.fn(async () => ({
        teamName: 'e2e-team',
        runId: running ? 'active-team-run' : null,
        updatedAt: new Date().toISOString(),
        members: {
          lead: {
            memberName: 'lead',
            alive: running,
            restartable: false,
            livenessKind: running ? ('confirmed_bootstrap' as const) : ('not_found' as const),
            updatedAt: new Date().toISOString(),
          },
        },
      })),
      getMemberStatuses: vi.fn(async () => ({ runId: 'active-team-run', statuses: {} })),
      getLeadName: vi.fn(async () => 'lead'),
      getSavedRequest: vi.fn(async () => saved),
      attachMember: vi.fn(async () => undefined),
      createTask: vi.fn(async () => ({
        id: 'e2e-task',
        displayId: '7',
        subject: 'scheduled task',
        status: 'in_progress',
      } as TeamTask)),
      launchTeam: vi.fn(async () => ({ runId: 'new-team-run', launchStatus: 'started' as const })),
      runOneShot: oneShot,
    };
    // Each run writes to the same repository the renderer reads. No mocked JSON
    // storage: this tests schema compatibility, cron persistence and run history.
    const executor = {
      execute: oneShot,
      cancel: vi.fn(() => false),
      cancelAll: vi.fn(),
    } as unknown as ScheduledTaskExecutor;
    scheduler = new SchedulerService(
      repository,
      executor,
      async () => ({ ready: true, message: 'ready' }),
      new SmartScheduleDispatcher(port)
    );
    await scheduler.start();
  });

  afterEach(async () => {
    await scheduler.stop();
    setClaudeBasePathOverride(null);
    fs.rmSync(basePath, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const input = () => ({
    teamName: 'e2e-team',
    cronExpression: '0 9 * * 1-5',
    timezone: 'UTC',
    warmUpMinutes: 0,
    launchConfig: { cwd: '/tmp/e2e-project', prompt: 'Check open bugs', providerId: 'anthropic' as const },
  });

  async function waitForRun(scheduleId: string, expected: string) {
    await vi.waitFor(async () => {
      const runs = await repository.listRuns(scheduleId);
      expect(runs[0]?.status).toBe(expected);
    }, { timeout: 8000 });
    return (await repository.listRuns(scheduleId))[0];
  }

  it('reads unmodified preexisting JSON and continues the one-shot executor after editing', async () => {
    const now = new Date().toISOString();
    const legacy: Schedule = {
      ...input(),
      id: 'legacy-e2e',
      status: 'active',
      maxConsecutiveFailures: 3,
      consecutiveFailures: 0,
      maxTurns: 5,
      createdAt: now,
      updatedAt: now,
    };
    await repository.saveSchedule(legacy);
    await scheduler.stop();
    await scheduler.start();

    const persisted = await scheduler.getSchedule(legacy.id);
    expect(persisted?.executionMode).toBeUndefined();
    await scheduler.updateSchedule(legacy.id, { label: 'Old job, new label' });
    expect((await repository.getSchedule(legacy.id))?.executionMode).toBeUndefined();

    await scheduler.triggerNow(legacy.id);
    const run = await waitForRun(legacy.id, 'completed');
    expect(run.summary).toContain('standalone executed');
    expect(oneShot).toHaveBeenCalledOnce();
    expect(port.createTask).not.toHaveBeenCalled();
    expect(port.launchTeam).not.toHaveBeenCalled();
    expect((await repository.getRunLogs(legacy.id, run.id)).stdout).toBe('standalone executed');
  });

  it('creates an idempotent assigned task and never launches CLI for a running team', async () => {
    const schedule = await scheduler.createSchedule({
      ...input(), executionMode: 'agent', targetMember: '', label: 'Daily review',
    });
    await scheduler.triggerNow(schedule.id);
    const run = await waitForRun(schedule.id, 'dispatched');

    expect(run.summary).toContain('assigned to lead');
    expect(oneShot).not.toHaveBeenCalled();
    expect(port.launchTeam).not.toHaveBeenCalled();
    expect(port.createTask).toHaveBeenCalledOnce();
    const req = vi.mocked(port.createTask).mock.calls[0][1];
    expect(req.command?.commandId).toBe(run.id);
    expect(req.command?.idempotencyKey).toBe(`schedule:${run.id}`);
    expect(req.startImmediately).toBe(true);
    const persisted = await repository.getSchedule(schedule.id);
    expect(persisted?.executionMode).toBe('agent');

    await scheduler.stop();
    await scheduler.start();
    expect((await repository.listRuns(schedule.id))[0].status).toBe('dispatched');
  });

  it('starts a stopped team once from its saved provider profile without a second task', async () => {
    port.isTeamAlive = vi.fn(() => false);
    const schedule = await scheduler.createSchedule({
      ...input(), executionMode: 'team', label: 'Start team for backlog',
    });
    await scheduler.triggerNow(schedule.id);
    const run = await waitForRun(schedule.id, 'dispatched');
    expect(run.summary).toContain('launch requested');
    expect(port.launchTeam).toHaveBeenCalledOnce();
    expect(port.launchTeam).toHaveBeenCalledWith(expect.objectContaining({
      teamName: 'e2e-team',
      cwd: path.join(basePath, 'saved-project'),
      providerId: 'anthropic',
      prompt: 'Check open bugs',
    }));
    expect(oneShot).not.toHaveBeenCalled();
    expect(port.createTask).not.toHaveBeenCalled();
  });

  it('persists a skipped state without task, launch or one-shot side effects', async () => {
    port.isTeamLaunching = vi.fn(() => true);
    const schedule = await scheduler.createSchedule({ ...input(), executionMode: 'team' });
    await scheduler.triggerNow(schedule.id);
    const run = await waitForRun(schedule.id, 'skipped');
    expect(run.summary).toMatch(/launching/i);
    expect(port.launchTeam).not.toHaveBeenCalled();
    expect(port.createTask).not.toHaveBeenCalled();
    expect(oneShot).not.toHaveBeenCalled();
  });
});
