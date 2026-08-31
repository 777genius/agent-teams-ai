import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const producerProvenanceContractArtifact = readFileSync(
  resolve(
    process.cwd(),
    'src/features/hosted-producer-provenance/contracts/hosted-producer-provenance-v2.schema.json'
  )
);

export const CONTRACT_PURPOSE = 'agent-teams.p3c.actual-owner-harness/v2' as const;
export const INTEGRATION_PURPOSE = 'agent-teams.p3c.integration-descriptor/v2' as const;
export const RAW_RECORD_PURPOSE = 'agent-teams.p3c.raw-record/v1' as const;
export const P3C1_FREEZE_PURPOSE = 'agent-teams.p3c.p3c1-freeze/v1' as const;
export const HARNESS_REVIEW_PURPOSE = 'agent-teams.p3c.harness-review/v1' as const;
export const ONE_RUN_AUTHORIZATION_PURPOSE =
  'agent-teams.p3c.controller-one-run-authorization/v1' as const;
export const CONSUMED_ATTEMPT_PURPOSE = 'agent-teams.p3c.consumed-attempt/v1' as const;
export const PRODUCER_CANDIDATE_PURPOSE = 'agent-teams.p3c.producer-candidate/v1' as const;
export const GLOBAL_FINAL_RUN_RECORD = 'actual-owner-final-run-000001.json' as const;
export const P3C_LANE = 'P3.C2.FINAL_NO_FAKE_RUN' as const;
export const MAXIMUM_FINAL_RUNS = 1 as const;

export const PRODUCT_AUTHORITY_COMMIT = '85c0850e2fc312b995ba3116f8d4aa46dcb0b1dd' as const;
export const PACKET_BASE_COMMIT = '720fc62768341e1c2960cfaf4ad2496dd008291e' as const;
export const AUDITED_PRODUCT_COMMIT = 'd71671599c062244767494d392575cfacba5e1ff' as const;
export const AUDITED_PRODUCT_TREE = 'af7fa38ec50893550ce14026c39b428f8dbfd1f2' as const;
export const P3B_SOURCE_COMMIT = '459eae38e60a1463ca2b7b077047bc18e4ab3bcc' as const;

/**
 * Historical r0 candidate. It is retained only so admission and evidence can explain why bytes
 * from that superseded candidate are rejected. It is never an accepted descriptor identity.
 */
export const REJECTED_HISTORICAL_OPENCODE_IDENTITIES = Object.freeze({
  pullRequestHead: '9fb0d367a9ff28c63b4b90774c9650c3dec19f80',
  workflowMergeCommit: '6cb3c41e74e70915099ef25904df80684e055e82',
  releaseSourceCommit: '9d715ab06095a130c37202ea54437be180323f52',
  releaseSourceTree: '48ed783507f284923ae537beb2956fb852278a5b',
  releaseBaseCommit: 'ef2880f379129aa048be9e9353e30aa168d42c17',
  workflowRunId: '32981811498',
  workflowRunAttempt: 1,
  workflowRef: 'refs/pull/4/merge',
  artifactId: '9612023097',
  actionsArtifactZipSha256: '0dbe83717768df7ffb3840764d082927552f1c354246ca953e16b9a1117ef932',
  buildProvenanceBundleSha256: 'a9bfa64fe9ea53505b9fa78e04a49459bbed9fec784c4c098e2039608c4fa562',
  releaseManifestSha256: 'ac749763956ddf2c34e31e345ce228fc744eb3d217a8cdfe0bdf162570f7cb5d',
  linuxX64ArchiveSha256: '16de032488890e60c66d90291e2148da556a021590c635e22d3a4ade15b59a61',
  linuxX64BinarySha256: 'cffecbe3ff685de84d7fa028e552c42d15a7c720a8f8d5d1cddd265110e5eb88',
} as const);

/**
 * Canonical repository identity only. Every run-, commit-, artifact-, and digest-level acquisition
 * identity remains future descriptor material until committed authoritative evidence supplies it.
 */
export const REQUIRED_OPENCODE_ACQUISITION = Object.freeze({
  repository: '777genius/opencode-anomaly',
} as const);

export const PRODUCER_CANDIDATE_SIGNATURE_DOMAIN =
  'agent-teams.p3c.producer-candidate-signature/v1\0' as const;

export const PRODUCT_ORIGIN = 'http://127.0.0.1:45131' as const;
export const INTEGRATION_DESCRIPTOR_FD = 3;
export const BROWSER_OBSERVATION_FD = 4;
export const OWNER_CHILD_FDS = Object.freeze({
  sealedLauncherLease: 3,
  bootstrap: 4,
  activationV2: 5,
} as const);
export const OWNER_WRAPPER_ARGUMENT = '--runtime-manifest' as const;
export const OWNER_SEALED_PROTOCOL_ARGUMENT = '--hosted-actual-owner-sealed-protocol=v1' as const;
export const OWNER_CHILD_PROTOCOL = Object.freeze({
  sealedLauncherLease: Object.freeze({
    fd: 3,
    kind: 'sealed-memfd',
    format: 'agent-teams.hosted-control.launcher-lease/v1',
    maximumBytes: 64 * 1024,
    requiredSeals: Object.freeze(['seal', 'shrink', 'grow', 'write'] as const),
    childOwnership: 'retained-until-owner-close',
  }),
  bootstrap: Object.freeze({
    fd: 4,
    kind: 'one-use-stream',
    format: 'agent-teams.hosted-control.bootstrap/v1',
    framing: 'u32be-header-length+canonical-json-header+32-byte-key+32-byte-hmac',
    maximumHeaderBytes: 64 * 1024,
    maximumFrameBytes: 4 + 64 * 1024 + 32 + 32,
    childOwnership: 'close-after-one-frame-eof',
  }),
  activationV2: Object.freeze({
    fd: 5,
    kind: 'connected-stream-socket',
    protocol: 'agent-teams.hosted-approval-activation-v2',
    alreadyAuthenticated: true,
    maximumPrepareBytes: 64 * 1024,
    maximumResponseBytes: 64 * 1024,
    maximumAdmissionBytes: 256 * 1024,
    childOwnership: 'retained-by-activation-lease',
  }),
  parentOwnership: Object.freeze({
    sourceDescriptors: 'arbitrary-distinct-owned',
    closeCopiesAfterSpawn: true,
  }),
} as const);

export const ROOT_NAMES = Object.freeze([
  'harness',
  'toolchain',
  'productRuntime',
  'browserBundle',
  'p3b2',
  'openCode',
  'controllerAuthority',
  'sandboxParent',
  'evidenceRoot',
] as const);
export type RootName = (typeof ROOT_NAMES)[number];

export const MATRIX_ROWS = Object.freeze([
  '01_pending_before_http',
  '02_browser_allow_deny',
  '03_owner_effect_settlement',
  '04_auth_replay_rejections',
  '05_restart_generation_fences',
  '06_ambiguity_reconciliation',
  '07_socket_capability_admission',
  '08_cross_team_isolation',
  '09_forced_failure_shutdown',
  '10_normal_shutdown_cleanup',
] as const);
export type MatrixRow = (typeof MATRIX_ROWS)[number];

export const RAW_ORIGINS = Object.freeze([
  'browser',
  'product-http',
  'product-sse',
  'owner-wal',
  'opencode',
  'supervisor',
] as const);
export type RawOrigin = (typeof RAW_ORIGINS)[number];

export const OWNED_PATHS = Object.freeze([
  'scripts/e2e/hosted-actual-owner/README.md',
  'scripts/e2e/hosted-actual-owner/actual-owner-contract.v2.json',
  'scripts/e2e/hosted-actual-owner/contracts.ts',
  'scripts/e2e/hosted-actual-owner/anchors.ts',
  'scripts/e2e/hosted-actual-owner/secure-files.ts',
  'scripts/e2e/hosted-actual-owner/preflight.ts',
  'scripts/e2e/hosted-actual-owner/sandbox.ts',
  'scripts/e2e/hosted-actual-owner/processes.ts',
  'scripts/e2e/hosted-actual-owner/evidence.ts',
  'scripts/e2e/hosted-actual-owner/driver.ts',
  'scripts/e2e/hosted-actual-owner/run.ts',
  'test/e2e/fixtures/hosted-actual-owner/integration-manifest.unintegrated.json',
  'test/e2e/fixtures/hosted-actual-owner/harness.test.ts',
  'test/e2e/hosted-web/actual-owner-approval.spec.ts',
] as const);

const HEX_40 = /^[0-9a-f]{40}$/u;
const HEX_64 = /^[0-9a-f]{64}$/u;
const HARNESS_RUN_ID = /^[0-9a-f]{64}$/u;
const PRODUCT_RUN_ID = /^run_[0-9a-f]{32}$/u;
const DECIMAL = /^(?:0|[1-9]\d*)$/u;
const SAFE_ID = /^[a-z][a-z0-9._:-]{0,127}$/u;

export const RUNTIME_CAPTURE_NAMES = Object.freeze([
  'conditionalPostLedgerPath',
  'negativeResultsPath',
  'openCodeTimelinePath',
  'ownerWalTimelinePath',
  'productTimelinePath',
  'protectedEffectLedgerPath',
] as const);
export type RuntimeCaptureName = (typeof RUNTIME_CAPTURE_NAMES)[number];

export const PRODUCER_PROVENANCE_CONTRACT = Object.freeze({
  contract: 'claude-team/hosted-producer-provenance' as const,
  version: 2 as const,
  environment: 'CLAUDE_TEAM_PRODUCER_PROVENANCE_V2' as const,
  framing: 'canonical-ndjson' as const,
  maximumLineBytes: 64 * 1024,
  firstRecordType: 'producer-open' as const,
  firstSequence: 0 as const,
  descriptorSlots: Object.freeze({
    ownerWalTimeline: 9,
    conditionalPostLedger: 9,
    productTimeline: 10,
    negativeResults: 9,
    openCodeTimeline: 9,
    protectedEffectLedger: 10,
  }),
});

/** Digest of the exact shared, LF-terminated, repo-neutral contract artifact bytes. */
export const PRODUCER_PROVENANCE_CONTRACT_SHA256 = sha256(
  producerProvenanceContractArtifact
);
if (
  Buffer.byteLength(producerProvenanceContractArtifact) !== 54_393 ||
  PRODUCER_PROVENANCE_CONTRACT_SHA256 !==
    'acde43e62b8ab42cc5fd2bbecc22f1b96d68f456bfa188b8c63730751222f498'
) {
  throw new Error('p3c_producer_provenance_contract_artifact_identity');
}

export const RUNTIME_CAPTURE_STREAMS = Object.freeze({
  conditionalPostLedgerPath: 'conditionalPostLedger',
  negativeResultsPath: 'negativeResults',
  openCodeTimelinePath: 'openCodeTimeline',
  ownerWalTimelinePath: 'ownerWalTimeline',
  productTimelinePath: 'productTimeline',
  protectedEffectLedgerPath: 'protectedEffectLedger',
} as const satisfies Readonly<Record<RuntimeCaptureName, string>>);
export type ProducerProvenanceStream = (typeof RUNTIME_CAPTURE_STREAMS)[RuntimeCaptureName];

export type ProducerRole = 'browser' | 'opencode' | 'owner' | 'product-producer';
export type RuntimeProducerRole = 'browser' | 'opencode' | 'owner' | 'product';

export const RUNTIME_CAPTURE_PRODUCER_MAPPINGS = Object.freeze({
  conditionalPostLedgerPath: Object.freeze({
    role: 'product-producer',
    runtimeRole: 'product',
    stream: 'conditionalPostLedger',
    descriptorSlot: 9,
  }),
  negativeResultsPath: Object.freeze({
    role: 'browser',
    runtimeRole: 'browser',
    stream: 'negativeResults',
    descriptorSlot: 9,
  }),
  openCodeTimelinePath: Object.freeze({
    role: 'opencode',
    runtimeRole: 'opencode',
    stream: 'openCodeTimeline',
    descriptorSlot: 9,
  }),
  ownerWalTimelinePath: Object.freeze({
    role: 'owner',
    runtimeRole: 'owner',
    stream: 'ownerWalTimeline',
    descriptorSlot: 9,
  }),
  productTimelinePath: Object.freeze({
    role: 'product-producer',
    runtimeRole: 'product',
    stream: 'productTimeline',
    descriptorSlot: 10,
  }),
  protectedEffectLedgerPath: Object.freeze({
    role: 'opencode',
    runtimeRole: 'opencode',
    stream: 'protectedEffectLedger',
    descriptorSlot: 10,
  }),
} as const satisfies Readonly<
  Record<
    RuntimeCaptureName,
    Readonly<{
      role: ProducerRole;
      runtimeRole: RuntimeProducerRole;
      stream: ProducerProvenanceStream;
      descriptorSlot: 9 | 10;
    }>
  >
>);

export interface OpenCodeCandidateIdentities {
  readonly repository: typeof REQUIRED_OPENCODE_ACQUISITION.repository;
  readonly pullRequestHead: string;
  readonly workflowMergeCommit: string;
  readonly releaseSourceCommit: string;
  readonly releaseSourceTree: string;
  readonly releaseBaseCommit: string;
  readonly workflowRunId: string;
  readonly workflowRunAttempt: number;
  readonly workflowRef: string;
  readonly candidateArtifactId: string;
  readonly provenanceArtifactId: string;
  readonly candidateArtifactSha256: string;
  readonly provenanceArtifactSha256: string;
  readonly buildProvenanceBundleSha256: string;
  readonly releaseManifestSha256: string;
  readonly linuxX64ArchiveSha256: string;
  readonly linuxX64BinarySha256: string;
}

export interface SignedProducerIdentity {
  readonly artifactManifestSha256: string;
  readonly executableSha256: string;
  readonly implementationId: string;
  readonly moduleSha256: string;
  readonly role: ProducerRole;
  readonly sourceCommit: string;
  readonly sourceRepository: string;
  readonly sourceTree: string;
}

export interface OpenCodeProvenanceIdentity {
  readonly repository: typeof REQUIRED_OPENCODE_ACQUISITION.repository;
  readonly pullRequestHead: string;
  readonly workflowMergeCommit: string;
  readonly releaseSourceCommit: string;
  readonly releaseSourceTree: string;
  readonly releaseBaseCommit: string;
  readonly workflowRunId: string;
  readonly workflowRunAttempt: number;
  readonly workflowRef: string;
  readonly candidateArtifactId: string;
  readonly candidateArtifactSha256: string;
  readonly provenanceArtifactId: string;
  readonly provenanceArtifactSha256: string;
  readonly buildProvenanceBundleSha256: string;
}

export interface VerifiedProducerCandidateBinding {
  readonly purpose: 'agent-teams.p3c.verified-producer-candidate/v1';
  readonly payloadSha256: string;
  readonly signatureSha256: string;
  readonly signerKeyId: string;
  readonly signerPublicKeySha256: string;
  readonly trustAnchorSha256: string;
  readonly openCodeProvenance: OpenCodeProvenanceIdentity;
  readonly producers: readonly SignedProducerIdentity[];
}

export interface ActualOwnerRuntimeManifest {
  readonly schemaVersion: 1;
  readonly purpose: 'agent-teams.hosted-actual-owner-e2e/v1';
  readonly harnessRunId: string;
  readonly sandboxRoot: string;
  readonly markerPath: string;
  readonly evidenceRoot: string;
  readonly capture: Readonly<Record<RuntimeCaptureName, string>>;
  readonly captureEmissionContract: Readonly<{
    contract: typeof PRODUCER_PROVENANCE_CONTRACT.contract;
    version: typeof PRODUCER_PROVENANCE_CONTRACT.version;
    contractSha256: string;
    environment: typeof PRODUCER_PROVENANCE_CONTRACT.environment;
    framing: typeof PRODUCER_PROVENANCE_CONTRACT.framing;
    descriptorSlots: typeof PRODUCER_PROVENANCE_CONTRACT.descriptorSlots;
    verifierMayProduceBytes: false;
    producerNativeIdentitiesComposed: true;
    captureAuthority: 'verified-signed-four-producer-candidate';
    producerCandidate: VerifiedProducerCandidateBinding;
    captureMappings: typeof RUNTIME_CAPTURE_PRODUCER_MAPPINGS;
  }>;
  readonly refs: Readonly<{
    openCode: string;
    openCodeExecutableSha256: string;
    orchestrator: string;
    product: string;
  }>;
}

export interface RootPin {
  readonly path: string;
  readonly device: string;
  readonly inode: string;
  readonly mountId: string;
  readonly mode: 448;
}

export interface FilePin {
  readonly root: RootName;
  readonly relativePath: string;
  readonly sha256: string;
  readonly size: number;
  readonly mode: 256 | 292 | 365;
  readonly device: string;
  readonly inode: string;
  readonly nlink: 1;
}

export interface ClosurePin {
  readonly manifest: FilePin;
  readonly manifestSha256: string;
  readonly merkleRoot: string;
  readonly fileCount: number;
  readonly totalBytes: number;
}

export interface IntegrationDescriptor {
  readonly schemaVersion: 2;
  readonly purpose: typeof INTEGRATION_PURPOSE;
  readonly integrationReady: true;
  readonly executionAuthorized: true;
  readonly controllerNonce: string;
  readonly authority: {
    readonly productAuthorityCommit: typeof PRODUCT_AUTHORITY_COMMIT;
    readonly packetBaseCommit: typeof PACKET_BASE_COMMIT;
    readonly auditedProductCommit: typeof AUDITED_PRODUCT_COMMIT;
    readonly auditedProductTree: typeof AUDITED_PRODUCT_TREE;
  };
  readonly control: {
    readonly lane: typeof P3C_LANE;
    readonly maximumFinalRuns: typeof MAXIMUM_FINAL_RUNS;
    readonly freezeId: string;
    readonly reviewId: string;
    readonly authorizationId: string;
    readonly freeze: FilePin;
    readonly harnessReview: FilePin;
    readonly oneRunAuthorization: FilePin;
    readonly harnessReviewerPublicKey: FilePin;
    readonly runAuthorizationPublicKey: FilePin;
  };
  readonly producerCandidate: {
    readonly payload: FilePin;
    readonly signature: FilePin;
    readonly signerPublicKey: FilePin;
    readonly trustAnchorSha256: string;
  };
  readonly roots: Readonly<Record<RootName, RootPin>>;
  readonly product: {
    readonly finalHarnessCommit: string;
    readonly harnessClosure: ClosurePin;
    readonly runEntry: FilePin;
    readonly runtimeClosure: ClosurePin;
    readonly compositionEntry: FilePin;
    readonly compositionDescriptor: FilePin;
    readonly browserBundle: ClosurePin;
    readonly playwrightEntry: FilePin;
    readonly playwrightConfig: FilePin;
    readonly playwrightSpec: FilePin;
    readonly chromiumExecutable: FilePin;
  };
  readonly toolchain: {
    readonly node: FilePin;
    readonly loader: FilePin;
    readonly closure: ClosurePin;
    readonly nodeVersion: 'v24.16.0';
  };
  readonly p3b2: {
    readonly sourceBaseCommit: typeof P3B_SOURCE_COMMIT;
    readonly resultCommit: string;
    readonly entry: FilePin;
    readonly supervisor: FilePin;
    readonly recipe: FilePin;
    readonly closure: ClosurePin;
    readonly recipeSha256: string;
    readonly independentlyAccepted: true;
  };
  readonly openCode: {
    readonly identities: OpenCodeCandidateIdentities;
    readonly acquisitionReceipt: FilePin;
    readonly provenanceArtifactZip: FilePin;
    readonly buildProvenanceBundle: FilePin;
    readonly releaseManifest: FilePin;
    readonly actionsArtifactZip: FilePin;
    readonly linuxX64Archive: FilePin;
    readonly linuxX64Binary: FilePin;
    readonly signedBuildProvenance: true;
    readonly productionEligible: false;
    readonly releaseEligible: false;
  };
  readonly browser: {
    readonly origin: typeof PRODUCT_ORIGIN;
    readonly descriptor: FilePin;
    readonly workers: 1;
    readonly retries: 0;
  };
  readonly productionGates: {
    readonly productActivation: false;
    readonly orchestratorActivation: false;
    readonly openCodeActivation: false;
    readonly coordinatedActivation: false;
  };
}

export interface RawRecord {
  readonly schemaVersion: 1;
  readonly purpose: typeof RAW_RECORD_PURPOSE;
  readonly controllerNonce: string;
  readonly origin: RawOrigin;
  readonly row: MatrixRow;
  readonly sequence: number;
  readonly monotonicNs: string;
  readonly processStartToken: string;
  readonly recordId: string;
  readonly event: string;
  readonly correlation: string;
  readonly effectCount: number;
  readonly payloadBase64: string;
  readonly payloadSha256: string;
}

export const ORDERED_PRODUCER_IDENTITIES = Object.freeze([
  Object.freeze({ role: 'browser', implementationId: 'agent-teams.product.browser-observer.v1' }),
  Object.freeze({ role: 'opencode', implementationId: 'agent-teams.opencode.hosted-approval.v1' }),
  Object.freeze({ role: 'owner', implementationId: 'agent-teams.orchestrator.hosted-approval-owner.v1' }),
  Object.freeze({
    role: 'product-producer',
    implementationId: 'agent-teams.product.hosted-approval.v1',
  }),
] as const);

export interface SignedProducerCandidatePayload {
  readonly contract: typeof PRODUCER_PROVENANCE_CONTRACT.contract;
  readonly contractSha256: typeof PRODUCER_PROVENANCE_CONTRACT_SHA256;
  readonly openCodeProvenance: OpenCodeProvenanceIdentity;
  readonly producers: readonly SignedProducerIdentity[];
  readonly productionEligible: false;
  readonly purpose: typeof PRODUCER_CANDIDATE_PURPOSE;
  readonly releaseEligible: false;
  readonly schemaVersion: 1;
  readonly signedBuildProvenanceRequired: true;
}

export interface ProducerCandidateSignatureSidecar {
  readonly algorithm: 'ed25519';
  readonly keyId: string;
  readonly payloadSha256: string;
  readonly signature: string;
}

export interface ParsedProducerCandidateSignatureSidecar {
  readonly sidecar: ProducerCandidateSignatureSidecar;
  readonly signatureBytes: Buffer;
}

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string')
    return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypeError('p3c_non_canonical_number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype)
    throw new TypeError('p3c_non_json_value');
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => Buffer.from(left).compare(Buffer.from(right)))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(',')}}`;
}

export function exactRecord(
  value: unknown,
  keys: readonly string[],
  label: string
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError(`p3c_${label}`);
  const item = value as Record<string, unknown>;
  const actual = Object.keys(item).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]))
    throw new TypeError(`p3c_${label}_keys`);
  return item;
}

function text(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) throw new TypeError(`p3c_${label}`);
  return value;
}

export function safeRelativePath(value: unknown, label = 'relative_path'): string {
  const path = text(value, /^[\x21-\x7e]{1,512}$/u, label);
  if (
    path.startsWith('/') ||
    path.endsWith('/') ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new TypeError(`p3c_${label}`);
  return path;
}

export function canonicalAbsolutePath(value: unknown, label = 'absolute_path'): string {
  const path = text(value, /^\/[\x20-\x7e]+$/u, label);
  if (!isAbsolute(path) || resolve(path) !== path || path === '/')
    throw new TypeError(`p3c_${label}`);
  return path;
}

export function parseProductRunId(value: unknown, label = 'product_run_id'): string {
  return text(value, PRODUCT_RUN_ID, label);
}

export function parseHarnessRunId(value: unknown, label = 'harness_run_id'): string {
  return text(value, HARNESS_RUN_ID, label);
}

export function assertRuntimeIdentifierSeparation(
  input: Readonly<{
    productRunId: unknown;
    harnessRunId: unknown;
    controllerNonce: unknown;
  }>
): void {
  const productRunId = parseProductRunId(input.productRunId);
  const harnessRunId = parseHarnessRunId(input.harnessRunId);
  const controllerNonce = text(input.controllerNonce, HEX_64, 'controller_nonce');
  if (
    productRunId.slice('run_'.length) === harnessRunId ||
    productRunId.slice('run_'.length) === controllerNonce ||
    harnessRunId === controllerNonce
  ) {
    throw new TypeError('p3c_runtime_identifier_spliced');
  }
}

export function assertCandidateOpenCodeDigestChain(
  input: Readonly<{
    expectedExecutableSha256: unknown;
    compiledBuildPin: unknown;
    runtimeRef: unknown;
    rehashedExecutable: unknown;
    signedRouteDigests: readonly unknown[];
  }>
): string {
  const expected = text(input.expectedExecutableSha256, HEX_64, 'candidate_opencode_expected_sha');
  if (
    input.compiledBuildPin !== expected ||
    input.runtimeRef !== expected ||
    input.rehashedExecutable !== expected ||
    input.signedRouteDigests.length === 0 ||
    input.signedRouteDigests.some((digest) => digest !== `sha256:${expected}`)
  ) {
    throw new TypeError('p3c_candidate_opencode_digest_chain_mismatch');
  }
  return expected;
}

export function parseActualOwnerRuntimeManifest(
  value: unknown,
  expectedProducerCandidate: VerifiedProducerCandidateBinding
): ActualOwnerRuntimeManifest {
  const item = exactRecord(
    value,
    [
      'schemaVersion',
      'purpose',
      'runId',
      'sandboxRoot',
      'markerPath',
      'evidenceRoot',
      'driverBaseUrl',
      'productBaseUrl',
      'approvalPath',
      'browser',
      'capture',
      'captureEmissionContract',
      'refs',
    ],
    'runtime_manifest'
  );
  if (item.schemaVersion !== 1 || item.purpose !== 'agent-teams.hosted-actual-owner-e2e/v1') {
    throw new TypeError('p3c_runtime_manifest_version');
  }
  const sandboxRoot = canonicalAbsolutePath(item.sandboxRoot, 'runtime_sandbox_root');
  const markerPath = canonicalAbsolutePath(item.markerPath, 'runtime_marker');
  const evidenceRoot = canonicalAbsolutePath(item.evidenceRoot, 'runtime_evidence_root');
  const capture = exactRecord(item.capture, RUNTIME_CAPTURE_NAMES, 'runtime_capture');
  const capturePaths = Object.fromEntries(
    RUNTIME_CAPTURE_NAMES.map((name) => [
      name,
      canonicalAbsolutePath(capture[name], `runtime_capture_${name}`),
    ])
  ) as Record<RuntimeCaptureName, string>;
  const confinedPaths = [markerPath, evidenceRoot, ...Object.values(capturePaths)];
  const captureEmissionContract = exactRecord(
    item.captureEmissionContract,
    [
      'contract',
      'version',
      'contractSha256',
      'environment',
      'framing',
      'descriptorSlots',
      'verifierMayProduceBytes',
      'producerNativeIdentitiesComposed',
      'captureAuthority',
      'producerCandidate',
      'captureMappings',
    ],
    'runtime_capture_emission_contract'
  );
  const producerCandidate = parseVerifiedProducerCandidateBinding(
    captureEmissionContract.producerCandidate
  );
  if (
    confinedPaths.some((path) => {
      const relation = relative(sandboxRoot, path);
      return relation === '' || relation === '..' || relation.startsWith(`..${sep}`);
    }) ||
    new Set(confinedPaths).size !== confinedPaths.length
  ) {
    throw new TypeError('p3c_runtime_capture_not_isolated');
  }
  if (
    captureEmissionContract.contract !== PRODUCER_PROVENANCE_CONTRACT.contract ||
    captureEmissionContract.version !== PRODUCER_PROVENANCE_CONTRACT.version ||
    captureEmissionContract.contractSha256 !== PRODUCER_PROVENANCE_CONTRACT_SHA256 ||
    captureEmissionContract.environment !== PRODUCER_PROVENANCE_CONTRACT.environment ||
    captureEmissionContract.framing !== PRODUCER_PROVENANCE_CONTRACT.framing ||
    canonicalJson(captureEmissionContract.descriptorSlots) !==
      canonicalJson(PRODUCER_PROVENANCE_CONTRACT.descriptorSlots) ||
    captureEmissionContract.verifierMayProduceBytes !== false ||
    captureEmissionContract.producerNativeIdentitiesComposed !== true ||
    captureEmissionContract.captureAuthority !== 'verified-signed-four-producer-candidate' ||
    canonicalJson(captureEmissionContract.captureMappings) !==
      canonicalJson(RUNTIME_CAPTURE_PRODUCER_MAPPINGS) ||
    canonicalJson(producerCandidate) !== canonicalJson(expectedProducerCandidate)
  ) {
    throw new TypeError('p3c_runtime_capture_emission_contract');
  }
  const refs = exactRecord(
    item.refs,
    ['openCode', 'openCodeExecutableSha256', 'orchestrator', 'product'],
    'runtime_refs'
  );
  const openCodeProducer = producerCandidate.producers.find(({ role }) => role === 'opencode')!;
  const ownerProducer = producerCandidate.producers.find(({ role }) => role === 'owner')!;
  const browserProducer = producerCandidate.producers.find(({ role }) => role === 'browser')!;
  if (
    refs.openCodeExecutableSha256 !== openCodeProducer.executableSha256 ||
    refs.openCode !== openCodeProducer.sourceCommit ||
    refs.orchestrator !== ownerProducer.sourceCommit ||
    refs.product !== browserProducer.sourceCommit
  ) {
    throw new TypeError('p3c_runtime_refs_invalid');
  }
  return Object.freeze({
    schemaVersion: 1,
    purpose: 'agent-teams.hosted-actual-owner-e2e/v1',
    harnessRunId: parseHarnessRunId(item.runId),
    sandboxRoot,
    markerPath,
    evidenceRoot,
    capture: Object.freeze(capturePaths),
    captureEmissionContract: Object.freeze({
      contract: PRODUCER_PROVENANCE_CONTRACT.contract,
      version: PRODUCER_PROVENANCE_CONTRACT.version,
      contractSha256: PRODUCER_PROVENANCE_CONTRACT_SHA256,
      environment: PRODUCER_PROVENANCE_CONTRACT.environment,
      framing: PRODUCER_PROVENANCE_CONTRACT.framing,
      descriptorSlots: PRODUCER_PROVENANCE_CONTRACT.descriptorSlots,
      verifierMayProduceBytes: false,
      producerNativeIdentitiesComposed: true,
      captureAuthority: 'verified-signed-four-producer-candidate',
      producerCandidate,
      captureMappings: RUNTIME_CAPTURE_PRODUCER_MAPPINGS,
    }),
    refs: Object.freeze({
      openCode: refs.openCode,
      openCodeExecutableSha256: openCodeProducer.executableSha256,
      orchestrator: refs.orchestrator,
      product: refs.product,
    }),
  });
}

function rootPin(value: unknown, label: string): RootPin {
  const item = exactRecord(value, ['path', 'device', 'inode', 'mountId', 'mode'], label);
  if (item.mode !== 448) throw new TypeError(`p3c_${label}_mode`);
  return Object.freeze({
    path: canonicalAbsolutePath(item.path, `${label}_path`),
    device: text(item.device, DECIMAL, `${label}_device`),
    inode: text(item.inode, DECIMAL, `${label}_inode`),
    mountId: text(item.mountId, DECIMAL, `${label}_mount`),
    mode: 448,
  });
}

function filePin(value: unknown, label: string): FilePin {
  const item = exactRecord(
    value,
    ['root', 'relativePath', 'sha256', 'size', 'mode', 'device', 'inode', 'nlink'],
    label
  );
  if (!ROOT_NAMES.includes(item.root as RootName)) throw new TypeError(`p3c_${label}_root`);
  if (
    !Number.isSafeInteger(item.size) ||
    (item.size as number) < 1 ||
    (item.size as number) > 1024 ** 3
  )
    throw new TypeError(`p3c_${label}_size`);
  if (![0o400, 0o444, 0o555].includes(item.mode as number) || item.nlink !== 1)
    throw new TypeError(`p3c_${label}_metadata`);
  return Object.freeze({
    root: item.root as RootName,
    relativePath: safeRelativePath(item.relativePath, `${label}_path`),
    sha256: text(item.sha256, HEX_64, `${label}_sha`),
    size: item.size as number,
    mode: item.mode as FilePin['mode'],
    device: text(item.device, DECIMAL, `${label}_device`),
    inode: text(item.inode, DECIMAL, `${label}_inode`),
    nlink: 1,
  });
}

function closurePin(value: unknown, label: string): ClosurePin {
  const item = exactRecord(
    value,
    ['manifest', 'manifestSha256', 'merkleRoot', 'fileCount', 'totalBytes'],
    label
  );
  if (
    !Number.isSafeInteger(item.fileCount) ||
    (item.fileCount as number) < 1 ||
    (item.fileCount as number) > 200_000
  )
    throw new TypeError(`p3c_${label}_count`);
  if (
    !Number.isSafeInteger(item.totalBytes) ||
    (item.totalBytes as number) < 1 ||
    (item.totalBytes as number) > 8 * 1024 ** 3
  )
    throw new TypeError(`p3c_${label}_bytes`);
  const manifest = filePin(item.manifest, `${label}_manifest`);
  const manifestSha256 = text(item.manifestSha256, HEX_64, `${label}_manifest_sha`);
  if (manifest.sha256 !== manifestSha256) throw new TypeError(`p3c_${label}_manifest_disagreement`);
  return Object.freeze({
    manifest,
    manifestSha256,
    merkleRoot: text(item.merkleRoot, HEX_64, `${label}_merkle`),
    fileCount: item.fileCount as number,
    totalBytes: item.totalBytes as number,
  });
}

export function assertNotRejectedHistoricalOpenCodeCandidate(
  identities: Readonly<{
    pullRequestHead: string;
    workflowRunId: string;
    candidateArtifactId: string;
    candidateArtifactSha256: string;
    buildProvenanceBundleSha256: string;
    releaseManifestSha256: string;
    linuxX64ArchiveSha256: string;
    linuxX64BinarySha256: string;
  }>
): void {
  const historical = REJECTED_HISTORICAL_OPENCODE_IDENTITIES;
  if (
    identities.pullRequestHead === historical.pullRequestHead ||
    identities.workflowRunId === historical.workflowRunId ||
    identities.candidateArtifactId === historical.artifactId ||
    identities.candidateArtifactSha256 === historical.actionsArtifactZipSha256 ||
    identities.buildProvenanceBundleSha256 === historical.buildProvenanceBundleSha256 ||
    identities.releaseManifestSha256 === historical.releaseManifestSha256 ||
    identities.linuxX64ArchiveSha256 === historical.linuxX64ArchiveSha256 ||
    identities.linuxX64BinarySha256 === historical.linuxX64BinarySha256
  ) {
    throw new TypeError('p3c_rejected_historical_opencode_candidate');
  }
}

function exactOpenCodeIdentities(value: unknown): OpenCodeCandidateIdentities {
  const item = exactRecord(
    value,
    [
      'repository',
      'pullRequestHead',
      'workflowMergeCommit',
      'releaseSourceCommit',
      'releaseSourceTree',
      'releaseBaseCommit',
      'workflowRunId',
      'workflowRunAttempt',
      'workflowRef',
      'candidateArtifactId',
      'provenanceArtifactId',
      'candidateArtifactSha256',
      'provenanceArtifactSha256',
      'buildProvenanceBundleSha256',
      'releaseManifestSha256',
      'linuxX64ArchiveSha256',
      'linuxX64BinarySha256',
    ],
    'opencode_identities'
  );
  const parsed = Object.freeze({
    repository: text(
      item.repository,
      /^777genius\/opencode-anomaly$/u,
      'opencode_repository'
    ) as typeof REQUIRED_OPENCODE_ACQUISITION.repository,
    pullRequestHead: text(
      item.pullRequestHead,
      HEX_40,
      'opencode_pull_request_head'
    ),
    workflowMergeCommit: text(item.workflowMergeCommit, HEX_40, 'opencode_workflow_merge_commit'),
    releaseSourceCommit: text(item.releaseSourceCommit, HEX_40, 'opencode_release_source_commit'),
    releaseSourceTree: text(item.releaseSourceTree, HEX_40, 'opencode_release_source_tree'),
    releaseBaseCommit: text(item.releaseBaseCommit, HEX_40, 'opencode_release_base_commit'),
    workflowRunId: text(
      item.workflowRunId,
      /^[1-9]\d{0,19}$/u,
      'opencode_workflow_run_id'
    ),
    workflowRunAttempt: item.workflowRunAttempt as number,
    workflowRef: text(
      item.workflowRef,
      /^refs\/[A-Za-z0-9._/-]{1,255}$/u,
      'opencode_workflow_ref'
    ),
    candidateArtifactId: text(
      item.candidateArtifactId,
      /^[1-9]\d{0,19}$/u,
      'opencode_candidate_artifact_id'
    ),
    provenanceArtifactId: text(
      item.provenanceArtifactId,
      /^[1-9]\d{0,19}$/u,
      'opencode_provenance_artifact_id'
    ),
    candidateArtifactSha256: text(
      item.candidateArtifactSha256,
      HEX_64,
      'opencode_candidate_artifact_sha'
    ),
    provenanceArtifactSha256: text(
      item.provenanceArtifactSha256,
      HEX_64,
      'opencode_provenance_artifact_sha'
    ),
    buildProvenanceBundleSha256: text(
      item.buildProvenanceBundleSha256,
      HEX_64,
      'opencode_build_provenance_bundle_sha'
    ),
    releaseManifestSha256: text(
      item.releaseManifestSha256,
      HEX_64,
      'opencode_release_manifest_sha'
    ),
    linuxX64ArchiveSha256: text(item.linuxX64ArchiveSha256, HEX_64, 'opencode_archive_sha'),
    linuxX64BinarySha256: text(item.linuxX64BinarySha256, HEX_64, 'opencode_binary_sha'),
  });
  if (
    !Number.isSafeInteger(parsed.workflowRunAttempt) ||
    parsed.workflowRunAttempt < 1 ||
    parsed.workflowRunAttempt > 100
  ) {
    throw new TypeError('p3c_opencode_workflow_run_attempt');
  }
  if (parsed.candidateArtifactId === parsed.provenanceArtifactId) {
    throw new TypeError('p3c_opencode_artifact_id_collapsed');
  }
  if (
    new Set([
      parsed.candidateArtifactSha256,
      parsed.provenanceArtifactSha256,
      parsed.buildProvenanceBundleSha256,
    ]).size !== 3
  ) {
    throw new TypeError('p3c_opencode_provenance_artifact_bundle_identity_collapsed');
  }
  assertNotRejectedHistoricalOpenCodeCandidate(parsed);
  return parsed;
}

function hasRawUtf8Bom(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
}

export function parseIntegrationDescriptor(bytes: Uint8Array): IntegrationDescriptor {
  if (hasRawUtf8Bom(bytes)) throw new TypeError('p3c_descriptor_encoding');
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new TypeError('p3c_descriptor_utf8');
  }
  if (source.includes('\r') || source.startsWith('\ufeff') || source.length > 2 * 1024 * 1024)
    throw new TypeError('p3c_descriptor_encoding');
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new TypeError('p3c_descriptor_json');
  }
  if (canonicalJson(value) !== source) throw new TypeError('p3c_descriptor_noncanonical');
  const top = exactRecord(
    value,
    [
      'schemaVersion',
      'purpose',
      'integrationReady',
      'executionAuthorized',
      'controllerNonce',
      'authority',
      'control',
      'producerCandidate',
      'roots',
      'product',
      'toolchain',
      'p3b2',
      'openCode',
      'browser',
      'productionGates',
    ],
    'descriptor'
  );
  if (
    top.schemaVersion !== 2 ||
    top.purpose !== INTEGRATION_PURPOSE ||
    top.integrationReady !== true ||
    top.executionAuthorized !== true
  )
    throw new TypeError('p3c_descriptor_not_integrated');

  const authority = exactRecord(
    top.authority,
    ['productAuthorityCommit', 'packetBaseCommit', 'auditedProductCommit', 'auditedProductTree'],
    'authority'
  );
  const expectedAuthority = {
    productAuthorityCommit: PRODUCT_AUTHORITY_COMMIT,
    packetBaseCommit: PACKET_BASE_COMMIT,
    auditedProductCommit: AUDITED_PRODUCT_COMMIT,
    auditedProductTree: AUDITED_PRODUCT_TREE,
  } as const;
  if (canonicalJson(authority) !== canonicalJson(expectedAuthority))
    throw new TypeError('p3c_authority_pin');

  const control = exactRecord(
    top.control,
    [
      'lane',
      'maximumFinalRuns',
      'freezeId',
      'reviewId',
      'authorizationId',
      'freeze',
      'harnessReview',
      'oneRunAuthorization',
      'harnessReviewerPublicKey',
      'runAuthorizationPublicKey',
    ],
    'control'
  );
  if (control.lane !== P3C_LANE || control.maximumFinalRuns !== MAXIMUM_FINAL_RUNS)
    throw new TypeError('p3c_wrong_lane_or_run_limit');
  const freezeId = text(control.freezeId, HEX_64, 'freeze_id');
  const reviewId = text(control.reviewId, HEX_64, 'review_id');
  const authorizationId = text(control.authorizationId, HEX_64, 'authorization_id');
  if (new Set([freezeId, reviewId, authorizationId]).size !== 3)
    throw new TypeError('p3c_control_identity_collapsed');
  const harnessReviewerPublicKey = filePin(
    control.harnessReviewerPublicKey,
    'harness_reviewer_public_key'
  );
  const runAuthorizationPublicKey = filePin(
    control.runAuthorizationPublicKey,
    'run_authorization_public_key'
  );
  if (
    harnessReviewerPublicKey.root !== 'controllerAuthority' ||
    runAuthorizationPublicKey.root !== 'controllerAuthority' ||
    harnessReviewerPublicKey.sha256 === runAuthorizationPublicKey.sha256 ||
    (harnessReviewerPublicKey.device === runAuthorizationPublicKey.device &&
      harnessReviewerPublicKey.inode === runAuthorizationPublicKey.inode)
  )
    throw new TypeError('p3c_control_signer_identity_collapsed');

  const producerCandidate = exactRecord(
    top.producerCandidate,
    ['payload', 'signature', 'signerPublicKey', 'trustAnchorSha256'],
    'producer_candidate_descriptor'
  );
  const producerCandidatePayload = filePin(
    producerCandidate.payload,
    'producer_candidate_payload'
  );
  const producerCandidateSignature = filePin(
    producerCandidate.signature,
    'producer_candidate_signature'
  );
  const producerCandidateSignerPublicKey = filePin(
    producerCandidate.signerPublicKey,
    'producer_candidate_signer_public_key'
  );
  const producerCandidateTrustAnchorSha256 = text(
    producerCandidate.trustAnchorSha256,
    HEX_64,
    'producer_candidate_trust_anchor_sha'
  );
  const candidatePins = [
    producerCandidatePayload,
    producerCandidateSignature,
    producerCandidateSignerPublicKey,
  ];
  if (
    candidatePins.some((pin) => pin.root !== 'controllerAuthority') ||
    new Set(candidatePins.map((pin) => pin.sha256)).size !== candidatePins.length ||
    new Set(candidatePins.map((pin) => `${pin.device}:${pin.inode}`)).size !==
      candidatePins.length ||
    candidatePins.some(
      (pin) =>
        pin.sha256 === harnessReviewerPublicKey.sha256 ||
        pin.sha256 === runAuthorizationPublicKey.sha256 ||
        (pin.device === harnessReviewerPublicKey.device &&
          pin.inode === harnessReviewerPublicKey.inode) ||
        (pin.device === runAuthorizationPublicKey.device &&
          pin.inode === runAuthorizationPublicKey.inode)
    )
  ) {
    throw new TypeError('p3c_producer_candidate_file_identity_collapsed');
  }

  const rootsValue = exactRecord(top.roots, ROOT_NAMES, 'roots');
  const roots = Object.fromEntries(
    ROOT_NAMES.map((name) => [name, rootPin(rootsValue[name], `root_${name}`)])
  ) as unknown as Record<RootName, RootPin>;
  const rootBackingIdentities = ROOT_NAMES.map(
    (name) => `${roots[name].device}:${roots[name].inode}`
  );
  if (new Set(rootBackingIdentities).size !== rootBackingIdentities.length)
    throw new TypeError('p3c_root_backing_alias');
  for (let left = 0; left < ROOT_NAMES.length; left += 1) {
    for (let right = left + 1; right < ROOT_NAMES.length; right += 1) {
      const a = roots[ROOT_NAMES[left]].path;
      const b = roots[ROOT_NAMES[right]].path;
      const relation = relative(a, b);
      const reverse = relative(b, a);
      if (
        relation === '' ||
        relation === '..' ||
        !relation.startsWith(`..${sep}`) ||
        reverse === '..' ||
        !reverse.startsWith(`..${sep}`)
      )
        throw new TypeError('p3c_root_overlap');
    }
  }

  const product = exactRecord(
    top.product,
    [
      'finalHarnessCommit',
      'harnessClosure',
      'runEntry',
      'runtimeClosure',
      'compositionEntry',
      'compositionDescriptor',
      'browserBundle',
      'playwrightEntry',
      'playwrightConfig',
      'playwrightSpec',
      'chromiumExecutable',
    ],
    'product'
  );
  const finalHarnessCommit = text(product.finalHarnessCommit, HEX_40, 'final_harness_commit');
  if (finalHarnessCommit === PACKET_BASE_COMMIT || finalHarnessCommit === AUDITED_PRODUCT_COMMIT)
    throw new TypeError('p3c_final_harness_identity_collapsed');
  const toolchain = exactRecord(
    top.toolchain,
    ['node', 'loader', 'closure', 'nodeVersion'],
    'toolchain'
  );
  const node = filePin(toolchain.node, 'toolchain_node');
  const loader = filePin(toolchain.loader, 'toolchain_loader');
  if (
    node.root !== 'toolchain' ||
    node.mode !== 0o555 ||
    loader.root !== 'toolchain' ||
    loader.mode !== 0o444 ||
    toolchain.nodeVersion !== 'v24.16.0'
  )
    throw new TypeError('p3c_toolchain_node');

  const p3b2 = exactRecord(
    top.p3b2,
    [
      'sourceBaseCommit',
      'resultCommit',
      'entry',
      'supervisor',
      'recipe',
      'closure',
      'recipeSha256',
      'independentlyAccepted',
    ],
    'p3b2'
  );
  const p3b2Result = text(p3b2.resultCommit, HEX_40, 'p3b2_result_commit');
  if (
    p3b2.sourceBaseCommit !== P3B_SOURCE_COMMIT ||
    p3b2Result === P3B_SOURCE_COMMIT ||
    p3b2.independentlyAccepted !== true
  )
    throw new TypeError('p3c_p3b2_not_accepted_result');
  const p3b2Recipe = filePin(p3b2.recipe, 'p3b2_recipe_file');
  const p3b2RecipeSha256 = text(p3b2.recipeSha256, HEX_64, 'p3b2_recipe');
  if (p3b2Recipe.sha256 !== p3b2RecipeSha256) throw new TypeError('p3c_p3b2_recipe_disagreement');

  const openCode = exactRecord(
    top.openCode,
    [
      'identities',
      'acquisitionReceipt',
      'provenanceArtifactZip',
      'buildProvenanceBundle',
      'releaseManifest',
      'actionsArtifactZip',
      'linuxX64Archive',
      'linuxX64Binary',
      'signedBuildProvenance',
      'productionEligible',
      'releaseEligible',
    ],
    'opencode'
  );
  if (
    openCode.signedBuildProvenance !== true ||
    openCode.productionEligible !== false ||
    openCode.releaseEligible !== false
  )
    throw new TypeError('p3c_opencode_gate_drift');
  const openCodeIdentities = exactOpenCodeIdentities(openCode.identities);
  const acquisitionReceipt = filePin(openCode.acquisitionReceipt, 'opencode_receipt');
  const provenanceArtifactZip = filePin(
    openCode.provenanceArtifactZip,
    'opencode_provenance_artifact_zip'
  );
  const buildProvenanceBundle = filePin(
    openCode.buildProvenanceBundle,
    'opencode_build_provenance_bundle'
  );
  const releaseManifest = filePin(openCode.releaseManifest, 'opencode_manifest');
  const actionsArtifactZip = filePin(openCode.actionsArtifactZip, 'opencode_zip');
  const linuxX64Archive = filePin(openCode.linuxX64Archive, 'opencode_archive');
  const linuxX64Binary = filePin(openCode.linuxX64Binary, 'opencode_binary');
  const acquiredArtifactFiles = [
    actionsArtifactZip,
    provenanceArtifactZip,
    buildProvenanceBundle,
  ];
  const acquiredArtifactBackingIdentities = acquiredArtifactFiles.map(
    (pin) => `${pin.device}:${pin.inode}`
  );
  if (
    new Set(acquiredArtifactBackingIdentities).size !==
    acquiredArtifactBackingIdentities.length
  ) {
    throw new TypeError('p3c_opencode_artifact_backing_identity_collapsed');
  }
  if (
    openCodeIdentities.candidateArtifactSha256 !== actionsArtifactZip.sha256 ||
    openCodeIdentities.provenanceArtifactSha256 !== provenanceArtifactZip.sha256 ||
    openCodeIdentities.buildProvenanceBundleSha256 !== buildProvenanceBundle.sha256 ||
    openCodeIdentities.releaseManifestSha256 !== releaseManifest.sha256 ||
    openCodeIdentities.linuxX64ArchiveSha256 !== linuxX64Archive.sha256 ||
    openCodeIdentities.linuxX64BinarySha256 !== linuxX64Binary.sha256
  ) {
    throw new TypeError('p3c_opencode_identity_file_pin_disagreement');
  }
  const browser = exactRecord(
    top.browser,
    ['origin', 'descriptor', 'workers', 'retries'],
    'browser'
  );
  if (browser.origin !== PRODUCT_ORIGIN || browser.workers !== 1 || browser.retries !== 0)
    throw new TypeError('p3c_browser_origin_or_workers');
  const gates = exactRecord(
    top.productionGates,
    ['productActivation', 'orchestratorActivation', 'openCodeActivation', 'coordinatedActivation'],
    'production_gates'
  );
  if (Object.values(gates).some((gate) => gate !== false))
    throw new TypeError('p3c_production_gate_drift');

  return Object.freeze({
    schemaVersion: 2,
    purpose: INTEGRATION_PURPOSE,
    integrationReady: true,
    executionAuthorized: true,
    controllerNonce: text(top.controllerNonce, HEX_64, 'controller_nonce'),
    authority: expectedAuthority,
    control: Object.freeze({
      lane: P3C_LANE,
      maximumFinalRuns: MAXIMUM_FINAL_RUNS,
      freezeId,
      reviewId,
      authorizationId,
      freeze: filePin(control.freeze, 'p3c1_freeze'),
      harnessReview: filePin(control.harnessReview, 'harness_review'),
      oneRunAuthorization: filePin(control.oneRunAuthorization, 'one_run_authorization'),
      harnessReviewerPublicKey,
      runAuthorizationPublicKey,
    }),
    producerCandidate: Object.freeze({
      payload: producerCandidatePayload,
      signature: producerCandidateSignature,
      signerPublicKey: producerCandidateSignerPublicKey,
      trustAnchorSha256: producerCandidateTrustAnchorSha256,
    }),
    roots: Object.freeze(roots),
    product: Object.freeze({
      finalHarnessCommit,
      harnessClosure: closurePin(product.harnessClosure, 'harness_closure'),
      runEntry: filePin(product.runEntry, 'harness_run_entry'),
      runtimeClosure: closurePin(product.runtimeClosure, 'product_runtime_closure'),
      compositionEntry: filePin(product.compositionEntry, 'product_composition_entry'),
      compositionDescriptor: filePin(
        product.compositionDescriptor,
        'product_composition_descriptor'
      ),
      browserBundle: closurePin(product.browserBundle, 'product_browser_bundle'),
      playwrightEntry: filePin(product.playwrightEntry, 'playwright_entry'),
      playwrightConfig: filePin(product.playwrightConfig, 'playwright_config'),
      playwrightSpec: filePin(product.playwrightSpec, 'playwright_spec'),
      chromiumExecutable: filePin(product.chromiumExecutable, 'chromium_executable'),
    }),
    toolchain: Object.freeze({
      node,
      loader,
      closure: closurePin(toolchain.closure, 'toolchain_closure'),
      nodeVersion: 'v24.16.0',
    }),
    p3b2: Object.freeze({
      sourceBaseCommit: P3B_SOURCE_COMMIT,
      resultCommit: p3b2Result,
      entry: filePin(p3b2.entry, 'p3b2_entry'),
      supervisor: filePin(p3b2.supervisor, 'p3b2_supervisor'),
      recipe: p3b2Recipe,
      closure: closurePin(p3b2.closure, 'p3b2_closure'),
      recipeSha256: p3b2RecipeSha256,
      independentlyAccepted: true,
    }),
    openCode: Object.freeze({
      identities: openCodeIdentities,
      acquisitionReceipt,
      provenanceArtifactZip,
      buildProvenanceBundle,
      releaseManifest,
      actionsArtifactZip,
      linuxX64Archive,
      linuxX64Binary,
      signedBuildProvenance: true,
      productionEligible: false,
      releaseEligible: false,
    }),
    browser: Object.freeze({
      origin: PRODUCT_ORIGIN,
      descriptor: filePin(browser.descriptor, 'browser_descriptor'),
      workers: 1,
      retries: 0,
    }),
    productionGates: Object.freeze({
      productActivation: false,
      orchestratorActivation: false,
      openCodeActivation: false,
      coordinatedActivation: false,
    }),
  });
}

export function parseRunArguments(arguments_: readonly string[]): void {
  if (arguments_.length !== 0) throw new TypeError('p3c_run_accepts_no_cli_inputs');
}

function parseCanonicalCandidateDocument(bytes: Buffer, label: string): Record<string, unknown> {
  if (
    bytes.length < 2 ||
    bytes.length > 1024 * 1024 ||
    bytes.includes(0x0d) ||
    hasRawUtf8Bom(bytes)
  ) {
    throw new TypeError(`p3c_${label}_frame`);
  }
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new TypeError(`p3c_${label}_json`);
  }
  if (canonicalJson(value) !== source) throw new TypeError(`p3c_${label}_noncanonical`);
  return exactRecord(value, Reflect.ownKeys(value as object) as string[], label);
}

function parseOpenCodeProvenanceIdentity(value: unknown): OpenCodeProvenanceIdentity {
  const item = exactRecord(
    value,
    [
      'repository',
      'pullRequestHead',
      'workflowMergeCommit',
      'releaseSourceCommit',
      'releaseSourceTree',
      'releaseBaseCommit',
      'workflowRunId',
      'workflowRunAttempt',
      'workflowRef',
      'candidateArtifactId',
      'candidateArtifactSha256',
      'provenanceArtifactId',
      'provenanceArtifactSha256',
      'buildProvenanceBundleSha256',
    ],
    'producer_candidate_opencode_provenance'
  );
  if (
    item.repository !== REQUIRED_OPENCODE_ACQUISITION.repository ||
    typeof item.pullRequestHead !== 'string' ||
    !HEX_40.test(item.pullRequestHead) ||
    typeof item.workflowMergeCommit !== 'string' ||
    !HEX_40.test(item.workflowMergeCommit) ||
    typeof item.releaseSourceCommit !== 'string' ||
    !HEX_40.test(item.releaseSourceCommit) ||
    typeof item.releaseSourceTree !== 'string' ||
    !HEX_40.test(item.releaseSourceTree) ||
    typeof item.releaseBaseCommit !== 'string' ||
    !HEX_40.test(item.releaseBaseCommit) ||
    typeof item.workflowRunId !== 'string' ||
    !/^[1-9]\d{0,19}$/u.test(item.workflowRunId) ||
    !Number.isSafeInteger(item.workflowRunAttempt) ||
    (item.workflowRunAttempt as number) < 1 ||
    (item.workflowRunAttempt as number) > 100 ||
    typeof item.workflowRef !== 'string' ||
    !/^refs\/[A-Za-z0-9._/-]{1,255}$/u.test(item.workflowRef) ||
    typeof item.candidateArtifactId !== 'string' ||
    !/^[1-9]\d{0,19}$/u.test(item.candidateArtifactId) ||
    typeof item.provenanceArtifactId !== 'string' ||
    !/^[1-9]\d{0,19}$/u.test(item.provenanceArtifactId) ||
    item.candidateArtifactId === item.provenanceArtifactId ||
    typeof item.candidateArtifactSha256 !== 'string' ||
    !HEX_64.test(item.candidateArtifactSha256) ||
    typeof item.provenanceArtifactSha256 !== 'string' ||
    !HEX_64.test(item.provenanceArtifactSha256) ||
    typeof item.buildProvenanceBundleSha256 !== 'string' ||
    !HEX_64.test(item.buildProvenanceBundleSha256) ||
    new Set([
      item.candidateArtifactSha256,
      item.provenanceArtifactSha256,
      item.buildProvenanceBundleSha256,
    ]).size !== 3
  ) {
    throw new TypeError('p3c_producer_candidate_opencode_provenance');
  }
  return Object.freeze(item) as unknown as OpenCodeProvenanceIdentity;
}

function parseProducerIdentities(
  value: unknown,
  label: string
): readonly SignedProducerIdentity[] {
  if (!Array.isArray(value) || value.length !== ORDERED_PRODUCER_IDENTITIES.length) {
    throw new TypeError(`p3c_${label}_contract`);
  }
  const producerRoles = value.map((candidate) =>
    candidate && typeof candidate === 'object' && !Array.isArray(candidate)
      ? (candidate as Record<string, unknown>).role
      : undefined
  );
  const requiredRoles = ORDERED_PRODUCER_IDENTITIES.map(({ role }) => role);
  if (
    new Set(producerRoles).size !== requiredRoles.length ||
    canonicalJson([...producerRoles].sort()) !== canonicalJson([...requiredRoles].sort())
  ) {
    throw new TypeError(`p3c_${label}_roles`);
  }
  const repositories = Object.freeze({
    browser: '777genius/agent-teams-ai',
    opencode: REQUIRED_OPENCODE_ACQUISITION.repository,
    owner: '777genius/agent_teams_orchestrator',
    'product-producer': '777genius/agent-teams-ai',
  } as const);
  const producers = value.map((candidate, index) => {
    const producer = exactRecord(
      candidate,
      [
        'artifactManifestSha256', 'executableSha256', 'implementationId', 'moduleSha256',
        'role', 'sourceCommit', 'sourceRepository', 'sourceTree',
      ],
      `${label}_producer_${index}`
    );
    const identity = ORDERED_PRODUCER_IDENTITIES[index]!;
    if (
      producer.role !== identity.role ||
      producer.implementationId !== identity.implementationId ||
      producer.sourceRepository !== repositories[identity.role] ||
      typeof producer.sourceCommit !== 'string' ||
      !HEX_40.test(producer.sourceCommit) ||
      typeof producer.sourceTree !== 'string' ||
      !HEX_40.test(producer.sourceTree) ||
      [producer.artifactManifestSha256, producer.executableSha256, producer.moduleSha256].some(
        (digest) => typeof digest !== 'string' || !HEX_64.test(digest)
      )
    ) {
      throw new TypeError(`p3c_${label}_producer_${index}`);
    }
    return Object.freeze(producer) as unknown as SignedProducerIdentity;
  });
  const nativeIdentities = producers.map((producer) =>
    canonicalJson({
      artifactManifestSha256: producer.artifactManifestSha256,
      executableSha256: producer.executableSha256,
      moduleSha256: producer.moduleSha256,
    })
  );
  if (
    new Set(producers.map(({ role }) => role)).size !== producers.length ||
    new Set(producers.map(({ implementationId }) => implementationId)).size !== producers.length ||
    new Set(nativeIdentities).size !== producers.length
  ) {
    throw new TypeError(`p3c_${label}_identity_collapsed`);
  }
  return Object.freeze(producers);
}

export function parseSignedProducerCandidatePayload(
  bytes: Buffer
): SignedProducerCandidatePayload {
  const item = exactRecord(
    parseCanonicalCandidateDocument(bytes, 'producer_candidate'),
    [
      'contract',
      'contractSha256',
      'openCodeProvenance',
      'producers',
      'productionEligible',
      'purpose',
      'releaseEligible',
      'schemaVersion',
      'signedBuildProvenanceRequired',
    ],
    'producer_candidate'
  );
  if (
    item.contract !== PRODUCER_PROVENANCE_CONTRACT.contract ||
    item.contractSha256 !== PRODUCER_PROVENANCE_CONTRACT_SHA256 ||
    item.productionEligible !== false ||
    item.purpose !== PRODUCER_CANDIDATE_PURPOSE ||
    item.releaseEligible !== false ||
    item.schemaVersion !== 1 ||
    item.signedBuildProvenanceRequired !== true ||
    !Array.isArray(item.producers) ||
    item.producers.length !== ORDERED_PRODUCER_IDENTITIES.length
  ) {
    throw new TypeError('p3c_producer_candidate_contract');
  }
  const openCodeProvenance = parseOpenCodeProvenanceIdentity(item.openCodeProvenance);
  const producers = parseProducerIdentities(item.producers, 'producer_candidate');
  return Object.freeze({
    ...item,
    openCodeProvenance,
    producers,
  }) as unknown as SignedProducerCandidatePayload;
}

export function parseProducerCandidateSignatureSidecar(
  bytes: Buffer,
  payloadBytes: Buffer
): ProducerCandidateSignatureSidecar {
  return parseProducerCandidateSignatureSidecarWithBytes(bytes, payloadBytes).sidecar;
}

export function parseProducerCandidateSignatureSidecarWithBytes(
  bytes: Buffer,
  payloadBytes: Buffer
): ParsedProducerCandidateSignatureSidecar {
  const item = exactRecord(
    parseCanonicalCandidateDocument(bytes, 'producer_candidate_signature'),
    ['algorithm', 'keyId', 'payloadSha256', 'signature'],
    'producer_candidate_signature'
  );
  const signatureBytes =
    typeof item.signature === 'string' &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(item.signature)
      ? Buffer.from(item.signature, 'base64')
      : undefined;
  if (
    item.algorithm !== 'ed25519' ||
    typeof item.keyId !== 'string' ||
    !HEX_64.test(item.keyId) ||
    item.payloadSha256 !== sha256(payloadBytes) ||
    signatureBytes === undefined ||
    signatureBytes.length !== 64 ||
    signatureBytes.toString('base64') !== item.signature
  ) {
    throw new TypeError('p3c_producer_candidate_signature');
  }
  const sidecar = Object.freeze(item) as unknown as ProducerCandidateSignatureSidecar;
  return Object.freeze({ sidecar, signatureBytes });
}

export function parseVerifiedProducerCandidateBinding(
  value: unknown
): VerifiedProducerCandidateBinding {
  const item = exactRecord(
    value,
    [
      'purpose',
      'payloadSha256',
      'signatureSha256',
      'signerKeyId',
      'signerPublicKeySha256',
      'trustAnchorSha256',
      'openCodeProvenance',
      'producers',
    ],
    'verified_producer_candidate'
  );
  if (
    item.purpose !== 'agent-teams.p3c.verified-producer-candidate/v1' ||
    typeof item.payloadSha256 !== 'string' ||
    !HEX_64.test(item.payloadSha256) ||
    typeof item.signatureSha256 !== 'string' ||
    !HEX_64.test(item.signatureSha256) ||
    typeof item.signerKeyId !== 'string' ||
    !HEX_64.test(item.signerKeyId) ||
    typeof item.signerPublicKeySha256 !== 'string' ||
    !HEX_64.test(item.signerPublicKeySha256) ||
    typeof item.trustAnchorSha256 !== 'string' ||
    !HEX_64.test(item.trustAnchorSha256)
  ) {
    throw new TypeError('p3c_verified_producer_candidate_identity');
  }
  const openCodeProvenance = parseOpenCodeProvenanceIdentity(item.openCodeProvenance);
  const producers = parseProducerIdentities(item.producers, 'verified_producer_candidate');
  return Object.freeze({
    purpose: 'agent-teams.p3c.verified-producer-candidate/v1',
    payloadSha256: item.payloadSha256,
    signatureSha256: item.signatureSha256,
    signerKeyId: item.signerKeyId,
    signerPublicKeySha256: item.signerPublicKeySha256,
    trustAnchorSha256: item.trustAnchorSha256,
    openCodeProvenance,
    producers,
  });
}

export function validateRecordId(value: unknown, label: string): string {
  return text(value, HEX_64, label);
}

export function validateSafeId(value: unknown, label: string): string {
  return text(value, SAFE_ID, label);
}

export function validateDecimal(value: unknown, label: string): string {
  return text(value, DECIMAL, label);
}
