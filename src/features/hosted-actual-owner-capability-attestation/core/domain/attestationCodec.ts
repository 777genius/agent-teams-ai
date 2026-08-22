import {
  HOSTED_ACTUAL_OWNER_CAPABILITY_ATTESTATION_ALGORITHM,
  HOSTED_ACTUAL_OWNER_CAPABILITY_ATTESTATION_AUDIENCE,
  HOSTED_ACTUAL_OWNER_CAPABILITY_ATTESTATION_DOMAIN,
  HOSTED_ACTUAL_OWNER_CAPABILITY_ATTESTATION_ISSUER,
  HOSTED_ACTUAL_OWNER_CAPABILITY_ATTESTATION_MAX_BYTES,
  HOSTED_ACTUAL_OWNER_CAPABILITY_ATTESTATION_MAX_LIFETIME_MS,
  HOSTED_ACTUAL_OWNER_CAPABILITY_ATTESTATION_PURPOSE,
  HOSTED_ACTUAL_OWNER_CAPABILITY_ATTESTATION_SCHEMA_VERSION,
  HOSTED_ACTUAL_OWNER_FROZEN_TRANSITION_SHA256,
  type HostedActualOwnerExternalWriterCapabilityAttestation,
  type HostedActualOwnerExternalWriterCapabilityAttestationSubject,
  type HostedActualOwnerExternalWriterCapabilityAttestationUnsigned,
  type HostedActualOwnerSocketIdentity,
} from '../../contracts';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const HEX_SHA256 = /^[0-9a-f]{64}$/u;
const GIT_COMMIT = /^(?!0{40}$)[0-9a-f]{40}$/u;
const RUN_ID = /^[0-9a-f]{48}$/u;
const TEAM_ID = /^team_[0-9a-f]{32}$/u;
const SESSION_ID = /^session_[A-Za-z0-9._:-]{1,191}$/u;
const DECIMAL = /^(?:0|[1-9][0-9]{0,31})$/u;
const BASE64URL_32 = /^[A-Za-z0-9_-]{43}$/u;
const BASE64URL_64 = /^[A-Za-z0-9_-]{86}$/u;

const TOP_LEVEL_KEYS = Object.freeze([
  'schemaVersion',
  'purpose',
  'issuer',
  'keyId',
  'algorithm',
  'subject',
  'audience',
  'issuedAtMs',
  'notBeforeMs',
  'expiresAtMs',
  'nonce',
  'capability',
] as const);
const SUBJECT_KEYS = Object.freeze([
  'runId',
  'teamId',
  'sessionId',
  'productPid',
  'productCommit',
  'orchestratorCommit',
  'openCodeCommit',
  'productExecutableSha256',
  'sourceClosureSha256',
  'buildProvenanceSha256',
  'ownerContractSha256',
  'frozenTransitionSha256',
  'manifestSha256',
  'driverSocketIdentity',
  'productSocketIdentity',
  'routeDigest',
  'captureDigest',
] as const);
const SOCKET_KEYS = Object.freeze(['device', 'inode'] as const);
const CAPABILITY_KEYS = Object.freeze(['name', 'descriptorDelivery'] as const);

export class HostedActualOwnerCapabilityAttestationValidationError extends Error {
  constructor(readonly code: string) {
    super(`hosted_actual_owner_capability_attestation_${code}`);
    this.name = 'HostedActualOwnerCapabilityAttestationValidationError';
  }
}

function fail(code: string): never {
  throw new HostedActualOwnerCapabilityAttestationValidationError(code);
}

function record(value: unknown, code: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(code);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], code: string): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) fail(code);
}

function safeInteger(value: unknown, positive: boolean, code: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    Object.is(value, -0) ||
    value < (positive ? 1 : 0) ||
    value > MAX_SAFE_INTEGER
  ) {
    fail(code);
  }
  return value;
}

function stringMatching(value: unknown, pattern: RegExp, code: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) fail(code);
  return value;
}

function socketIdentity(value: unknown, code: string): HostedActualOwnerSocketIdentity {
  const input = record(value, code);
  exactKeys(input, SOCKET_KEYS, `${code}_keys`);
  return Object.freeze({
    device: stringMatching(input.device, DECIMAL, `${code}_device`),
    inode: stringMatching(input.inode, DECIMAL, `${code}_inode`),
  });
}

function validateBase64Url32(value: unknown, code: string): string {
  const encoded = stringMatching(value, BASE64URL_32, code);
  // Thirty-two bytes leave four significant bits in the final base64url character.
  if (!/[AEIMQUYcgkosw048]$/u.test(encoded)) fail(code);
  return encoded;
}

function validateBase64Url64(value: unknown, code: string): string {
  const encoded = stringMatching(value, BASE64URL_64, code);
  // Sixty-four bytes leave two significant bits in the final base64url character.
  if (!/[AQgw]$/u.test(encoded)) fail(code);
  return encoded;
}

export function validateHostedActualOwnerCapabilityAttestationSubject(
  value: unknown
): HostedActualOwnerExternalWriterCapabilityAttestationSubject {
  const input = record(value, 'subject_type');
  exactKeys(input, SUBJECT_KEYS, 'subject_keys');
  if (
    stringMatching(
      input.frozenTransitionSha256,
      HEX_SHA256,
      'subject_frozen_transition_sha256'
    ) !== HOSTED_ACTUAL_OWNER_FROZEN_TRANSITION_SHA256
  ) {
    fail('subject_frozen_transition_identity');
  }
  const subject = Object.freeze({
    runId: stringMatching(input.runId, RUN_ID, 'subject_run_id'),
    teamId: stringMatching(input.teamId, TEAM_ID, 'subject_team_id'),
    sessionId: stringMatching(input.sessionId, SESSION_ID, 'subject_session_id'),
    productPid: safeInteger(input.productPid, true, 'subject_product_pid'),
    productCommit: stringMatching(input.productCommit, GIT_COMMIT, 'subject_product_commit'),
    orchestratorCommit: stringMatching(
      input.orchestratorCommit,
      GIT_COMMIT,
      'subject_orchestrator_commit'
    ),
    openCodeCommit: stringMatching(input.openCodeCommit, GIT_COMMIT, 'subject_opencode_commit'),
    productExecutableSha256: stringMatching(
      input.productExecutableSha256,
      HEX_SHA256,
      'subject_product_executable_sha256'
    ),
    sourceClosureSha256: stringMatching(
      input.sourceClosureSha256,
      HEX_SHA256,
      'subject_source_closure_sha256'
    ),
    buildProvenanceSha256: stringMatching(
      input.buildProvenanceSha256,
      HEX_SHA256,
      'subject_build_provenance_sha256'
    ),
    ownerContractSha256: stringMatching(
      input.ownerContractSha256,
      HEX_SHA256,
      'subject_owner_contract_sha256'
    ),
    frozenTransitionSha256: HOSTED_ACTUAL_OWNER_FROZEN_TRANSITION_SHA256,
    manifestSha256: stringMatching(input.manifestSha256, HEX_SHA256, 'subject_manifest_sha256'),
    driverSocketIdentity: socketIdentity(input.driverSocketIdentity, 'subject_driver_socket'),
    productSocketIdentity: socketIdentity(input.productSocketIdentity, 'subject_product_socket'),
    routeDigest: stringMatching(input.routeDigest, HEX_SHA256, 'subject_route_digest'),
    captureDigest: stringMatching(input.captureDigest, HEX_SHA256, 'subject_capture_digest'),
  });
  if (subject.sessionId !== `session_${subject.runId}`) fail('subject_session_identity');
  if (
    subject.driverSocketIdentity.device === subject.productSocketIdentity.device &&
    subject.driverSocketIdentity.inode === subject.productSocketIdentity.inode
  ) {
    fail('subject_socket_identity_collision');
  }
  return subject;
}

export function validateHostedActualOwnerCapabilityAttestationUnsigned(
  value: unknown
): HostedActualOwnerExternalWriterCapabilityAttestationUnsigned {
  const input = record(value, 'type');
  exactKeys(input, TOP_LEVEL_KEYS, 'keys');
  if (
    input.schemaVersion !== HOSTED_ACTUAL_OWNER_CAPABILITY_ATTESTATION_SCHEMA_VERSION ||
    input.purpose !== HOSTED_ACTUAL_OWNER_CAPABILITY_ATTESTATION_PURPOSE ||
    input.issuer !== HOSTED_ACTUAL_OWNER_CAPABILITY_ATTESTATION_ISSUER ||
    input.algorithm !== HOSTED_ACTUAL_OWNER_CAPABILITY_ATTESTATION_ALGORITHM ||
    input.audience !== HOSTED_ACTUAL_OWNER_CAPABILITY_ATTESTATION_AUDIENCE
  ) {
    fail('literal');
  }
  const issuedAtMs = safeInteger(input.issuedAtMs, false, 'issued_at');
  const notBeforeMs = safeInteger(input.notBeforeMs, false, 'not_before');
  const expiresAtMs = safeInteger(input.expiresAtMs, false, 'expires_at');
  if (
    notBeforeMs < issuedAtMs ||
    expiresAtMs <= notBeforeMs ||
    expiresAtMs - issuedAtMs > HOSTED_ACTUAL_OWNER_CAPABILITY_ATTESTATION_MAX_LIFETIME_MS
  ) {
    fail('lifetime');
  }
  const capability = record(input.capability, 'capability_type');
  exactKeys(capability, CAPABILITY_KEYS, 'capability_keys');
  if (
    capability.name !== 'hosted-actual-owner-external-writer' ||
    capability.descriptorDelivery !== 'one-use'
  ) {
    fail('capability_literal');
  }
  return Object.freeze({
    schemaVersion: HOSTED_ACTUAL_OWNER_CAPABILITY_ATTESTATION_SCHEMA_VERSION,
    purpose: HOSTED_ACTUAL_OWNER_CAPABILITY_ATTESTATION_PURPOSE,
    issuer: HOSTED_ACTUAL_OWNER_CAPABILITY_ATTESTATION_ISSUER,
    keyId: stringMatching(input.keyId, HEX_SHA256, 'key_id'),
    algorithm: HOSTED_ACTUAL_OWNER_CAPABILITY_ATTESTATION_ALGORITHM,
    subject: validateHostedActualOwnerCapabilityAttestationSubject(input.subject),
    audience: HOSTED_ACTUAL_OWNER_CAPABILITY_ATTESTATION_AUDIENCE,
    issuedAtMs,
    notBeforeMs,
    expiresAtMs,
    nonce: validateBase64Url32(input.nonce, 'nonce'),
    capability: Object.freeze({
      name: 'hosted-actual-owner-external-writer',
      descriptorDelivery: 'one-use',
    }),
  });
}

export function canonicalHostedActualOwnerCapabilityAttestationUnsignedBytes(
  value: HostedActualOwnerExternalWriterCapabilityAttestationUnsigned
): Uint8Array {
  return encoder.encode(
    JSON.stringify(validateHostedActualOwnerCapabilityAttestationUnsigned(value))
  );
}

export function canonicalHostedActualOwnerCapabilityAttestationBytes(
  value: HostedActualOwnerExternalWriterCapabilityAttestation
): Uint8Array {
  const unsignedInput = Object.fromEntries(TOP_LEVEL_KEYS.map((key) => [key, value[key]]));
  const unsigned = validateHostedActualOwnerCapabilityAttestationUnsigned(unsignedInput);
  const signature = validateBase64Url64(value.signature, 'signature');
  const unsignedJson = JSON.stringify(unsigned);
  return encoder.encode(`${unsignedJson.slice(0, -1)},"signature":${JSON.stringify(signature)}}`);
}

export function hostedActualOwnerCapabilityAttestationSigningBytes(
  unsigned: HostedActualOwnerExternalWriterCapabilityAttestationUnsigned
): Uint8Array {
  const domain = encoder.encode(HOSTED_ACTUAL_OWNER_CAPABILITY_ATTESTATION_DOMAIN);
  const canonical = canonicalHostedActualOwnerCapabilityAttestationUnsignedBytes(unsigned);
  const output = new Uint8Array(domain.byteLength + 1 + canonical.byteLength);
  output.set(domain);
  output[domain.byteLength] = 0;
  output.set(canonical, domain.byteLength + 1);
  return output;
}

export function parseHostedActualOwnerCapabilityAttestation(
  bytes: Uint8Array
): HostedActualOwnerExternalWriterCapabilityAttestation {
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > HOSTED_ACTUAL_OWNER_CAPABILITY_ATTESTATION_MAX_BYTES
  ) {
    fail('length');
  }
  let source: string;
  try {
    source = decoder.decode(bytes);
  } catch {
    fail('utf8');
  }
  if (source.charCodeAt(0) === 0xfeff) fail('bom');
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    fail('json');
  }
  const input = record(parsed, 'type');
  exactKeys(input, [...TOP_LEVEL_KEYS, 'signature'], 'keys');
  const unsignedInput = Object.fromEntries(TOP_LEVEL_KEYS.map((key) => [key, input[key]]));
  const unsigned = validateHostedActualOwnerCapabilityAttestationUnsigned(unsignedInput);
  const attestation = Object.freeze({
    ...unsigned,
    signature: validateBase64Url64(input.signature, 'signature'),
  });
  const canonical = canonicalHostedActualOwnerCapabilityAttestationBytes(attestation);
  if (!equalBytes(canonical, bytes)) fail('noncanonical');
  return attestation;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((value, index) => value === right[index]);
}
