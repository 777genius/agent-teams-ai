import type {
  BackupIdentityInventory,
  StateCompatibilityManifestRef,
} from '../../contracts/coordinationBackupContracts';
import type { CaptureBackupIdentityInventoryRequest } from '../../core/application';

/** Durable identity authority injected by the owning deployment and workspace features. */
export interface DurableIdentityInventorySource {
  captureDurableIdentityInventory(input: {
    readonly backupRunId: string;
    readonly deploymentId: string;
    readonly fenceGeneration: number;
    readonly coordinationBarrier: CaptureBackupIdentityInventoryRequest['barrier'];
  }): Promise<BackupIdentityInventory>;
}

/** Current state-compatibility authority captured at the coordination barrier. */
export interface DurableStateCompatibilityManifestSource {
  captureCurrent(input: {
    readonly backupRunId: string;
    readonly fenceGeneration: number;
  }): Promise<StateCompatibilityManifestRef>;
}
