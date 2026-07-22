import type {
  MainProcessIdentityRef,
  ProcessControllerInstanceId,
  ProcessOwnerAttestation,
  ProcessWorkspaceBinding,
} from '../../../contracts/processSupervision';
import type { Sha256Hash } from '../../../contracts/runtimePlan';
import type { SpawnIntent } from './SpawnIntent';

export const PROCESS_OWNERSHIP_RECORD_VERSION = 1 as const;

export interface ProcessOwnershipReadyProof {
  readonly processRef: SpawnIntent['processRef'];
  readonly scope: SpawnIntent['scope'];
  readonly workspaceBinding: ProcessWorkspaceBinding;
  readonly spawnNonceDigest: Sha256Hash;
  readonly controllerInstanceId: ProcessControllerInstanceId;
  readonly ownerAttestation: ProcessOwnerAttestation;
  readonly mainProcessIdentityRef: MainProcessIdentityRef;
  readonly statusSequence: 1;
}

export interface ProcessOwnershipRecord {
  readonly recordVersion: typeof PROCESS_OWNERSHIP_RECORD_VERSION;
  readonly processRef: SpawnIntent['processRef'];
  readonly scope: SpawnIntent['scope'];
  readonly workspaceBinding: ProcessWorkspaceBinding;
  readonly spawnNonceDigest: Sha256Hash;
  /** A boot-local fence. A replacement controller may not adopt this channel. */
  readonly controllerInstanceId: ProcessControllerInstanceId;
  readonly ownerAttestation: ProcessOwnerAttestation;
  readonly mainProcessIdentityRef: MainProcessIdentityRef;
  readonly lastStatusSequence: number;
}

/** Stable-handle EOF observation for the exact immutable spawn-owner attestation. */
export interface OwnedProcessEofProof {
  readonly processRef: SpawnIntent['processRef'];
  readonly ownerAttestation: ProcessOwnerAttestation;
  readonly observed: true;
}

export interface ProcessDrainProof {
  readonly processRef: SpawnIntent['processRef'];
  readonly scope: SpawnIntent['scope'];
  readonly spawnNonceDigest: Sha256Hash;
  readonly ownerAttestation: ProcessOwnerAttestation;
  readonly ownedProcessEof: OwnedProcessEofProof;
  readonly statusSequence: number;
  readonly outcome: 'drained' | 'unclassified';
  readonly residuals: readonly string[];
}
