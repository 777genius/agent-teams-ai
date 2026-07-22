import {
  type AnchorChannelRef,
  isExactProcessOwnerAttestation,
  isExactProcessOwnershipScope,
  isExactProcessWorkspaceBinding,
  parseProcessOwnerAttestation,
  PROCESS_SUPERVISION_PROTOCOL_VERSION,
  type ProcessControllerInstanceId,
  type ProcessOwnerAttestation,
} from '../../../../contracts/processSupervision';
import {
  type OwnedProcessEofProof,
  type ProcessDrainProof,
  type ProcessOwnershipReadyProof,
  type ProcessOwnershipRecord,
  type SpawnIntent,
  spawnNonceDigest,
} from '../../../../core/domain/process-supervision';

import type {
  AnchorDrainedStatusFrame,
  AnchorReadyStatusFrame,
  AnchorStopControlFrame,
  AnchorUnclassifiedStatusFrame,
} from '../../../infrastructure/process-supervision';

export function mapAnchorReadyProof(
  intent: SpawnIntent,
  controllerInstanceId: ProcessControllerInstanceId,
  channelRef: AnchorChannelRef,
  ownerAttestationValue: unknown,
  frame: AnchorReadyStatusFrame
): ProcessOwnershipReadyProof | null {
  let ownerAttestation: ProcessOwnerAttestation;
  try {
    ownerAttestation = parseProcessOwnerAttestation(ownerAttestationValue);
  } catch {
    return null;
  }
  if (
    frame.protocolVersion !== PROCESS_SUPERVISION_PROTOCOL_VERSION ||
    frame.sequence !== 1 ||
    frame.processRef !== intent.processRef ||
    frame.channelRef !== channelRef ||
    !isExactProcessOwnershipScope(frame, intent.scope) ||
    !isExactProcessWorkspaceBinding(frame.workspaceBinding, intent.workspaceBinding) ||
    frame.spawnNonceDigest !== spawnNonceDigest(intent.spawnNonce) ||
    ownerAttestation.processRef !== intent.processRef ||
    !isExactProcessOwnershipScope(ownerAttestation.scope, intent.scope) ||
    !isExactProcessWorkspaceBinding(ownerAttestation.workspaceBinding, intent.workspaceBinding) ||
    ownerAttestation.spawnNonceDigest !== frame.spawnNonceDigest ||
    ownerAttestation.channelRef !== channelRef ||
    ownerAttestation.anchorIdentityRef !== frame.anchorIdentityRef
  ) {
    return null;
  }
  return Object.freeze({
    processRef: intent.processRef,
    scope: intent.scope,
    workspaceBinding: intent.workspaceBinding,
    spawnNonceDigest: frame.spawnNonceDigest,
    controllerInstanceId,
    ownerAttestation,
    mainProcessIdentityRef: frame.mainProcessIdentityRef,
    statusSequence: 1,
  });
}

export function createAnchorStopControlFrame(
  ownership: ProcessOwnershipRecord,
  mode: 'graceful' | 'immediate',
  graceMs: number
): AnchorStopControlFrame {
  return Object.freeze({
    protocolVersion: PROCESS_SUPERVISION_PROTOCOL_VERSION,
    type: 'stop',
    sequence: 1,
    processRef: ownership.processRef,
    planRef: ownership.scope.planRef,
    executionUnitId: ownership.scope.executionUnitId,
    mode,
    graceMs: mode === 'immediate' ? 0 : graceMs,
  });
}

export function mapAnchorDrainProof(
  ownership: ProcessOwnershipRecord,
  frame: AnchorDrainedStatusFrame | AnchorUnclassifiedStatusFrame,
  ownedProcessEof: OwnedProcessEofProof
): ProcessDrainProof | null {
  if (!ownedProcessEof || typeof ownedProcessEof !== 'object') return null;
  let eofOwnerAttestation: ProcessOwnerAttestation;
  try {
    eofOwnerAttestation = parseProcessOwnerAttestation(ownedProcessEof.ownerAttestation);
  } catch {
    return null;
  }
  if (
    frame.processRef !== ownership.processRef ||
    !isExactProcessOwnershipScope(frame, ownership.scope) ||
    frame.spawnNonceDigest !== ownership.spawnNonceDigest ||
    frame.channelRef !== ownership.ownerAttestation.channelRef ||
    frame.sequence <= ownership.lastStatusSequence ||
    ownedProcessEof.observed !== true ||
    ownedProcessEof.processRef !== ownership.processRef ||
    !isExactProcessOwnerAttestation(eofOwnerAttestation, ownership.ownerAttestation)
  ) {
    return null;
  }
  return Object.freeze({
    processRef: ownership.processRef,
    scope: ownership.scope,
    spawnNonceDigest: ownership.spawnNonceDigest,
    ownerAttestation: ownership.ownerAttestation,
    ownedProcessEof: Object.freeze({
      processRef: ownership.processRef,
      ownerAttestation: eofOwnerAttestation,
      observed: true,
    }),
    statusSequence: frame.sequence,
    outcome: frame.type === 'drained' ? 'drained' : 'unclassified',
    residuals: frame.residuals,
  });
}
