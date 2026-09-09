export const OWNER_LOCK_FILENAME: 'hosted-lifecycle-owner.lock.json';
export const STACK_LOCK_FILENAME: 'hosted-stack.lock.json';
export const OWNER_LOCK_TYPE: 'hosted-lifecycle-owner';
export const STACK_LOCK_TYPE: 'hosted-stack';
export const LOCK_SCHEMA_VERSION: 1;
export const MAX_LOCK_BYTES: number;
export const LEGACY_HOSTED_OWNER_LOCK_FILENAME: 'hosted-lifecycle-owner-runtime.lock.json';

export interface HostedSourceIdentity {
  repository: string;
  commit: string;
  tree: string;
  tag: string;
}

export interface HostedBuildIdentity {
  entryPath: string;
  entrySha256: string;
  closureManifestPath: string;
  closureManifestSha256: string;
  closureSha256: string;
}

export interface HostedArtifactIdentity {
  namespace: string;
  name: string;
  sha256: string;
  signatureSha256: string;
}

export interface HostedImageIdentity {
  reference: string;
  digest: string;
}

export interface HostedSignedDocumentIdentity {
  path: string;
  sha256: string;
  signatureSha256: string;
}

export interface HostedProtocolIdentity {
  version: string;
  digest: string;
  capabilityDigest: string;
  capabilities: string[];
}

export interface HostedEligibility {
  temporaryRuntime: true;
  productionEligible: false;
  releaseEligible: false;
}

export interface HostedOwnerToolchain {
  nodeVersion: string;
  bunVersion: string;
  bunLockSha256: string;
}

export interface HostedOwnerIdentity {
  source: HostedSourceIdentity;
  toolchain: HostedOwnerToolchain;
  build: HostedBuildIdentity;
  artifact: HostedArtifactIdentity;
  image: HostedImageIdentity;
  sbom: HostedSignedDocumentIdentity;
  attestation: HostedSignedDocumentIdentity;
  protocol: HostedProtocolIdentity;
  durableState: {
    formatVersion: string;
    compatibilityDigest: string;
  };
  eligibility: HostedEligibility;
}

export interface HostedOwnerLock extends HostedOwnerIdentity {
  schemaVersion: typeof LOCK_SCHEMA_VERSION;
  lockType: typeof OWNER_LOCK_TYPE;
}

export interface HostedProductIdentity {
  source: HostedSourceIdentity;
  toolchain: {
    nodeVersion: string;
    pnpmVersion: string;
    pnpmLockSha256: string;
  };
  build: HostedBuildIdentity;
  artifact: HostedArtifactIdentity;
  image: HostedImageIdentity;
}

export interface HostedOpenCodeIdentity {
  source: HostedSourceIdentity;
  toolchain: {
    bunVersion: string;
    bunLockSha256: string;
  };
  build: HostedBuildIdentity;
  artifact: HostedArtifactIdentity;
  image: HostedImageIdentity;
  sbom: HostedSignedDocumentIdentity;
  attestation: HostedSignedDocumentIdentity;
  protocol: HostedProtocolIdentity;
}

export interface HostedStackLock {
  schemaVersion: typeof LOCK_SCHEMA_VERSION;
  lockType: typeof STACK_LOCK_TYPE;
  product: HostedProductIdentity;
  owner: HostedOwnerIdentity & { lockSha256: string };
  openCode: HostedOpenCodeIdentity;
  contracts: {
    hostedProducerProvenanceV2Sha256: string;
    actualOwnerContractV2Sha256: string;
    stackContractSha256: string;
  };
  toolchains: {
    productSha256: string;
    ownerSha256: string;
    openCodeSha256: string;
  };
  deploymentRecipe: {
    path: string;
    sha256: string;
  };
  eligibility: HostedEligibility;
}

export function canonicalJsonBytes(value: unknown): Buffer;
export function sha256Digest(bytes: Uint8Array): string;
export function parseOwnerLock(bytes: Uint8Array): HostedOwnerLock;
export function parseStackLock(bytes: Uint8Array): HostedStackLock;
export function verifyHostedLockPair(
  ownerBytes: Uint8Array,
  stackBytes: Uint8Array
): { owner: HostedOwnerLock; stack: HostedStackLock };
