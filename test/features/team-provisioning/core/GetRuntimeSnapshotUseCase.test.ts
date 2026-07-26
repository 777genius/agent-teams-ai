import {
  GetRuntimeSnapshotUseCase,
  type RuntimeSnapshotReaderPort,
} from '@features/team-provisioning/core/application/queries/GetRuntimeSnapshotUseCase';
import { describe, expect, it, vi } from 'vitest';

import type { TeamAgentRuntimeSnapshot } from '@shared/types/team';

function runtimeSnapshot(updatedAt = '2026-07-26T10:00:00.000Z'): TeamAgentRuntimeSnapshot {
  return {
    teamName: 'team-1',
    updatedAt,
    runId: 'run-1',
    members: {},
  };
}

describe('GetRuntimeSnapshotUseCase', () => {
  it('returns the exact snapshot and forwards the team name unchanged', async () => {
    const snapshot = runtimeSnapshot();
    const readByTeamName = vi.fn<RuntimeSnapshotReaderPort['readByTeamName']>(() =>
      Promise.resolve(snapshot)
    );
    const useCase = new GetRuntimeSnapshotUseCase({ readByTeamName });

    await expect(useCase.execute({ teamName: '  team-1  ' })).resolves.toBe(snapshot);
    expect(readByTeamName).toHaveBeenCalledOnce();
    expect(readByTeamName).toHaveBeenCalledWith('  team-1  ');
  });

  it('preserves reader failures without translating them', async () => {
    const failure = new Error('runtime snapshot probe failed');
    const useCase = new GetRuntimeSnapshotUseCase({
      readByTeamName: () => Promise.reject(failure),
    });

    await expect(useCase.execute({ teamName: 'team-1' })).rejects.toBe(failure);
  });

  it('leaves request coalescing and cache identity to the reader', async () => {
    const firstSnapshot = runtimeSnapshot('2026-07-26T10:00:00.000Z');
    const secondSnapshot = runtimeSnapshot('2026-07-26T10:00:01.000Z');
    const readByTeamName = vi
      .fn<RuntimeSnapshotReaderPort['readByTeamName']>()
      .mockResolvedValueOnce(firstSnapshot)
      .mockResolvedValueOnce(secondSnapshot);
    const useCase = new GetRuntimeSnapshotUseCase({ readByTeamName });

    const [first, second] = await Promise.all([
      useCase.execute({ teamName: 'team-1' }),
      useCase.execute({ teamName: 'team-1' }),
    ]);

    expect(first).toBe(firstSnapshot);
    expect(second).toBe(secondSnapshot);
    expect(readByTeamName).toHaveBeenCalledTimes(2);
  });
});
