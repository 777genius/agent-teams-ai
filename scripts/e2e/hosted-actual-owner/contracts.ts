import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export const CONTRACT_PURPOSE = 'agent-teams.p3c.actual-owner-harness/v2' as const;
export const INTEGRATION_PURPOSE = 'agent-teams.p3c.integration-descriptor/v2' as const;
export const RAW_RECORD_PURPOSE = 'agent-teams.p3c.raw-record/v1' as const;
export const P3C1_FREEZE_PURPOSE = 'agent-teams.p3c.p3c1-freeze/v1' as const;
export const HARNESS_REVIEW_PURPOSE = 'agent-teams.p3c.harness-review/v1' as const;
export const ONE_RUN_AUTHORIZATION_PURPOSE =
  'agent-teams.p3c.controller-one-run-authorization/v1' as const;
export const CONSUMED_ATTEMPT_PURPOSE = 'agent-teams.p3c.consumed-attempt/v1' as const;
export const P3C_LANE = 'P3.C2.FINAL_NO_FAKE_RUN' as const;

export const PRODUCT_AUTHORITY_COMMIT = '666a4d89ce68f52984e08a857f6abfeda2931cb4' as const;
export const PACKET_BASE_COMMIT = '720fc62768341e1c2960cfaf4ad2496dd008291e' as const;
export const AUDITED_PRODUCT_COMMIT = 'd71671599c062244767494d392575cfacba5e1ff' as const;
export const AUDITED_PRODUCT_TREE = 'af7fa38ec50893550ce14026c39b428f8dbfd1f2' as const;
export const P3B_SOURCE_COMMIT = '06e5dd89aee920c6e3ecd8ff0efbfcf5135021b7' as const;

export const OPENCODE_IDENTITIES = Object.freeze({
  pullRequestHead: 'fe07feb2f6c1a1d58ffb65d2f269c8fb3de4ca8f',
  workflowMergeCommit: '2cbaa3f8d7f130ba41f07aab114a76f08cc311f1',
  releaseSourceCommit: '3186244c3103eb02d95a255b593847b14488b070',
  releaseSourceTree: '8fba45aecd63ec61f334a856694cbd3da037df90',
  releaseBaseCommit: '47b6b6f5f4f9b42d2bce7af1c4e5bf6efaf22ba7',
  workflowRunId: '32784750815',
  workflowRunAttempt: 1,
  workflowRef: 'refs/pull/4/merge',
  artifactId: '9541196940',
  actionsArtifactZipSha256: '601e3bf7713ff4180d449cc788e6000a2b706fb01f7cd11647379ab45c004b0c',
  releaseManifestSha256: '076dd096b36e34c47ad789c7b492d6b510f9b89cca9e6604f6fd0431c02d99fd',
  linuxX64ArchiveSha256: 'fb1a48abaa25c412134c684f2c5b7ffa4fafd16d68c717fe0ede3ee655123308',
  linuxX64BinarySha256: '4947f69d85d491b5f73ef1c9306a5ef69c2991800fbd40f05f2b15a53f57299e',
} as const);

export const PRODUCT_ORIGIN = 'http://127.0.0.1:45131' as const;
export const INTEGRATION_DESCRIPTOR_FD = 3;
export const BROWSER_OBSERVATION_FD = 4;

export const ROOT_NAMES = Object.freeze([
  'harness',
  'toolchain',
  'productRuntime',
  'browserBundle',
  'p3b2',
  'openCode',
  'controllerAuthority',
  'attemptLedger',
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
const DECIMAL = /^(?:0|[1-9]\d*)$/u;
const SAFE_ID = /^[a-z][a-z0-9._:-]{0,127}$/u;

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
    readonly releaseManifest: FilePin;
    readonly actionsArtifactZip: FilePin;
    readonly linuxX64Archive: FilePin;
    readonly linuxX64Binary: FilePin;
    readonly signedBuildProvenance: false;
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
  if (control.lane !== P3C_LANE) throw new TypeError('p3c_wrong_lane');
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
    openCode.signedBuildProvenance !== false ||
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
      releaseManifest: filePin(openCode.releaseManifest, 'opencode_manifest'),
      actionsArtifactZip: filePin(openCode.actionsArtifactZip, 'opencode_zip'),
      linuxX64Archive: filePin(openCode.linuxX64Archive, 'opencode_archive'),
      linuxX64Binary: filePin(openCode.linuxX64Binary, 'opencode_binary'),
      signedBuildProvenance: false,
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

export function validateRecordId(value: unknown, label: string): string {
  return text(value, HEX_64, label);
}

export function validateSafeId(value: unknown, label: string): string {
  return text(value, SAFE_ID, label);
}

export function validateDecimal(value: unknown, label: string): string {
  return text(value, DECIMAL, label);
}
