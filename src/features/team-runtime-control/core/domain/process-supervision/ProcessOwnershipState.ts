import {
  isExactProcessOwnerAttestation,
  isExactProcessOwnershipScope,
  isExactProcessWorkspaceBinding,
  parseProcessOwnerAttestation,
  type ProcessOwnerAttestation,
  type ProcessStopFence,
} from '../../../contracts/processSupervision';

import {
  PROCESS_OWNERSHIP_RECORD_VERSION,
  type ProcessDrainProof,
  type ProcessOwnershipReadyProof,
  type ProcessOwnershipRecord,
} from './ProcessOwnershipRecord';
import { areSpawnIntentsExact, type SpawnIntent, spawnNonceDigest } from './SpawnIntent';

export type ProcessOwnershipPhase =
  | 'spawn_intent'
  | 'owned'
  | 'stopping'
  | 'drained'
  | 'unclassified_residual';

interface ProcessOwnershipStateBase {
  readonly stateVersion: 1;
  readonly revision: number;
  readonly phase: ProcessOwnershipPhase;
  readonly intent: SpawnIntent;
}

export interface SpawnIntentState extends ProcessOwnershipStateBase {
  readonly phase: 'spawn_intent';
}

interface LiveProcessOwnershipStateBase extends ProcessOwnershipStateBase {
  readonly ownership: ProcessOwnershipRecord;
}

export interface OwnedProcessOwnershipState extends LiveProcessOwnershipStateBase {
  readonly phase: 'owned';
}

export interface StoppingProcessOwnershipState extends LiveProcessOwnershipStateBase {
  readonly phase: 'stopping';
}

export type LiveProcessOwnershipState = OwnedProcessOwnershipState | StoppingProcessOwnershipState;

export interface DrainedProcessOwnershipState extends ProcessOwnershipStateBase {
  readonly phase: 'drained';
  readonly ownership: ProcessOwnershipRecord;
  readonly terminalReason: string;
}

/** Fail-closed classification only; it never claims that the owned process has exited. */
export interface UnclassifiedProcessOwnershipState extends ProcessOwnershipStateBase {
  readonly phase: 'unclassified_residual';
  readonly ownership?: ProcessOwnershipRecord;
  readonly terminalReason: string;
}

export type TerminalProcessOwnershipState = DrainedProcessOwnershipState;

export type ProcessOwnershipState =
  | SpawnIntentState
  | LiveProcessOwnershipState
  | DrainedProcessOwnershipState
  | UnclassifiedProcessOwnershipState;

export type OwnershipTransitionResult =
  | { readonly status: 'accepted'; readonly next: ProcessOwnershipState }
  | {
      readonly status: 'rejected';
      readonly reason: 'invalid_phase' | 'ownership_mismatch' | 'protocol_order';
    };

export function initializeProcessOwnershipState(intent: SpawnIntent): SpawnIntentState {
  return Object.freeze({ stateVersion: 1, revision: 1, phase: 'spawn_intent', intent });
}

export function commitProcessOwnership(
  current: ProcessOwnershipState,
  proof: ProcessOwnershipReadyProof
): OwnershipTransitionResult {
  if (current.phase !== 'spawn_intent') return { status: 'rejected', reason: 'invalid_phase' };
  const intent = current.intent;
  let ownerAttestation: ProcessOwnerAttestation;
  try {
    ownerAttestation = parseProcessOwnerAttestation(proof.ownerAttestation);
  } catch {
    return { status: 'rejected', reason: 'ownership_mismatch' };
  }
  if (
    proof.statusSequence !== 1 ||
    proof.processRef !== intent.processRef ||
    !isExactProcessOwnershipScope(proof.scope, intent.scope) ||
    !isExactProcessWorkspaceBinding(proof.workspaceBinding, intent.workspaceBinding) ||
    proof.spawnNonceDigest !== spawnNonceDigest(intent.spawnNonce) ||
    ownerAttestation.processRef !== intent.processRef ||
    !isExactProcessOwnershipScope(ownerAttestation.scope, intent.scope) ||
    !isExactProcessWorkspaceBinding(ownerAttestation.workspaceBinding, intent.workspaceBinding) ||
    ownerAttestation.spawnNonceDigest !== proof.spawnNonceDigest
  ) {
    return { status: 'rejected', reason: 'ownership_mismatch' };
  }

  const ownership: ProcessOwnershipRecord = deepFreeze({
    recordVersion: PROCESS_OWNERSHIP_RECORD_VERSION,
    processRef: intent.processRef,
    scope: intent.scope,
    workspaceBinding: intent.workspaceBinding,
    spawnNonceDigest: proof.spawnNonceDigest,
    controllerInstanceId: proof.controllerInstanceId,
    ownerAttestation,
    mainProcessIdentityRef: proof.mainProcessIdentityRef,
    lastStatusSequence: proof.statusSequence,
  });
  return {
    status: 'accepted',
    next: deepFreeze({
      stateVersion: 1,
      revision: current.revision + 1,
      phase: 'owned',
      intent,
      ownership,
    }),
  };
}

export function beginOwnedProcessStop(
  current: ProcessOwnershipState,
  fence: ProcessStopFence
): OwnershipTransitionResult {
  if (!doesStateMatchStopFence(current, fence)) {
    return { status: 'rejected', reason: 'ownership_mismatch' };
  }
  if (current.phase !== 'owned') return { status: 'rejected', reason: 'invalid_phase' };
  return {
    status: 'accepted',
    next: deepFreeze({
      ...current,
      revision: current.revision + 1,
      phase: 'stopping',
    }),
  };
}

export function completeOwnedProcessStop(
  current: ProcessOwnershipState,
  proof: ProcessDrainProof
): OwnershipTransitionResult {
  if (current.phase !== 'stopping') return { status: 'rejected', reason: 'invalid_phase' };
  const ownership = current.ownership;
  let ownerAttestation: ProcessOwnerAttestation;
  try {
    ownerAttestation = parseProcessOwnerAttestation(proof.ownerAttestation);
  } catch {
    return { status: 'rejected', reason: 'ownership_mismatch' };
  }
  if (
    proof.processRef !== ownership.processRef ||
    !isExactProcessOwnershipScope(proof.scope, ownership.scope) ||
    proof.spawnNonceDigest !== ownership.spawnNonceDigest ||
    !isExactProcessOwnerAttestation(ownerAttestation, ownership.ownerAttestation) ||
    proof.ownedProcessEof?.observed !== true ||
    proof.ownedProcessEof.processRef !== ownership.processRef
  ) {
    return { status: 'rejected', reason: 'ownership_mismatch' };
  }
  let eofOwnerAttestation: ProcessOwnerAttestation;
  try {
    eofOwnerAttestation = parseProcessOwnerAttestation(proof.ownedProcessEof.ownerAttestation);
  } catch {
    return { status: 'rejected', reason: 'ownership_mismatch' };
  }
  if (!isExactProcessOwnerAttestation(eofOwnerAttestation, ownership.ownerAttestation)) {
    return { status: 'rejected', reason: 'ownership_mismatch' };
  }
  if (
    !Number.isSafeInteger(proof.statusSequence) ||
    proof.statusSequence <= ownership.lastStatusSequence
  ) {
    return { status: 'rejected', reason: 'protocol_order' };
  }
  if (proof.outcome === 'drained' && proof.residuals.length !== 0) {
    return { status: 'rejected', reason: 'ownership_mismatch' };
  }
  return {
    status: 'accepted',
    next: deepFreeze({
      stateVersion: 1,
      revision: current.revision + 1,
      phase: proof.outcome === 'drained' ? 'drained' : 'unclassified_residual',
      intent: current.intent,
      ownership: {
        ...ownership,
        lastStatusSequence: proof.statusSequence,
      },
      terminalReason:
        proof.outcome === 'drained' ? 'anchor-reported-drained' : 'anchor-reported-unclassified',
    }),
  };
}

export function markProcessOwnershipUnclassified(
  current: ProcessOwnershipState,
  reason: string
): UnclassifiedProcessOwnershipState {
  if (current.phase === 'unclassified_residual') return current;
  return deepFreeze({
    stateVersion: 1,
    revision: current.revision + 1,
    phase: 'unclassified_residual',
    intent: current.intent,
    ...('ownership' in current ? { ownership: current.ownership } : {}),
    terminalReason: reason,
  });
}

export function doesStateMatchStopFence(
  state: ProcessOwnershipState,
  fence: ProcessStopFence
): boolean {
  return (
    state.intent.processRef === fence.processRef &&
    isExactProcessOwnershipScope(state.intent.scope, fence)
  );
}

export function areOwnershipStatesEquivalent(
  left: ProcessOwnershipState,
  right: ProcessOwnershipState
): boolean {
  if (left.phase !== right.phase || left.revision !== right.revision) return false;
  if (!areSpawnIntentsExact(left.intent, right.intent)) return false;
  return canonicalStateValue(left) === canonicalStateValue(right);
}

function canonicalStateValue(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypeError('process-ownership-state-number-invalid');
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalStateValue).join(',')}]`;
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalStateValue(record[key])}`)
      .join(',')}}`;
  }
  throw new TypeError('process-ownership-state-value-invalid');
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
