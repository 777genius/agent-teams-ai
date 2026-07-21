import { CoordinationEventHandoff } from '../../core/application';
import { SqliteCoordinationEventJournal } from '../adapters/output/SqliteCoordinationEventJournal';
import {
  type CoordinationEventRecoveryArtifactStore,
  SqliteCoordinationEventRecoveryPointParticipant,
} from '../adapters/output/SqliteCoordinationEventRecoveryPointParticipant';
import { SqliteSnapshotRetentionLeaseCoordinator } from '../adapters/output/SqliteSnapshotRetentionLeaseCoordinator';

import type {
  CoordinationEventRecoveryPointParticipant as CoordinationEventRecoveryPointParticipantPort,
  CoordinationEventWakeup,
} from '../../core/application';
import type { CoordinationDurabilityStorageGateway } from '@features/internal-storage/main';

export interface CreateCoordinationEventsFeatureOptions {
  readonly storage: CoordinationDurabilityStorageGateway;
  readonly deploymentId: string;
  readonly eventEpoch?: string;
  readonly wakeup?: CoordinationEventWakeup;
  readonly recoveryArtifacts?: CoordinationEventRecoveryArtifactStore;
  readonly now?: () => Date;
}

export interface CoordinationEventsFeature {
  /** Public publish/replay/snapshot facade; mutable storage primitives stay private. */
  readonly handoff: CoordinationEventHandoff;
  readonly recoveryPointParticipant: CoordinationEventRecoveryPointParticipantPort | null;
}

export function createCoordinationEventsFeature(
  input: CreateCoordinationEventsFeatureOptions
): CoordinationEventsFeature {
  const journal = new SqliteCoordinationEventJournal({
    storage: input.storage,
    deploymentId: input.deploymentId,
    ...(input.eventEpoch === undefined ? {} : { eventEpoch: input.eventEpoch }),
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  const retentionLeases = new SqliteSnapshotRetentionLeaseCoordinator({
    storage: input.storage,
    deploymentId: input.deploymentId,
    ...(input.now === undefined ? {} : { nowMs: () => input.now!().getTime() }),
  });
  return Object.freeze({
    handoff: new CoordinationEventHandoff({
      journal,
      retentionLeases,
      ...(input.wakeup === undefined ? {} : { wakeup: input.wakeup }),
    }),
    recoveryPointParticipant: input.recoveryArtifacts
      ? new SqliteCoordinationEventRecoveryPointParticipant({
          deploymentId: input.deploymentId,
          journal,
          artifacts: input.recoveryArtifacts,
        })
      : null,
  });
}
