import {
  createHash,
  createPrivateKey,
  createPublicKey,
  type KeyObject,
  sign,
  verify,
} from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import { TeamProvisioningService } from '../TeamProvisioningService';

import {
  createHostedApprovalRuntimeAdmissionComposition,
  HOSTED_APPROVAL_RUNTIME_ORCHESTRATOR_CAPABILITY,
  HOSTED_APPROVAL_RUNTIME_PRODUCTION_ELIGIBLE,
} from './HostedApprovalRuntimeAdmissionComposition';
import { parseHostedApprovalRuntimeAdmissionDocument } from './HostedApprovalRuntimeAdmissionPublisher';
import { createHostedApprovalRuntimeAuthoritativeEvidenceAdapter } from './HostedApprovalRuntimeAuthoritativeEvidenceAdapter';
import { HostedApprovalRuntimeTransitionService } from './HostedApprovalRuntimeTransitionService';

import type { HostedApprovalRuntimeAdmissionCoordinator } from './HostedApprovalRuntimeAdmissionComposition';
import type { HostedApprovalRuntimeTransitionAuthority } from './HostedApprovalRuntimeAuthoritativeEvidenceAdapter';

export interface ProductOwnedTeamProvisioningComposition {
  readonly service: TeamProvisioningService;
  readonly hostedApprovalRuntime: HostedApprovalRuntimeTransitionService;
}

/** Constructor composition for the compatibility facade; no post-construction capability slots. */
export function createTeamProvisioningServiceWithHostedApprovalRuntimeAdmission(
  coordinator: HostedApprovalRuntimeAdmissionCoordinator | null,
  transitionAuthority: HostedApprovalRuntimeTransitionAuthority | null = null
): ProductOwnedTeamProvisioningComposition {
  return Object.freeze({
    service: new TeamProvisioningService(),
    hostedApprovalRuntime: new HostedApprovalRuntimeTransitionService({
      coordinator,
      transitionAuthority,
    }),
  });
}

/**
 * Product-owned production composition. Both admission gates intentionally remain false; the real
 * request-scoped authority adapter is nevertheless wired now so promotion cannot fall back to
 * workspace-derived or ambient evidence.
 */
export function createProductOwnedTeamProvisioningService(
  teamsBasePath: string,
  stateDirectoryPath: string
): ProductOwnedTeamProvisioningComposition {
  const authoritativeEvidence = createHostedApprovalRuntimeAuthoritativeEvidenceAdapter();
  const coordinator = createHostedApprovalRuntimeAdmissionComposition({
    enabled:
      HOSTED_APPROVAL_RUNTIME_PRODUCTION_ELIGIBLE &&
      HOSTED_APPROVAL_RUNTIME_ORCHESTRATOR_CAPABILITY,
    resolveTeamDirectoryPath: (teamName) => join(teamsBasePath, teamName),
    stateDirectoryPath,
    authoritativeEvidence,
  });
  return createTeamProvisioningServiceWithHostedApprovalRuntimeAdmission(
    coordinator,
    authoritativeEvidence
  );
}

export const HOSTED_APPROVAL_ACTIVATION_AUTHORSHIP_ALGORITHM = 'Ed25519' as const;
export const HOSTED_APPROVAL_ACTIVATION_SIGNING_KEY_FILE_ENV =
  'HOSTED_APPROVAL_ACTIVATION_PRODUCT_SIGNING_KEY_FILE' as const;
export const HOSTED_APPROVAL_ACTIVATION_PUBLIC_KEY_DIGEST_ENV =
  'HOSTED_APPROVAL_ACTIVATION_PRODUCT_PUBLIC_KEY_SPKI_DIGEST' as const;
export const HOSTED_APPROVAL_ACTIVATION_CONTRACT_DIGEST_ENV =
  'HOSTED_APPROVAL_ACTIVATION_PRODUCT_CONTRACT_DIGEST' as const;
export const HOSTED_APPROVAL_ACTIVATION_ADMISSION_FILE_ENV =
  'HOSTED_APPROVAL_ACTIVATION_PRODUCT_ADMISSION_FILE' as const;

const ACTIVATION_SHA256 = /^sha256:[0-9a-f]{64}$/u;

export interface HostedApprovalRuntimeActivationAuthorship {
  readonly algorithm: typeof HOSTED_APPROVAL_ACTIVATION_AUTHORSHIP_ALGORITHM;
  readonly publicKeyDigest: `sha256:${string}`;
  readonly contractDigest: `sha256:${string}`;
  readonly signature: string;
}

export interface HostedApprovalRuntimeActivationSigningIdentity {
  readonly privateKey: KeyObject;
  readonly publicKeySpkiDer: Uint8Array;
  readonly publicKeyDigest: `sha256:${string}`;
  readonly contractDigest: `sha256:${string}`;
}

export interface HostedApprovalRuntimeActivationPublicVerifier {
  readonly publicKeySpkiDer: Uint8Array;
  readonly publicKeyDigest: `sha256:${string}`;
  readonly contractDigest: `sha256:${string}`;
}

export interface HostedApprovalRuntimeActivationPublicationContract {
  readonly signingIdentity: HostedApprovalRuntimeActivationSigningIdentity;
  readonly admissionDocument: string;
  readonly admissionDocumentDigest: `sha256:${string}`;
}

/**
 * Loads the product-authorship key and the canonical publisher output as one
 * fail-closed configuration. The admission publication is deliberately not a
 * signed-v4 route-catalog field.
 */
export function readHostedApprovalRuntimeActivationPublicationContract(
  environment: Readonly<Record<string, string | undefined>>
): HostedApprovalRuntimeActivationPublicationContract | null {
  const admissionPath = environment[HOSTED_APPROVAL_ACTIVATION_ADMISSION_FILE_ENV];
  const signingConfigured = [
    environment[HOSTED_APPROVAL_ACTIVATION_SIGNING_KEY_FILE_ENV],
    environment[HOSTED_APPROVAL_ACTIVATION_PUBLIC_KEY_DIGEST_ENV],
    environment[HOSTED_APPROVAL_ACTIVATION_CONTRACT_DIGEST_ENV],
  ].some((value) => value !== undefined);
  if (!signingConfigured && admissionPath === undefined) return null;
  if (
    admissionPath === undefined ||
    !isAbsolute(admissionPath) ||
    resolve(admissionPath) !== admissionPath ||
    admissionPath.includes('\0')
  ) {
    throw new TypeError('hosted-approval-activation-signing-contract-invalid');
  }
  const signingIdentity = readHostedApprovalRuntimeActivationSigningIdentity(environment);
  if (signingIdentity === null) {
    throw new TypeError('hosted-approval-activation-signing-contract-invalid');
  }
  const admissionDocument = readStableActivationAdmissionDocument(admissionPath);
  return Object.freeze({
    signingIdentity,
    admissionDocument,
    admissionDocumentDigest: `sha256:${createHash('sha256')
      .update(admissionDocument)
      .digest('hex')}`,
  });
}

export function serializeHostedApprovalRuntimeActivationAuthorshipPublication(
  envelope: string,
  signingIdentity: HostedApprovalRuntimeActivationSigningIdentity
): string {
  const identity = validateActivationSigningIdentity(signingIdentity);
  const authorship: HostedApprovalRuntimeActivationAuthorship = Object.freeze({
    algorithm: HOSTED_APPROVAL_ACTIVATION_AUTHORSHIP_ALGORITHM,
    publicKeyDigest: identity.publicKeyDigest,
    contractDigest: identity.contractDigest,
    signature: sign(
      null,
      Buffer.from(
        serializeActivationAuthorshipStatement(
          envelope,
          identity.publicKeyDigest,
          identity.contractDigest
        ),
        'utf8'
      ),
      identity.privateKey
    ).toString('base64url'),
  });
  return `{"schemaVersion":1,"envelope":${envelope},"authorship":${JSON.stringify(authorship)}}`;
}

export function verifyHostedApprovalRuntimeActivationAuthorshipPublication(
  source: string,
  verifier: HostedApprovalRuntimeActivationPublicVerifier
): string {
  const publication = parseCanonicalActivationObject(source, [
    'schemaVersion',
    'envelope',
    'authorship',
  ]);
  if (
    publication.schemaVersion !== 1 ||
    !publication.envelope ||
    typeof publication.envelope !== 'object' ||
    Array.isArray(publication.envelope)
  ) {
    throw new TypeError('hosted-approval-activation-publication-invalid');
  }
  const envelope = JSON.stringify(publication.envelope);
  verifyActivationAuthorship(envelope, publication.authorship, verifier);
  return envelope;
}

export function readHostedApprovalRuntimeActivationSigningIdentity(
  environment: Readonly<Record<string, string | undefined>>
): HostedApprovalRuntimeActivationSigningIdentity | null {
  const path = environment[HOSTED_APPROVAL_ACTIVATION_SIGNING_KEY_FILE_ENV];
  const publicKeyDigest = environment[HOSTED_APPROVAL_ACTIVATION_PUBLIC_KEY_DIGEST_ENV];
  const contractDigest = environment[HOSTED_APPROVAL_ACTIVATION_CONTRACT_DIGEST_ENV];
  if (path === undefined && publicKeyDigest === undefined && contractDigest === undefined)
    return null;
  if (
    path === undefined ||
    publicKeyDigest === undefined ||
    contractDigest === undefined ||
    !ACTIVATION_SHA256.test(publicKeyDigest) ||
    !ACTIVATION_SHA256.test(contractDigest) ||
    !isAbsolute(path) ||
    resolve(path) !== path ||
    path.includes('\0')
  ) {
    throw new TypeError('hosted-approval-activation-signing-contract-invalid');
  }
  let before: ReturnType<typeof lstatSync>;
  try {
    before = lstatSync(path, { bigint: true });
  } catch {
    throw new TypeError('hosted-approval-activation-signing-key-file-invalid');
  }
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    throw new TypeError('hosted-approval-activation-signing-key-file-invalid');
  }
  try {
    const stat = fstatSync(descriptor, { bigint: true });
    const runtimeUid = BigInt(process.getuid?.() ?? 0);
    if (
      before.isSymbolicLink() ||
      !before.isFile() ||
      !stat.isFile() ||
      before.dev !== stat.dev ||
      before.ino !== stat.ino ||
      (stat.uid !== 0n && stat.uid !== runtimeUid) ||
      Number(stat.mode & 0o777n) !== 0o400 ||
      stat.size < 64n ||
      stat.size > 16_384n
    ) {
      throw new TypeError('hosted-approval-activation-signing-key-file-invalid');
    }
    const bytes = Buffer.alloc(Number(stat.size));
    if (readSync(descriptor, bytes, 0, bytes.byteLength, 0) !== bytes.byteLength) {
      throw new TypeError('hosted-approval-activation-signing-key-file-substituted');
    }
    const descriptorAfter = fstatSync(descriptor, { bigint: true });
    let after: ReturnType<typeof lstatSync>;
    try {
      after = lstatSync(path, { bigint: true });
    } catch {
      throw new TypeError('hosted-approval-activation-signing-key-file-substituted');
    }
    if (
      after.isSymbolicLink() ||
      !after.isFile() ||
      descriptorAfter.dev !== stat.dev ||
      descriptorAfter.ino !== stat.ino ||
      descriptorAfter.size !== stat.size ||
      descriptorAfter.mtimeNs !== stat.mtimeNs ||
      descriptorAfter.ctimeNs !== stat.ctimeNs ||
      after.dev !== stat.dev ||
      after.ino !== stat.ino ||
      after.size !== stat.size ||
      after.mtimeNs !== stat.mtimeNs ||
      after.ctimeNs !== stat.ctimeNs
    ) {
      throw new TypeError('hosted-approval-activation-signing-key-file-substituted');
    }
    let privateKey: KeyObject;
    try {
      privateKey = createPrivateKey({ key: bytes, format: 'pem', type: 'pkcs8' });
    } catch {
      throw new TypeError('hosted-approval-activation-signing-key-invalid');
    }
    if (
      privateKey.type !== 'private' ||
      privateKey.asymmetricKeyType !== 'ed25519' ||
      privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() !== bytes.toString('utf8')
    ) {
      throw new TypeError('hosted-approval-activation-signing-key-invalid');
    }
    const publicKeySpkiDer = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
    const actualDigest = `sha256:${createHash('sha256').update(publicKeySpkiDer).digest('hex')}`;
    if (actualDigest !== publicKeyDigest) {
      throw new TypeError('hosted-approval-activation-signing-key-pin-mismatch');
    }
    return Object.freeze({
      privateKey,
      publicKeySpkiDer: Uint8Array.from(publicKeySpkiDer),
      publicKeyDigest: publicKeyDigest as `sha256:${string}`,
      contractDigest: contractDigest as `sha256:${string}`,
    });
  } finally {
    closeSync(descriptor);
  }
}

function validateActivationSigningIdentity(
  identity: HostedApprovalRuntimeActivationSigningIdentity
): HostedApprovalRuntimeActivationSigningIdentity {
  if (
    identity.privateKey.type !== 'private' ||
    identity.privateKey.asymmetricKeyType !== 'ed25519' ||
    !ACTIVATION_SHA256.test(identity.publicKeyDigest) ||
    !ACTIVATION_SHA256.test(identity.contractDigest)
  ) {
    throw new TypeError('hosted-approval-activation-signing-identity-invalid');
  }
  const expectedSpki = createPublicKey(identity.privateKey).export({ format: 'der', type: 'spki' });
  const suppliedSpki = Buffer.from(identity.publicKeySpkiDer);
  const digest = `sha256:${createHash('sha256').update(suppliedSpki).digest('hex')}`;
  if (!expectedSpki.equals(suppliedSpki) || digest !== identity.publicKeyDigest) {
    throw new TypeError('hosted-approval-activation-signing-key-pin-mismatch');
  }
  return identity;
}

function readStableActivationAdmissionDocument(path: string): string {
  let before: ReturnType<typeof lstatSync>;
  try {
    before = lstatSync(path, { bigint: true });
  } catch {
    throw new TypeError('hosted-approval-activation-admission-file-invalid');
  }
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    throw new TypeError('hosted-approval-activation-admission-file-invalid');
  }
  try {
    const stat = fstatSync(descriptor, { bigint: true });
    const runtimeUid = BigInt(process.getuid?.() ?? 0);
    if (
      before.isSymbolicLink() ||
      !before.isFile() ||
      !stat.isFile() ||
      before.dev !== stat.dev ||
      before.ino !== stat.ino ||
      (stat.uid !== 0n && stat.uid !== runtimeUid) ||
      Number(stat.mode & 0o777n) !== 0o600 ||
      stat.size < 3n ||
      stat.size > 1_048_576n
    ) {
      throw new TypeError('hosted-approval-activation-admission-file-invalid');
    }
    const bytes = Buffer.alloc(Number(stat.size));
    if (readSync(descriptor, bytes, 0, bytes.byteLength, 0) !== bytes.byteLength) {
      throw new TypeError('hosted-approval-activation-admission-file-substituted');
    }
    const descriptorAfter = fstatSync(descriptor, { bigint: true });
    const after = lstatSync(path, { bigint: true });
    if (
      after.isSymbolicLink() ||
      !after.isFile() ||
      descriptorAfter.dev !== stat.dev ||
      descriptorAfter.ino !== stat.ino ||
      descriptorAfter.size !== stat.size ||
      descriptorAfter.mtimeNs !== stat.mtimeNs ||
      descriptorAfter.ctimeNs !== stat.ctimeNs ||
      after.dev !== stat.dev ||
      after.ino !== stat.ino ||
      after.size !== stat.size ||
      after.mtimeNs !== stat.mtimeNs ||
      after.ctimeNs !== stat.ctimeNs
    ) {
      throw new TypeError('hosted-approval-activation-admission-file-substituted');
    }
    const document = bytes.toString('utf8');
    if (
      !document.endsWith('\n') ||
      document.includes('\r') ||
      Buffer.from(document).length !== bytes.length
    ) {
      throw new TypeError('hosted-approval-activation-admission-file-invalid');
    }
    try {
      parseHostedApprovalRuntimeAdmissionDocument(document);
    } catch {
      throw new TypeError('hosted-approval-activation-admission-file-invalid');
    }
    return document;
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError('hosted-approval-activation-admission-file-substituted');
  } finally {
    closeSync(descriptor);
  }
}

function verifyActivationAuthorship(
  source: string,
  value: unknown,
  verifier: HostedApprovalRuntimeActivationPublicVerifier
): void {
  const authorship = orderedActivationRecord(value, [
    'algorithm',
    'publicKeyDigest',
    'contractDigest',
    'signature',
  ]);
  const spki = Buffer.from(verifier.publicKeySpkiDer);
  let publicKey: KeyObject;
  try {
    publicKey = createPublicKey({ key: spki, format: 'der', type: 'spki' });
  } catch {
    throw new TypeError('hosted-approval-activation-authorship-key-invalid');
  }
  const actualDigest = `sha256:${createHash('sha256').update(spki).digest('hex')}`;
  if (
    publicKey.type !== 'public' ||
    publicKey.asymmetricKeyType !== 'ed25519' ||
    authorship.algorithm !== HOSTED_APPROVAL_ACTIVATION_AUTHORSHIP_ALGORITHM ||
    authorship.publicKeyDigest !== verifier.publicKeyDigest ||
    authorship.publicKeyDigest !== actualDigest ||
    authorship.contractDigest !== verifier.contractDigest ||
    !ACTIVATION_SHA256.test(verifier.publicKeyDigest) ||
    !ACTIVATION_SHA256.test(verifier.contractDigest) ||
    typeof authorship.signature !== 'string'
  ) {
    throw new TypeError('hosted-approval-activation-authorship-pin-mismatch');
  }
  const signature = Buffer.from(authorship.signature, 'base64url');
  if (
    signature.byteLength !== 64 ||
    signature.toString('base64url') !== authorship.signature ||
    !verify(
      null,
      Buffer.from(
        serializeActivationAuthorshipStatement(
          source,
          verifier.publicKeyDigest,
          verifier.contractDigest
        ),
        'utf8'
      ),
      publicKey,
      signature
    )
  ) {
    throw new TypeError('hosted-approval-activation-authorship-invalid');
  }
}

function serializeActivationAuthorshipStatement(
  envelope: string,
  publicKeyDigest: string,
  contractDigest: string
): string {
  return `{"schemaVersion":1,"algorithm":"${HOSTED_APPROVAL_ACTIVATION_AUTHORSHIP_ALGORITHM}","publicKeyDigest":"${publicKeyDigest}","contractDigest":"${contractDigest}","envelope":${envelope}}`;
}

function parseCanonicalActivationObject(
  source: string,
  keys: readonly string[]
): Record<string, unknown> {
  if (source.length < 2 || source.includes('\n') || source.includes('\r')) {
    throw new TypeError('hosted-approval-activation-publication-invalid');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new TypeError('hosted-approval-activation-publication-invalid');
  }
  const record = orderedActivationRecord(parsed, keys);
  if (JSON.stringify(record) !== source) {
    throw new TypeError('hosted-approval-activation-publication-noncanonical');
  }
  return record;
}

function orderedActivationRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('hosted-approval-activation-object-invalid');
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record);
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    throw new TypeError('hosted-approval-activation-order-invalid');
  }
  return record;
}
