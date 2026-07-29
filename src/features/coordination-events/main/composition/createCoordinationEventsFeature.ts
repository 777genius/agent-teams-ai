import { CoordinationEventHandoff } from '../../core/application';
import { SqliteCoordinationEventJournal } from '../adapters/output/SqliteCoordinationEventJournal';

import type { CoordinationEventWakeup } from '../../core/application';
import type { CoordinationDurabilityStorageGateway } from '@features/internal-storage/main';

export interface CreateCoordinationEventsFeatureOptions {
  readonly storage: CoordinationDurabilityStorageGateway;
  readonly deploymentId: string;
  readonly eventEpoch?: string;
  readonly wakeup?: CoordinationEventWakeup;
  readonly now?: () => Date;
}

export interface CoordinationEventsFeature {
  /** Public publish/replay/snapshot facade; mutable storage primitives stay private. */
  readonly handoff: CoordinationEventHandoff;
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
  return Object.freeze({
    handoff: new CoordinationEventHandoff({
      journal,
      ...(input.wakeup === undefined ? {} : { wakeup: input.wakeup }),
    }),
  });
}
