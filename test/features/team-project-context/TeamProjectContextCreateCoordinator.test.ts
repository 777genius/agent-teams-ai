import { describe, expect, it, vi } from 'vitest';

import { TeamProjectContextCreateCoordinator } from '../../../src/features/team-project-context/main/TeamProjectContextCreateCoordinator';

import type {
  TeamCreateRequest,
  TeamProvisioningProgress,
} from '../../../src/shared/types/team';

const request: TeamCreateRequest = {
  teamName: 'builders',
  cwd: '/sandbox/a',
  members: [],
  projectContextMode: 'per_project',
};
const context = {
  logicalTeamName: 'builders',
  executionTeamName: 'ptc-abc',
  workContextId: '11111111-1111-4111-8111-111111111111',
  mode: 'per_project' as const,
  state: 'reserved' as const,
  projectPath: '/sandbox/a',
};
const ready = { ...context, state: 'ready' as const };

function fixture() {
  let nativeProgress: ((event: TeamProvisioningProgress) => void) | null = null;
  const ports = {
    createLogicalDraft: vi.fn(async () => undefined),
    withLogicalTeamLock: vi.fn(async <T>(_: string, fn: () => Promise<T>): Promise<T> => fn()),
    reserve: vi.fn(async () => context),
    releaseUnusedReservation: vi.fn(async () => true),
    assertOtherContextsStopped: vi.fn(async () => undefined),
    ensurePhysicalDraft: vi.fn(async () => context),
    createNativeTeam: vi.fn(async (_: TeamCreateRequest, emit: (event: TeamProvisioningProgress) => void) => {
      nativeProgress = emit;
      return { runId: 'run-a' };
    }),
    confirmReady: vi.fn(async () => ready),
  };
  return {
    create: new TeamProjectContextCreateCoordinator(ports),
    ports,
    emit: (event: TeamProvisioningProgress) => {
      if (!nativeProgress) throw new Error('Not launched');
      nativeProgress(event);
    },
  };
}

const progress = (state: TeamProvisioningProgress['state']): TeamProvisioningProgress => ({
  runId: 'run-a',
  teamName: 'ptc-abc',
  state,
  message: state,
  startedAt: '2026-11-17T00:00:00Z',
  updatedAt: '2026-11-17T00:00:00Z',
});

describe('TeamProjectContextCreateCoordinator', () => {
  it('rejects launch without a project before writing its logical draft', async () => {
    const f = fixture();
    await expect(f.create.create({ ...request, cwd: undefined }, vi.fn()))
      .rejects.toThrow('Choose a project');
    expect(f.ports.createLogicalDraft).not.toHaveBeenCalled();
    expect(f.ports.reserve).not.toHaveBeenCalled();
  });

  it('starts only the project-specific native team and maps progress to the logical team', async () => {
    const f = fixture();
    const onProgress = vi.fn();
    await expect(f.create.create(request, onProgress)).resolves.toEqual({ runId: 'run-a' });
    expect(f.ports.createLogicalDraft).toHaveBeenCalledWith(request);
    expect(f.ports.createNativeTeam).toHaveBeenCalledWith({
      ...request, teamName: context.executionTeamName, cwd: context.projectPath, projectContextMode: 'shared',
    }, expect.any(Function));
    f.emit(progress('spawning'));
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({
      teamName: 'builders', state: 'spawning',
    }));
    f.emit(progress('ready'));
    await vi.waitFor(() => {
      expect(f.ports.confirmReady).toHaveBeenCalled();
      expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({
        teamName: 'builders', state: 'ready',
      }));
    });
  });

  it('uses canonical context path when the user-supplied path is a symlink alias', async () => {
    const f = fixture();
    const aliasRequest = { ...request, cwd: '/links/a' };
    await f.create.create(aliasRequest, vi.fn());
    expect(f.ports.reserve).toHaveBeenCalledWith({
      logicalTeamName: 'builders',
      projectPath: '/links/a',
    });
    expect(f.ports.ensurePhysicalDraft).toHaveBeenCalledWith({
      logicalTeamName: 'builders',
      projectPath: '/sandbox/a',
    });
    expect(f.ports.createNativeTeam).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/sandbox/a' }), expect.any(Function)
    );
  });

  it('releases only empty reservations on failed admission', async () => {
    const f = fixture();
    f.ports.assertOtherContextsStopped.mockRejectedValue(new Error('A is running'));
    await expect(f.create.create(request, vi.fn())).rejects.toThrow('A is running');
    expect(f.ports.createNativeTeam).not.toHaveBeenCalled();
    expect(f.ports.releaseUnusedReservation).toHaveBeenCalledWith(
      'builders', 'ptc-abc', context.workContextId
    );
  });

  it('does not release aliases after native creation has begun', async () => {
    const f = fixture();
    f.ports.createNativeTeam.mockRejectedValue(new Error('spawn failed'));
    await expect(f.create.create(request, vi.fn())).rejects.toThrow('spawn failed');
    expect(f.ports.releaseUnusedReservation).not.toHaveBeenCalled();
  });

  it('reports a failed verification instead of falsely marking an unverified context ready', async () => {
    const f = fixture();
    const onProgress = vi.fn();
    f.ports.confirmReady.mockRejectedValue(new Error('missing native config'));
    await f.create.create(request, onProgress);
    f.emit(progress('ready'));
    await vi.waitFor(() => {
      expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({
        teamName: 'builders', state: 'failed', error: 'missing native config',
      }));
    });
    expect(onProgress).not.toHaveBeenCalledWith(expect.objectContaining({ state: 'ready' }));
  });
});
