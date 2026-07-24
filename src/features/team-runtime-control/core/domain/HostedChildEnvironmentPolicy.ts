import { parseRunId } from '@shared/contracts/hosted';

import {
  type CreateHostedChildEnvironmentPolicyResult,
  HOSTED_CHILD_ENVIRONMENT_CONTROLLER_ONLY_DENIAL,
  HOSTED_CHILD_ENVIRONMENT_NON_SECRET_AUTHORITIES,
  HOSTED_CHILD_ENVIRONMENT_NON_SECRET_PROVENANCE,
  type HostedChildEnvironmentIdentity,
  type HostedChildEnvironmentKeyProvenanceHash,
  type HostedChildEnvironmentPolicy,
  type HostedChildEnvironmentPolicyError,
  type HostedChildEnvironmentPolicyErrorCode,
  type HostedChildEnvironmentProviderDeclaration,
  type HostedChildEnvironmentVariable,
} from '../../contracts/hostedChildEnvironment';
import {
  type CredentialExposureSet,
  parseExecutionUnitId,
  parseLaneId,
  parseSecretClass,
  parseSecretRefId,
  type SecretRefMetadata,
} from '../../contracts/runtimePlan';

import type { TeamProviderId } from '@shared/types';

const PROVIDER_IDS = Object.freeze([
  'anthropic',
  'codex',
  'gemini',
  'opencode',
] as const satisfies readonly TeamProviderId[]);
const BACKENDS = Object.freeze(['provisioning_cli', 'opencode'] as const);
const ENVIRONMENT_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const MAX_ENVIRONMENT_VARIABLES = 256;
const MAX_SECRET_REFS = 256;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const NON_SECRET_AUTHORITY_BY_PROVENANCE = Object.freeze({
  provider_static: 'runtime-provider-management',
  runtime_metadata: 'team-runtime-control',
  workspace_metadata: 'workspace-registry',
} as const);

type ParseResult<T> =
  | { readonly status: 'parsed'; readonly value: T }
  | { readonly status: 'rejected'; readonly error: HostedChildEnvironmentPolicyError };

export function createHostedChildEnvironmentPolicy(
  input: unknown
): CreateHostedChildEnvironmentPolicyResult {
  try {
    return createHostedChildEnvironmentPolicyUnchecked(input);
  } catch {
    return reject('invalid_contract');
  }
}

function createHostedChildEnvironmentPolicyUnchecked(
  input: unknown
): CreateHostedChildEnvironmentPolicyResult {
  const parsed = parseCreationInput(input);
  if (parsed.status === 'rejected') return parsed;

  const { identity, providerDeclaration, requestedVariables, acceptedCredentialExposureSet } =
    parsed.value;
  if (
    identity.providerId !== providerDeclaration.providerId ||
    identity.backend !== providerDeclaration.backend
  ) {
    return reject('identity_mismatch');
  }

  const declarationKeyError = firstDuplicateVariableKey(providerDeclaration.variables);
  if (declarationKeyError) return reject('duplicate_key', declarationKeyError);
  const requestedKeyError = firstDuplicateVariableKey(requestedVariables);
  if (requestedKeyError) return reject('duplicate_key', requestedKeyError);

  const declarationRefError = firstDuplicateSecretRef(providerDeclaration.secretRefs);
  if (declarationRefError) return reject('duplicate_secret_ref');
  const exposureRefError = firstDuplicateSecretRef(acceptedCredentialExposureSet.secretRefs);
  if (exposureRefError) return reject('duplicate_secret_ref');

  const declaredRefs = new Set(providerDeclaration.secretRefs.map(secretRefKey));
  for (const variable of providerDeclaration.variables) {
    if (
      variable.provenance === 'secret_ref' &&
      !declaredRefs.has(secretRefKey(variable.secretRef))
    ) {
      return reject('secret_ref_not_declared', variable.name);
    }
  }
  for (const secretRef of acceptedCredentialExposureSet.secretRefs) {
    if (!declaredRefs.has(secretRefKey(secretRef))) {
      return reject('secret_ref_not_declared');
    }
  }

  const forbiddenDeclarationKey = firstForbiddenVariableKey(providerDeclaration.variables);
  if (forbiddenDeclarationKey) return reject('forbidden_key', forbiddenDeclarationKey);
  const forbiddenRequestedKey = firstForbiddenVariableKey(requestedVariables);
  if (forbiddenRequestedKey) return reject('forbidden_key', forbiddenRequestedKey);

  const declaredVariables = new Map(
    providerDeclaration.variables.map((variable) => [variable.name, variable] as const)
  );
  const acceptedRefs = new Set(acceptedCredentialExposureSet.secretRefs.map(secretRefKey));
  for (const variable of requestedVariables) {
    const declared = declaredVariables.get(variable.name);
    if (!declared || !sameVariableDeclaration(declared, variable)) {
      return reject('unknown_key', variable.name);
    }
    if (
      variable.provenance === 'secret_ref' &&
      !acceptedRefs.has(secretRefKey(variable.secretRef))
    ) {
      return reject('credential_exposure_widening', variable.name);
    }
  }

  const variables = Object.freeze([...requestedVariables].sort(compareVariables));
  const exposureSet = freezeCredentialExposureSet(acceptedCredentialExposureSet);
  const frozenIdentity = Object.freeze({ ...identity });
  const keyProvenanceHash = createKeyProvenanceHash(frozenIdentity, variables, exposureSet);
  const policy: HostedChildEnvironmentPolicy = {
    policy: 'explicit_allowlist',
    inheritance: 'none',
    identity: frozenIdentity,
    variables,
    acceptedCredentialExposureSet: exposureSet,
    keyProvenanceHash,
  };
  return Object.freeze({ status: 'accepted', policy: deepFreeze(policy) });
}

export function admitHostedChildEnvironmentPolicy(
  input: unknown
): CreateHostedChildEnvironmentPolicyResult {
  try {
    return admitHostedChildEnvironmentPolicyUnchecked(input);
  } catch {
    return reject('invalid_contract');
  }
}

function admitHostedChildEnvironmentPolicyUnchecked(
  input: unknown
): CreateHostedChildEnvironmentPolicyResult {
  if (
    !isExactRecord(input, [
      'acceptedCredentialExposureSet',
      'identity',
      'inheritance',
      'keyProvenanceHash',
      'policy',
      'variables',
    ]) ||
    input.policy !== 'explicit_allowlist' ||
    input.inheritance !== 'none' ||
    typeof input.keyProvenanceHash !== 'string' ||
    !SHA256_PATTERN.test(input.keyProvenanceHash)
  ) {
    return reject('invalid_contract');
  }
  if (!isDeepFrozen(input)) return reject('policy_not_immutable');

  const identity = parseIdentity(input.identity);
  if (identity.status === 'rejected') return identity;
  const variables = parseVariableArray(input.variables);
  if (variables.status === 'rejected') return variables;
  const exposureSet = parseCredentialExposureSet(input.acceptedCredentialExposureSet);
  if (exposureSet.status === 'rejected') return exposureSet;

  const reconstructed = createHostedChildEnvironmentPolicy({
    identity: identity.value,
    providerDeclaration: {
      providerId: identity.value.providerId,
      backend: identity.value.backend,
      secretRefs: exposureSet.value.secretRefs,
      variables: variables.value,
    },
    requestedVariables: variables.value,
    acceptedCredentialExposureSet: exposureSet.value,
    inheritance: 'none',
  });
  if (reconstructed.status === 'rejected') return reconstructed;
  if (reconstructed.policy.keyProvenanceHash !== input.keyProvenanceHash) {
    return reject('policy_hash_mismatch');
  }
  return Object.freeze({
    status: 'accepted',
    policy: input as unknown as HostedChildEnvironmentPolicy,
  });
}

export function validateHostedChildCredentialExposureSet(
  policy: HostedChildEnvironmentPolicy,
  candidate: unknown
):
  | { readonly status: 'accepted'; readonly exposureSet: CredentialExposureSet }
  | { readonly status: 'rejected'; readonly error: HostedChildEnvironmentPolicyError } {
  const parsed = parseCredentialExposureSet(candidate);
  if (parsed.status === 'rejected') return parsed;
  const expected = new Set(policy.acceptedCredentialExposureSet.secretRefs.map(secretRefKey));
  const actual = new Set(parsed.value.secretRefs.map(secretRefKey));
  for (const secretRef of actual) {
    if (!expected.has(secretRef)) return reject('credential_exposure_widening');
  }
  if (expected.size !== actual.size) return reject('credential_exposure_mismatch');
  return Object.freeze({
    status: 'accepted',
    exposureSet: freezeCredentialExposureSet(parsed.value),
  });
}

export function hostedChildEnvironmentIdentitiesEqual(
  left: HostedChildEnvironmentIdentity,
  right: HostedChildEnvironmentIdentity
): boolean {
  return (
    left.providerId === right.providerId &&
    left.backend === right.backend &&
    left.executionUnitId === right.executionUnitId &&
    left.laneId === right.laneId &&
    left.runId === right.runId
  );
}

function parseCreationInput(input: unknown): ParseResult<{
  readonly identity: HostedChildEnvironmentIdentity;
  readonly providerDeclaration: HostedChildEnvironmentProviderDeclaration;
  readonly requestedVariables: readonly HostedChildEnvironmentVariable[];
  readonly acceptedCredentialExposureSet: CredentialExposureSet;
}> {
  if (!isRecord(input)) return reject('invalid_contract');
  if (
    input.inheritance !== 'none' ||
    'processEnvironment' in input ||
    'shellEnvironment' in input ||
    'inheritedEnvironment' in input
  ) {
    return reject('environment_inheritance_forbidden');
  }
  if (
    !isExactRecord(input, [
      'acceptedCredentialExposureSet',
      'identity',
      'inheritance',
      'providerDeclaration',
      'requestedVariables',
    ])
  ) {
    return reject('invalid_contract');
  }

  const identity = parseIdentity(input.identity);
  if (identity.status === 'rejected') return identity;
  const providerDeclaration = parseProviderDeclaration(input.providerDeclaration);
  if (providerDeclaration.status === 'rejected') return providerDeclaration;
  const requestedVariables = parseVariableArray(input.requestedVariables);
  if (requestedVariables.status === 'rejected') return requestedVariables;
  const exposureSet = parseCredentialExposureSet(input.acceptedCredentialExposureSet);
  if (exposureSet.status === 'rejected') return exposureSet;
  return {
    status: 'parsed',
    value: {
      identity: identity.value,
      providerDeclaration: providerDeclaration.value,
      requestedVariables: requestedVariables.value,
      acceptedCredentialExposureSet: exposureSet.value,
    },
  };
}

function parseIdentity(input: unknown): ParseResult<HostedChildEnvironmentIdentity> {
  if (
    !isExactRecord(input, ['backend', 'executionUnitId', 'laneId', 'providerId', 'runId']) ||
    !PROVIDER_IDS.includes(input.providerId as TeamProviderId) ||
    !BACKENDS.includes(input.backend as (typeof BACKENDS)[number])
  ) {
    return reject('invalid_contract');
  }
  try {
    return {
      status: 'parsed',
      value: {
        providerId: input.providerId as TeamProviderId,
        backend: input.backend as (typeof BACKENDS)[number],
        executionUnitId: parseExecutionUnitId(input.executionUnitId),
        laneId: parseLaneId(input.laneId),
        runId: parseRunId(input.runId),
      },
    };
  } catch {
    return reject('invalid_contract');
  }
}

function parseProviderDeclaration(
  input: unknown
): ParseResult<HostedChildEnvironmentProviderDeclaration> {
  if (
    !isExactRecord(input, ['backend', 'providerId', 'secretRefs', 'variables']) ||
    !PROVIDER_IDS.includes(input.providerId as TeamProviderId) ||
    !BACKENDS.includes(input.backend as (typeof BACKENDS)[number])
  ) {
    return reject('invalid_contract');
  }
  const secretRefs = parseSecretRefArray(input.secretRefs);
  if (secretRefs.status === 'rejected') return secretRefs;
  const variables = parseVariableArray(input.variables);
  if (variables.status === 'rejected') return variables;
  return {
    status: 'parsed',
    value: {
      providerId: input.providerId as TeamProviderId,
      backend: input.backend as (typeof BACKENDS)[number],
      secretRefs: secretRefs.value,
      variables: variables.value,
    },
  };
}

function parseVariableArray(
  input: unknown
): ParseResult<readonly HostedChildEnvironmentVariable[]> {
  if (!isDenseArray(input) || input.length > MAX_ENVIRONMENT_VARIABLES) {
    return reject('invalid_contract');
  }
  const variables: HostedChildEnvironmentVariable[] = [];
  for (const candidate of input) {
    const parsed = parseVariable(candidate);
    if (parsed.status === 'rejected') return parsed;
    variables.push(parsed.value);
  }
  return { status: 'parsed', value: variables };
}

function parseVariable(input: unknown): ParseResult<HostedChildEnvironmentVariable> {
  if (!isRecord(input)) return reject('invalid_contract');
  const safeKey =
    typeof input.name === 'string' && ENVIRONMENT_KEY_PATTERN.test(input.name)
      ? input.name
      : undefined;
  if ('value' in input || 'resolvedValue' in input || 'secretValue' in input) {
    return reject('contract_secret_value_forbidden', safeKey);
  }
  if (input.provenance === 'secret_ref') {
    if (!isExactRecord(input, ['name', 'provenance', 'secretRef']) || !safeKey) {
      return reject('invalid_contract');
    }
    const secretRef = parseSecretRef(input.secretRef);
    if (secretRef.status === 'rejected') return secretRef;
    return {
      status: 'parsed',
      value: { name: safeKey, provenance: 'secret_ref', secretRef: secretRef.value },
    };
  }
  if (
    !isExactRecord(input, ['authority', 'name', 'provenance']) ||
    !safeKey ||
    !HOSTED_CHILD_ENVIRONMENT_NON_SECRET_PROVENANCE.includes(
      input.provenance as (typeof HOSTED_CHILD_ENVIRONMENT_NON_SECRET_PROVENANCE)[number]
    ) ||
    !HOSTED_CHILD_ENVIRONMENT_NON_SECRET_AUTHORITIES.includes(
      input.authority as (typeof HOSTED_CHILD_ENVIRONMENT_NON_SECRET_AUTHORITIES)[number]
    ) ||
    NON_SECRET_AUTHORITY_BY_PROVENANCE[
      input.provenance as keyof typeof NON_SECRET_AUTHORITY_BY_PROVENANCE
    ] !== input.authority
  ) {
    return reject('invalid_contract');
  }
  return {
    status: 'parsed',
    value: {
      name: safeKey,
      provenance:
        input.provenance as (typeof HOSTED_CHILD_ENVIRONMENT_NON_SECRET_PROVENANCE)[number],
      authority:
        input.authority as (typeof HOSTED_CHILD_ENVIRONMENT_NON_SECRET_AUTHORITIES)[number],
    },
  };
}

function parseCredentialExposureSet(input: unknown): ParseResult<CredentialExposureSet> {
  if (!isExactRecord(input, ['secretRefs'])) return reject('invalid_contract');
  const secretRefs = parseSecretRefArray(input.secretRefs);
  if (secretRefs.status === 'rejected') return secretRefs;
  if (firstDuplicateSecretRef(secretRefs.value)) return reject('duplicate_secret_ref');
  return { status: 'parsed', value: { secretRefs: secretRefs.value } };
}

function parseSecretRefArray(input: unknown): ParseResult<readonly SecretRefMetadata[]> {
  if (!isDenseArray(input) || input.length > MAX_SECRET_REFS) return reject('invalid_contract');
  const secretRefs: SecretRefMetadata[] = [];
  for (const candidate of input) {
    const parsed = parseSecretRef(candidate);
    if (parsed.status === 'rejected') return parsed;
    secretRefs.push(parsed.value);
  }
  return { status: 'parsed', value: secretRefs };
}

function parseSecretRef(input: unknown): ParseResult<SecretRefMetadata> {
  if (!isRecord(input)) return reject('invalid_contract');
  if ('value' in input || 'resolvedValue' in input || 'secretValue' in input) {
    return reject('contract_secret_value_forbidden');
  }
  if (!isExactRecord(input, ['secretClass', 'secretRefId'])) return reject('invalid_contract');
  try {
    return {
      status: 'parsed',
      value: {
        secretRefId: parseSecretRefId(input.secretRefId),
        secretClass: parseSecretClass(input.secretClass),
      },
    };
  } catch {
    return reject('invalid_contract');
  }
}

function sameVariableDeclaration(
  left: HostedChildEnvironmentVariable,
  right: HostedChildEnvironmentVariable
): boolean {
  if (left.provenance !== right.provenance) return false;
  if (left.provenance === 'secret_ref' && right.provenance === 'secret_ref') {
    return secretRefKey(left.secretRef) === secretRefKey(right.secretRef);
  }
  return (
    left.provenance !== 'secret_ref' &&
    right.provenance !== 'secret_ref' &&
    left.authority === right.authority
  );
}

function firstDuplicateVariableKey(
  variables: readonly HostedChildEnvironmentVariable[]
): string | undefined {
  const seen = new Set<string>();
  for (const variable of variables) {
    const normalized = variable.name.toUpperCase();
    if (seen.has(normalized)) return variable.name;
    seen.add(normalized);
  }
  return undefined;
}

function firstForbiddenVariableKey(
  variables: readonly HostedChildEnvironmentVariable[]
): string | undefined {
  for (const variable of variables) {
    const normalized = variable.name.toUpperCase();
    if (
      HOSTED_CHILD_ENVIRONMENT_CONTROLLER_ONLY_DENIAL.exactNames.some(
        (name) => normalized === name
      ) ||
      HOSTED_CHILD_ENVIRONMENT_CONTROLLER_ONLY_DENIAL.prefixes.some((prefix) =>
        normalized.startsWith(prefix)
      )
    ) {
      return variable.name;
    }
  }
  return undefined;
}

function firstDuplicateSecretRef(secretRefs: readonly SecretRefMetadata[]): boolean {
  const seenRefs = new Set<string>();
  for (const secretRef of secretRefs) {
    const key = secretRefKey(secretRef);
    if (seenRefs.has(key)) return true;
    seenRefs.add(key);
  }
  return false;
}

function secretRefKey(secretRef: SecretRefMetadata): string {
  return `${secretRef.secretRefId}\u0000${secretRef.secretClass}`;
}

function compareVariables(
  left: HostedChildEnvironmentVariable,
  right: HostedChildEnvironmentVariable
): number {
  return compareText(left.name, right.name);
}

function freezeCredentialExposureSet(exposureSet: CredentialExposureSet): CredentialExposureSet {
  return Object.freeze({
    secretRefs: Object.freeze(
      [...exposureSet.secretRefs]
        .sort((left, right) => compareText(secretRefKey(left), secretRefKey(right)))
        .map((secretRef) => Object.freeze({ ...secretRef }))
    ),
  });
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function createKeyProvenanceHash(
  identity: HostedChildEnvironmentIdentity,
  variables: readonly HostedChildEnvironmentVariable[],
  exposureSet: CredentialExposureSet
): HostedChildEnvironmentKeyProvenanceHash {
  const payload = {
    contract: 'hosted-child-environment-key-provenance/v1',
    identity,
    variables: variables.map((variable) =>
      variable.provenance === 'secret_ref'
        ? {
            name: variable.name,
            provenance: variable.provenance,
            secretRefId: variable.secretRef.secretRefId,
            secretClass: variable.secretRef.secretClass,
          }
        : {
            name: variable.name,
            provenance: variable.provenance,
            authority: variable.authority,
          }
    ),
    credentialExposure: exposureSet.secretRefs.map((secretRef) => ({
      secretRefId: secretRef.secretRefId,
      secretClass: secretRef.secretClass,
    })),
  };
  return `sha256:${sha256Hex(canonicalJson(payload))}` as HostedChildEnvironmentKeyProvenanceHash;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('hosted-child-environment-hash-invalid');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  throw new TypeError('hosted-child-environment-hash-invalid');
}

const SHA256_ROUND_CONSTANTS = Object.freeze([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const);

function rotateRight(value: number, amount: number): number {
  return (value >>> amount) | (value << (32 - amount));
}

function sha256Hex(input: string): string {
  const inputBytes = new TextEncoder().encode(input);
  const bitLength = inputBytes.length * 8;
  const paddedLength = Math.ceil((inputBytes.length + 9) / 64) * 64;
  const bytes = new Uint8Array(paddedLength);
  bytes.set(inputBytes);
  bytes[inputBytes.length] = 0x80;
  const view = new DataView(bytes.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);
  const hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index += 1) {
      const word15 = words[index - 15] ?? 0;
      const word2 = words[index - 2] ?? 0;
      const sigma0 = rotateRight(word15, 7) ^ rotateRight(word15, 18) ^ (word15 >>> 3);
      const sigma1 = rotateRight(word2, 17) ^ rotateRight(word2, 19) ^ (word2 >>> 10);
      words[index] = ((words[index - 16] ?? 0) + sigma0 + (words[index - 7] ?? 0) + sigma1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const upperSigma1 =
        rotateRight(e ?? 0, 6) ^ rotateRight(e ?? 0, 11) ^ rotateRight(e ?? 0, 25);
      const choice = ((e ?? 0) & (f ?? 0)) ^ (~(e ?? 0) & (g ?? 0));
      const temporary1 =
        ((h ?? 0) +
          upperSigma1 +
          choice +
          (SHA256_ROUND_CONSTANTS[index] ?? 0) +
          (words[index] ?? 0)) >>>
        0;
      const upperSigma0 =
        rotateRight(a ?? 0, 2) ^ rotateRight(a ?? 0, 13) ^ rotateRight(a ?? 0, 22);
      const majority = ((a ?? 0) & (b ?? 0)) ^ ((a ?? 0) & (c ?? 0)) ^ ((b ?? 0) & (c ?? 0));
      const temporary2 = (upperSigma0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = ((d ?? 0) + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }
    hash[0] = ((hash[0] ?? 0) + (a ?? 0)) >>> 0;
    hash[1] = ((hash[1] ?? 0) + (b ?? 0)) >>> 0;
    hash[2] = ((hash[2] ?? 0) + (c ?? 0)) >>> 0;
    hash[3] = ((hash[3] ?? 0) + (d ?? 0)) >>> 0;
    hash[4] = ((hash[4] ?? 0) + (e ?? 0)) >>> 0;
    hash[5] = ((hash[5] ?? 0) + (f ?? 0)) >>> 0;
    hash[6] = ((hash[6] ?? 0) + (g ?? 0)) >>> 0;
    hash[7] = ((hash[7] ?? 0) + (h ?? 0)) >>> 0;
  }
  return [...hash].map((word) => word.toString(16).padStart(8, '0')).join('');
}

function reject(
  code: HostedChildEnvironmentPolicyErrorCode,
  key?: string
): { readonly status: 'rejected'; readonly error: HostedChildEnvironmentPolicyError } {
  return Object.freeze({
    status: 'rejected',
    error: Object.freeze(key === undefined ? { code } : { code, key }),
  });
}

function isDenseArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value) && Object.keys(value).length === value.length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const actualKeys = Object.keys(value);
  return actualKeys.length === keys.length && actualKeys.every((key) => keys.includes(key));
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.isFrozen(value) ? value : Object.freeze(value);
}

function isDeepFrozen(value: unknown, seen = new WeakSet<object>()): boolean {
  if (typeof value !== 'object' || value === null) return true;
  if (seen.has(value)) return true;
  seen.add(value);
  return Object.isFrozen(value) && Object.values(value).every((child) => isDeepFrozen(child, seen));
}
