import type {
  HostedActualOwnerIdentity,
  HostedOpenCodeIdentity,
  HostedOwnerIdentity,
  HostedProductIdentity,
  HostedStackLock,
  HostedTrustedReleaseAdapter,
} from './contracts.mjs';

export interface HostedMaterializerInput {
  product: HostedProductIdentity;
  owner: HostedOwnerIdentity;
  openCode: HostedOpenCodeIdentity;
  actualOwner: HostedActualOwnerIdentity;
  contracts: HostedStackLock['contracts'];
  deploymentRecipe: HostedStackLock['deploymentRecipe'];
  evidence: HostedLockEvidence;
}

export interface HostedSourceEvidence {
  repository: string;
  tag: string;
  commitBytes: Uint8Array;
  treeBytes: Uint8Array;
}

export interface HostedProductToolchainEvidence { nodeVersion: string; pnpmVersion: string; pnpmLockBytes: Uint8Array; }
export interface HostedOwnerToolchainEvidence { nodeVersion: string; bunVersion: string; bunLockBytes: Uint8Array; }
export interface HostedOpenCodeToolchainEvidence { bunVersion: string; bunLockBytes: Uint8Array; }

export interface HostedBuildEvidence {
  entryPath: string;
  closureManifestPath: string;
  entryBytes: Uint8Array;
  closureManifestBytes: Uint8Array;
  closureBytes: Uint8Array;
}

export interface HostedArtifactEvidence {
  namespace: string;
  name: string;
  bytes: Uint8Array;
  signatureBytes: Uint8Array;
  subjectBytes: Uint8Array;
}

export interface HostedImageEvidence {
  reference: string;
  manifestBytes: Uint8Array;
}

export interface HostedSignedDocumentEvidence {
  path: string;
  bytes: Uint8Array;
  signatureBytes: Uint8Array;
}

export interface HostedProtocolEvidence {
  version: string;
  bytes: Uint8Array;
  capabilityBytes: Uint8Array;
}

export interface HostedDurableStateEvidence {
  formatVersion: string;
  bytes: Uint8Array;
}

export interface HostedProductEvidence {
  role: 'product';
  source: HostedSourceEvidence;
  toolchain: HostedProductToolchainEvidence;
  build: HostedBuildEvidence;
  artifact: HostedArtifactEvidence;
  image: HostedImageEvidence;
}

export interface HostedOwnerEvidence {
  role: 'owner';
  source: HostedSourceEvidence;
  toolchain: HostedOwnerToolchainEvidence;
  build: HostedBuildEvidence;
  artifact: HostedArtifactEvidence;
  image: HostedImageEvidence;
  sbom: HostedSignedDocumentEvidence;
  attestation: HostedSignedDocumentEvidence;
  protocol: HostedProtocolEvidence;
  durableState: HostedDurableStateEvidence;
  actualOwner: HostedActualOwnerIdentity;
  socketIdentity: HostedActualOwnerIdentity['socketIdentity'];
}

export interface HostedOpenCodeEvidence {
  role: 'openCode';
  source: HostedSourceEvidence;
  toolchain: HostedOpenCodeToolchainEvidence;
  build: HostedBuildEvidence;
  artifact: HostedArtifactEvidence;
  image: HostedImageEvidence;
  sbom: HostedSignedDocumentEvidence;
  attestation: HostedSignedDocumentEvidence;
  protocol: HostedProtocolEvidence;
}

export interface HostedLockEvidence {
  /** The independently observed recipe path; runtime rejects a mixed path. */
  path: string;
  product: HostedProductEvidence;
  owner: HostedOwnerEvidence;
  openCode: HostedOpenCodeEvidence;
  deploymentRecipeBytes: Uint8Array;
  contracts: {
    hostedProducerProvenanceV2Bytes: Uint8Array;
    actualOwnerContractV2Bytes: Uint8Array;
    stackContractBytes: Uint8Array;
  };
  release: {
    payloadBytes: Uint8Array;
    signatureBytes: Uint8Array;
  };
}

export function materializeHostedLockPair(input: HostedMaterializerInput, trustedAdapter: HostedTrustedReleaseAdapter): Promise<{
  ownerBytes: Buffer;
  stackBytes: Buffer;
  ownerSha256: string;
  stackSha256: string;
}>;
export function recomputeHostedLockDigests(ownerBytes: Uint8Array, stackBytes: Uint8Array, evidence: HostedLockEvidence, trustedAdapter: HostedTrustedReleaseAdapter): Promise<{
  ownerSha256: string;
  stackSha256: string;
  productToolchainSha256: string;
  ownerToolchainSha256: string;
  openCodeToolchainSha256: string;
  declaredDigests: Record<string, string>;
}>;
export function materializeHostedLocksAtRoot(root: string, input: HostedMaterializerInput, trustedAdapter: HostedTrustedReleaseAdapter, options?: {
  onStaged?: (details: { stagingRoot: string; temporary: string[] }) => Promise<void> | void;
  onPublished?: (details: { paths: string[] }) => Promise<void> | void;
  /** Test seam invoked after the owned marker is durable and before publication. */
  onMarkerReady?: (details: { markerPath: string }) => Promise<void> | void;
  /** Test/fault-injection seam; cleanup still rolls back through live descriptors. */
  onCleanup?: () => Promise<void> | void;
  /** Post-commit cleanup evidence; its failure is reported in warnings only. */
  onCommittedCleanup?: () => Promise<void> | void;
}): Promise<{
  ownerBytes: Buffer;
  stackBytes: Buffer;
  ownerSha256: string;
  stackSha256: string;
  ownerPath: string;
  stackPath: string;
  /** Required identity binding for the returned generation paths. */
  transactionIdentity: { device: string; inode: string };
  /** Post-commit close/cleanup failures. Publication remains authoritative. */
  warnings: string[];
}>;
