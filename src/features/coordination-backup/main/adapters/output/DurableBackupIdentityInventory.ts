import { parseWorkspaceId } from '@shared/contracts/hosted';

import { parseSha256Digest } from '../../../contracts/coordinationBackupContracts';

import type {
  BackupIdentityInventory,
  BackupIdentityInventoryEntry,
  BackupWorkspaceRegistrationEntry,
} from '../../../contracts/coordinationBackupContracts';
import type {
  BackupIdentityInventoryPort,
  CaptureBackupIdentityInventoryRequest,
} from '../../../core/application';

/**
 * Injected durable authority only. Implementations are expected to compose the
 * deployment identity, team/member identity registry, and workspace
 * registration store; directory scans and current-run projections cannot
 * satisfy this surface.
 */
export interface DurableIdentityInventorySource {
  captureDurableIdentityInventory(input: {
    readonly backupRunId: string;
    readonly deploymentId: string;
    readonly fenceGeneration: number;
    readonly coordinationBarrier: CaptureBackupIdentityInventoryRequest['barrier'];
  }): Promise<BackupIdentityInventory>;
}

export class DurableBackupIdentityInventory implements BackupIdentityInventoryPort {
  constructor(
    private readonly options: {
      readonly deploymentId: string;
      readonly source: DurableIdentityInventorySource;
    }
  ) {
    if (!options.deploymentId || !options.source) {
      throw new TypeError('durable-backup-identity-inventory-options-invalid');
    }
  }

  async capture(request: CaptureBackupIdentityInventoryRequest): Promise<BackupIdentityInventory> {
    if (
      request.fence.admittedRunId !== request.backupRunId ||
      request.barrier.acceptedCommandDrain.admittedRunId !== request.backupRunId ||
      request.barrier.acceptedCommandDrain.fenceGeneration !== request.fence.generation
    ) {
      throw new Error('durable-backup-identity-inventory-fence-mismatch');
    }
    const inventory = await this.options.source.captureDurableIdentityInventory({
      backupRunId: request.backupRunId,
      deploymentId: this.options.deploymentId,
      fenceGeneration: request.fence.generation,
      coordinationBarrier: request.barrier,
    });
    validateInventory(inventory, this.options.deploymentId);
    return Object.freeze({
      schemaVersion: 1 as const,
      deploymentId: inventory.deploymentId,
      identities: Object.freeze(
        inventory.identities
          .map((identity) => Object.freeze({ ...identity }))
          .sort((left, right) => identityKey(left).localeCompare(identityKey(right)))
      ),
      workspaceRegistrations: Object.freeze(
        inventory.workspaceRegistrations
          .map((registration) => Object.freeze({ ...registration }))
          .sort((left, right) => left.registrationKey.localeCompare(right.registrationKey))
      ),
    });
  }
}

function validateInventory(inventory: BackupIdentityInventory, deploymentId: string): void {
  requireExactKeys(inventory, [
    'schemaVersion',
    'deploymentId',
    'identities',
    'workspaceRegistrations',
  ]);
  if (
    inventory.schemaVersion !== 1 ||
    inventory.deploymentId !== deploymentId ||
    !Array.isArray(inventory.identities) ||
    !Array.isArray(inventory.workspaceRegistrations)
  ) {
    throw new Error('durable-backup-identity-inventory-invalid');
  }
  const identityIds = new Set<string>();
  const teamIds = new Set<string>();
  let deploymentCount = 0;
  for (const identity of inventory.identities as readonly BackupIdentityInventoryEntry[]) {
    requireExactKeys(identity, [
      'kind',
      'identityId',
      'parentIdentityId',
      'state',
      'checksum',
      'fileEntryId',
    ]);
    if (
      (identity.kind !== 'deployment' && identity.kind !== 'team' && identity.kind !== 'member') ||
      (identity.state !== 'active' && identity.state !== 'tombstoned') ||
      typeof identity.identityId !== 'string' ||
      identity.identityId.length === 0 ||
      (identity.parentIdentityId !== null && typeof identity.parentIdentityId !== 'string') ||
      (identity.fileEntryId !== null && typeof identity.fileEntryId !== 'string') ||
      (identity.state === 'active' && identity.fileEntryId === null) ||
      identityIds.has(identity.identityId)
    ) {
      throw new Error('durable-backup-identity-entry-invalid');
    }
    parseSha256Digest(identity.checksum);
    identityIds.add(identity.identityId);
    if (identity.kind === 'team') teamIds.add(identity.identityId);
    if (identity.kind === 'deployment') {
      deploymentCount += 1;
      if (
        identity.identityId !== deploymentId ||
        identity.parentIdentityId !== null ||
        identity.state !== 'active'
      ) {
        throw new Error('durable-backup-deployment-identity-invalid');
      }
    }
  }
  if (deploymentCount !== 1) throw new Error('durable-backup-deployment-identity-count-invalid');
  for (const identity of inventory.identities as readonly BackupIdentityInventoryEntry[]) {
    if (
      (identity.kind === 'team' && identity.parentIdentityId !== deploymentId) ||
      (identity.kind === 'member' &&
        (identity.parentIdentityId === null || !teamIds.has(identity.parentIdentityId)))
    ) {
      throw new Error('durable-backup-identity-parent-invalid');
    }
  }
  const workspaceIds = new Set<string>();
  const registrationKeys = new Set<string>();
  for (const registration of inventory.workspaceRegistrations as readonly BackupWorkspaceRegistrationEntry[]) {
    requireExactKeys(registration, ['workspaceId', 'registrationKey', 'state']);
    if (
      (registration.state !== 'registered' && registration.state !== 'disabled') ||
      typeof registration.workspaceId !== 'string' ||
      workspaceIds.has(registration.workspaceId) ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(registration.registrationKey) ||
      registrationKeys.has(registration.registrationKey)
    ) {
      throw new Error('durable-backup-workspace-registration-invalid');
    }
    parseWorkspaceId(registration.workspaceId);
    workspaceIds.add(registration.workspaceId);
    registrationKeys.add(registration.registrationKey);
  }
}

function requireExactKeys(value: object, keys: readonly string[]): void {
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))
  ) {
    throw new Error('durable-backup-identity-surface-invalid');
  }
}

function identityKey(identity: BackupIdentityInventory['identities'][number]): string {
  return `${identity.kind}\0${identity.identityId}`;
}
