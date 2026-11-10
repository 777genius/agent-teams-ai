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
      isTeamBusy: vi.fn(() => false),
      getRuntime: vi.fn(async () => ({
        teamName: 'e2e-team',
        runId: running ? 'active-team-run' : null,
        updatedAt: new Date().toISOString(),
        members: {
          lead: {
            memberName: 'lead',
            alive: running,
            restartable: false,
            backendType: 'lead' as const,
            pid: running ? 321 : undefined,
            pidSource: running ? ('lead_process' as const) : undefined,
            updatedAt: new Date().toISOString(),
          },
        },
      })),
      getMemberStatuses: vi.fn(async () => ({ runId: 'active-team-run', statuses: {} })),
      getLeadName: vi.fn(async () => 'lead'),
      getSavedRequest: vi.fn(async () => saved),
      hasLaunchConfig: vi.fn(async () => true),
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

  async function triggerWhenIdle(scheduleId: string) {
    // The run can be persisted before its finally block releases the in-memory lock.
    return vi.waitFor(() => scheduler.triggerNow(scheduleId), { timeout: 8000 });
  }

  async function waitForRun(scheduleId: string, expected: string) {
    await vi.waitFor(async () => {
      const runs = await repository.listRuns(scheduleId);
      expect(runs[0]?.status).toBe(expected);
    }, { timeout: 8000 });
    return (await repository.listRuns(scheduleId))[0];
  }

  it('refuses to persist, resume or execute Host-owned schedules through legacy services', async () => {
    const hostTeam = 'host-team:TEST-captured-handle';
    const hostInput = { ...input(), teamName: hostTeam, executionMode: 'agent' as const };
    await expect(scheduler.createSchedule(hostInput)).rejects.toThrow(
      'Host-backed teams require owner-aware scheduling'
    );
    expect(await repository.listSchedules()).toHaveLength(0);

    // Old records remain readable for cleanup, but never become executable.
    const now = new Date().toISOString();
    const retained: Schedule = {
      ...hostInput,
      id: 'retained-host-schedule',
      status: 'active',
      maxConsecutiveFailures: 3,
      consecutiveFailures: 0,
      maxTurns: 5,
      createdAt: now,
      updatedAt: now,
    };
    await repository.saveSchedule(retained);
    await scheduler.stop();
    await scheduler.start();
    await expect(scheduler.triggerNow(retained.id)).rejects.toThrow(
      'Host-backed teams require owner-aware scheduling'
    );
    await expect(scheduler.updateSchedule(retained.id, { label: 'Unsafe' })).rejects.toThrow(
      'Host-backed teams require owner-aware scheduling'
    );
    await expect(scheduler.resumeSchedule(retained.id)).rejects.toThrow(
      'Host-backed teams require owner-aware scheduling'
    );
    expect((await repository.listRuns(retained.id))).toHaveLength(0);
    expect(oneShot).not.toHaveBeenCalled();
    expect(port.launchTeam).not.toHaveBeenCalled();
    expect(port.createTask).not.toHaveBeenCalled();

    await scheduler.pauseSchedule(retained.id);
    await scheduler.deleteSchedule(retained.id);
    expect(await repository.listSchedules()).toHaveLength(0);
  });

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

  it('rejects task-first persistence without an execution mode', async () => {
    await expect(scheduler.createSchedule({ ...input(), taskFirst: true })).rejects.toThrow(
      /requires agent or team executionMode/
    );
    expect(await scheduler.listSchedules()).toHaveLength(0);
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

  it('persists task-first run linked to real task and skips the next overlapping occurrence', async () => {
    const boardTask: TeamTask = {
      id: 'e2e-task', displayId: '7', subject: 'In progress', status: 'in_progress',
    } as TeamTask;
    port.getPreviousRuns = async (id, runId) =>
      (await repository.listRuns(id, { limit: 50 })).filter((run) => run.id !== runId);
    port.getTask = vi.fn(async (_team, id) => id === boardTask.id ? boardTask : null);
    port.hasRunnableConfig = vi.fn(async () => true);
    port.startTaskByUser = vi.fn(async () => ({ notifiedOwner: true }));

    const schedule = await scheduler.createSchedule({
      ...input(), executionMode: 'agent', taskFirst: true, targetMember: '',
    });
    await scheduler.triggerNow(schedule.id);
    const first = await waitForRun(schedule.id, 'dispatched');
    expect(first.linkedTaskId).toBe(boardTask.id);
    expect(port.createTask).toHaveBeenCalledOnce();
    expect(port.runOneShot).not.toHaveBeenCalled();

    await scheduler.triggerNow(schedule.id);
    const skipped = await waitForRun(schedule.id, 'skipped');
    expect(skipped.id).not.toBe(first.id);
    expect(skipped.linkedTaskId).toBe(boardTask.id);
    expect(skipped.summary).toMatch(/previous task/i);
    expect(port.createTask).toHaveBeenCalledOnce();

    await scheduler.stop();
    await scheduler.start();
    const runs = await repository.listRuns(schedule.id);
    expect(runs[0]).toMatchObject({ status: 'skipped', linkedTaskId: boardTask.id });
    const savedSchedule = await repository.getSchedule(schedule.id);
    expect(savedSchedule?.taskFirst).toBe(true);
  });

  it('carries the unfinished task through more skips than the retained run history', async () => {
    const unfinished = { id: 'e2e-task', subject: 'Long-running work', status: 'in_progress' } as TeamTask;
    port.getPreviousRuns = async (id, runId) =>
      (await repository.listRuns(id, { limit: 50 })).filter((run) => run.id !== runId);
    port.getTask = vi.fn(async (_team, id) => id === unfinished.id ? unfinished : null);
    port.hasRunnableConfig = vi.fn(async () => true);
    port.startTaskByUser = vi.fn(async () => ({ notifiedOwner: true }));

    const schedule = await scheduler.createSchedule({
      ...input(), executionMode: 'team', taskFirst: true,
    });
    await scheduler.triggerNow(schedule.id);
    await waitForRun(schedule.id, 'dispatched');
    port.isTeamLaunching = vi.fn(() => true);
    for (let i = 0; i < 53; i++) {
      await triggerWhenIdle(schedule.id);
      const run = await waitForRun(schedule.id, 'skipped');
      expect(run.linkedTaskId).toBe(unfinished.id);
    }
    const history = await repository.listRuns(schedule.id);
    expect(history).toHaveLength(50);
    expect(history.every((run) => run.linkedTaskId === unfinished.id)).toBe(true);
    expect(port.createTask).toHaveBeenCalledOnce();

    port.isTeamLaunching = vi.fn(() => false);
    await triggerWhenIdle(schedule.id);
    expect((await waitForRun(schedule.id, 'skipped')).linkedTaskId).toBe(unfinished.id);
    expect(port.createTask).toHaveBeenCalledOnce();
  }, 20_000);

  it('creates a pending task before starting an inactive saved team without its old prompt', async () => {
    let live = false;
    port.isTeamAlive = vi.fn(() => live);
    port.getPreviousRuns = async (id, runId) =>
      (await repository.listRuns(id, { limit: 50 })).filter((run) => run.id !== runId);
    port.getTask = vi.fn(async () => null);
    port.hasRunnableConfig = vi.fn(async () => true);
    port.startTaskByUser = vi.fn(async () => ({ notifiedOwner: true }));
    port.getRuntime = vi.fn(async () => ({
      teamName: 'e2e-team',
      runId: live ? 'new-team-run' : null,
      updatedAt: new Date().toISOString(),
      members: {
        alice: {
          memberName: 'alice', alive: live, restartable: false,
          livenessKind: live ? 'confirmed_bootstrap' as const : 'not_found' as const,
          updatedAt: new Date().toISOString(),
        },
      },
    }));
    port.launchTeam = vi.fn(async (request) => {
      expect(port.createTask).toHaveBeenCalledOnce();
      expect(request).toMatchObject({
        teamName: 'e2e-team', providerId: 'anthropic',
        bootstrapOnly: true, prompt: undefined,
      });
      live = true;
      return { runId: 'new-team-run', launchStatus: 'started' as const };
    });
    const schedule = await scheduler.createSchedule({
      ...input(), executionMode: 'agent', taskFirst: true, targetMember: 'alice',
    });
    await scheduler.triggerNow(schedule.id);
    const run = await waitForRun(schedule.id, 'dispatched');
    expect(run.linkedTaskId).toBe('e2e-task');
    expect(port.createTask).toHaveBeenCalledWith(
      'e2e-team',
      expect.objectContaining({
        owner: 'alice', startImmediately: false,
        command: { commandId: run.id, idempotencyKey: `schedule:${run.id}` },
      })
    );
    expect(port.startTaskByUser).toHaveBeenCalledExactlyOnceWith(
      'e2e-team', 'e2e-task',
      expect.objectContaining({ expectedOwner: 'alice', canStart: expect.any(Function) })
    );
    expect(port.launchTeam).toHaveBeenCalledOnce();
    expect(port.runOneShot).not.toHaveBeenCalled();
  });

  it('rejects a metadata-only team draft before saving and safely skips retained schedules', async () => {
    port.hasLaunchConfig = vi.fn(async () => false);
    const draftInput = { ...input(), executionMode: 'team' as const };
    await expect(scheduler.createSchedule(draftInput)).rejects.toThrow('Finish team setup');
    expect(await repository.listSchedules()).toHaveLength(0);

    const now = new Date().toISOString();
    const retained: Schedule = {
      ...draftInput, id: 'retained-draft', status: 'active', maxConsecutiveFailures: 3,
      consecutiveFailures: 0, maxTurns: 5, createdAt: now, updatedAt: now,
    };
    await repository.saveSchedule(retained);
    await expect(scheduler.updateSchedule(retained.id, { label: 'Retry' })).rejects.toThrow('Finish team setup');
    await expect(scheduler.resumeSchedule(retained.id)).rejects.toThrow('Finish team setup');
    port.isTeamAlive = vi.fn(() => false);
    await scheduler.triggerNow(retained.id);
    const run = await waitForRun(retained.id, 'skipped');
    expect(run.summary).toContain('Finish team setup');
    expect(port.launchTeam).not.toHaveBeenCalled();
    expect(oneShot).not.toHaveBeenCalled();
  });

  it('persists a selected teammate HOLD without silently spawning a standalone agent', async () => {
    port.isTeamAlive = vi.fn(() => false);
    const schedule = await scheduler.createSchedule({
      ...input(), executionMode: 'agent', targetMember: 'alice', label: 'Alice backlog',
    });
    await scheduler.triggerNow(schedule.id);
    const run = await waitForRun(schedule.id, 'skipped');
    expect(run.summary).toContain('Selected teammate "alice" cannot run');
    expect(oneShot).not.toHaveBeenCalled();
    expect(port.createTask).not.toHaveBeenCalled();
    expect(port.launchTeam).not.toHaveBeenCalled();
    expect(port.attachMember).not.toHaveBeenCalled();
    await scheduler.stop();
    await scheduler.start();
    expect((await repository.listRuns(schedule.id))[0]?.status).toBe('skipped');
    expect((await repository.getSchedule(schedule.id))?.targetMember).toBe('alice');
  });

  it('persists a skipped run after a scheduled agent team is deleted', async () => {
    const schedule = await scheduler.createSchedule({
      ...input(), executionMode: 'agent', targetMember: 'alice',
    });
    // Schedule JSON survives team removal, but must not execute instructions.
    port.isTeamAlive = vi.fn(() => false);
    port.getSavedRequest = vi.fn(async () => null);
    await scheduler.triggerNow(schedule.id);
    const run = await waitForRun(schedule.id, 'skipped');
    expect(run.summary).toContain('configuration is missing');
    expect(oneShot).not.toHaveBeenCalled();
    expect(port.launchTeam).not.toHaveBeenCalled();
    expect(port.createTask).not.toHaveBeenCalled();
    expect((await repository.listRuns(schedule.id))[0]?.status).toBe('skipped');
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

  it('drains an in-flight JSON timestamp write before stop, cleanup and restart', async () => {
    const schedule = await scheduler.createSchedule({
      ...input(), executionMode: 'agent', targetMember: '',
    });
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
    let writeStarted = false;
    const saveSchedule = repository.saveSchedule.bind(repository);
    vi.spyOn(repository, 'saveSchedule').mockImplementation(async (candidate) => {
      if (candidate.id === schedule.id && candidate.lastRunAt) {
        writeStarted = true;
        await writeGate;
      }
      return saveSchedule(candidate);
    });

    await scheduler.triggerNow(schedule.id);
    await vi.waitFor(() => expect(writeStarted).toBe(true), { timeout: 8000 });
    let stopFinished = false;
    const stopping = scheduler.stop().then(() => { stopFinished = true; });
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      expect(stopFinished).toBe(false);
      expect(fs.existsSync(path.join(basePath, 'agent-teams-schedules'))).toBe(true);
    } finally {
      releaseWrite();
      await stopping;
    }

    expect((await repository.getSchedule(schedule.id))?.lastRunAt).toBeTruthy();
    expect((await repository.listRuns(schedule.id))[0]?.status).toBe('dispatched');
    await scheduler.start();
    expect((await repository.listRuns(schedule.id))[0]?.status).toBe('dispatched');
    expect(port.createTask).toHaveBeenCalledOnce();
    expect(oneShot).not.toHaveBeenCalled();
  });


  it('does not persist a late executor result from the previous scheduler generation', async () => {
    let finishExecution!: () => void;
    const executing = new Promise<void>((resolve) => { finishExecution = resolve; });
    oneShot.mockImplementationOnce(async () => {
      await executing;
      return {
        exitCode: 0, stdout: 'old run', stderr: '', summary: 'old run', durationMs: 10,
      };
    });
    const schedule = await scheduler.createSchedule(input());
    const run = await scheduler.triggerNow(schedule.id);
    await vi.waitFor(() => expect(oneShot).toHaveBeenCalledOnce(), { timeout: 8000 });
    try {
      await scheduler.stop();
      await scheduler.start();
    } finally {
      finishExecution();
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));

    expect((await repository.listRuns(schedule.id))[0]).toMatchObject({
      id: run.id, status: 'failed_interrupted',
    });
    expect((await repository.getSchedule(schedule.id))?.lastRunAt).toBeUndefined();
    expect(oneShot).toHaveBeenCalledOnce();
    expect(port.createTask).not.toHaveBeenCalled();
  });
});
