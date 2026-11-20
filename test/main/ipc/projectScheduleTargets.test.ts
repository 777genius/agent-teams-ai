import {
  TeamProjectContextLaunchConflictError,
  TeamProjectContextUnavailableError,
} from '@features/team-project-context/main';
import { describe, expect, it, vi } from 'vitest';

import {
  ProjectScheduleTargets,
  type ProjectScheduleTargetPorts,
} from '../../../src/main/ipc/teams/projectScheduleTargets';

import type { TeamLaunchRequest, TeamLaunchResponse } from '@shared/types';

const schedule = {
  teamName: 'builders',
  launchConfig: { cwd: '/work/a', prompt: 'go' },
};
const launchRequest = {
  teamName: 'ptc-x-a',
  cwd: '/work/a',
  providerId: 'anthropic',
} as TeamLaunchRequest;
const readyCopy = (executionTeamName = 'ptc-x-a') => ({
  logicalTeamName: 'builders',
  executionTeamName,
  projectPath: '/work/a',
  state: 'ready' as const,
  mode: 'per_project' as const,
});

function makePorts(
  overrides: Partial<ProjectScheduleTargetPorts> = {}
): ProjectScheduleTargetPorts {
  return {
    getMode: vi.fn(async () => 'per_project' as const),
    isOwnedExecutionAlias: vi.fn(async () => false),
    isTrashed: vi.fn(async () => false),
    isDirectory: vi.fn(async () => true),
    forRead: vi.fn(async () => readyCopy()),
    assertOtherContextsStopped: vi.fn(async () => undefined),
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
const targetsOf = (ports: ProjectScheduleTargetPorts) => new ProjectScheduleTargets(() => ports);
const reasonOf = (result: unknown) => (result as { reason: string }).reason;

describe('ProjectScheduleTargets.admit', () => {
  it('lets ordinary and per-project teams be scheduled', async () => {
    const shared = targetsOf(makePorts({ getMode: vi.fn(async () => 'shared' as const) }));
    expect(await shared.admit('legacy')).toEqual({ allowed: true });
    expect(await targetsOf(makePorts()).admit('builders')).toEqual({ allowed: true });
  });

  it('refuses a project copy: schedules belong to the team, never to its copy', async () => {
    const targets = targetsOf(
      makePorts({
        getMode: vi.fn(async () => 'shared' as const),
        isOwnedExecutionAlias: vi.fn(async () => true),
      })
    );
    const result = await targets.admit('ptc-x-a');
    expect(result).toMatchObject({ allowed: false });
    expect(reasonOf(result)).toMatch(/project copy/i);
  });

  it('fails closed when the team metadata cannot be read', async () => {
    const targets = targetsOf(
      makePorts({
        getMode: vi.fn(async () => {
          throw new Error('Team metadata is unreadable; refusing shared-history fallback');
        }),
      })
    );
    const result = await targets.admit('builders');
    expect(result).toMatchObject({ allowed: false });
    expect(reasonOf(result)).toMatch(/unreadable/i);
  });

  it('fails closed when alias ownership cannot be determined', async () => {
    const targets = targetsOf(
      makePorts({
        getMode: vi.fn(async () => 'shared' as const),
        isOwnedExecutionAlias: vi.fn(async () => {
          throw new Error('registry offline');
        }),
      })
    );
    expect(await targets.admit('legacy')).toMatchObject({ allowed: false });
  });

  it('refuses a schedule of a per-project team whose project folder does not exist', async () => {
    const ports = makePorts({ isDirectory: vi.fn(async () => false) });
    const result = await targetsOf(ports).admit('builders', '/work/gone');
    expect(result).toMatchObject({ allowed: false });
    expect(reasonOf(result)).toMatch(/folder/i);
    expect(ports.isDirectory).toHaveBeenCalledWith('/work/gone');
  });

  it('accepts an existing project folder and never asks about it for ordinary teams', async () => {
    expect(await targetsOf(makePorts()).admit('builders', '/work/a')).toEqual({ allowed: true });
    const legacy = makePorts({
      getMode: vi.fn(async () => 'shared' as const),
      isDirectory: vi.fn(async () => false),
    });
    expect(await targetsOf(legacy).admit('legacy', '/anything')).toEqual({ allowed: true });
    expect(legacy.isDirectory).not.toHaveBeenCalled();
  });
});

describe('ProjectScheduleTargets.resolve', () => {
  it('leaves ordinary teams on their own name', async () => {
    const ports = makePorts({ getMode: vi.fn(async () => 'shared' as const) });
    expect(await targetsOf(ports).resolve({ ...schedule, teamName: 'legacy' })).toEqual({
      kind: 'native',
    });
    expect(ports.forRead).not.toHaveBeenCalled();
  });

  it('maps a per-project schedule to the ready copy of its project, never creating one', async () => {
    const ports = makePorts();
    expect(await targetsOf(ports).resolve(schedule)).toEqual({
      kind: 'project',
      executionTeamName: 'ptc-x-a',
      projectPath: '/work/a',
    });
    expect(ports.forRead).toHaveBeenCalledWith({
      logicalTeamName: 'builders',
      projectPath: '/work/a',
    });
    expect(ports.assertOtherContextsStopped).toHaveBeenCalledWith('builders', 'ptc-x-a');
    expect(ports.prepareLaunch).not.toHaveBeenCalled();
  });

  it('refuses with a clear reason when the project has no launched copy yet', async () => {
    const result = await targetsOf(makePorts({ forRead: vi.fn(async () => null) })).resolve(
      schedule
    );
    expect(result.kind).toBe('refused');
    expect(reasonOf(result)).toMatch(/launch the team in this project/i);
  });

  it('refuses a copy that is not confirmed ready', async () => {
    const result = await targetsOf(
      makePorts({ forRead: vi.fn(async () => ({ ...readyCopy(), state: 'reserved' as const })) })
    ).resolve(schedule);
    expect(result.kind).toBe('refused');
  });

  it('refuses a trashed team and an unreadable one', async () => {
    expect(
      (await targetsOf(makePorts({ isTrashed: vi.fn(async () => true) })).resolve(schedule)).kind
    ).toBe('refused');
    expect(
      (
        await targetsOf(
          makePorts({
            getMode: vi.fn(async () => {
              throw new Error('unreadable');
            }),
          })
        ).resolve(schedule)
      ).kind
    ).toBe('refused');
  });

  // The real registry throws for these (it does not return a state): each must be a recorded
  // skip with a reason, never an exception that counts toward auto-pause.
  it.each([
    'Project context creation is incomplete',
    'Team is being deleted or moved to trash',
    'Team permanent deletion is in progress',
    'Corrupt project-context index',
    'Incompatible project-context index',
    'Team belongs to a different or unknown profile',
    'Ambiguous project runtime alias',
  ])('records a skip, not a failure, when reading the copy throws "%s"', async (message) => {
    const ports = makePorts({
      forRead: vi.fn(async () => {
        throw new TeamProjectContextUnavailableError(message);
      }),
    });
    const result = await targetsOf(ports).resolve(schedule);
    expect(result.kind).toBe('refused');
    expect(reasonOf(result)).toContain(message);
    expect(ports.prepareLaunch).not.toHaveBeenCalled();
    expect(ports.launchPhysical).not.toHaveBeenCalled();
  });

  it('records a skip when reading the copy fails for any other reason', async () => {
    const ports = makePorts({
      forRead: vi.fn(async () => {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      }),
    });
    const result = await targetsOf(ports).resolve(schedule);
    expect(result.kind).toBe('refused');
    expect(reasonOf(result)).not.toContain('EACCES');
  });

  it('records a skip when the trash state cannot be read', async () => {
    const ports = makePorts({
      isTrashed: vi.fn(async () => {
        throw new Error('EIO');
      }),
    });
    expect((await targetsOf(ports).resolve(schedule)).kind).toBe('refused');
  });

  it('refuses before any work when the team is running in another project', async () => {
    const ports = makePorts({
      assertOtherContextsStopped: vi.fn(async () => {
        throw new TeamProjectContextLaunchConflictError('This team is running in another project');
      }),
    });
    const result = await targetsOf(ports).resolve(schedule);
    expect(result).toEqual({ kind: 'refused', reason: 'This team is running in another project' });
  });
});

describe('ProjectScheduleTargets.launch', () => {
  it('prepares the context under the logical lock and launches the project copy', async () => {
    const ports = makePorts();
    const result = await targetsOf(ports).launch(schedule, launchRequest);
    expect(result).toEqual({ runId: 'run-1' });
    expect(ports.withLogicalLock).toHaveBeenCalledWith('builders', expect.any(Function));
    expect(ports.prepareLaunch).toHaveBeenCalledWith(
      expect.objectContaining({ teamName: 'builders', cwd: '/work/a' })
    );
    expect(ports.launchPhysical).toHaveBeenCalledWith(
      expect.objectContaining({ teamName: 'ptc-x-a' }),
      expect.any(Function)
    );
    expect(ports.rememberRunIdentity).toHaveBeenCalledWith('run-1', 'builders', 'ptc-x-a');
  });

  it('turns a refusal of the launch admission into a recorded refusal, not a failure', async () => {
    const conflict = new TeamProjectContextLaunchConflictError(
      'This team is running in another project'
    );
    const ports = makePorts({
      prepareLaunch: vi.fn(async () => {
        throw conflict;
      }),
    });
    const result = await targetsOf(ports).launch(schedule, launchRequest);
    expect(result).toEqual({ refused: 'This team is running in another project' });
    expect(ports.launchPhysical).not.toHaveBeenCalled();
  });

  it('lets unknown preparation errors propagate as failures', async () => {
    const ports = makePorts({
      prepareLaunch: vi.fn(async () => {
        throw new Error('disk exploded');
      }),
    });
    await expect(targetsOf(ports).launch(schedule, launchRequest)).rejects.toThrow(
      'disk exploded'
    );
  });

  it('maps native progress through the context confirmation', async () => {
    const mapProgress = vi.fn();
    const ports = makePorts({
      prepareLaunch: vi.fn(async (request) => ({
        request: { ...request, teamName: 'ptc-x-a' },
        mapProgress,
      })),
      launchPhysical: vi.fn(async (_request, onProgress) => {
        onProgress({ state: 'ready' } as never);
        return { runId: 'run-2' } as TeamLaunchResponse;
      }),
    });
    await targetsOf(ports).launch(schedule, launchRequest);
    expect(mapProgress).toHaveBeenCalledWith({ state: 'ready' }, expect.any(Function));
  });

  // "A scheduler never creates a copy" must not rest on coincidence: prepareLaunch can reserve
  // and materialize one, so the copy resolve chose is re-checked read-only before it, and the
  // prepared request is asserted to be that very copy.
  it('never prepares a launch when the copy chosen earlier is no longer the ready one', async () => {
    for (const current of [null, readyCopy('ptc-x-other'), { ...readyCopy(), state: 'reserved' as const }]) {
      const ports = makePorts({ forRead: vi.fn(async () => current) });
      const result = await targetsOf(ports).launch(schedule, launchRequest);
      expect(result).toMatchObject({ refused: expect.stringMatching(/changed/i) });
      expect(ports.prepareLaunch).not.toHaveBeenCalled();
      expect(ports.launchPhysical).not.toHaveBeenCalled();
    }
  });

  it('refuses and starts nothing when the prepared launch is not the chosen copy', async () => {
    const ports = makePorts({
      prepareLaunch: vi.fn(async (request) => ({
        request: { ...request, teamName: 'ptc-x-created-now' },
      })),
    });
    const result = await targetsOf(ports).launch(schedule, launchRequest);
    expect(result).toMatchObject({ refused: expect.stringMatching(/changed/i) });
    expect(ports.launchPhysical).not.toHaveBeenCalled();
    expect(ports.rememberRunIdentity).not.toHaveBeenCalled();
  });

  it('refuses when the copy can no longer be read', async () => {
    const ports = makePorts({
      forRead: vi.fn(async () => {
        throw new TeamProjectContextUnavailableError('Project context creation is incomplete');
      }),
    });
    const result = await targetsOf(ports).launch(schedule, launchRequest);
    expect(result).toMatchObject({ refused: expect.stringContaining('incomplete') });
    expect(ports.prepareLaunch).not.toHaveBeenCalled();
  });
});

describe('ProjectScheduleTargets ports', () => {
  it('are built for every call, so a changed Claude root is never served from an old one', async () => {
    const makePortsSpy = vi.fn(() => makePorts());
    const targets = new ProjectScheduleTargets(makePortsSpy);
    await targets.admit('builders');
    await targets.resolve(schedule);
    await targets.launch(schedule, launchRequest);
    expect(makePortsSpy).toHaveBeenCalledTimes(3);
  });
});
