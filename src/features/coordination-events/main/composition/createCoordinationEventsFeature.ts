import { CoordinationEventHandoff } from '../../core/application';
import { SqliteCoordinationEventJournal } from '../adapters/output/SqliteCoordinationEventJournal';
import {
  HostedCoordinationEventRetentionOwner,
  type HostedCoordinationEventRetentionPolicy,
  type HostedCoordinationEventRetentionScheduler,
} from '../application/HostedCoordinationEventRetentionOwner';

import type {
  CoordinationEventDeadlineScheduler,
  CoordinationEventWakeup,
} from '../../core/application';
import type { CoordinationDurabilityStorageGateway } from '@features/internal-storage/main';

const NODE_DEADLINE_SCHEDULER: CoordinationEventDeadlineScheduler = Object.freeze({
  scheduleDeadline(delayMs: number, onDeadline: () => void) {
    const handle = setTimeout(onDeadline, delayMs);
    return () => clearTimeout(handle);
  },
});

export interface CreateCoordinationEventsFeatureOptions {
  readonly storage: CoordinationDurabilityStorageGateway;
  readonly deploymentId: string;
  readonly eventEpoch?: string;
  readonly wakeup?: CoordinationEventWakeup;
  readonly now?: () => Date;
  readonly retention?: {
    readonly policy: HostedCoordinationEventRetentionPolicy;
    readonly scheduler: HostedCoordinationEventRetentionScheduler;
  };
}

export interface CoordinationEventsFeature {
  /** Public publish/replay/snapshot facade; mutable storage primitives stay private. */
  readonly handoff: CoordinationEventHandoff;
  close(): void;
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
  const retentionOwner =
    input.retention === undefined
      ? null
      : new HostedCoordinationEventRetentionOwner(
          journal,
          input.retention.scheduler,
          input.retention.policy
        );
  retentionOwner?.start();
  return Object.freeze({
    handoff: new CoordinationEventHandoff({
      journal,
      deadlineScheduler: NODE_DEADLINE_SCHEDULER,
      ...(input.wakeup === undefined ? {} : { wakeup: input.wakeup }),
    }),
    close: () => retentionOwner?.close(),
  });
}
