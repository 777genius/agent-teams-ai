import { type KeyObject, randomBytes, sign } from 'node:crypto';

import { memberStartOperationId } from './hostedMemberStartResolution';

export const MEMBER_ADMISSION_FORMAT = 'agent-teams.hosted-opencode-member-admission/v1';
export const MEMBER_ADMISSION_DOMAIN = `${MEMBER_ADMISSION_FORMAT}\0`;
export const MEMBER_ADMISSION_MAX_BYTES = 8192;

const HEX_32 = /^[0-9a-f]{32}$/u;
const HEX_64 = /^[0-9a-f]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const GRANT_ID = /^grant_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/u;
const AUTHORIZATION_GENERATION = /^authorization-generation_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/u;
const OWNER_SESSION = /^owner-session_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/u;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,255}$/u;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/u;

const PAYLOAD_KEYS = [
  'admissionId',
  'authorizationGeneration',
  'bootId',
  'deploymentId',
  'expiresAtMs',
  'format',
  'grantId',
  'grantRevision',
  'issuedAtMs',
  'laneId',
  'memberId',
  'memberName',
  'memberOrdinal',
  'model',
  'mountGeneration',
  'operationId',
  'ownerGeneration',
  'ownerSessionId',
  'planGeneration',
  'planSha256',
  'policyId',
  'promptSha256',
  'restoreGeneration',
  'runId',
  'teamId',
  'workspaceId',
] as const;

/** All authority values come from one Product-owned, immutable plan/member resolution. */
export interface FrozenMemberAdmissionRecord {
  readonly operationId: string;
  readonly deploymentId: string;
  readonly bootId: string;
  readonly restoreGeneration: number;
  readonly ownerGeneration: number;
  readonly ownerSessionId: string;
  readonly workspaceId: string;
  readonly mountGeneration: number;
  readonly grantId: string;
  readonly grantRevision: string;
  readonly authorizationGeneration: string;
  readonly planSha256: string;
  readonly planGeneration: string;
  readonly teamId: string;
  readonly runId: string;
  readonly laneId: string;
  readonly memberId: string;
  readonly memberName: string;
  readonly memberOrdinal: number;
  readonly model: string;
  readonly promptSha256: string;
  readonly policyId: string;
}

export interface MemberAdmissionPayload extends FrozenMemberAdmissionRecord {
  readonly format: typeof MEMBER_ADMISSION_FORMAT;
  readonly admissionId: string;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
}

export interface SignedMemberAdmission {
  readonly payload: MemberAdmissionPayload;
  readonly signature: string;
}

export interface MemberAdmissionProductAuthority {
  /** Must use private v33 lookup(runId), verify its frozen roster binding, and select one member. */
  resolveFrozenMember(runId: string, memberId: string): Promise<FrozenMemberAdmissionRecord>;
  /** Must independently re-read the authenticated grant and plan fences. Throw on any change. */
  assertCurrent(record: FrozenMemberAdmissionRecord): Promise<void>;
}

export interface MemberAdmissionPrivateKeyProvider {
  /** Trusted Product custody only, for example an inherited fd. Never Owner HMAC material. */
  loadPrivateKey(): Promise<KeyObject>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function safeInteger(value: unknown, minimum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}

function validMemberName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= 256 &&
    value.normalize('NFC') === value &&
    !/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(value)
  );
}

/** Strict flat schema also prevents introducing paths, network options, or extra members. */
export function isMemberAdmissionPayload(value: unknown): value is MemberAdmissionPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    exactKeys(row, PAYLOAD_KEYS) &&
    row.format === MEMBER_ADMISSION_FORMAT &&
    typeof row.admissionId === 'string' &&
    HEX_32.test(row.admissionId) &&
    typeof row.operationId === 'string' &&
    /^start_[0-9a-f]{64}$/u.test(row.operationId) &&
    safeInteger(row.issuedAtMs, 1) &&
    safeInteger(row.expiresAtMs, 1) &&
    row.expiresAtMs > row.issuedAtMs &&
    row.expiresAtMs - row.issuedAtMs <= 60_000 &&
    typeof row.deploymentId === 'string' &&
    SAFE_ID.test(row.deploymentId) &&
    typeof row.bootId === 'string' &&
    SAFE_ID.test(row.bootId) &&
    safeInteger(row.restoreGeneration, 0) &&
    safeInteger(row.ownerGeneration, 1) &&
    typeof row.ownerSessionId === 'string' &&
    OWNER_SESSION.test(row.ownerSessionId) &&
    typeof row.workspaceId === 'string' &&
    SAFE_ID.test(row.workspaceId) &&
    safeInteger(row.mountGeneration, 1) &&
    typeof row.grantId === 'string' &&
    GRANT_ID.test(row.grantId) &&
    typeof row.grantRevision === 'string' &&
    HEX_64.test(row.grantRevision) &&
    typeof row.authorizationGeneration === 'string' &&
    AUTHORIZATION_GENERATION.test(row.authorizationGeneration) &&
    typeof row.planSha256 === 'string' &&
    HEX_64.test(row.planSha256) &&
    row.planGeneration === `plan-generation_${row.planSha256}` &&
    typeof row.teamId === 'string' &&
    SAFE_ID.test(row.teamId) &&
    typeof row.runId === 'string' &&
    /^run_[0-9a-f]{32}$/u.test(row.runId) &&
    typeof row.laneId === 'string' &&
    SAFE_ID.test(row.laneId) &&
    typeof row.memberId === 'string' &&
    /^member_[0-9a-f]{32}$/u.test(row.memberId) &&
    row.operationId === memberStartOperationId(row.runId, row.memberId, row.planSha256) &&
    validMemberName(row.memberName) &&
    safeInteger(row.memberOrdinal, 0) &&
    typeof row.model === 'string' &&
    MODEL_ID.test(row.model) &&
    typeof row.promptSha256 === 'string' &&
    HEX_64.test(row.promptSha256) &&
    typeof row.policyId === 'string' &&
    SAFE_ID.test(row.policyId)
  );
}

export function canonicalMemberAdmissionPayload(payload: MemberAdmissionPayload): Buffer {
  if (!isMemberAdmissionPayload(payload)) throw new Error('member-admission-payload-invalid');
  const ordered = Object.fromEntries(PAYLOAD_KEYS.map((key) => [key, payload[key]]));
  const bytes = Buffer.from(JSON.stringify(ordered), 'utf8');
  if (bytes.length > MEMBER_ADMISSION_MAX_BYTES) throw new Error('member-admission-oversized');
  return bytes;
}

export function memberAdmissionSigningBytes(payload: MemberAdmissionPayload): Buffer {
  return Buffer.concat([
    Buffer.from(MEMBER_ADMISSION_DOMAIN, 'utf8'),
    canonicalMemberAdmissionPayload(payload),
  ]);
}

/** Rejects duplicate/unknown keys and noncanonical escapes by exact byte comparison. */
export function parseCanonicalMemberAdmission(bytes: Uint8Array): SignedMemberAdmission {
  if (bytes.byteLength < 1 || bytes.byteLength > MEMBER_ADMISSION_MAX_BYTES) {
    throw new Error('member-admission-wire-size-invalid');
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('member-admission-json-invalid');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('member-admission-envelope-invalid');
  }
  const envelope = parsed as Record<string, unknown>;
  if (
    !exactKeys(envelope, ['payload', 'signature']) ||
    !isMemberAdmissionPayload(envelope.payload) ||
    typeof envelope.signature !== 'string' ||
    !SIGNATURE.test(envelope.signature) ||
    Buffer.from(envelope.signature, 'base64url').length !== 64 ||
    Buffer.from(envelope.signature, 'base64url').toString('base64url') !== envelope.signature
  ) {
    throw new Error('member-admission-envelope-invalid');
  }
  const canonical = Buffer.from(
    JSON.stringify({
      payload: JSON.parse(canonicalMemberAdmissionPayload(envelope.payload).toString('utf8')),
      signature: envelope.signature,
    }),
    'utf8'
  );
  if (!Buffer.from(bytes).equals(canonical)) throw new Error('member-admission-not-canonical');
  return { payload: envelope.payload, signature: envelope.signature };
}

/** Inactive contract: no route or active composition constructs this signer yet. */
export function createMemberAdmissionSigner(dependencies: {
  readonly productAuthority: MemberAdmissionProductAuthority;
  readonly privateKeyProvider: MemberAdmissionPrivateKeyProvider;
  readonly now?: () => number;
  readonly randomAdmissionId?: () => string;
}): { issue(runId: string, memberId: string): Promise<Buffer> } {
  if (typeof dependencies !== 'object' || dependencies === null) {
    throw new Error('member-admission-ports-invalid');
  }
  const authority = dependencies.productAuthority;
  const keyProvider = dependencies.privateKeyProvider;
  const resolveMethod = authority?.resolveFrozenMember;
  const assertMethod = authority?.assertCurrent;
  const loadKeyMethod = keyProvider?.loadPrivateKey;
  if (
    typeof authority !== 'object' ||
    authority === null ||
    typeof keyProvider !== 'object' ||
    keyProvider === null ||
    typeof resolveMethod !== 'function' ||
    typeof assertMethod !== 'function' ||
    typeof loadKeyMethod !== 'function' ||
    (dependencies.now !== undefined && typeof dependencies.now !== 'function') ||
    (dependencies.randomAdmissionId !== undefined &&
      typeof dependencies.randomAdmissionId !== 'function')
  ) {
    throw new Error('member-admission-ports-invalid');
  }
  // Capture both the implementation and its receiver before any asynchronous work.
  const resolveFrozenMember = resolveMethod.bind(authority);
  const assertCurrent = assertMethod.bind(authority);
  const loadPrivateKey = loadKeyMethod.bind(keyProvider);
  const now = dependencies.now ?? Date.now;
  const randomAdmissionId =
    dependencies.randomAdmissionId ?? (() => randomBytes(16).toString('hex'));
  return Object.freeze({
    issue: async (runId: string, memberId: string): Promise<Buffer> => {
      if (!/^run_[0-9a-f]{32}$/u.test(runId) || !/^member_[0-9a-f]{32}$/u.test(memberId)) {
        throw new Error('member-admission-selector-invalid');
      }
      const record = Object.freeze({
        ...(await resolveFrozenMember(runId, memberId)),
      });
      if (
        record.runId !== runId ||
        record.memberId !== memberId ||
        typeof record.planSha256 !== 'string' ||
        !HEX_64.test(record.planSha256) ||
        record.operationId !== memberStartOperationId(runId, memberId, record.planSha256)
      ) {
        throw new Error('member-admission-resolver-mismatch');
      }
      await assertCurrent(record);
      const privateKey = await loadPrivateKey();
      if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519') {
        throw new Error('member-admission-key-invalid');
      }
      // The grant/plan may have changed while key custody was awaited.
      await assertCurrent(record);
      const issuedAtMs = now();
      if (!safeInteger(issuedAtMs, 1) || issuedAtMs > Number.MAX_SAFE_INTEGER - 60_000) {
        throw new Error('member-admission-clock-invalid');
      }
      const payload: MemberAdmissionPayload = {
        ...record,
        format: MEMBER_ADMISSION_FORMAT,
        admissionId: randomAdmissionId(),
        issuedAtMs,
        expiresAtMs: issuedAtMs + 60_000,
      };
      const signature = sign(null, memberAdmissionSigningBytes(payload), privateKey).toString(
        'base64url'
      );
      const wire = Buffer.from(
        JSON.stringify({
          payload: JSON.parse(canonicalMemberAdmissionPayload(payload).toString('utf8')),
          signature,
        }),
        'utf8'
      );
      if (wire.length > MEMBER_ADMISSION_MAX_BYTES) throw new Error('member-admission-oversized');
      return wire;
    },
  });
}
