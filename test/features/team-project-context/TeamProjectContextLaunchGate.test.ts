import { describe, expect, it, vi } from 'vitest';

import {
  isConfirmedStoppedTeamRuntime,
  isStoppedTeamRuntime,
  TeamProjectContextLaunchConflictError,
  TeamProjectContextLaunchGate,
} from '../../../src/features/team-project-context/main/TeamProjectContextLaunchGate';

import type { PersistedTeamWorkContext } from '../../../src/features/team-project-context/main';
import type { TeamRuntimeState } from '../../../src/shared/types/team';

const first: PersistedTeamWorkContext = {
  id: '11111111-1111-4111-8111-111111111111',
  projectKey: '/TEST-a',
  projectPath: '/TEST-a',
  executionTeamName: 'ptc-first',
  state: 'ready',
};
const second: PersistedTeamWorkContext = {
  ...first, id: '22222222-2222-4222-8222-222222222222',
  projectKey: '/TEST-b', projectPath: '/TEST-b', executionTeamName: 'ptc-second',
};

function fixture() {
  const states = new Map<string, TeamRuntimeState>();
  const contexts = { list: vi.fn(async () => [first, second]) };
  const runtime = {
    getRuntimeState: vi.fn(async (teamName: string): Promise<TeamRuntimeState> =>
      states.get(teamName) ?? { teamName, isAlive: false, runId: null, progress: null }),
    hasProvisioningRun: vi.fn((_teamName: string) => false),
  };
  return { states, contexts, runtime, gate: new TeamProjectContextLaunchGate(contexts, runtime) };
}

const stateOf = (patch: Partial<TeamRuntimeState>): TeamRuntimeState => ({
  teamName: 'ptc-x',
  isAlive: false,
  runId: null,
  progress: null,
  ...patch,
});
const progressOf = (
  state: string,
  extra: Record<string, unknown> = {}
): TeamRuntimeState['progress'] =>
  ({ runId: 'run-x', teamName: 'ptc-x', state, ...extra }) as TeamRuntimeState['progress'];

describe('isStoppedTeamRuntime and isConfirmedStoppedTeamRuntime', () => {
  it('treats a copy that is idle, or whose bootstrap owner died, as stopped', () => {
    expect(isStoppedTeamRuntime(stateOf({}))).toBe(true);
    // What a dead bootstrap owner reports: no live process, the run id still set, a failed progress.
    const deadOwner = stateOf({ runId: 'run-x', progress: progressOf('failed') });
    expect(isStoppedTeamRuntime(deadOwner)).toBe(true);
    expect(isStoppedTeamRuntime(stateOf({ runId: 'run-x', progress: progressOf('cancelled') }))).toBe(true);
    // ...but a launch or an edit still waits for the run id to be released.
    expect(isConfirmedStoppedTeamRuntime(deadOwner)).toBe(false);
    expect(isConfirmedStoppedTeamRuntime(stateOf({}))).toBe(true);
  });

  it('treats a live process or a run that is still going as not stopped', () => {
    expect(isStoppedTeamRuntime(stateOf({ isAlive: true, runId: 'run-x' }))).toBe(false);
    // A live bootstrap owner: not alive yet, progress in flight.
    for (const state of ['validating', 'spawning', 'configuring', 'assembling', 'finalizing', 'verifying']) {
      expect(isStoppedTeamRuntime(stateOf({ runId: 'run-x', progress: progressOf(state) }))).toBe(false);
    }
    // A failed process that is still alive is not stopped.
    expect(isStoppedTeamRuntime(stateOf({ isAlive: true, progress: progressOf('failed') }))).toBe(false);
  });

  it('does not take a stale ready or disconnected progress, or a run id that is not cleared yet, for stopped', () => {
    expect(isStoppedTeamRuntime(stateOf({ runId: 'run-x', progress: progressOf('ready', { teamName: 'ptc-second' }) }))).toBe(false);
    expect(isStoppedTeamRuntime(stateOf({ runId: 'run-x', progress: progressOf('disconnected') }))).toBe(false);
    // The transient right after a stop: the tracked run id is not cleared yet.
    expect(isStoppedTeamRuntime(stateOf({ runId: 'run-x', progress: null }))).toBe(false);
  });

  it('does not take a failed run that kept secondary lanes alive for stopped', () => {
    const retained = stateOf({
      runId: 'run-x',
      progress: progressOf('failed', { retainedSecondaryRuntime: true }),
    });
    expect(isStoppedTeamRuntime(retained)).toBe(false);
  });
});

describe('TeamProjectContextLaunchGate', () => {
  describe('findRunningContextForEdit', () => {
    it('selects the one live project and permits an entirely stopped team', async () => {
      const f = fixture();
      await expect(f.gate.findRunningContextForEdit('builders')).resolves.toBeNull();
      f.states.set('ptc-second', {
        teamName: 'ptc-second', isAlive: true, runId: 'run-x', progress: progressOf('ready', { teamName: 'ptc-second' }),
      });
      await expect(f.gate.findRunningContextForEdit('builders')).resolves.toEqual({ executionTeamName: 'ptc-second', runId: 'run-x' });
    });

    it('requires the tracked run to be alive and report the same ready identity', async () => {
      const f = fixture();
      f.runtime.hasProvisioningRun.mockImplementation((name) => name === 'ptc-first');
      f.states.set('ptc-first', { teamName: 'ptc-first', isAlive: true, runId: 'run-x', progress: progressOf('ready', { teamName: 'ptc-first' }) });
      await expect(f.gate.findRunningContextForEdit('builders')).resolves.toEqual({ executionTeamName: 'ptc-first', runId: 'run-x' });
      f.states.set('ptc-first', { teamName: 'ptc-first', isAlive: true, runId: 'another', progress: progressOf('ready', { teamName: 'ptc-first' }) });
      await expect(f.gate.findRunningContextForEdit('builders')).rejects.toThrow('launching');
      f.states.set('ptc-first', { teamName: 'ptc-first', isAlive: false, runId: 'run-x', progress: progressOf('ready', { teamName: 'ptc-first' }) });
      await expect(f.gate.findRunningContextForEdit('builders')).rejects.toThrow('launching');
      f.states.set('ptc-first', { teamName: 'another-team', isAlive: true, runId: 'run-x', progress: progressOf('ready', { teamName: 'ptc-first' }) });
      await expect(f.gate.findRunningContextForEdit('builders')).rejects.toThrow('launching');
    });

    it('refuses multiple running projects or a logical runtime', async () => {
      const f = fixture();
      f.states.set('ptc-first', { teamName: 'ptc-first', isAlive: true, runId: 'run-x', progress: progressOf('ready', { teamName: 'ptc-first' }) });
      f.states.set('ptc-second', { teamName: 'ptc-second', isAlive: true, runId: 'run-x', progress: progressOf('ready', { teamName: 'ptc-second' }) });
      await expect(f.gate.findRunningContextForEdit('builders')).rejects.toThrow('more than one');
      f.states.clear();
      f.states.set('builders', { teamName: 'builders', isAlive: true, runId: 'run-3', progress: null });
      await expect(f.gate.findRunningContextForEdit('builders')).rejects.toThrow('running');
    });

    it('refuses provisioning, reserved copies and unresolved stopped ownership', async () => {
      const f = fixture();
      f.runtime.hasProvisioningRun.mockImplementation((name) => name === 'ptc-first');
      await expect(f.gate.findRunningContextForEdit('builders')).rejects.toThrow('launching');
      f.runtime.hasProvisioningRun.mockReturnValue(false);
      f.contexts.list.mockResolvedValue([first, { ...second, state: 'reserved' }]);
      await expect(f.gate.findRunningContextForEdit('builders')).rejects.toThrow('prepared');
      f.contexts.list.mockResolvedValue([first, second]);
      f.states.set('ptc-first', { teamName: 'ptc-first', isAlive: false, runId: 'unreleased', progress: null });
      await expect(f.gate.findRunningContextForEdit('builders')).rejects.toThrow('running');
      f.states.set('ptc-first', {
        teamName: 'ptc-first', isAlive: true, runId: 'retained',
        progress: progressOf('failed', { retainedSecondaryRuntime: true }),
      });
      await expect(f.gate.findRunningContextForEdit('builders')).rejects.toThrow('running');
    });
  });

  it('allows B only when the logical team and A have confirmed stopped ownership', async () => {
    const f = fixture();
    await expect(f.gate.assertOtherContextsStopped('builders', 'ptc-second'))
      .resolves.toBeUndefined();
    expect(f.runtime.getRuntimeState).toHaveBeenCalledWith('ptc-first');
    expect(f.runtime.getRuntimeState).toHaveBeenCalledWith('builders');
  });

  it('rejects a live or unconfirmed previous project even if current selection is B', async () => {
    const f = fixture();
    f.states.set('ptc-first', { teamName: 'ptc-first', isAlive: true, runId: 'running', progress: null });
    await expect(f.gate.assertOtherContextsStopped('builders', 'ptc-second'))
      .rejects.toBeInstanceOf(TeamProjectContextLaunchConflictError);
  });

  it('refuses unknown and disconnected runtime ownership', async () => {
    const f = fixture();
    f.states.set('ptc-first', {
      teamName: 'ptc-first', isAlive: false, runId: null,
      progress: {
        teamName: 'ptc-first', runId: 'old', state: 'disconnected',
        message: 'unconfirmed', startedAt: '', updatedAt: '',
      },
    });
    await expect(f.gate.assertOtherContextsStopped('builders', 'ptc-second'))
      .rejects.toThrow('unresolved');
  });

  it('rejects a reserved context in a different project until it is reconciled', async () => {
    const f = fixture();
    f.contexts.list.mockResolvedValue([first, { ...second, state: 'reserved' }]);
    await expect(f.gate.assertOtherContextsStopped('builders', 'ptc-first'))
      .rejects.toBeInstanceOf(TeamProjectContextLaunchConflictError);
  });

  it('does not mistake a late provisioning run for stopped', async () => {
    const f = fixture();
    f.runtime.hasProvisioningRun.mockReturnValueOnce(true);
    await expect(f.gate.assertOtherContextsStopped('builders', 'ptc-second'))
      .rejects.toThrow('launching or stopping');
  });

  describe('assertAllContextsStopped (editing the team definition)', () => {
    it('allows an edit when the logical team and every project are confirmed stopped', async () => {
      const f = fixture();
      await expect(f.gate.assertAllContextsStopped('builders')).resolves.toBeUndefined();
      for (const name of ['builders', 'ptc-first', 'ptc-second']) {
        expect(f.runtime.getRuntimeState).toHaveBeenCalledWith(name);
      }
    });

    it('refuses while any project runs, including the one that is open', async () => {
      const f = fixture();
      f.states.set('ptc-second', {
        teamName: 'ptc-second', isAlive: true, runId: 'running', progress: null,
      });
      await expect(f.gate.assertAllContextsStopped('builders'))
        .rejects.toBeInstanceOf(TeamProjectContextLaunchConflictError);
    });

    it('tells a stopped run that is still tracked apart from a run that is going', async () => {
      const f = fixture();
      // A dead bootstrap owner: stopped, but its run id is not released yet.
      f.states.set('ptc-first', {
        teamName: 'ptc-first',
        isAlive: false,
        runId: 'run-dead',
        progress: { runId: 'run-dead', teamName: 'ptc-first', state: 'failed' } as TeamRuntimeState['progress'],
      });
      await expect(f.gate.assertAllContextsStopped('builders')).rejects.toThrow('not released yet');

      f.states.set('ptc-first', { teamName: 'ptc-first', isAlive: true, runId: 'run', progress: null });
      await expect(f.gate.assertAllContextsStopped('builders')).rejects.toThrow('stop it in every project');
    });

    it('refuses while a project is launching or stopping', async () => {
      const f = fixture();
      f.runtime.hasProvisioningRun.mockImplementation((name: string) => name === 'ptc-first');
      await expect(f.gate.assertAllContextsStopped('builders')).rejects.toThrow('launching');
    });

    it('refuses while a project context is not yet reconciled', async () => {
      const f = fixture();
      f.contexts.list.mockResolvedValue([first, { ...second, state: 'reserved' }]);
      await expect(f.gate.assertAllContextsStopped('builders')).rejects.toThrow('prepared');
      expect(f.runtime.getRuntimeState).not.toHaveBeenCalled();
    });
  });
});
