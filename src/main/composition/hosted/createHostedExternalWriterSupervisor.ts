import { ExternalWriterReconciliationRouter } from '@features/external-writer-coordination/main';
// eslint-disable-next-line no-restricted-imports -- Hosted composition owns the concrete durable state adapter.
import { InternalStorageExternalWriterObservationStateStore } from '@features/internal-storage/main/hosted';
// eslint-disable-next-line no-restricted-imports -- Hosted composition owns the concrete message reconciler.
import {
  HOSTED_MESSAGE_EXTERNAL_WRITER_FEATURE_KEY,
  HostedMessageExternalWriterReconciler,
} from '@features/team-message-delivery/main/hosted';
// eslint-disable-next-line no-restricted-imports -- Hosted composition owns the concrete task reconciler.
import {
  HOSTED_TASK_EXTERNAL_WRITER_FEATURE_KEY,
  HostedTaskExternalWriterReconciler,
} from '@features/team-task-board/main/hosted';

import {
  HostedMessageExternalWriterJournalAuthority,
  HostedTaskExternalWriterJournalAuthority,
} from './hostedExternalWriterAuthorities';
import {
  HostedExternalWriterInventorySupervisor,
  HostedExternalWriterTaskInventory,
} from './hostedExternalWriterInventorySupervisor';

import type { createTeamLifecycleReadOnlyIdentitySource } from './teamLifecycleReadOnlyIdentitySource';
import type { HostedCoordinationEventStream } from '@features/coordination-events/main';
import type { HostedAuthStorageBackend } from '@main/http';

export function createHostedExternalWriterSupervisor(input: {
  readonly admittedClaudeRoot: string;
  readonly deploymentId: string;
  readonly storage: HostedAuthStorageBackend;
  readonly eventStream: HostedCoordinationEventStream;
  readonly teamIdentities: NonNullable<
    Awaited<ReturnType<typeof createTeamLifecycleReadOnlyIdentitySource>>
  >;
}): HostedExternalWriterInventorySupervisor {
  const sharedAuthority = {
    deploymentId: input.deploymentId,
    storage: input.storage.externalWriterReconciliations,
    notifyDurableCommit: input.eventStream.notifyDurableCommit,
    teamIdentities: input.teamIdentities,
  };
  return new HostedExternalWriterInventorySupervisor({
    inventory: new HostedExternalWriterTaskInventory({
      admittedClaudeRoot: input.admittedClaudeRoot,
      teamIdentities: input.teamIdentities,
    }),
    reconciliation: new ExternalWriterReconciliationRouter([
      {
        featureKey: HOSTED_TASK_EXTERNAL_WRITER_FEATURE_KEY,
        reconciliation: new HostedTaskExternalWriterReconciler(
          new HostedTaskExternalWriterJournalAuthority(sharedAuthority)
        ),
      },
      {
        featureKey: HOSTED_MESSAGE_EXTERNAL_WRITER_FEATURE_KEY,
        reconciliation: new HostedMessageExternalWriterReconciler(
          new HostedMessageExternalWriterJournalAuthority(sharedAuthority)
        ),
      },
    ]),
    stateStore: new InternalStorageExternalWriterObservationStateStore(
      input.storage.externalWriterObservations,
      {
        deploymentId: input.deploymentId as ConstructorParameters<
          typeof InternalStorageExternalWriterObservationStateStore
        >[1]['deploymentId'],
        observerId: 'hosted-task-message-observer-v1',
      }
    ),
    clock: {
      nowMs: Date.now,
      sleep: (durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs)),
    },
    stableCatalogRescanIntervalMs: 30_000,
  });
}
