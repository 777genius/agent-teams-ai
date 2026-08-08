import { parseRunId, parseTeamId, parseWorkspaceId } from '@shared/contracts/hosted';

import {
  isExactProcessOwnerAttestation,
  isExactProcessOwnershipScope,
  isExactProcessWorkspaceBinding,
  parseMainProcessIdentityRef,
  parseOwnedProcessRef,
  parseProcessControllerInstanceId,
  parseProcessOwnerAttestation,
  parseProcessSupervisionSha256,
  parseSpawnNonce,
  PROCESS_OWNER_ATTESTATION_VERSION,
  type ProcessOwnershipScope,
  type ProcessWorkspaceBinding,
} from '../../../../contracts/processSupervision';
import {
  type CompositeRuntimePlanHash,
  parseExecutionUnitId,
  parseRuntimeBinaryId,
} from '../../../../contracts/runtimePlan';
import {
  MAX_PROCESS_ARGV_COUNT,
  PROCESS_OWNERSHIP_RECORD_VERSION,
  type ProcessOwnershipRecord,
  type ProcessOwnershipState,
  SPAWN_INTENT_VERSION,
  type SpawnIntent,
  spawnNonceDigest,
} from '../../../../core/domain/process-supervision';

export const PROCESS_OWNERSHIP_STATE_CODEC_VERSION = 1 as const;
const MAX_ENCODED_STATE_BYTES = 64 * 1_024;

export class ProcessOwnershipStateCodecError extends TypeError {
  constructor(readonly reason: string) {
    super(`process-ownership-state-codec-invalid:${reason}`);
    this.name = 'ProcessOwnershipStateCodecError';
  }
}

/** Encodes one validated state into a deterministic, explicitly versioned JSON envelope. */
export function encodeProcessOwnershipState(state: ProcessOwnershipState): string {
  let encoded: string;
  try {
    encoded = canonicalJson({
      codecVersion: PROCESS_OWNERSHIP_STATE_CODEC_VERSION,
      state,
    });
  } catch {
    throw new ProcessOwnershipStateCodecError('value');
  }
  if (new TextEncoder().encode(encoded).byteLength > MAX_ENCODED_STATE_BYTES) {
    throw new ProcessOwnershipStateCodecError('size');
  }
  // Encoding is an admission boundary too: structurally forged states never reach SQLite.
  decodeProcessOwnershipState(encoded);
  return encoded;
}

/**
 * Decodes only the current exact envelope. Callers must map every thrown error to unavailable;
 * unknown or malformed durable bytes never mean that an ownership record is missing.
 */
export function decodeProcessOwnershipState(encoded: string): ProcessOwnershipState {
  if (
    typeof encoded !== 'string' ||
    new TextEncoder().encode(encoded).byteLength > MAX_ENCODED_STATE_BYTES
  ) {
    throw new ProcessOwnershipStateCodecError('size');
  }
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch {
    throw new ProcessOwnershipStateCodecError('json');
  }
  try {
    if (canonicalJson(value) !== encoded) {
      throw new ProcessOwnershipStateCodecError('canonical');
    }
  } catch (error) {
    if (error instanceof ProcessOwnershipStateCodecError) throw error;
    throw new ProcessOwnershipStateCodecError('value');
  }
  const envelope = exactRecord(value, ['codecVersion', 'state'], 'envelope');
  if (envelope.codecVersion !== PROCESS_OWNERSHIP_STATE_CODEC_VERSION) {
    throw new ProcessOwnershipStateCodecError('version');
  }
  return deepFreeze(parseState(envelope.state));
}

function parseState(value: unknown): ProcessOwnershipState {
  const base = plainRecord(value, 'state');
  if (base.stateVersion !== 1) throw new ProcessOwnershipStateCodecError('state-version');
  const revision = positiveInteger(base.revision, 'revision');
  const phase = base.phase;
  const keys =
    phase === 'spawn_intent'
      ? ['stateVersion', 'revision', 'phase', 'intent']
      : phase === 'owned' || phase === 'stopping'
        ? ['stateVersion', 'revision', 'phase', 'intent', 'ownership']
        : phase === 'drained'
          ? ['stateVersion', 'revision', 'phase', 'intent', 'ownership', 'terminalReason']
          : phase === 'unclassified_residual'
            ? [
                'stateVersion',
                'revision',
                'phase',
                'intent',
                ...(Object.hasOwn(base, 'ownership') ? ['ownership'] : []),
                'terminalReason',
              ]
            : null;
  if (!keys) throw new ProcessOwnershipStateCodecError('phase');
  exactRecord(base, keys, 'state');

  const intent = parseIntent(base.intent);
  if (phase === 'spawn_intent') {
    if (revision !== 1) throw new ProcessOwnershipStateCodecError('spawn-revision');
    return { stateVersion: 1, revision, phase, intent };
  }

  const ownership =
    base.ownership === undefined ? undefined : parseOwnership(base.ownership, intent);
  if (phase === 'owned' || phase === 'stopping') {
    if (!ownership) throw new ProcessOwnershipStateCodecError('ownership');
    if (revision < (phase === 'owned' ? 2 : 3)) {
      throw new ProcessOwnershipStateCodecError('phase-revision');
    }
    return { stateVersion: 1, revision, phase, intent, ownership };
  }

  const terminalReason = parseTerminalReason(base.terminalReason);
  if (phase === 'drained') {
    if (!ownership) throw new ProcessOwnershipStateCodecError('ownership');
    if (revision < 4) throw new ProcessOwnershipStateCodecError('phase-revision');
    return { stateVersion: 1, revision, phase, intent, ownership, terminalReason };
  }
  if (revision < 2) throw new ProcessOwnershipStateCodecError('phase-revision');
  return {
    stateVersion: 1,
    revision,
    phase: 'unclassified_residual',
    intent,
    ...(ownership ? { ownership } : {}),
    terminalReason,
  };
}

function parseIntent(value: unknown): SpawnIntent {
  const record = exactRecord(
    value,
    [
      'intentVersion',
      'scope',
      'processRef',
      'spawnNonce',
      'workspaceBinding',
      'binaryBinding',
      'argvDigest',
      'argvCount',
      'environmentPolicyDigest',
      'relayScopeDigest',
    ],
    'intent'
  );
  if (record.intentVersion !== SPAWN_INTENT_VERSION) {
    throw new ProcessOwnershipStateCodecError('intent-version');
  }
  const argvCount = nonNegativeInteger(record.argvCount, 'argv-count');
  if (argvCount > MAX_PROCESS_ARGV_COUNT) throw new ProcessOwnershipStateCodecError('argv-count');
  const binary = exactRecord(
    record.binaryBinding,
    ['policy', 'binaryId', 'binaryRevision', 'binaryHash'],
    'binary'
  );
  if (binary.policy !== 'registered_exact_binary') {
    throw new ProcessOwnershipStateCodecError('binary-policy');
  }
  return {
    intentVersion: SPAWN_INTENT_VERSION,
    scope: parseScope(record.scope),
    processRef: parseOwnedProcessRef(record.processRef),
    spawnNonce: parseSpawnNonce(record.spawnNonce),
    workspaceBinding: parseWorkspaceBinding(record.workspaceBinding),
    binaryBinding: {
      policy: 'registered_exact_binary',
      binaryId: parseRuntimeBinaryId(binary.binaryId),
      binaryRevision: positiveInteger(binary.binaryRevision, 'binary-revision'),
      binaryHash: parseProcessSupervisionSha256(binary.binaryHash),
    },
    argvDigest: parseProcessSupervisionSha256(record.argvDigest),
    argvCount,
    environmentPolicyDigest: parseProcessSupervisionSha256(record.environmentPolicyDigest),
    relayScopeDigest: parseProcessSupervisionSha256(record.relayScopeDigest),
  };
}

function parseOwnership(value: unknown, intent: SpawnIntent): ProcessOwnershipRecord {
  const record = exactRecord(
    value,
    [
      'recordVersion',
      'processRef',
      'scope',
      'workspaceBinding',
      'spawnNonceDigest',
      'controllerInstanceId',
      'ownerAttestation',
      'mainProcessIdentityRef',
      'lastStatusSequence',
    ],
    'ownership'
  );
  if (record.recordVersion !== PROCESS_OWNERSHIP_RECORD_VERSION) {
    throw new ProcessOwnershipStateCodecError('record-version');
  }
  const ownership: ProcessOwnershipRecord = {
    recordVersion: PROCESS_OWNERSHIP_RECORD_VERSION,
    processRef: parseOwnedProcessRef(record.processRef),
    scope: parseScope(record.scope),
    workspaceBinding: parseWorkspaceBinding(record.workspaceBinding),
    spawnNonceDigest: parseProcessSupervisionSha256(record.spawnNonceDigest),
    controllerInstanceId: parseProcessControllerInstanceId(record.controllerInstanceId),
    ownerAttestation: parseProcessOwnerAttestation(record.ownerAttestation),
    mainProcessIdentityRef: parseMainProcessIdentityRef(record.mainProcessIdentityRef),
    lastStatusSequence: positiveInteger(record.lastStatusSequence, 'status-sequence'),
  };
  if (
    ownership.processRef !== intent.processRef ||
    !isExactProcessOwnershipScope(ownership.scope, intent.scope) ||
    !isExactProcessWorkspaceBinding(ownership.workspaceBinding, intent.workspaceBinding) ||
    ownership.spawnNonceDigest !== spawnNonceDigest(intent.spawnNonce) ||
    ownership.ownerAttestation.attestationVersion !== PROCESS_OWNER_ATTESTATION_VERSION ||
    !isExactProcessOwnerAttestation(ownership.ownerAttestation, {
      ...ownership.ownerAttestation,
      processRef: intent.processRef,
      scope: intent.scope,
      workspaceBinding: intent.workspaceBinding,
      spawnNonceDigest: ownership.spawnNonceDigest,
    })
  ) {
    throw new ProcessOwnershipStateCodecError('ownership-binding');
  }
  return ownership;
}

function parseScope(value: unknown): ProcessOwnershipScope {
  const scope = exactRecord(value, ['planRef', 'executionUnitId'], 'scope');
  const plan = exactRecord(
    scope.planRef,
    ['teamId', 'runId', 'generation', 'planHash'],
    'plan-ref'
  );
  return {
    planRef: {
      teamId: parseTeamId(plan.teamId),
      runId: parseRunId(plan.runId),
      generation: positiveInteger(plan.generation, 'plan-generation'),
      planHash: parseProcessSupervisionSha256(plan.planHash) as CompositeRuntimePlanHash,
    },
    executionUnitId: parseExecutionUnitId(scope.executionUnitId),
  };
}

function parseWorkspaceBinding(value: unknown): ProcessWorkspaceBinding {
  const record = exactRecord(
    value,
    ['workspaceId', 'registrationRevision', 'bindingGeneration', 'mountGeneration'],
    'workspace'
  );
  return {
    workspaceId: parseWorkspaceId(record.workspaceId),
    registrationRevision: positiveInteger(record.registrationRevision, 'registration-revision'),
    bindingGeneration: positiveInteger(record.bindingGeneration, 'binding-generation'),
    mountGeneration: positiveInteger(record.mountGeneration, 'mount-generation'),
  };
}

function parseTerminalReason(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
    throw new ProcessOwnershipStateCodecError('terminal-reason');
  }
  let separator = true;
  for (const character of value) {
    if (character === '-') {
      if (separator) throw new ProcessOwnershipStateCodecError('terminal-reason');
      separator = true;
      continue;
    }
    const code = character.charCodeAt(0);
    if (!((code >= 97 && code <= 122) || (code >= 48 && code <= 57))) {
      throw new ProcessOwnershipStateCodecError('terminal-reason');
    }
    separator = false;
  }
  if (separator) throw new ProcessOwnershipStateCodecError('terminal-reason');
  return value;
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  reason: string
): Record<string, unknown> {
  const record = plainRecord(value, reason);
  const actual = Reflect.ownKeys(record);
  const expected = [...keys].sort((left, right) => left.localeCompare(right));
  if (
    actual.some((key) => typeof key !== 'string') ||
    actual.length !== keys.length ||
    [...(actual as string[])]
      .sort((left, right) => left.localeCompare(right))
      .some((key, index) => key !== expected[index])
  ) {
    throw new ProcessOwnershipStateCodecError(`${reason}-fields`);
  }
  return record;
}

function plainRecord(value: unknown, reason: string): Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new ProcessOwnershipStateCodecError(reason);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Object.values(descriptors).some(
      (descriptor) => !descriptor.enumerable || !('value' in descriptor)
    )
  ) {
    throw new ProcessOwnershipStateCodecError(`${reason}-descriptor`);
  }
  return value as Record<string, unknown>;
}

function positiveInteger(value: unknown, reason: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new ProcessOwnershipStateCodecError(reason);
  }
  return value;
}

function nonNegativeInteger(value: unknown, reason: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ProcessOwnershipStateCodecError(reason);
  }
  return value;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new ProcessOwnershipStateCodecError('number');
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = plainRecord(value, 'canonical-value');
  return `{${Object.keys(record)
    .sort((left, right) => left.localeCompare(right))
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
