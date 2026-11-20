import { describe, expect, it, vi } from 'vitest';

import {
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

describe('TeamProjectContextLaunchGate', () => {
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
