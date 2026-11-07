import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SmartScheduleDispatcher,
  type SmartScheduleRuntimePort,
} from '../../../../src/main/services/schedule/SmartScheduleDispatcher';

import type {
  Schedule,
  TeamAgentRuntimeEntry,
  TeamAgentRuntimeSnapshot,
  TeamCreateRequest,
  TeamTask,
} from '@shared/types';

function makeSchedule(mode: 'agent' | 'team' | undefined = 'agent'): Schedule {
  return {
    id: 'schedule-1',
    teamName: 'test-team',
    ...(mode ? { executionMode: mode } : {}),
    cronExpression: '0 * * * *',
    timezone: 'UTC',
    status: 'active',
    warmUpMinutes: 0,
    maxConsecutiveFailures: 3,
    consecutiveFailures: 0,
    maxTurns: 5,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    launchConfig: { cwd: '/tmp/schedule', prompt: 'Check bugs', providerId: 'anthropic' },
  };
}

function runtimeMembers(ready: boolean): TeamAgentRuntimeSnapshot {
  const member = (name: string, alive: boolean): TeamAgentRuntimeEntry => ({
    memberName: name,
    alive,
    restartable: false,
    livenessKind: alive ? 'confirmed_bootstrap' : 'not_found',
    updatedAt: new Date().toISOString(),
  });
  return {
    teamName: 'test-team',
    runId: 'team-run-1',
    updatedAt: new Date().toISOString(),
    members: { lead: member('lead', true), alice: member('alice', ready) },
  };
}

function makePort(): SmartScheduleRuntimePort {
  const saved: TeamCreateRequest = {
    teamName: 'test-team',
    cwd: '/tmp/saved-team',
    providerId: 'anthropic',
    members: [{ name: 'alice' }],
    model: 'claude-sonnet-4-5',
  };
  return {
    isTeamAlive: vi.fn(() => true),
    isTeamLaunching: vi.fn(() => false),
    getRuntime: vi.fn(async () => runtimeMembers(true)),
    getMemberStatuses: vi.fn(async () => ({
      runId: 'team-run-1',
      statuses: {
        alice: { status: 'offline' as const, launchState: 'failed_to_start' as const, updatedAt: new Date().toISOString() },
      },
    })),
    getLeadName: vi.fn(async () => 'lead'),
    getSavedRequest: vi.fn(async () => saved),
    attachMember: vi.fn(async () => undefined),
    createTask: vi.fn(async () => ({ id: 'task-1', displayId: '7', subject: 'task', status: 'in_progress' } as TeamTask)),
    launchTeam: vi.fn(async () => ({ runId: 'launched-1', launchStatus: 'started' as const })),
    runOneShot: vi.fn(async () => ({
      stdout: 'done',
      stderr: '',
      exitCode: 0,
      summary: 'done',
      durationMs: 100,
    })),
  };
}

describe('SmartScheduleDispatcher (source-level dispatch E2E)', () => {
  let port: SmartScheduleRuntimePort;
  let dispatch: SmartScheduleDispatcher;
  const active = () => false;

  beforeEach(() => {
    port = makePort();
    dispatch = new SmartScheduleDispatcher(port);
  });

  it('does not reinterpret a pre-existing legacy schedule', async () => {
    const legacy = makeSchedule('agent');
    delete legacy.executionMode;
    await expect(dispatch.dispatch(legacy, 'run-1', active)).rejects.toThrow(
      'Legacy schedule'
    );
    expect(port.runOneShot).not.toHaveBeenCalled();
    expect(port.launchTeam).not.toHaveBeenCalled();
  });

  it('runs the old one-shot executor for a new agent schedule if the team is off', async () => {
    port.isTeamAlive = vi.fn(() => false);
    const result = await dispatch.dispatch(makeSchedule('agent'), 'run-1', active);
    expect(result.kind).toBe('one_shot');
    expect(port.runOneShot).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-1', config: expect.objectContaining({ prompt: 'Check bugs' }) })
    );
    expect(port.launchTeam).not.toHaveBeenCalled();
    expect(port.createTask).not.toHaveBeenCalled();
  });

  it('creates exactly one idempotent task for an already running agent', async () => {
    const result = await dispatch.dispatch(makeSchedule('agent'), 'run-2', active);
    expect(result.kind).toBe('dispatched');
    expect(port.createTask).toHaveBeenCalledOnce();
    expect(port.createTask).toHaveBeenCalledWith('test-team', expect.objectContaining({
      owner: 'lead',
      startImmediately: true,
      command: { commandId: 'run-2', idempotencyKey: 'schedule:run-2' },
    }));
    expect(port.runOneShot).not.toHaveBeenCalled();
    expect(port.launchTeam).not.toHaveBeenCalled();
    expect(port.attachMember).not.toHaveBeenCalled();
  });

  it('targets the selected live teammate, not an unrelated agent', async () => {
    const schedule = { ...makeSchedule('agent'), targetMember: 'alice' };
    const result = await dispatch.dispatch(schedule, 'run-3', active);
    expect(result.kind).toBe('dispatched');
    expect(port.createTask).toHaveBeenCalledWith('test-team', expect.objectContaining({ owner: 'alice' }));
  });

  it('attaches an explicitly offline teammate without restart and creates task only after ready', async () => {
    let online = false;
    port.getRuntime = vi.fn(async () => runtimeMembers(online));
    port.attachMember = vi.fn(async () => { online = true; });
    const schedule = { ...makeSchedule('agent'), targetMember: 'alice' };
    const result = await dispatch.dispatch(schedule, 'run-4', active);
    expect(result.kind).toBe('dispatched');
    expect(port.attachMember).toHaveBeenCalledOnce();
    expect(port.createTask).toHaveBeenCalledOnce();
    expect(port.createTask).toHaveBeenCalledWith('test-team', expect.objectContaining({ owner: 'alice' }));
  });

  it('refuses auto attach when member might still own an uncertain runtime', async () => {
    const uncertain = runtimeMembers(false);
    uncertain.members.alice = { ...uncertain.members.alice, livenessKind: 'stale_metadata' };
    port.getRuntime = vi.fn(async () => uncertain);
    const schedule = { ...makeSchedule('agent'), targetMember: 'alice' };
    const result = await dispatch.dispatch(schedule, 'run-5', active);
    expect(result.kind).toBe('skipped');
    expect(port.attachMember).not.toHaveBeenCalled();
    expect(port.createTask).not.toHaveBeenCalled();
  });

  it('does not auto-reattach a possibly shared OpenCode runtime', async () => {
    const offline = runtimeMembers(false);
    offline.members.alice = { ...offline.members.alice, providerId: 'opencode', laneKind: 'secondary' };
    port.getRuntime = vi.fn(async () => offline);
    const result = await dispatch.dispatch(
      { ...makeSchedule('agent'), targetMember: 'alice' }, 'open-code-run', active
    );
    expect(result.kind).toBe('skipped');
    expect(port.attachMember).not.toHaveBeenCalled();
    expect(port.createTask).not.toHaveBeenCalled();
  });

  it('respects a deliberately skipped teammate', async () => {
    port.getRuntime = vi.fn(async () => runtimeMembers(false));
    port.getMemberStatuses = vi.fn(async () => ({
      runId: 'team-run-1', statuses: { alice: { status: 'skipped' as const, launchState: 'skipped_for_launch' as const, updatedAt: new Date().toISOString() } },
    }));
    const result = await dispatch.dispatch(
      { ...makeSchedule('agent'), targetMember: 'alice' }, 'run-skipped', active
    );
    expect(result.kind).toBe('skipped');
    expect(port.attachMember).not.toHaveBeenCalled();
  });

  it('launches the whole team once using saved provider/CWD and one prompt', async () => {
    port.isTeamAlive = vi.fn(() => false);
    const result = await dispatch.dispatch(makeSchedule('team'), 'run-6', active);
    expect(result.kind).toBe('dispatched');
    expect(port.launchTeam).toHaveBeenCalledOnce();
    expect(port.launchTeam).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/tmp/saved-team',
      providerId: 'anthropic',
      prompt: 'Check bugs',
    }));
    expect(port.runOneShot).not.toHaveBeenCalled();
    expect(port.createTask).not.toHaveBeenCalled();
  });

  it('assigns a task to the live lead instead of relaunching the whole team', async () => {
    const result = await dispatch.dispatch(makeSchedule('team'), 'run-7', active);
    expect(result.kind).toBe('dispatched');
    expect(port.createTask).toHaveBeenCalledWith('test-team', expect.objectContaining({ owner: 'lead' }));
    expect(port.launchTeam).not.toHaveBeenCalled();
  });

  it('skips an already launching team without side effects', async () => {
    port.isTeamLaunching = vi.fn(() => true);
    const result = await dispatch.dispatch(makeSchedule('team'), 'run-8', active);
    expect(result.kind).toBe('skipped');
    expect(port.createTask).not.toHaveBeenCalled();
    expect(port.launchTeam).not.toHaveBeenCalled();
  });

  it('never creates a task after cancellation or runtime replacement', async () => {
    let snapshotCount = 0;
    port.getRuntime = vi.fn(async () => {
      snapshotCount++;
      return { ...runtimeMembers(true), runId: snapshotCount > 1 ? 'new-run' : 'team-run-1' };
    });
    const result = await dispatch.dispatch(makeSchedule('agent'), 'run-9', active);
    expect(result.kind).toBe('skipped');
    expect(port.createTask).not.toHaveBeenCalled();
  });

  it('skips simultaneous schedules for the same team instead of submitting duplicate tasks', async () => {
    const pending: { resolve?: (task: TeamTask) => void } = {};
    port.createTask = vi.fn(() => new Promise<TeamTask>((resolve) => { pending.resolve = resolve; }));
    const first = dispatch.dispatch(makeSchedule('team'), 'run-10', active);
    const second = await dispatch.dispatch(makeSchedule('agent'), 'run-11', active);
    expect(second.kind).toBe('skipped');
    // The first dispatch is waiting for the one task write to finish.
    await vi.waitFor(() => expect(port.createTask).toHaveBeenCalledOnce());
    if (!pending.resolve) throw new Error('task write was not started');
    pending.resolve({ id: 'task-1', displayId: '7', subject: 'task', status: 'in_progress' } as TeamTask);
    expect((await first).kind).toBe('dispatched');
  });
});
