import { HostSmartScheduleRuntimeAdapter } from '@features/agent-backend/main/adapters/output/HostSmartScheduleRuntimeAdapter';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SmartScheduleDispatcher,
  type SmartScheduleRuntimePort,
} from '../../../../src/main/services/schedule/SmartScheduleDispatcher';

import type { BackendLaunchSnapshot } from '@features/agent-backend/contracts/launch';
import type { BackendRuntimeSnapshot } from '@features/agent-backend/contracts/operations';
import type { CapturedHostScheduleTarget } from '@features/agent-backend/main/application/captureHostScheduleTarget';
import type {
  Schedule,
  ScheduleRun,
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
    members: {
      // Mirrors the real non-OpenCode lead process snapshot: no livenessKind.
      lead: {
        memberName: 'lead',
        alive: true,
        backendType: 'lead',
        pid: 321,
        pidSource: 'lead_process',
        restartable: false,
        updatedAt: new Date().toISOString(),
      },
      alice: member('alice', ready),
    },
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
    isTeamBusy: vi.fn(() => false),
    getRuntime: vi.fn(async () => runtimeMembers(true)),
    getMemberStatuses: vi.fn(async () => ({
      runId: 'team-run-1',
      statuses: {
        alice: { status: 'offline' as const, launchState: 'failed_to_start' as const, updatedAt: new Date().toISOString() },
      },
    })),
    getLeadName: vi.fn(async () => 'lead'),
    getSavedRequest: vi.fn(async () => saved),
    hasLaunchConfig: vi.fn(async () => true),
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

  it('awaits owner-backed liveness and busy checks before creating scheduled work', async () => {
    port.isTeamAlive = vi.fn(async () => true);
    port.isTeamLaunching = vi.fn(async () => false);
    port.isTeamBusy = vi.fn(async () => false);
    const result = await dispatch.dispatch(makeSchedule('agent'), 'async-owner-run', active);
    expect(result.kind).toBe('dispatched');
    expect(port.createTask).toHaveBeenCalledTimes(1);
    expect(port.launchTeam).not.toHaveBeenCalled();
    expect(port.runOneShot).not.toHaveBeenCalled();
  });

  it('attaches only the original owned unopened Host generation and fences Start to its run', async () => {
    const selection = 'host-team:TEST-handle';
    const unopened: BackendRuntimeSnapshot = { memberId: 'TEST-member', generation: 'TEST-generation',
      phase: 'unopened', custody: 'owned', attached: false, sealed: false, nativeReady: false,
      inputs: [], interactions: [] };
    const state = { ...unopened };
    const launch: BackendLaunchSnapshot = { launchId: 'TEST-original-run', rosterRevision: 'TEST-roster',
      status: 'partial', ready: 0, expected: 1, retryCapability: 'same-binding-no-allocation-only',
      members: [{ memberId: state.memberId, generation: state.generation!, attemptId: 'TEST-attempt',
        status: 'not-started', nativeReady: false, usable: false, controlAvailable: false,
        noAllocation: true, reason: 'TEST-unopened' }] };
    const invoke = vi.fn<CapturedHostScheduleTarget['invoke']>(async request => {
      switch (request.operation) {
        case 'team.roster.read': return { ok: true, value: { revision: 'TEST-roster', removedMembers: [],
          members: [{ memberId: state.memberId, name: 'alice', role: 'member', settings: {} }] } };
        case 'team.snapshot': return { ok: true, value: { teamName: selection, revision: 'TEST-revision',
          feed: { streamId: 'TEST-stream', sequence: 0, cursor: 'TEST-cursor' }, members: [], tasks: [], messages: [],
          kanbanState: { teamName: selection, reviewers: [], tasks: {} } } };
        case 'team.launch.read': return { ok: true, value: launch };
        case 'runtime.read': case 'runtime.open': return { ok: true, value: state };
        case 'task.start': return { ok: true, value: { commandId: request.commandId,
          operation: 'task.start', phase: 'completed', notifiedOwner: true } };
        default: throw new Error('Unexpected TEST scheduled operation');
      }
    });
    const target: CapturedHostScheduleTarget = { target: { kind: 'host', contextId: 'TEST-context',
      handleId: 'TEST-handle', ownerResourceRef: 'TEST-owner', teamResourceRef: 'TEST-team' },
      isCurrent: () => true, invoke, prepareModels: async () => { throw new Error('Unexpected TEST model preparation'); } };
    const adapter = new HostSmartScheduleRuntimeAdapter({ target, selection, runId: 'TEST-occurrence',
      taskFirst: true, getPreviousRuns: async () => [] });
    const expected = { runId: launch.launchId, generation: state.generation! };
    expect(await adapter.getMemberStatuses(selection)).toMatchObject({
      statuses: { alice: { status: 'offline' } } });
    await adapter.attachMember(selection, 'alice', expected);
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ operation: 'runtime.open' }),
      { launchId: expected.runId, memberId: state.memberId, expectedGeneration: state.generation });
    const admission = { expectedOwner: 'alice', expectedRunId: expected.runId,
      expectedGeneration: expected.generation, isCurrent: () => true, canStart: async () => true };
    await expect(adapter.startTaskByUser(selection, 'TEST-task', admission)).resolves.toEqual({ notifiedOwner: true });
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ operation: 'task.start',
      payload: { taskId: 'TEST-task', notification: 'user', expectedRecipient: {
        name: 'alice', memberId: state.memberId, ...expected, requireIdle: true } } }));
    for (const changed of [{ custody: 'unknown' as const }, { sealed: true }, { attached: true }, { phase: 'allocated' }]) {
      Object.assign(state, unopened, changed);
      expect(await adapter.getMemberStatuses(selection)).toMatchObject({ statuses: { alice: { status: 'error' } } });
      await expect(adapter.attachMember(selection, 'alice', expected)).rejects.toThrow('manual restart');
    }
    Object.assign(state, unopened);
    launch.launchId = 'TEST-replacement-run'; // Same generation label cannot authorize another run.
    await expect(adapter.attachMember(selection, 'alice', expected)).rejects.toThrow('recipient changed');
    await expect(adapter.startTaskByUser(selection, 'TEST-task', admission)).rejects.toThrow('recipient changed');
    expect(invoke.mock.calls.filter(([request]) => request.operation === 'runtime.open')).toHaveLength(1);
    expect(invoke.mock.calls.filter(([request]) => request.operation === 'task.start')).toHaveLength(1);
  });

  it('awaits the final owner check after task creation before starting a task', async () => {
    enableTaskFirstPorts();
    let busy = false;
    port.isTeamAlive = vi.fn(async () => true);
    port.isTeamLaunching = vi.fn(async () => false);
    port.isTeamBusy = vi.fn(async () => busy);
    port.hasActiveOwnedTask = vi.fn(async () => false);
    port.startTaskByUser = vi.fn(async (
      _team: string,
      _task: string,
      admission?: { expectedOwner: string; canStart: () => Promise<boolean> }
    ) => {
      busy = true;
      return { notifiedOwner: await admission!.canStart() };
    });
    const result = await dispatch.dispatch(
      { ...makeSchedule('agent'), taskFirst: true }, 'async-owner-start', active
    );
    expect(port.createTask).toHaveBeenCalledTimes(1);
    expect(port.startTaskByUser).toHaveBeenCalledTimes(1);
    expect(result.kind).toBe('skipped');
  });

  it('observes cancellation that arrives during the last asynchronous liveness read', async () => {
    let cancelled = false;
    let reads = 0;
    port.isTeamAlive = vi.fn(async () => {
      if (++reads === 3) cancelled = true;
      return true;
    });
    const result = await dispatch.dispatch(makeSchedule('agent'), 'cancel-at-read', () => cancelled);
    expect(reads).toBe(3);
    expect(result.kind).toBe('skipped');
    expect(port.createTask).not.toHaveBeenCalled();
    expect(port.runOneShot).not.toHaveBeenCalled();
  });

  it('refuses Host-owned schedules before reading or mutating the legacy runtime', async () => {
    for (const mode of ['agent', 'team'] as const) {
      const result = await dispatch.dispatch(
        { ...makeSchedule(mode), teamName: 'host-team:TEST-captured-handle' },
        'TEST-host-run',
        active
      );
      expect(result.kind).toBe('skipped');
    }
    expect(port.isTeamAlive).not.toHaveBeenCalled();
    expect(port.getSavedRequest).not.toHaveBeenCalled();
    expect(port.createTask).not.toHaveBeenCalled();
    expect(port.launchTeam).not.toHaveBeenCalled();
    expect(port.runOneShot).not.toHaveBeenCalled();
  });

  it('rejects invalid persisted modes instead of silently launching a team', async () => {
    const invalid = { ...makeSchedule('agent'), executionMode: 'unknown' as never };
    await expect(dispatch.dispatch(invalid, 'bad-mode', active)).rejects.toThrow(
      'Unsupported schedule execution mode'
    );
    expect(port.launchTeam).not.toHaveBeenCalled();
    expect(port.createTask).not.toHaveBeenCalled();
  });

  it('skips blank scheduled instructions without a process or task', async () => {
    const bad = {
      ...makeSchedule('agent'),
      launchConfig: { ...makeSchedule('agent').launchConfig, prompt: '   ' },
    };
    const result = await dispatch.dispatch(bad, 'blank', active);
    expect(result.kind).toBe('skipped');
    expect(port.runOneShot).not.toHaveBeenCalled();
    expect(port.createTask).not.toHaveBeenCalled();
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

  function enableTaskFirstPorts(): void {
    port.hasRunnableConfig = vi.fn(async () => true);
    port.getPreviousRuns = vi.fn(async () => []);
    port.getTask = vi.fn(async () => null);
    port.startTaskByUser = vi.fn(async () => ({ notifiedOwner: true }));
  }

  it.each([true, false])(
    'does not assign a second task while selected member is already working (team live: %s)',
    async (live) => {
      enableTaskFirstPorts();
      port.isTeamAlive = vi.fn(() => live);
      port.hasActiveOwnedTask = vi.fn((_team, member) => member === 'alice');
      const outcome = await dispatch.dispatch(
        { ...makeSchedule('agent'), taskFirst: true, targetMember: 'alice' },
        'busy-member', active
      );
      expect(outcome.kind).toBe('skipped');
      if (outcome.kind !== 'skipped') throw new Error('Expected skipped outcome');
      expect(outcome.summary).toContain('already working');
      expect(port.createTask).not.toHaveBeenCalled();
      expect(port.launchTeam).not.toHaveBeenCalled();
      expect(port.startTaskByUser).not.toHaveBeenCalled();
    }
  );

  it('leaves the saved task visible if another task becomes active before scheduled start', async () => {
    enableTaskFirstPorts();
    port.startTaskByUser = vi.fn(async () => {
      throw new Error('Scheduled recipient is already working');
    });
    const outcome = await dispatch.dispatch(
      { ...makeSchedule('agent'), taskFirst: true, targetMember: 'alice' },
      'member-became-busy', active
    );
    expect(outcome).toMatchObject({ kind: 'skipped', taskId: 'task-1' });
    if (outcome.kind !== 'skipped') throw new Error('Expected skipped outcome');
    expect(outcome.summary).toContain('already working');
    expect(port.createTask).toHaveBeenCalledOnce();
  });

  it('creates one pending task before bootstrap-only launch and starts the exact teammate after readiness', async () => {
    enableTaskFirstPorts();
    let running = false;
    port.isTeamAlive = vi.fn(() => running);
    port.getRuntime = vi.fn(async () => ({
      ...runtimeMembers(true),
      runId: 'launched-1',
    }));
    port.launchTeam = vi.fn(async () => {
      expect(port.createTask).toHaveBeenCalledOnce();
      expect(port.createTask).toHaveBeenCalledWith(
        'test-team',
        expect.objectContaining({ owner: 'alice', startImmediately: false })
      );
      running = true;
      return { runId: 'launched-1', launchStatus: 'started' as const };
    });

    const schedule = { ...makeSchedule('agent'), taskFirst: true as const, targetMember: 'alice' };
    const result = await dispatch.dispatch(schedule, 'task-first-1', active);

    expect(result).toMatchObject({ kind: 'dispatched', taskId: 'task-1' });
    expect(port.launchTeam).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/tmp/saved-team',
        bootstrapOnly: true,
        prompt: undefined,
      })
    );
    expect(port.startTaskByUser).toHaveBeenCalledExactlyOnceWith(
      'test-team', 'task-1',
      expect.objectContaining({ expectedOwner: 'alice', canStart: expect.any(Function) })
    );
    expect(port.runOneShot).not.toHaveBeenCalled();
    expect(port.attachMember).not.toHaveBeenCalled();
  });

  it('routes task-first team work to the live lead without a redundant launch', async () => {
    enableTaskFirstPorts();
    const result = await dispatch.dispatch(
      { ...makeSchedule('team'), taskFirst: true },
      'task-first-live',
      active
    );
    expect(result).toMatchObject({ kind: 'dispatched', taskId: 'task-1' });
    expect(port.createTask).toHaveBeenCalledExactlyOnceWith(
      'test-team',
      expect.objectContaining({ owner: 'lead', startImmediately: false })
    );
    expect(port.startTaskByUser).toHaveBeenCalledExactlyOnceWith(
      'test-team', 'task-1',
      expect.objectContaining({ expectedOwner: 'lead', canStart: expect.any(Function) })
    );
    expect(port.launchTeam).not.toHaveBeenCalled();
    expect(port.runOneShot).not.toHaveBeenCalled();
  });

  it('retains a pending task if the live runtime changes after durable creation', async () => {
    enableTaskFirstPorts();
    let reads = 0;
    port.getRuntime = vi.fn(async () => {
      reads++;
      return { ...runtimeMembers(true), runId: reads > 2 ? 'replacement-run' : 'team-run-1' };
    });
    const result = await dispatch.dispatch(
      { ...makeSchedule('agent'), taskFirst: true, targetMember: 'alice' },
      'live-task-run-changed',
      active
    );
    expect(result).toMatchObject({ kind: 'skipped', taskId: 'task-1' });
    expect(port.createTask).toHaveBeenCalledWith(
      'test-team',
      expect.objectContaining({ owner: 'alice', startImmediately: false })
    );
    expect(port.startTaskByUser).not.toHaveBeenCalled();
  });

  it('never starts a saved offline task against a replaced runtime generation', async () => {
    enableTaskFirstPorts();
    let running = false;
    port.isTeamAlive = vi.fn(() => running);
    let reads = 0;
    port.getRuntime = vi.fn(async () => {
      reads++;
      return { ...runtimeMembers(true), runId: reads > 1 ? 'replacement-run' : 'launched-1' };
    });
    port.launchTeam = vi.fn(async () => {
      running = true;
      return { runId: 'launched-1', launchStatus: 'started' as const };
    });
    const result = await dispatch.dispatch(
      { ...makeSchedule('agent'), taskFirst: true, targetMember: 'alice' },
      'offline-task-run-changed',
      active
    );
    expect(result).toMatchObject({ kind: 'skipped', taskId: 'task-1' });
    expect(port.startTaskByUser).not.toHaveBeenCalled();
  });

  it('never creates more work while the previous scheduled board task is unfinished', async () => {
    enableTaskFirstPorts();
    port.getPreviousRuns = vi.fn(async (): Promise<ScheduleRun[]> => [{
      id: 'prior-run', scheduleId: 'schedule-1', teamName: 'test-team', status: 'dispatched',
      scheduledFor: new Date().toISOString(), startedAt: new Date().toISOString(),
      retryCount: 0, linkedTaskId: 'prior-task',
    }]);
    port.getTask = vi.fn(async () => ({
      id: 'prior-task', displayId: '17', subject: 'Still working', status: 'in_progress',
    } as TeamTask));
    const outcome = await dispatch.dispatch(
      { ...makeSchedule('agent'), taskFirst: true, targetMember: 'alice' },
      'next-occurrence',
      active
    );
    expect(outcome).toMatchObject({ kind: 'skipped', taskId: 'prior-task' });
    if (outcome.kind !== 'skipped') throw new Error('Expected unfinished task to skip');
    expect(outcome.summary).toMatch(/still active/);
    expect(port.createTask).not.toHaveBeenCalled();
    expect(port.launchTeam).not.toHaveBeenCalled();
    expect(port.runOneShot).not.toHaveBeenCalled();
  });

  it('ignores taskless skipped runs but retains older unfinished board work', async () => {
    enableTaskFirstPorts();
    const now = new Date().toISOString();
    const prior = (id: string, status: ScheduleRun['status'], linkedTaskId?: string): ScheduleRun => ({
      id,
      scheduleId: 'schedule-1',
      teamName: 'test-team',
      status,
      scheduledFor: now,
      startedAt: now,
      retryCount: 0,
      ...(linkedTaskId ? { linkedTaskId } : {}),
    });
    port.getPreviousRuns = vi.fn(async () => [
      prior('skipped-without-task', 'skipped'),
      prior('failed-without-task', 'failed_interrupted'),
      prior('older-task-run', 'dispatched', 'older-active-task'),
    ]);
    port.getTask = vi.fn(async (_team, id) =>
      id === 'older-active-task'
        ? ({ id, subject: 'Review in progress', status: 'in_progress' } as TeamTask)
        : null
    );
    const result = await dispatch.dispatch(
      { ...makeSchedule('agent'), taskFirst: true },
      'new-tick',
      active
    );
    expect(result).toMatchObject({ kind: 'skipped', taskId: 'older-active-task' });
    expect(port.getTask).toHaveBeenCalledTimes(3);
    expect(port.createTask).not.toHaveBeenCalled();
  });

  it('propagates the outstanding task through a launching-team early skip', async () => {
    enableTaskFirstPorts();
    port.isTeamLaunching = vi.fn(() => true);
    port.getPreviousRuns = vi.fn(async (): Promise<ScheduleRun[]> => [{
      id: 'earlier-run',
      scheduleId: 'schedule-1',
      teamName: 'test-team',
      status: 'skipped',
      scheduledFor: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      retryCount: 0,
      linkedTaskId: 'still-active',
    }]);
    port.getTask = vi.fn(async () => ({
      id: 'still-active',
      subject: 'Unfinished work',
      status: 'pending',
    } as TeamTask));
    const result = await dispatch.dispatch(
      { ...makeSchedule('team'), taskFirst: true },
      'early-skip',
      active
    );
    expect(result).toMatchObject({ kind: 'skipped', taskId: 'still-active' });
    expect(port.createTask).not.toHaveBeenCalled();
    expect(port.launchTeam).not.toHaveBeenCalled();
  });

  it('recovers an unlinked task created before its prior schedule run was interrupted', async () => {
    enableTaskFirstPorts();
    const now = new Date().toISOString();
    port.getPreviousRuns = vi.fn(async (): Promise<ScheduleRun[]> => [{
      id: 'interrupted-creation-id',
      scheduleId: 'schedule-1',
      teamName: 'test-team',
      status: 'failed_interrupted',
      scheduledFor: now,
      startedAt: now,
      retryCount: 0,
    }]);
    port.getTask = vi.fn(async (_team, taskId) => ({
      id: taskId,
      subject: 'Durably saved before crash',
      status: 'pending',
    } as TeamTask));
    const result = await dispatch.dispatch(
      { ...makeSchedule('team'), taskFirst: true },
      'after-crash',
      active
    );
    expect(result).toMatchObject({ kind: 'skipped', taskId: 'interrupted-creation-id' });
    expect(port.createTask).not.toHaveBeenCalled();
    expect(port.launchTeam).not.toHaveBeenCalled();
  });

  it('runs after a taskless skipped occurrence instead of deadlocking the schedule', async () => {
    enableTaskFirstPorts();
    const now = new Date().toISOString();
    port.getPreviousRuns = vi.fn(async (): Promise<ScheduleRun[]> => [{
      id: 'taskless-previous',
      scheduleId: 'schedule-1',
      teamName: 'test-team',
      status: 'skipped',
      scheduledFor: now,
      startedAt: now,
      retryCount: 0,
    }]);
    port.getTask = vi.fn(async () => null);
    const result = await dispatch.dispatch(
      { ...makeSchedule('team'), taskFirst: true },
      'next-tick',
      active
    );
    expect(result).toMatchObject({ kind: 'dispatched', taskId: 'task-1' });
    expect(port.createTask).toHaveBeenCalledOnce();
  });

  it('keeps a saved board task pending when bootstrap fails and never retries the prompt', async () => {
    enableTaskFirstPorts();
    port.isTeamAlive = vi.fn(() => false);
    port.launchTeam = vi.fn(async () => {
      throw new Error('Provider offline');
    });
    const outcome = await dispatch.dispatch(
      { ...makeSchedule('agent'), taskFirst: true, targetMember: 'alice' },
      'task-first-failed-launch',
      active
    );
    expect(outcome).toMatchObject({ kind: 'skipped', taskId: 'task-1' });
    expect(port.createTask).toHaveBeenCalledExactlyOnceWith(
      'test-team',
      expect.objectContaining({ owner: 'alice', startImmediately: false })
    );
    expect(port.startTaskByUser).not.toHaveBeenCalled();
    expect(port.runOneShot).not.toHaveBeenCalled();
  });

  it('skips non-runnable drafts or unmigrated historical work before creating a task', async () => {
    enableTaskFirstPorts();
    port.isTeamAlive = vi.fn(() => false);
    port.hasRunnableConfig = vi.fn(async () => false);
    const schedule = { ...makeSchedule('team'), taskFirst: true as const };
    expect((await dispatch.dispatch(schedule, 'draft', active)).kind).toBe('skipped');
    port.hasRunnableConfig = vi.fn(async () => true);
    port.getSavedRequest = vi.fn(async () => ({
      teamName: 'test-team', cwd: '/tmp/saved-team', providerId: 'anthropic' as const,
      prompt: 'Legacy work that may contain instructions', members: [{ name: 'alice' }],
    }));
    expect((await dispatch.dispatch(schedule, 'legacy-prompt', active)).kind).toBe('skipped');
    expect(port.createTask).not.toHaveBeenCalled();
    expect(port.launchTeam).not.toHaveBeenCalled();
  });


  it('allows a reviewed old prompt without executing it on bootstrap', async () => {
    enableTaskFirstPorts();
    port.isTeamAlive = vi.fn(() => false);
    port.getSavedRequest = vi.fn(async () => ({
      teamName: 'test-team', cwd: '/tmp/saved-team', providerId: 'anthropic' as const,
      prompt: 'Old one-time work', members: [{ name: 'alice' }],
    }));
    const outcome = await dispatch.dispatch(
      { ...makeSchedule('team'), taskFirst: true, reviewedSavedPrompt: true },
      'reviewed-old-instructions', active
    );
    expect(outcome).toMatchObject({ taskId: 'task-1' });
    expect(port.createTask).toHaveBeenCalledOnce();
    expect(port.launchTeam).toHaveBeenCalledWith(expect.objectContaining({
      bootstrapOnly: true, prompt: undefined,
    }));
    expect(port.runOneShot).not.toHaveBeenCalled();
  });

  it('does not create a stopped-team task after cancellation during metadata reads', async () => {
    enableTaskFirstPorts();
    port.isTeamAlive = vi.fn(() => false);
    let cancelled = false;
    port.getLeadName = vi.fn(async () => {
      cancelled = true;
      return 'lead';
    });
    const outcome = await dispatch.dispatch(
      { ...makeSchedule('team'), taskFirst: true }, 'cancel-during-read', () => cancelled
    );
    expect(outcome.kind).toBe('skipped');
    expect(port.createTask).not.toHaveBeenCalled();
    expect(port.launchTeam).not.toHaveBeenCalled();
  });

  it('fences scheduled work against a runtime replaced during the task-service read', async () => {
    enableTaskFirstPorts();
    let replaced = false;
    let checkingStart = false;
    let cancelled = false;
    port.isTeamAlive = vi.fn(async () => {
      if (checkingStart) replaced = true;
      return true;
    });
    port.getRuntime = vi.fn(async () => ({
      ...runtimeMembers(true),
      runId: replaced ? 'replacement-run' : 'team-run-1',
    }));
    port.startTaskByUser = vi.fn(async (
      _team: string,
      _taskId: string,
      admission?: Parameters<NonNullable<SmartScheduleRuntimePort['startTaskByUser']>>[2]
    ) => {
      checkingStart = true;
      expect(admission?.isCurrent()).toBe(true);
      expect(await admission?.canStart()).toBe(false);
      cancelled = true;
      expect(admission?.isCurrent()).toBe(false);
      throw new Error('Scheduled task start superseded');
    });
    const outcome = await dispatch.dispatch(
      { ...makeSchedule('agent'), taskFirst: true, targetMember: 'alice' },
      'superseded-during-read', () => cancelled
    );
    expect(outcome).toMatchObject({ kind: 'skipped', taskId: 'task-1' });
    expect(port.startTaskByUser).toHaveBeenCalledWith(
      'test-team', 'task-1',
      expect.objectContaining({ expectedOwner: 'alice', expectedRunId: 'team-run-1',
        canStart: expect.any(Function), isCurrent: expect.any(Function) })
    );
    expect(port.createTask).toHaveBeenCalledOnce();
  });

  it('does not claim dispatch when a pending task loses its owner before start', async () => {
    enableTaskFirstPorts();
    port.startTaskByUser = vi.fn(async () => ({ notifiedOwner: false }));
    const outcome = await dispatch.dispatch(
      { ...makeSchedule('team'), taskFirst: true }, 'owner-removed', active
    );
    expect(outcome).toMatchObject({ kind: 'skipped', taskId: 'task-1' });
    expect(port.createTask).toHaveBeenCalledOnce();
  });

  it.each(['review', 'needsFix'] as const)(
    'keeps a completed task awaiting %s open instead of creating duplicate work',
    async (reviewState) => {
      enableTaskFirstPorts();
      const previous: ScheduleRun = {
        id: 'earlier-task', scheduleId: 'schedule-1', teamName: 'test-team',
        status: 'dispatched', scheduledFor: new Date().toISOString(),
        startedAt: new Date().toISOString(), retryCount: 0, linkedTaskId: 'review-task',
      };
      port.getPreviousRuns = vi.fn(async () => [previous]);
      port.getTask = vi.fn(async () => ({
        id: 'review-task', subject: 'Waiting for review', status: 'completed', reviewState,
      } as TeamTask));
      const outcome = await dispatch.dispatch(
        { ...makeSchedule('agent'), taskFirst: true }, 'next-after-review', active
      );
      expect(outcome).toMatchObject({ kind: 'skipped', taskId: 'review-task' });
      expect(port.createTask).not.toHaveBeenCalled();
    }
  );

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

  it('skips a retained one-agent schedule if its team was deleted', async () => {
    port.isTeamAlive = vi.fn(() => false);
    port.getSavedRequest = vi.fn(async () => null);
    const result = await dispatch.dispatch(
      { ...makeSchedule('agent'), targetMember: 'alice' },
      'orphaned-team',
      active
    );
    expect(result).toMatchObject({ kind: 'skipped', summary: expect.stringContaining('configuration is missing') });
    expect(port.runOneShot).not.toHaveBeenCalled();
    expect(port.launchTeam).not.toHaveBeenCalled();
    expect(port.createTask).not.toHaveBeenCalled();
  });

  it('fails closed for a configured selected teammate when the team is stopped', async () => {
    port.isTeamAlive = vi.fn(() => false);
    const result = await dispatch.dispatch(
      { ...makeSchedule('agent'), targetMember: 'alice' }, 'selected-alice-offline', active
    );
    expect(result).toMatchObject({
      kind: 'skipped',
      summary: expect.stringContaining('Selected teammate "alice" cannot run'),
    });
    expect(port.runOneShot).not.toHaveBeenCalled();
    expect(port.createTask).not.toHaveBeenCalled();
    expect(port.launchTeam).not.toHaveBeenCalled();
    expect(port.attachMember).not.toHaveBeenCalled();
  });

  it('preserves the separate offline lead one-shot path without a team launch', async () => {
    port.isTeamAlive = vi.fn(() => false);
    const result = await dispatch.dispatch(
      { ...makeSchedule('agent'), targetMember: 'LEAD' }, 'selected-lead-offline', active
    );
    expect(result.kind).toBe('one_shot');
    expect(port.runOneShot).toHaveBeenCalledOnce();
    expect(port.launchTeam).not.toHaveBeenCalled();
    expect(port.createTask).not.toHaveBeenCalled();
  });

  it('skips an offline one-agent schedule if its selected member was removed', async () => {
    port.isTeamAlive = vi.fn(() => false);
    const result = await dispatch.dispatch(
      { ...makeSchedule('agent'), targetMember: 'removed-member' },
      'orphaned-member',
      active
    );
    expect(result).toMatchObject({ kind: 'skipped', summary: expect.stringContaining('not configured') });
    expect(port.runOneShot).not.toHaveBeenCalled();
  });

  it('does not run an offline agent with missing verified launch configuration', async () => {
    port.isTeamAlive = vi.fn(() => false);
    port.hasLaunchConfig = vi.fn(async () => false);
    const result = await dispatch.dispatch(makeSchedule('agent'), 'missing-config', active);
    expect(result.kind).toBe('skipped');
    expect(port.runOneShot).not.toHaveBeenCalled();
  });

  it('rechecks stop/cancel admission after validating the saved offline recipient', async () => {
    port.isTeamAlive = vi.fn(() => false);
    let cancelled = false;
    port.getLeadName = vi.fn(async () => {
      cancelled = true;
      return 'lead';
    });
    const result = await dispatch.dispatch(makeSchedule('agent'), 'cancelled-during-lookup', () => cancelled);
    expect(result.kind).toBe('skipped');
    expect(port.runOneShot).not.toHaveBeenCalled();
  });

  it('rejects a lead without current process evidence even when alive is claimed', async () => {
    const snapshot = runtimeMembers(true);
    snapshot.members.lead = { ...snapshot.members.lead, pidSource: undefined, pid: undefined };
    port.getRuntime = vi.fn(async () => snapshot);
    const outcome = await dispatch.dispatch(makeSchedule('team'), 'missing-lead-pid', active);
    expect(outcome.kind).toBe('skipped');
    expect(port.createTask).not.toHaveBeenCalled();
    expect(port.launchTeam).not.toHaveBeenCalled();
  });

  it('routes a case-variant lead target to the actual live lead', async () => {
    const schedule = { ...makeSchedule('agent'), targetMember: 'LEAD' };
    const result = await dispatch.dispatch(schedule, 'lead-case', active);
    expect(result.kind).toBe('dispatched');
    expect(port.createTask).toHaveBeenCalledOnce();
    expect(port.createTask).toHaveBeenCalledWith(
      'test-team',
      expect.objectContaining({ owner: 'lead', startImmediately: true })
    );
    expect(port.attachMember).not.toHaveBeenCalled();
  });

  it('keeps non-lead teammate identity exact to avoid accidental rerouting', async () => {
    const schedule = { ...makeSchedule('agent'), targetMember: 'ALICE' };
    const result = await dispatch.dispatch(schedule, 'member-case', active);
    expect(result.kind).toBe('skipped');
    expect(port.createTask).not.toHaveBeenCalled();
    expect(port.attachMember).not.toHaveBeenCalled();
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
    expect(port.attachMember).toHaveBeenCalledExactlyOnceWith('test-team', 'alice', { runId: 'team-run-1' });
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

  it('refuses metadata-only draft schedules without invoking the unsafe launch path', async () => {
    port.isTeamAlive = vi.fn(() => false);
    port.hasLaunchConfig = vi.fn(async () => false);
    await expect(dispatch.assertCanSchedule(makeSchedule('team'))).rejects.toThrow('Finish team setup');
    const result = await dispatch.dispatch(makeSchedule('team'), 'draft-run', active);
    expect(result).toMatchObject({ kind: 'skipped', summary: expect.stringContaining('Finish team setup') });
    expect(port.launchTeam).not.toHaveBeenCalled();
    expect(port.createTask).not.toHaveBeenCalled();
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

  it.each(['agent', 'team'] as const)(
    'skips an in-flight stop instead of restarting a supposedly offline %s',
    async (mode) => {
      port.isTeamAlive = vi.fn(() => false);
      port.isTeamBusy = vi.fn(() => true);
      const result = await dispatch.dispatch(makeSchedule(mode), 'stopping', active);
      expect(result.kind).toBe('skipped');
      expect(port.runOneShot).not.toHaveBeenCalled();
      expect(port.launchTeam).not.toHaveBeenCalled();
      expect(port.createTask).not.toHaveBeenCalled();
    }
  );

  it('rechecks stop admission after loading saved team settings', async () => {
    port.isTeamAlive = vi.fn(() => false);
    let busy = false;
    port.isTeamBusy = vi.fn(() => busy);
    port.getSavedRequest = vi.fn(async () => {
      busy = true;
      return { teamName: 'test-team', cwd: '/tmp/project', providerId: 'anthropic' as const, members: [] };
    });
    const result = await dispatch.dispatch(makeSchedule('team'), 'stopping-after-read', active);
    expect(result.kind).toBe('skipped');
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
    // Different cwd bypasses the scheduler's path lock. The dispatcher must
    // still serialize by team until the original task write settles.
    const anotherSchedule = {
      ...makeSchedule('agent'),
      launchConfig: { ...makeSchedule('agent').launchConfig, cwd: '/tmp/other-project' },
    };
    const second = await dispatch.dispatch(anotherSchedule, 'run-11', active);
    expect(second.kind).toBe('skipped');
    // The first dispatch is waiting for the one task write to finish.
    await vi.waitFor(() => expect(port.createTask).toHaveBeenCalledOnce());
    if (!pending.resolve) throw new Error('task write was not started');
    pending.resolve({ id: 'task-1', displayId: '7', subject: 'task', status: 'in_progress' } as TeamTask);
    expect((await first).kind).toBe('dispatched');
  });
});
