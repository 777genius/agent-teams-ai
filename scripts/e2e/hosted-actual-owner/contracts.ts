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

export const OPENCODE_IDENTITIES = Object.freeze({
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
    producerNativeIdentitiesComposed: false;
  }>;
  readonly refs: Readonly<{
    openCode: string;
    openCodeExecutableSha256: typeof OPENCODE_IDENTITIES.linuxX64BinarySha256;
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
    readonly identities: typeof OPENCODE_IDENTITIES;
    readonly acquisitionReceipt: FilePin;
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
  readonly producers: readonly Readonly<{
    artifactManifestSha256: string;
    executableSha256: string;
    implementationId: string;
    moduleSha256: string;
    role: (typeof ORDERED_PRODUCER_IDENTITIES)[number]['role'];
    sourceCommit: string;
    sourceRepository: string;
    sourceTree: string;
  }>[];
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
    compiledBuildPin: unknown;
    runtimeRef: unknown;
    rehashedExecutable: unknown;
    signedRouteDigests: readonly unknown[];
  }>
): typeof OPENCODE_IDENTITIES.linuxX64BinarySha256 {
  const expected = OPENCODE_IDENTITIES.linuxX64BinarySha256;
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

export function parseActualOwnerRuntimeManifest(value: unknown): ActualOwnerRuntimeManifest {
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
    ],
    'runtime_capture_emission_contract'
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
    captureEmissionContract.producerNativeIdentitiesComposed !== false
  ) {
    throw new TypeError('p3c_runtime_capture_emission_contract');
  }
  const refs = exactRecord(
    item.refs,
    ['openCode', 'openCodeExecutableSha256', 'orchestrator', 'product'],
    'runtime_refs'
  );
  if (
    refs.openCodeExecutableSha256 !== OPENCODE_IDENTITIES.linuxX64BinarySha256 ||
    typeof refs.openCode !== 'string' ||
    !HEX_40.test(refs.openCode) ||
    typeof refs.orchestrator !== 'string' ||
    !HEX_40.test(refs.orchestrator) ||
    typeof refs.product !== 'string' ||
    !HEX_40.test(refs.product)
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
      producerNativeIdentitiesComposed: false,
    }),
    refs: Object.freeze({
      openCode: refs.openCode,
      openCodeExecutableSha256: OPENCODE_IDENTITIES.linuxX64BinarySha256,
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

function exactOpenCodeIdentities(value: unknown): typeof OPENCODE_IDENTITIES {
  const keys = Object.keys(OPENCODE_IDENTITIES);
  const item = exactRecord(value, keys, 'opencode_identities');
  if (canonicalJson(item) !== canonicalJson(OPENCODE_IDENTITIES))
    throw new TypeError('p3c_opencode_identity_pin');
  return OPENCODE_IDENTITIES;
}

export function parseIntegrationDescriptor(bytes: Uint8Array): IntegrationDescriptor {
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
      identities: exactOpenCodeIdentities(openCode.identities),
      acquisitionReceipt: filePin(openCode.acquisitionReceipt, 'opencode_receipt'),
      buildProvenanceBundle: filePin(
        openCode.buildProvenanceBundle,
        'opencode_build_provenance_bundle'
      ),
      releaseManifest: filePin(openCode.releaseManifest, 'opencode_manifest'),
      actionsArtifactZip: filePin(openCode.actionsArtifactZip, 'opencode_zip'),
      linuxX64Archive: filePin(openCode.linuxX64Archive, 'opencode_archive'),
      linuxX64Binary: filePin(openCode.linuxX64Binary, 'opencode_binary'),
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
  if (bytes.length < 2 || bytes.length > 1024 * 1024 || bytes.includes(0x0d)) {
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

export function parseSignedProducerCandidatePayload(bytes: Buffer): SignedProducerCandidatePayload {
  const item = exactRecord(
    parseCanonicalCandidateDocument(bytes, 'producer_candidate'),
    [
      'contract', 'contractSha256', 'producers', 'productionEligible', 'purpose',
      'releaseEligible', 'schemaVersion', 'signedBuildProvenanceRequired',
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
  const producers = item.producers.map((value, index) => {
    const producer = exactRecord(
      value,
      [
        'artifactManifestSha256', 'executableSha256', 'implementationId', 'moduleSha256',
        'role', 'sourceCommit', 'sourceRepository', 'sourceTree',
      ],
      `producer_candidate_producer_${index}`
    );
    const identity = ORDERED_PRODUCER_IDENTITIES[index]!;
    if (
      producer.role !== identity.role ||
      producer.implementationId !== identity.implementationId ||
      typeof producer.sourceRepository !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/u.test(producer.sourceRepository) ||
      typeof producer.sourceCommit !== 'string' ||
      !HEX_40.test(producer.sourceCommit) ||
      typeof producer.sourceTree !== 'string' ||
      !HEX_40.test(producer.sourceTree) ||
      [producer.artifactManifestSha256, producer.executableSha256, producer.moduleSha256].some(
        (digest) => typeof digest !== 'string' || !HEX_64.test(digest)
      )
    ) {
      throw new TypeError(`p3c_producer_candidate_producer_${index}`);
    }
    return Object.freeze(producer) as SignedProducerCandidatePayload['producers'][number];
  });
  return Object.freeze({ ...item, producers: Object.freeze(producers) }) as unknown as SignedProducerCandidatePayload;
}

export function parseProducerCandidateSignatureSidecar(
  bytes: Buffer,
  payloadBytes: Buffer
): ProducerCandidateSignatureSidecar {
  const item = exactRecord(
    parseCanonicalCandidateDocument(bytes, 'producer_candidate_signature'),
    ['algorithm', 'keyId', 'payloadSha256', 'signature'],
    'producer_candidate_signature'
  );
  if (
    item.algorithm !== 'ed25519' ||
    typeof item.keyId !== 'string' ||
    !SAFE_ID.test(item.keyId) ||
    item.payloadSha256 !== sha256(payloadBytes) ||
    typeof item.signature !== 'string' ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(item.signature) ||
    Buffer.from(item.signature, 'base64').length !== 64
  ) {
    throw new TypeError('p3c_producer_candidate_signature');
  }
  return Object.freeze(item) as unknown as ProducerCandidateSignatureSidecar;
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
