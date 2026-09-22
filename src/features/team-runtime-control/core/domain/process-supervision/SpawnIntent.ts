import {
  type OwnedProcessRef,
  parseOwnedProcessRef,
  parseProcessSupervisionSha256,
  parseSpawnNonce,
  type ProcessBinaryBinding,
  type ProcessOwnershipScope,
  type ProcessWorkspaceBinding,
  type SpawnNonce,
} from '../../../contracts/processSupervision';

import type { Sha256Hash } from '../../../contracts/runtimePlan';

export const SPAWN_INTENT_VERSION = 1 as const;
export const MAX_PROCESS_ARGV_COUNT = 256;
export const MAX_PROCESS_ARG_BYTES = 64 * 1_024;
export const MAX_PROCESS_ARGV_BYTES = 256 * 1_024;

export interface SpawnIntent {
  readonly intentVersion: typeof SPAWN_INTENT_VERSION;
  readonly scope: ProcessOwnershipScope;
  readonly processRef: OwnedProcessRef;
  readonly spawnNonce: SpawnNonce;
  readonly workspaceBinding: ProcessWorkspaceBinding;
  readonly binaryBinding: ProcessBinaryBinding;
  readonly argvDigest: Sha256Hash;
  readonly argvCount: number;
  /** Hashes only allowlisted variable metadata; never environment values. */
  readonly environmentPolicyDigest: Sha256Hash;
  /** Binds lane/member ordering without persisting relay credentials. */
  readonly relayScopeDigest: Sha256Hash;
}

export interface CreateSpawnIntentValue {
  readonly scope: ProcessOwnershipScope;
  readonly processRef: OwnedProcessRef;
  readonly spawnNonce: SpawnNonce;
  readonly workspaceBinding: ProcessWorkspaceBinding;
  readonly binaryBinding: ProcessBinaryBinding;
  readonly argv: readonly string[];
  readonly callerArgvDigest: Sha256Hash;
  readonly environmentPolicyDigest: Sha256Hash;
  readonly relayScopeDigest: Sha256Hash;
}

export class SpawnIntentValidationError extends TypeError {
  constructor(readonly reason: string) {
    super(`spawn-intent-invalid:${reason}`);
    this.name = 'SpawnIntentValidationError';
  }
}

export function createSpawnIntent(value: CreateSpawnIntentValue): SpawnIntent {
  const argvDigest = computeCanonicalArgvDigest(value.argv);
  let callerArgvDigest: Sha256Hash;
  try {
    callerArgvDigest = parseProcessSupervisionSha256(value.callerArgvDigest);
  } catch {
    throw new SpawnIntentValidationError('argv-digest-mismatch');
  }
  if (callerArgvDigest !== argvDigest) {
    throw new SpawnIntentValidationError('argv-digest-mismatch');
  }
  validateScope(value.scope);
  validateWorkspace(value.workspaceBinding);
  validateBinary(value.binaryBinding);
  const processRef = parseOwnedProcessRef(value.processRef);
  const spawnNonce = parseSpawnNonce(value.spawnNonce);

  return deepFreeze({
    intentVersion: SPAWN_INTENT_VERSION,
    scope: copyScope(value.scope),
    processRef,
    spawnNonce,
    workspaceBinding: {
      workspaceId: value.workspaceBinding.workspaceId,
      registrationRevision: value.workspaceBinding.registrationRevision,
      bindingGeneration: value.workspaceBinding.bindingGeneration,
      mountGeneration: value.workspaceBinding.mountGeneration,
    },
    binaryBinding: {
      policy: value.binaryBinding.policy,
      binaryId: value.binaryBinding.binaryId,
      binaryRevision: value.binaryBinding.binaryRevision,
      binaryHash: value.binaryBinding.binaryHash,
    },
    argvDigest,
    argvCount: value.argv.length,
    environmentPolicyDigest: parseProcessSupervisionSha256(value.environmentPolicyDigest),
    relayScopeDigest: parseProcessSupervisionSha256(value.relayScopeDigest),
  });
}

/**
 * sha256 over an unambiguous UTF-8 length-prefixed argv sequence.
 * The executable authority is deliberately separate from argv.
 */
export function computeCanonicalArgvDigest(argv: readonly string[]): Sha256Hash {
  if (!Array.isArray(argv) || argv.length > MAX_PROCESS_ARGV_COUNT) {
    throw new SpawnIntentValidationError('argv-count');
  }

  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [encoder.encode('agent-teams-argv-v1\u0000')];
  let byteCount = 0;
  for (const argument of argv) {
    if (
      typeof argument !== 'string' ||
      argument.includes('\u0000') ||
      hasUnpairedSurrogate(argument)
    ) {
      throw new SpawnIntentValidationError('argv-entry');
    }
    const bytes = encoder.encode(argument);
    if (bytes.byteLength > MAX_PROCESS_ARG_BYTES) {
      throw new SpawnIntentValidationError('argv-entry-too-large');
    }
    byteCount += bytes.byteLength;
    if (byteCount > MAX_PROCESS_ARGV_BYTES) {
      throw new SpawnIntentValidationError('argv-too-large');
    }
    parts.push(encoder.encode(`${bytes.byteLength}:`), bytes, encoder.encode(';'));
  }
  return `sha256:${sha256Hex(concatenate(parts))}`;
}

export function computeCanonicalPolicyDigest(value: unknown): Sha256Hash {
  const canonical = canonicalJson(value);
  return `sha256:${sha256Hex(new TextEncoder().encode(canonical))}`;
}

export function areSpawnIntentsExact(left: SpawnIntent, right: SpawnIntent): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

/**
 * Compares the durable launch binding independently of its random lookup key and nonce. A retry for
 * the same exact scope must retain the first durable identity instead of conflicting with newly
 * generated candidate IDs.
 */
export function areSpawnIntentBindingsExact(left: SpawnIntent, right: SpawnIntent): boolean {
  return (
    canonicalJson(spawnIntentBindingValue(left)) === canonicalJson(spawnIntentBindingValue(right))
  );
}

export function spawnNonceDigest(nonce: SpawnNonce): Sha256Hash {
  return computeCanonicalPolicyDigest({ spawnNonce: nonce });
}

function validateScope(scope: ProcessOwnershipScope): void {
  if (
    !scope?.planRef ||
    !Number.isSafeInteger(scope.planRef.generation) ||
    scope.planRef.generation < 1 ||
    typeof scope.executionUnitId !== 'string'
  ) {
    throw new SpawnIntentValidationError('scope');
  }
  parseProcessSupervisionSha256(scope.planRef.planHash);
}

function spawnIntentBindingValue(
  intent: SpawnIntent
): Omit<SpawnIntent, 'processRef' | 'spawnNonce'> {
  return {
    intentVersion: intent.intentVersion,
    scope: intent.scope,
    workspaceBinding: intent.workspaceBinding,
    binaryBinding: intent.binaryBinding,
    argvDigest: intent.argvDigest,
    argvCount: intent.argvCount,
    environmentPolicyDigest: intent.environmentPolicyDigest,
    relayScopeDigest: intent.relayScopeDigest,
  };
}

function validateWorkspace(workspace: ProcessWorkspaceBinding): void {
  if (
    !workspace ||
    typeof workspace.workspaceId !== 'string' ||
    !isPositiveInteger(workspace.registrationRevision) ||
    !isPositiveInteger(workspace.bindingGeneration) ||
    !isPositiveInteger(workspace.mountGeneration)
  ) {
    throw new SpawnIntentValidationError('workspace-binding');
  }
}

function validateBinary(binary: ProcessBinaryBinding): void {
  if (
    binary?.policy !== 'registered_exact_binary' ||
    typeof binary.binaryId !== 'string' ||
    !isPositiveInteger(binary.binaryRevision)
  ) {
    throw new SpawnIntentValidationError('binary-binding');
  }
  parseProcessSupervisionSha256(binary.binaryHash);
}

function copyScope(scope: ProcessOwnershipScope): ProcessOwnershipScope {
  return {
    planRef: {
      teamId: scope.planRef.teamId,
      runId: scope.planRef.runId,
      generation: scope.planRef.generation,
      planHash: scope.planRef.planHash,
    },
    executionUnitId: scope.executionUnitId,
  };
}

function isPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1;
}

function hasUnpairedSurrogate(value: string): boolean {
  let index = 0;
  while (index < value.length) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isFinite(next) || next < 0xdc00 || next > 0xdfff) return true;
      index += 2;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    } else {
      index += 1;
    }
  }
  return false;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new SpawnIntentValidationError('canonical-number');
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  throw new SpawnIntentValidationError('canonical-value');
}

function concatenate(parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

// Pure SHA-256 keeps the domain independent from Node and WebCrypto effects.
function sha256Hex(message: Uint8Array): string {
  const constants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const bitLength = message.byteLength * 8;
  const paddedLength = Math.ceil((message.byteLength + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(message);
  padded[message.byteLength] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);

  const hash = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const words = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4, false);
    }
    for (let index = 16; index < 64; index += 1) {
      const first = words[index - 15];
      const second = words[index - 2];
      const sigma0 = rotateRight(first, 7) ^ rotateRight(first, 18) ^ (first >>> 3);
      const sigma1 = rotateRight(second, 17) ^ rotateRight(second, 19) ^ (second >>> 10);
      words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const bigSigma1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temporary1 = (h + bigSigma1 + choose + constants[index] + words[index]) >>> 0;
      const bigSigma0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2 = (bigSigma0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }
    const next = [a, b, c, d, e, f, g, h];
    for (let index = 0; index < hash.length; index += 1) {
      hash[index] = (hash[index] + next[index]) >>> 0;
    }
  }
  return hash.map((word) => word.toString(16).padStart(8, '0')).join('');
}

function rotateRight(value: number, shift: number): number {
  return (value >>> shift) | (value << (32 - shift));
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
