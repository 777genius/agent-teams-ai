import { describe, expect, it, vi } from 'vitest';

import { CreateTeamConfigUseCase } from '../../../../src/features/team-configuration/core/application/use-cases/CreateTeamConfigUseCase';
import { DeleteDraftTeamUseCase } from '../../../../src/features/team-configuration/core/application/use-cases/DeleteDraftTeamUseCase';
import { GetSavedTeamRequestUseCase } from '../../../../src/features/team-configuration/core/application/use-cases/GetSavedTeamRequestUseCase';
import { UpdateTeamConfigUseCase } from '../../../../src/features/team-configuration/core/application/use-cases/UpdateTeamConfigUseCase';

function createRepository() {
  return {
    createTeamConfig: vi.fn(() => Promise.resolve()),
    getSavedRequest: vi.fn(() => Promise.resolve(null)),
    getTeamDisplayName: vi.fn(() => Promise.resolve('Old Name')),
    permanentlyDeleteTeam: vi.fn(() => Promise.resolve()),
    updateConfig: vi.fn(() =>
      Promise.resolve({
        name: 'New Name',
        members: [],
      })
    ),
  };
}

describe('team configuration use cases', () => {
  it('invalidates the worker cache only after config creation succeeds', async () => {
    const repository = createRepository();
    const cache = { invalidateTeamConfig: vi.fn() };
    const useCase = new CreateTeamConfigUseCase({ repository, cache });

    await useCase.execute({ teamName: 'demo-team', members: [] });
    expect(cache.invalidateTeamConfig).toHaveBeenCalledWith('demo-team');

    repository.createTeamConfig.mockRejectedValueOnce(new Error('write failed'));
    cache.invalidateTeamConfig.mockClear();
    await expect(useCase.execute({ teamName: 'demo-team', members: [] })).rejects.toThrow(
      'write failed'
    );
    expect(cache.invalidateTeamConfig).not.toHaveBeenCalled();
  });

  it('notifies a live lead after a rename and then invalidates the cache', async () => {
    const order: string[] = [];
    const repository = createRepository();
    repository.updateConfig.mockImplementationOnce(async () => {
      order.push('update');
      return { name: 'New Name', members: [] };
    });
    const runtime = { isTeamAlive: vi.fn(() => true) };
    const messaging = {
      sendMessageToTeam: vi.fn(async () => {
        order.push('notify');
      }),
    };
    const cache = {
      invalidateTeamConfig: vi.fn(() => {
        order.push('invalidate');
      }),
    };
    const logger = { error: vi.fn(), warn: vi.fn() };
    const useCase = new UpdateTeamConfigUseCase({
      repository,
      runtime,
      messaging,
      cache,
      logger,
    });

    await useCase.execute('demo-team', { name: ' New Name ' });

    expect(messaging.sendMessageToTeam).toHaveBeenCalledWith(
      'demo-team',
      'The team has been renamed to "New Name". Please use this name when referring to the team going forward.'
    );
    expect(order).toEqual(['update', 'notify', 'invalidate']);
  });

  it('keeps rename notification best-effort and returns the updated config', async () => {
    const repository = createRepository();
    const runtime = { isTeamAlive: vi.fn(() => true) };
    const messaging = {
      sendMessageToTeam: vi.fn(() => Promise.reject(new Error('offline'))),
    };
    const cache = { invalidateTeamConfig: vi.fn() };
    const logger = { error: vi.fn(), warn: vi.fn() };
    const useCase = new UpdateTeamConfigUseCase({
      repository,
      runtime,
      messaging,
      cache,
      logger,
    });

    await expect(useCase.execute('demo-team', { name: 'New Name' })).resolves.toMatchObject({
      name: 'New Name',
    });
    expect(logger.warn).toHaveBeenCalledWith(
      'Failed to notify lead about team rename for demo-team'
    );
    expect(cache.invalidateTeamConfig).toHaveBeenCalledWith('demo-team');
  });

  it('does not notify an offline lead when display-name lookup falls back', async () => {
    const repository = createRepository();
    repository.getTeamDisplayName.mockRejectedValueOnce(new Error('display read failed'));
    const runtime = { isTeamAlive: vi.fn(() => false) };
    const messaging = { sendMessageToTeam: vi.fn(() => Promise.resolve()) };
    const cache = { invalidateTeamConfig: vi.fn() };
    const useCase = new UpdateTeamConfigUseCase({
      repository,
      runtime,
      messaging,
      cache,
      logger: { error: vi.fn(), warn: vi.fn() },
    });

    await useCase.execute('demo-team', { name: 'Renamed Team' });

    expect(runtime.isTeamAlive).toHaveBeenCalledWith('demo-team');
    expect(messaging.sendMessageToTeam).not.toHaveBeenCalled();
    expect(cache.invalidateTeamConfig).toHaveBeenCalledWith('demo-team');
  });

  it('does not invalidate when the config is missing', async () => {
    const repository = createRepository();
    repository.updateConfig.mockResolvedValueOnce(null as never);
    const cache = { invalidateTeamConfig: vi.fn() };
    const useCase = new UpdateTeamConfigUseCase({
      repository,
      runtime: { isTeamAlive: vi.fn(() => true) },
      messaging: { sendMessageToTeam: vi.fn(() => Promise.resolve()) },
      cache,
      logger: { error: vi.fn(), warn: vi.fn() },
    });

    await expect(useCase.execute('demo-team', { name: 'New Name' })).rejects.toThrow(
      'Team config not found'
    );
    expect(cache.invalidateTeamConfig).not.toHaveBeenCalled();
  });

  it('checks draft eligibility before permanent deletion', async () => {
    const order: string[] = [];
    const repository = createRepository();
    repository.permanentlyDeleteTeam.mockImplementationOnce(async () => {
      order.push('delete');
    });
    const draftGuard = {
      assertDraftCanBeDeleted: vi.fn(async () => {
        order.push('guard');
      }),
    };
    const useCase = new DeleteDraftTeamUseCase({ repository, draftGuard });

    await useCase.execute('draft-team');
    expect(order).toEqual(['guard', 'delete']);
  });

  it('does not delete when the draft guard rejects', async () => {
    const repository = createRepository();
    const draftGuard = {
      assertDraftCanBeDeleted: vi.fn(() => Promise.reject(new Error('config exists'))),
    };
    const useCase = new DeleteDraftTeamUseCase({ repository, draftGuard });

    await expect(useCase.execute('saved-team')).rejects.toThrow('config exists');
    expect(repository.permanentlyDeleteTeam).not.toHaveBeenCalled();
  });

  it('returns the saved request through the repository capability', async () => {
    const repository = createRepository();
    repository.getSavedRequest.mockResolvedValueOnce({
      teamName: 'draft-team',
      members: [],
    } as never);
    const useCase = new GetSavedTeamRequestUseCase(repository);

    await expect(useCase.execute('draft-team')).resolves.toMatchObject({
      teamName: 'draft-team',
    });
    expect(repository.getSavedRequest).toHaveBeenCalledWith('draft-team');
  });
});
