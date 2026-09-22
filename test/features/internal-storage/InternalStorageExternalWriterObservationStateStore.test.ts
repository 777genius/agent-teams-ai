import { InternalStorageExternalWriterObservationStateStore } from '@features/internal-storage/main/adapters/output/InternalStorageExternalWriterObservationStateStore';
import { parseDeploymentId } from '@shared/contracts/hosted';
import { describe, expect, it, vi } from 'vitest';

import type { FileObservationStateCheckpoint } from '@features/external-writer-coordination/contracts';
import type { ExternalWriterObservationCheckpointStorageGateway } from '@features/internal-storage/contracts/externalWriterObservationStorageContracts';

const checkpoint: FileObservationStateCheckpoint = {
  schemaVersion: 2,
  lastObservationSequence: 0,
  observationWatermark: 0,
  fileWriterEpochs: [],
  teamObservationWatermarks: [],
  pendingObservations: [],
  dirtyScopes: [],
  selfWriteIntents: [],
  observedFiles: [],
};

describe('InternalStorageExternalWriterObservationStateStore consume recovery', () => {
  it('retains the exact consume attempt id across a lost response', async () => {
    const consume = vi
      .fn()
      .mockRejectedValueOnce(new Error('worker-response-lost'))
      .mockResolvedValueOnce({ revision: 2, checkpoint });
    const gateway = {
      consumeExternalWriterCleanHandoffEligibility: consume,
    } as unknown as ExternalWriterObservationCheckpointStorageGateway;
    const store = new InternalStorageExternalWriterObservationStateStore(gateway, {
      deploymentId: parseDeploymentId('deployment_phase8'),
      observerId: 'hosted-task-observer',
    });

    await expect(store.consumeCleanHandoffEligibility()).rejects.toThrow('worker-response-lost');
    await expect(store.consumeCleanHandoffEligibility()).resolves.toEqual(checkpoint);
    expect(consume).toHaveBeenCalledTimes(2);
    expect(consume.mock.calls[1][0].consumeAttemptId).toBe(
      consume.mock.calls[0][0].consumeAttemptId
    );
  });
});
