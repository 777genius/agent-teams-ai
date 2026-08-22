import {
  createHash,
  createPrivateKey,
  createPublicKey,
  type KeyObject,
  randomBytes,
  sign,
  verify,
} from 'node:crypto';

import {
  HOSTED_ACTUAL_OWNER_CAPABILITY_ATTESTATION_ALGORITHM,
  HOSTED_ACTUAL_OWNER_CAPABILITY_ATTESTATION_AUDIENCE,
  HOSTED_ACTUAL_OWNER_CAPABILITY_ATTESTATION_ISSUER,
  HOSTED_ACTUAL_OWNER_CAPABILITY_ATTESTATION_MAX_LIFETIME_MS,
  HOSTED_ACTUAL_OWNER_CAPABILITY_ATTESTATION_PURPOSE,
  HOSTED_ACTUAL_OWNER_CAPABILITY_ATTESTATION_SCHEMA_VERSION,
  type HostedActualOwnerCapabilityAttestationDescriptor,
  type HostedActualOwnerCapabilityAttestationIssueInput,
  type HostedActualOwnerCapabilityAttestationIssuer,
  type HostedActualOwnerExternalWriterCapabilityAttestation,
} from '../contracts';
import {
  canonicalHostedActualOwnerCapabilityAttestationBytes,
  hostedActualOwnerCapabilityAttestationSigningBytes,
  parseHostedActualOwnerCapabilityAttestation,
  validateHostedActualOwnerCapabilityAttestationSubject,
} from '../core/domain';

const ED25519_PKCS8_SEED_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const BASE64URL_32 = /^[A-Za-z0-9_-]{43}$/u;

export interface NodeHostedActualOwnerCapabilityAttestationIssuerOptions {
  readonly now?: () => number;
  readonly randomBytes?: (size: number) => Uint8Array;
  /** Deterministic test vector input. Production callers must omit this. */
  readonly testOnlyPrivateKeySeed?: Uint8Array;
}

function exactly32Bytes(value: Uint8Array, code: string): Buffer {
  if (value.byteLength !== 32) throw new Error(code);
  return Buffer.from(value);
}

function keyPairFromSeed(seed: Buffer): { privateKey: KeyObject; publicKey: KeyObject } {
  const encodedPrivateKey = Buffer.concat([ED25519_PKCS8_SEED_PREFIX, seed]);
  try {
    const privateKey = createPrivateKey({ key: encodedPrivateKey, format: 'der', type: 'pkcs8' });
    return { privateKey, publicKey: createPublicKey(privateKey) };
  } finally {
    encodedPrivateKey.fill(0);
  }
}

function rawPublicKey(publicKey: KeyObject): string {
  const jwk = publicKey.export({ format: 'jwk' });
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string') {
    throw new Error('hosted_actual_owner_capability_attestation_public_key_invalid');
  }
  return jwk.x;
}

function keyId(publicKey: string): string {
  return createHash('sha256').update(Buffer.from(publicKey, 'base64url')).digest('hex');
}

function checkedTime(value: number, code: string): number {
  if (!Number.isSafeInteger(value) || Object.is(value, -0) || value < 0) throw new Error(code);
  return value;
}

/** Per-run issuer. Construct once for a run/session and dispose it during every shutdown path. */
export class NodeHostedActualOwnerCapabilityAttestationIssuer implements HostedActualOwnerCapabilityAttestationIssuer {
  readonly publicKey: string;
  readonly keyId: string;

  readonly #seed: Buffer;
  #privateKey: KeyObject | null;
  readonly #issuedNonces = new Set<string>();
  readonly #now: () => number;
  readonly #random: (size: number) => Uint8Array;
  #subjectBinding: string | null = null;

  constructor(options: NodeHostedActualOwnerCapabilityAttestationIssuerOptions = {}) {
    const suppliedSeed = options.testOnlyPrivateKeySeed;
    this.#seed = exactly32Bytes(suppliedSeed ?? randomBytes(32), 'invalid_ed25519_seed');
    const pair = keyPairFromSeed(this.#seed);
    this.#privateKey = pair.privateKey;
    this.publicKey = rawPublicKey(pair.publicKey);
    this.keyId = keyId(this.publicKey);
    this.#now = options.now ?? Date.now;
    this.#random = options.randomBytes ?? randomBytes;
  }

  issue(
    input: HostedActualOwnerCapabilityAttestationIssueInput
  ): HostedActualOwnerCapabilityAttestationDescriptor {
    const privateKey = this.#privateKey;
    if (!privateKey) throw new Error('hosted_actual_owner_capability_attestation_issuer_disposed');
    const issuedAtMs = checkedTime(
      input.issuedAtMs ?? this.#now(),
      'hosted_actual_owner_capability_attestation_issued_at_invalid'
    );
    const notBeforeMs = checkedTime(
      input.notBeforeMs ?? issuedAtMs,
      'hosted_actual_owner_capability_attestation_not_before_invalid'
    );
    const lifetimeMs = checkedTime(
      input.lifetimeMs ?? HOSTED_ACTUAL_OWNER_CAPABILITY_ATTESTATION_MAX_LIFETIME_MS,
      'hosted_actual_owner_capability_attestation_lifetime_invalid'
    );
    if (
      lifetimeMs < 1 ||
      lifetimeMs > HOSTED_ACTUAL_OWNER_CAPABILITY_ATTESTATION_MAX_LIFETIME_MS ||
      notBeforeMs < issuedAtMs ||
      issuedAtMs > Number.MAX_SAFE_INTEGER - lifetimeMs ||
      notBeforeMs >= issuedAtMs + lifetimeMs
    ) {
      throw new Error('hosted_actual_owner_capability_attestation_lifetime_invalid');
    }
    const subject = validateHostedActualOwnerCapabilityAttestationSubject(input.subject);
    const subjectBinding = JSON.stringify(subject);
    if (this.#subjectBinding !== null && this.#subjectBinding !== subjectBinding) {
      throw new Error('hosted_actual_owner_capability_attestation_subject_changed');
    }
    this.#subjectBinding = subjectBinding;
    const nonce = exactly32Bytes(
      this.#random(32),
      'hosted_actual_owner_capability_attestation_nonce_invalid'
    ).toString('base64url');
    if (this.#issuedNonces.has(nonce)) {
      throw new Error('hosted_actual_owner_capability_attestation_nonce_reused');
    }
    this.#issuedNonces.add(nonce);
    const unsigned = Object.freeze({
      schemaVersion: HOSTED_ACTUAL_OWNER_CAPABILITY_ATTESTATION_SCHEMA_VERSION,
      purpose: HOSTED_ACTUAL_OWNER_CAPABILITY_ATTESTATION_PURPOSE,
      issuer: HOSTED_ACTUAL_OWNER_CAPABILITY_ATTESTATION_ISSUER,
      keyId: this.keyId,
      algorithm: HOSTED_ACTUAL_OWNER_CAPABILITY_ATTESTATION_ALGORITHM,
      subject,
      audience: HOSTED_ACTUAL_OWNER_CAPABILITY_ATTESTATION_AUDIENCE,
      issuedAtMs,
      notBeforeMs,
      expiresAtMs: issuedAtMs + lifetimeMs,
      nonce,
      capability: Object.freeze({
        name: 'hosted-actual-owner-external-writer' as const,
        descriptorDelivery: 'one-use' as const,
      }),
    });
    const signature = sign(
      null,
      hostedActualOwnerCapabilityAttestationSigningBytes(unsigned),
      privateKey
    );
    const attestation: HostedActualOwnerExternalWriterCapabilityAttestation = Object.freeze({
      ...unsigned,
      signature: signature.toString('base64url'),
    });
    const canonicalBytes = canonicalHostedActualOwnerCapabilityAttestationBytes(attestation);
    return Object.freeze({ publicKey: this.publicKey, attestation, canonicalBytes });
  }

  dispose(): void {
    if (!this.#privateKey) return;
    this.#privateKey = null;
    this.#seed.fill(0);
    this.#issuedNonces.clear();
    this.#subjectBinding = null;
  }

  toJSON(): Readonly<{ keyId: string; publicKey: string }> {
    return Object.freeze({ keyId: this.keyId, publicKey: this.publicKey });
  }
}

export function verifyHostedActualOwnerCapabilityAttestation(input: {
  readonly bytes: Uint8Array;
  readonly publicKey: string;
  readonly nowMs?: number;
}): HostedActualOwnerExternalWriterCapabilityAttestation {
  if (!BASE64URL_32.test(input.publicKey) || !/[AEIMQUYcgkosw048]$/u.test(input.publicKey)) {
    throw new Error('hosted_actual_owner_capability_attestation_public_key_invalid');
  }
  const attestation = parseHostedActualOwnerCapabilityAttestation(input.bytes);
  if (keyId(input.publicKey) !== attestation.keyId) {
    throw new Error('hosted_actual_owner_capability_attestation_key_id_mismatch');
  }
  const publicKey = createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: input.publicKey },
    format: 'jwk',
  });
  const signature = Buffer.from(attestation.signature, 'base64url');
  const { signature: _signature, ...unsigned } = attestation;
  if (
    !verify(
      null,
      hostedActualOwnerCapabilityAttestationSigningBytes(unsigned),
      publicKey,
      signature
    )
  ) {
    throw new Error('hosted_actual_owner_capability_attestation_signature_invalid');
  }
  if (input.nowMs !== undefined) {
    const nowMs = checkedTime(
      input.nowMs,
      'hosted_actual_owner_capability_attestation_now_invalid'
    );
    if (nowMs < attestation.notBeforeMs || nowMs >= attestation.expiresAtMs) {
      throw new Error('hosted_actual_owner_capability_attestation_time_invalid');
    }
  }
  return attestation;
}
