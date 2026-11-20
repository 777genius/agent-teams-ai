import { describe, expect, it, vi } from 'vitest';

import { TeamProjectContextLaunchConflictError } from '@features/team-project-context/main';

import {
  ProjectScheduleTargets,
  type ProjectScheduleTargetPorts,
} from '../../../src/main/ipc/teams/projectScheduleTargets';

import type { TeamLaunchRequest, TeamLaunchResponse } from '@shared/types';

const schedule = {
  teamName: 'builders',
  launchConfig: { cwd: '/work/a', prompt: 'go' },
};
const launchRequest = { teamName: 'ptc-x-a', cwd: '/work/a', providerId: 'anthropic' } as TeamLaunchRequest;

function makePorts(overrides: Partial<ProjectScheduleTargetPorts> = {}): ProjectScheduleTargetPorts {
  return {
    getMode: vi.fn(async () => 'per_project' as const),
    isOwnedExecutionAlias: vi.fn(async () => false),
    isTrashed: vi.fn(async () => false),
    forRead: vi.fn(async () => ({
      logicalTeamName: 'builders',
      executionTeamName: 'ptc-x-a',
      projectPath: '/work/a',
      state: 'ready' as const,
      mode: 'per_project' as const,
    })),
    withLogicalLock: vi.fn(async (_team, operation) => operation()),
    prepareLaunch: vi.fn(async (request) => ({
      request: { ...request, teamName: 'ptc-x-a', cwd: '/work/a' },
      mapProgress: vi.fn(),
    })),
    launchPhysical: vi.fn(async () => ({ runId: 'run-1' }) as TeamLaunchResponse),
    rememberRunIdentity: vi.fn(),
    ...overrides,
  };
}

describe('ProjectScheduleTargets.admit', () => {
  it('lets ordinary and per-project teams be scheduled', async () => {
    const shared = new ProjectScheduleTargets(makePorts({ getMode: vi.fn(async () => 'shared' as const) }));
    expect(await shared.admit('legacy')).toEqual({ allowed: true });
    expect(await new ProjectScheduleTargets(makePorts()).admit('builders')).toEqual({ allowed: true });
  });

  it('refuses a project copy: schedules belong to the team, never to its copy', async () => {
    const targets = new ProjectScheduleTargets(makePorts({
      getMode: vi.fn(async () => 'shared' as const),
      isOwnedExecutionAlias: vi.fn(async () => true),
    }));
    const result = await targets.admit('ptc-x-a');
    expect(result).toMatchObject({ allowed: false });
    expect((result as { reason: string }).reason).toMatch(/project copy/i);
  });

  it('fails closed when the team metadata cannot be read', async () => {
    const targets = new ProjectScheduleTargets(makePorts({
      getMode: vi.fn(async () => {
        throw new Error('Team metadata is unreadable; refusing shared-history fallback');
      }),
    }));
    const result = await targets.admit('builders');
    expect(result).toMatchObject({ allowed: false });
    expect((result as { reason: string }).reason).toMatch(/unreadable/i);
  });

  it('fails closed when alias ownership cannot be determined', async () => {
    const targets = new ProjectScheduleTargets(makePorts({
      getMode: vi.fn(async () => 'shared' as const),
      isOwnedExecutionAlias: vi.fn(async () => {
        throw new Error('registry offline');
      }),
    }));
    expect(await targets.admit('legacy')).toMatchObject({ allowed: false });
  });
});

describe('ProjectScheduleTargets.resolve', () => {
  it('leaves ordinary teams on their own name', async () => {
    const ports = makePorts({ getMode: vi.fn(async () => 'shared' as const) });
    expect(await new ProjectScheduleTargets(ports).resolve({ ...schedule, teamName: 'legacy' }))
      .toEqual({ kind: 'native' });
    expect(ports.forRead).not.toHaveBeenCalled();
  });

  it('maps a per-project schedule to the ready copy of its project, never creating one', async () => {
    const ports = makePorts();
    expect(await new ProjectScheduleTargets(ports).resolve(schedule)).toEqual({
      kind: 'project',
      executionTeamName: 'ptc-x-a',
      projectPath: '/work/a',
    });
    expect(ports.forRead).toHaveBeenCalledWith({ logicalTeamName: 'builders', projectPath: '/work/a' });
    expect(ports.prepareLaunch).not.toHaveBeenCalled();
  });

  it('refuses with a clear reason when the project has no launched copy yet', async () => {
    const result = await new ProjectScheduleTargets(makePorts({ forRead: vi.fn(async () => null) }))
      .resolve(schedule);
    expect(result.kind).toBe('refused');
    expect((result as { reason: string }).reason).toMatch(/launch the team in this project/i);
  });

  it('refuses a copy that is not confirmed ready', async () => {
    const result = await new ProjectScheduleTargets(makePorts({
      forRead: vi.fn(async () => ({
        logicalTeamName: 'builders', executionTeamName: 'ptc-x-a',
        projectPath: '/work/a', state: 'reserved' as const, mode: 'per_project' as const,
      })),
    })).resolve(schedule);
    expect(result.kind).toBe('refused');
  });

  it('refuses a trashed team and an unreadable one', async () => {
    expect((await new ProjectScheduleTargets(makePorts({ isTrashed: vi.fn(async () => true) }))
      .resolve(schedule)).kind).toBe('refused');
    expect((await new ProjectScheduleTargets(makePorts({
      getMode: vi.fn(async () => {
        throw new Error('unreadable');
      }),
    })).resolve(schedule)).kind).toBe('refused');
  });
});

describe('ProjectScheduleTargets.launch', () => {
  it('prepares the context under the logical lock and launches the project copy', async () => {
    const ports = makePorts();
    const result = await new ProjectScheduleTargets(ports).launch(schedule, launchRequest);
    expect(result).toEqual({ runId: 'run-1' });
    expect(ports.withLogicalLock).toHaveBeenCalledWith('builders', expect.any(Function));
    expect(ports.prepareLaunch).toHaveBeenCalledWith(
      expect.objectContaining({ teamName: 'builders', cwd: '/work/a' })
    );
    expect(ports.launchPhysical).toHaveBeenCalledWith(
      expect.objectContaining({ teamName: 'ptc-x-a' }), expect.any(Function)
    );
    expect(ports.rememberRunIdentity).toHaveBeenCalledWith('run-1', 'builders', 'ptc-x-a');
  });

  it('turns a refusal of the launch admission into a recorded refusal, not a failure', async () => {
    const conflict = new TeamProjectContextLaunchConflictError('This team is running in another project');
    const ports = makePorts({
      prepareLaunch: vi.fn(async () => {
        throw conflict;
      }),
    });
    const result = await new ProjectScheduleTargets(ports).launch(schedule, launchRequest);
    expect(result).toEqual({ refused: 'This team is running in another project' });
    expect(ports.launchPhysical).not.toHaveBeenCalled();
  });

  it('lets unknown preparation errors propagate as failures', async () => {
    const ports = makePorts({
      prepareLaunch: vi.fn(async () => {
        throw new Error('disk exploded');
      }),
    });
    await expect(new ProjectScheduleTargets(ports).launch(schedule, launchRequest))
      .rejects.toThrow('disk exploded');
  });

  it('maps native progress through the context confirmation', async () => {
    const mapProgress = vi.fn();
    const ports = makePorts({
      prepareLaunch: vi.fn(async (request) => ({ request: { ...request, teamName: 'ptc-x-a' }, mapProgress })),
      launchPhysical: vi.fn(async (_request, onProgress) => {
        onProgress({ state: 'ready' } as never);
        return { runId: 'run-2' } as TeamLaunchResponse;
      }),
    });
    await new ProjectScheduleTargets(ports).launch(schedule, launchRequest);
    expect(mapProgress).toHaveBeenCalledWith({ state: 'ready' }, expect.any(Function));
  });
});
