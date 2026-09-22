import {
  type ExternalWriterCleanHandoffEligibilityPlan,
  type ExternalWriterObservationStateStore,
  FileObservationState,
  type FileObservationStateCheckpoint,
} from '@features/external-writer-coordination';

import {
  type ExternalWriterObservationCheckpointIdentity,
  type ExternalWriterObservationCheckpointStorageGateway,
} from '../../../contracts/externalWriterObservationStorageContracts';
import { parseTeamIdentityChecksum } from '../../../contracts/teamIdentityStorageContracts';

import type { TeamId } from '@shared/contracts/hosted';

const CHECKPOINT_LIMITS = Object.freeze({
  maxPendingObservations: 1_024,
  maxSelfWriteIntents: 1_024,
  maxObservationAttempts: 3,
  maxScopes: 1_024,
  maxObservedFiles: 100_000,
});

function validatedCheckpoint(
  checkpoint: FileObservationStateCheckpoint
): FileObservationStateCheckpoint {
  return FileObservationState.restore(checkpoint, CHECKPOINT_LIMITS).snapshot();
}

/**
 * Binds one observer generation to the durable checkpoint CAS. A second process
 * or stale supervisor instance cannot overwrite a newer observation watermark.
 */
export class InternalStorageExternalWriterObservationStateStore implements ExternalWriterObservationStateStore {
  private revision: number | null = null;
  private loaded = false;
  private operationTail: Promise<void> = Promise.resolve();
  private consumeAttemptId: string | null = null;

  constructor(
    private readonly gateway: ExternalWriterObservationCheckpointStorageGateway,
    private readonly identity: ExternalWriterObservationCheckpointIdentity
  ) {}

  load(): Promise<FileObservationStateCheckpoint | null> {
    return this.schedule(async () => {
      const record = await this.gateway.loadExternalWriterObservationCheckpoint(this.identity);
      this.loaded = true;
      this.revision = record?.revision ?? null;
      return record ? validatedCheckpoint(record.checkpoint) : null;
    });
  }

  consumeCleanHandoffEligibility(): Promise<FileObservationStateCheckpoint | null> {
    return this.schedule(async () => {
      const consumeAttemptId = (this.consumeAttemptId ??= crypto.randomUUID());
      const record = await this.gateway.consumeExternalWriterCleanHandoffEligibility({
        ...this.identity,
        consumeAttemptId,
      });
      this.consumeAttemptId = null;
      if (!record) return null;
      this.loaded = true;
      this.revision = record.revision;
      return validatedCheckpoint(record.checkpoint);
    });
  }

  listHotTeamIds(): Promise<readonly TeamId[]> {
    return this.schedule(async () => {
      const record = await this.gateway.loadExternalWriterObservationCheckpoint(this.identity);
      this.loaded = true;
      this.revision = record?.revision ?? null;
      if (!record) return Object.freeze([]);
      const checkpoint = validatedCheckpoint(record.checkpoint);
      return Object.freeze([
        ...new Set([
          ...checkpoint.fileWriterEpochs.map((entry) => entry.teamId),
          ...checkpoint.teamObservationWatermarks.map((entry) => entry.teamId),
          ...checkpoint.pendingObservations.map((entry) => entry.scope.teamId),
          ...checkpoint.dirtyScopes.map((entry) => entry.scope.teamId),
          ...checkpoint.selfWriteIntents.map((entry) => entry.scope.teamId),
          ...checkpoint.observedFiles.map((entry) => entry.scope.teamId),
        ]),
      ]);
    });
  }

  save(checkpoint: FileObservationStateCheckpoint): Promise<void> {
    return this.schedule(async () => {
      if (!this.loaded) {
        throw new Error('external-writer-observation-state-store-not-loaded');
      }
      const record = await this.gateway.saveExternalWriterObservationCheckpoint({
        ...this.identity,
        expectedRevision: this.revision,
        checkpoint: validatedCheckpoint(checkpoint),
      });
      this.revision = record.revision;
    });
  }

  saveCleanHandoffEligibility(
    checkpoint: FileObservationStateCheckpoint,
    plan: ExternalWriterCleanHandoffEligibilityPlan
  ): Promise<void> {
    return this.schedule(async () => {
      if (!this.loaded) throw new Error('external-writer-observation-state-store-not-loaded');
      const record = await this.gateway.saveExternalWriterCleanHandoffEligibility({
        ...this.identity,
        expectedRevision: this.revision,
        checkpoint: validatedCheckpoint(checkpoint),
        plan: {
          handoffId: plan.handoffId,
          oldCatalogToken: plan.oldCatalogToken,
          nextCatalogToken: plan.nextCatalogToken,
          retainedRegistrations: plan.retainedRegistrations.map((entry) => ({
            teamId: entry.scope.teamId,
            featureKey: entry.scope.featureKey,
            fileKey: entry.fileKey,
          })),
          retirementProofs: plan.retirementProofs.map((proof) => ({
            ...proof,
            identityChecksum: parseTeamIdentityChecksum(proof.identityChecksum),
          })),
          createdAt: plan.createdAt,
        },
      });
      this.revision = record.revision;
    });
  }

  private schedule<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}
