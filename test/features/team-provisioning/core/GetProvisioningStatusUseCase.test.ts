import {
  GetProvisioningStatusUseCase,
  type ProvisioningStatusReaderPort,
} from '@features/team-provisioning/core/application/use-cases/GetProvisioningStatusUseCase';
import { describe, expect, it, vi } from 'vitest';

import type { TeamProvisioningProgress } from '@shared/types/team';

function progress(): TeamProvisioningProgress {
  return {
    runId: 'run-1',
    teamName: 'team-1',
    state: 'spawning',
    message: 'Starting',
    startedAt: '2026-07-22T10:00:00.000Z',
    updatedAt: '2026-07-22T10:00:01.000Z',
  };
}

describe('GetProvisioningStatusUseCase', () => {
  it('returns the exact progress snapshot and forwards the run id unchanged', async () => {
    const snapshot = progress();
    const findByRunId = vi.fn<ProvisioningStatusReaderPort['findByRunId']>(() =>
      Promise.resolve(snapshot)
    );
    const useCase = new GetProvisioningStatusUseCase({ findByRunId });

    await expect(useCase.execute({ runId: '  run-1  ' })).resolves.toBe(snapshot);
    expect(findByRunId).toHaveBeenCalledWith('  run-1  ');
  });

  it('owns the stable Unknown runId application error', async () => {
    const useCase = new GetProvisioningStatusUseCase({
      findByRunId: () => Promise.resolve(undefined),
    });

    await expect(useCase.execute({ runId: 'missing-run' })).rejects.toThrow('Unknown runId');
  });
});
