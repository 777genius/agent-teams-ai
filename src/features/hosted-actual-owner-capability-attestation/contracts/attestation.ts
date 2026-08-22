export const HOSTED_ACTUAL_OWNER_CAPABILITY_ATTESTATION_SCHEMA_VERSION = 1 as const;
export const HOSTED_ACTUAL_OWNER_CAPABILITY_ATTESTATION_PURPOSE =
  'agent-teams.hosted-actual-owner.external-writer-capability-attestation/v1' as const;
export const HOSTED_ACTUAL_OWNER_CAPABILITY_ATTESTATION_ISSUER = 'product' as const;
export const HOSTED_ACTUAL_OWNER_CAPABILITY_ATTESTATION_ALGORITHM = 'ed25519' as const;
export const HOSTED_ACTUAL_OWNER_CAPABILITY_ATTESTATION_AUDIENCE = 'orchestrator' as const;
export const HOSTED_ACTUAL_OWNER_CAPABILITY_ATTESTATION_DOMAIN =
  'agent-teams.hosted-actual-owner.external-writer-capability-attestation/v1' as const;
export const HOSTED_ACTUAL_OWNER_CAPABILITY_ATTESTATION_MAX_LIFETIME_MS = 5_000 as const;
export const HOSTED_ACTUAL_OWNER_CAPABILITY_ATTESTATION_MAX_BYTES = 16_384 as const;
export const HOSTED_ACTUAL_OWNER_CAPABILITY_ATTESTATION_CONTRACT_SHA256 =
  'c4304b8eb1ed77145141390294575f403c9f041c6ff6ad5b6f9f21f8b1b9d39e' as const;
export const HOSTED_ACTUAL_OWNER_FROZEN_TRANSITION_SHA256 =
  HOSTED_ACTUAL_OWNER_CAPABILITY_ATTESTATION_CONTRACT_SHA256;

export interface HostedActualOwnerSocketIdentity {
  readonly device: string;
  readonly inode: string;
}

export interface HostedActualOwnerExternalWriterCapabilityAttestationSubject {
  readonly runId: string;
  readonly teamId: string;
  readonly sessionId: string;
  readonly productPid: number;
  readonly productCommit: string;
  readonly orchestratorCommit: string;
  readonly openCodeCommit: string;
  readonly productExecutableSha256: string;
  readonly sourceClosureSha256: string;
  readonly buildProvenanceSha256: string;
  readonly ownerContractSha256: string;
  readonly frozenTransitionSha256: typeof HOSTED_ACTUAL_OWNER_FROZEN_TRANSITION_SHA256;
  readonly manifestSha256: string;
  readonly driverSocketIdentity: HostedActualOwnerSocketIdentity;
  readonly productSocketIdentity: HostedActualOwnerSocketIdentity;
  readonly routeDigest: string;
  readonly captureDigest: string;
}

export interface HostedActualOwnerExternalWriterCapability {
  readonly name: 'hosted-actual-owner-external-writer';
  readonly descriptorDelivery: 'one-use';
}

export interface HostedActualOwnerExternalWriterCapabilityAttestationUnsigned {
  readonly schemaVersion: typeof HOSTED_ACTUAL_OWNER_CAPABILITY_ATTESTATION_SCHEMA_VERSION;
  readonly purpose: typeof HOSTED_ACTUAL_OWNER_CAPABILITY_ATTESTATION_PURPOSE;
  readonly issuer: typeof HOSTED_ACTUAL_OWNER_CAPABILITY_ATTESTATION_ISSUER;
  readonly keyId: string;
  readonly algorithm: typeof HOSTED_ACTUAL_OWNER_CAPABILITY_ATTESTATION_ALGORITHM;
  readonly subject: HostedActualOwnerExternalWriterCapabilityAttestationSubject;
  readonly audience: typeof HOSTED_ACTUAL_OWNER_CAPABILITY_ATTESTATION_AUDIENCE;
  readonly issuedAtMs: number;
  readonly notBeforeMs: number;
  readonly expiresAtMs: number;
  readonly nonce: string;
  readonly capability: HostedActualOwnerExternalWriterCapability;
}

export interface HostedActualOwnerExternalWriterCapabilityAttestation extends HostedActualOwnerExternalWriterCapabilityAttestationUnsigned {
  readonly signature: string;
}

export interface HostedActualOwnerCapabilityAttestationIssueInput {
  readonly subject: HostedActualOwnerExternalWriterCapabilityAttestationSubject;
  readonly issuedAtMs?: number;
  readonly notBeforeMs?: number;
  readonly lifetimeMs?: number;
}

/** Public-key material and signed bytes suitable for a future one-use descriptor frame. */
export interface HostedActualOwnerCapabilityAttestationDescriptor {
  readonly publicKey: string;
  readonly attestation: HostedActualOwnerExternalWriterCapabilityAttestation;
  readonly canonicalBytes: Uint8Array;
}

export interface HostedActualOwnerCapabilityAttestationIssuer {
  readonly keyId: string;
  readonly publicKey: string;
  issue(
    input: HostedActualOwnerCapabilityAttestationIssueInput
  ): HostedActualOwnerCapabilityAttestationDescriptor;
  dispose(): void;
}
