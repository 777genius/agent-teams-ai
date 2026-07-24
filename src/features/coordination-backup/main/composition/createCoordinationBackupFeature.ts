import { CoordinationBackupService } from '../../core/application';
import { DurableBackupIdentityInventory } from '../adapters/output/DurableBackupIdentityInventory';
import { SqliteBackupCoordinationFlush } from '../adapters/output/SqliteBackupCoordinationFlush';
import { SqliteBackupRunRepository } from '../adapters/output/SqliteBackupRunRepository';
import { SqliteBackupWriterFence } from '../adapters/output/SqliteBackupWriterFence';
import { SqliteOnlineBackupAdapter } from '../adapters/output/SqliteOnlineBackupAdapter';
import {
  NodeBackupManifestHasher,
  NodeBackupPublication,
  NodeImmutableBackupVerifier,
} from '../infrastructure';
import { CoordinationEventBackupParticipant } from '../participants';

import type { CoordinationBackupParticipant } from '../../core/application';
import type { DurableIdentityInventorySource } from '../adapters/output/DurableBackupIdentityInventory';
import type { DurableStateCompatibilityManifestSource } from '../adapters/output/SqliteBackupCoordinationFlush';
import type { CoordinationEventJournal } from '@features/coordination-events';
import type { CoordinationDurabilityStorageGateway } from '@features/internal-storage/main';

export interface CreateCoordinationBackupFeatureOptions {
  readonly storage: CoordinationDurabilityStorageGateway;
  readonly deploymentId: string;
  readonly backupRoot: string;
  readonly eventJournal: CoordinationEventJournal;
  readonly identityInventorySource: DurableIdentityInventorySource;
  readonly compatibilityManifestSource: DurableStateCompatibilityManifestSource;
  /** Identity/workspace participants are injected by their durable owning features. */
  readonly participants?: readonly CoordinationBackupParticipant[];
  readonly now?: () => Date;
  readonly createFenceLeaseId?: () => string;
  readonly onlineBackup?: {
    readonly deadlineMs?: number;
    readonly busyRetryMs?: number;
    readonly pagesPerStep?: number;
  };
}

export interface CoordinationBackupFeature {
  /** The only public mutation/recovery facade for this feature composition. */
  readonly service: CoordinationBackupService;
}

export function createCoordinationBackupFeature(
  options: CreateCoordinationBackupFeatureOptions
): CoordinationBackupFeature {
  if (
    !options.storage ||
    !options.deploymentId ||
    !options.backupRoot ||
    !options.eventJournal ||
    !options.identityInventorySource ||
    !options.compatibilityManifestSource
  ) {
    throw new TypeError('coordination-backup-feature-options-invalid');
  }
  const now = options.now ?? (() => new Date());
  const publication = new NodeBackupPublication({ backupRoot: options.backupRoot });
  const onlineBackup = new SqliteOnlineBackupAdapter({
    storage: options.storage,
    snapshotPublisher: publication,
    artifactWriter: publication,
    nowMs: () => now().getTime(),
    ...(options.onlineBackup?.deadlineMs === undefined
      ? {}
      : { deadlineMs: options.onlineBackup.deadlineMs }),
    ...(options.onlineBackup?.busyRetryMs === undefined
      ? {}
      : { busyRetryMs: options.onlineBackup.busyRetryMs }),
    ...(options.onlineBackup?.pagesPerStep === undefined
      ? {}
      : { pagesPerStep: options.onlineBackup.pagesPerStep }),
  });
  const participants = Object.freeze([
    new CoordinationEventBackupParticipant({
      deploymentId: options.deploymentId,
      journal: options.eventJournal,
      artifactWriter: publication,
    }),
    ...(options.participants ?? []),
  ]);
  const runs = new SqliteBackupRunRepository(options.storage);
  const writerFence = new SqliteBackupWriterFence({
    storage: options.storage,
    deploymentId: options.deploymentId,
    nowIso: () => now().toISOString(),
    ...(options.createFenceLeaseId === undefined
      ? {}
      : { createLeaseId: options.createFenceLeaseId }),
  });
  const coordinationFlush = new SqliteBackupCoordinationFlush({
    storage: options.storage,
    deploymentId: options.deploymentId,
    compatibilityManifest: options.compatibilityManifestSource,
  });
  const identityInventory = new DurableBackupIdentityInventory({
    deploymentId: options.deploymentId,
    source: options.identityInventorySource,
  });
  const immutableVerifier = new NodeImmutableBackupVerifier({
    backupRoot: options.backupRoot,
  });
  const service = new CoordinationBackupService({
    runs,
    writerFence,
    coordinationFlush,
    identityInventory,
    onlineBackup,
    sqliteIntegrity: onlineBackup,
    manifestHash: new NodeBackupManifestHasher(),
    publication,
    immutableVerifier,
    clock: { nowIso: () => now().toISOString() },
    participants,
  });
  return Object.freeze({ service });
}
