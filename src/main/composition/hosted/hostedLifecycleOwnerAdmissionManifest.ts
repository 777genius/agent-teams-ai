import { createPublicKey, verify } from 'node:crypto';

import { readHostedAdmissionExactRecord as readExactRecord } from './hostedAdmissionExactRecord';

export const HOSTED_LIFECYCLE_OWNER_ADMISSION_FORMAT =
  'agent-teams.hosted-lifecycle-owner-admission/v3';
export const HOSTED_LIFECYCLE_OWNER_ADMISSION_PAYLOAD_FORMAT =
  'agent-teams.hosted-lifecycle-owner-admission-payload/v3';
export const HOSTED_LIFECYCLE_OWNER_ADMISSION_SIGNATURE_DOMAIN =
  'agent-teams.hosted-lifecycle-owner-admission/v3';
export const HOSTED_LIFECYCLE_OWNER_ADMISSION_V4_FORMAT =
  'agent-teams.hosted-lifecycle-owner-admission/v4';
export const HOSTED_LIFECYCLE_OWNER_ADMISSION_V4_PAYLOAD_FORMAT =
  'agent-teams.hosted-lifecycle-owner-admission-payload/v4';
export const HOSTED_LIFECYCLE_OWNER_ADMISSION_V4_SIGNATURE_DOMAIN =
  'agent-teams.hosted-lifecycle-owner-admission/v4';
export const LEGACY_OWNER_ADMISSION_FORMAT = 'agent-teams.hosted-lifecycle-owner-admission/v2';
export const LEGACY_OWNER_ADMISSION_PAYLOAD_FORMAT =
  'agent-teams.hosted-lifecycle-owner-admission-payload/v2';
export const LEGACY_OWNER_ADMISSION_SIGNATURE_DOMAIN =
  'agent-teams.hosted-lifecycle-owner-admission/v2';

const MAXIMUM_PAYLOAD_BYTES = 12_288;
const ED25519_SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/u;

export interface HostedLifecycleAdmissionLauncherPin {
  readonly launcherPublicKey: string;
  readonly launcherKeyId: string;
}

export function authenticateHostedLifecycleAdmissionManifest(
  serialized: string,
  releasePin: HostedLifecycleAdmissionLauncherPin
): Readonly<{ payload: string; version: 2 | 3 | 4 }> {
  const canonicalEnvelope = serialized.endsWith('\n') ? serialized.slice(0, -1) : serialized;
  const parsedEnvelope = JSON.parse(canonicalEnvelope) as unknown;
  if (JSON.stringify(parsedEnvelope) !== canonicalEnvelope) {
    throw new TypeError('hosted-lifecycle-owner-admission-manifest-noncanonical');
  }
  const envelope = readExactRecord(parsedEnvelope, ['format', 'payload', 'authentication']);
  const authentication = readExactRecord(envelope.authentication, [
    'algorithm',
    'launcherKeyId',
    'signature',
  ]);
  if (
    (envelope.format !== HOSTED_LIFECYCLE_OWNER_ADMISSION_V4_FORMAT &&
      envelope.format !== HOSTED_LIFECYCLE_OWNER_ADMISSION_FORMAT &&
      envelope.format !== LEGACY_OWNER_ADMISSION_FORMAT) ||
    typeof envelope.payload !== 'string' ||
    envelope.payload.length === 0 ||
    Buffer.byteLength(envelope.payload, 'utf8') > MAXIMUM_PAYLOAD_BYTES ||
    authentication.algorithm !== 'ed25519' ||
    authentication.launcherKeyId !== releasePin.launcherKeyId ||
    typeof authentication.signature !== 'string' ||
    !ED25519_SIGNATURE_PATTERN.test(authentication.signature)
  ) {
    throw new TypeError('hosted-lifecycle-owner-admission-manifest-invalid');
  }
  const signature = decodeCanonicalBase64Url(authentication.signature, 64);
  const launcherPublicKey = createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: releasePin.launcherPublicKey },
    format: 'jwk',
  });
  const signatureDomain =
    envelope.format === HOSTED_LIFECYCLE_OWNER_ADMISSION_V4_FORMAT
      ? HOSTED_LIFECYCLE_OWNER_ADMISSION_V4_SIGNATURE_DOMAIN
      : envelope.format === HOSTED_LIFECYCLE_OWNER_ADMISSION_FORMAT
        ? HOSTED_LIFECYCLE_OWNER_ADMISSION_SIGNATURE_DOMAIN
        : LEGACY_OWNER_ADMISSION_SIGNATURE_DOMAIN;
  if (
    !verify(
      null,
      Buffer.from(`${signatureDomain}\u0000${envelope.payload}`, 'utf8'),
      launcherPublicKey,
      signature
    )
  ) {
    throw new TypeError('hosted-lifecycle-owner-admission-manifest-unauthenticated');
  }
  return Object.freeze({
    payload: envelope.payload,
    version:
      envelope.format === HOSTED_LIFECYCLE_OWNER_ADMISSION_V4_FORMAT
        ? 4
        : envelope.format === HOSTED_LIFECYCLE_OWNER_ADMISSION_FORMAT
          ? 3
          : 2,
  });
}

export function decodeCanonicalBase64Url(value: string, expectedBytes: number): Buffer {
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.byteLength !== expectedBytes || decoded.toString('base64url') !== value) {
    throw new TypeError('hosted-lifecycle-owner-admission-key-encoding-invalid');
  }
  return decoded;
}
