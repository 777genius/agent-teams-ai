import * as path from 'node:path';

import { InternalStorageWorkerClient } from '@features/internal-storage/main/infrastructure/InternalStorageWorkerClient';
import { parseInternalStorageWorkerResponseForPending } from '@features/internal-storage/main/infrastructure/worker/internalStorageWorkerProtocol';
import { parseDeploymentId } from '@shared/contracts/hosted';
import { afterEach, describe, expect, it } from 'vitest';

describe('InternalStorageWorkerClient real worker transport', () => {
  let client: InternalStorageWorkerClient | null = null;

  afterEach(async () => {
    await client?.close();
    client = null;
  });

  it('accepts a missing clean-handoff marker across the worker boundary', () => {
    expect(
      parseInternalStorageWorkerResponseForPending(
        { id: 'request-1', ok: true, result: null },
        () => 'externalWriterObservation.consumeCleanHandoff'
      )
    ).toEqual({ id: 'request-1', ok: true, result: null });
  });

  it('keeps the worker alive when a cold-start clean-handoff consume returns null', async () => {
    client = new InternalStorageWorkerClient({ databasePath: '/tmp/unused-storage.db' });
    Reflect.set(
      client,
      'workerPath',
      path.join(
        process.cwd(),
        'test/features/internal-storage/fixtures/externalWriterNullWorker.cjs'
      )
    );

    await expect(
      client.consumeExternalWriterCleanHandoffEligibility({
        deploymentId: parseDeploymentId('deployment_phase8'),
        observerId: 'hosted-task-observer',
        consumeAttemptId: 'attempt-cold-start',
      })
    ).resolves.toBeNull();
    await expect(client.ping()).resolves.toEqual({ backend: 'sqlite' });
  });
});
