import { constants, fstat, read, type BigIntStats } from 'node:fs';
import { open, readFile, readdir, realpath } from 'node:fs/promises';
import { X509Certificate, createPublicKey, verify as verifySignature } from 'node:crypto';

import {
  assertRootCurrent,
  closeAnchors,
  openFileAnchor,
  openRootAnchor,
  procFdPath,
  type FileAnchor,
  type RootAnchor,
} from './anchors';
import {
  BROWSER_OBSERVATION_FD,
  CONSUMED_ATTEMPT_PURPOSE,
  GLOBAL_FINAL_RUN_RECORD,
  HARNESS_REVIEW_PURPOSE,
  INTEGRATION_DESCRIPTOR_FD,
  MATRIX_ROWS,
  MAXIMUM_FINAL_RUNS,
  ONE_RUN_AUTHORIZATION_PURPOSE,
  OPENCODE_IDENTITIES,
  P3C1_FREEZE_PURPOSE,
  P3C_LANE,
  PRODUCT_ORIGIN,
  ROOT_NAMES,
  canonicalJson,
  exactRecord,
  parseIntegrationDescriptor,
  sha256,
  type FilePin,
  type IntegrationDescriptor,
  type RootName,
} from './contracts';
import {
  readStable,
  verifyClosure,
  verifyStableDigest,
  type ClosureEvidence,
  type WrittenFileEvidence,
  writeExclusive,
} from './secure-files';

const MAX_DESCRIPTOR_BYTES = 2 * 1024 * 1024;
const DESCRIPTOR_FIFO_TIMEOUT_MS = 5_000;
const FIFO_NONBLOCK_FLAG = 0o4000;
const CONTROLLER_TRUST_ANCHOR_ENV = 'AGENT_TEAMS_P3C_CONTROLLER_TRUST_ANCHOR';
export const DESCRIPTOR_FIFO_POLICY = Object.freeze({
  mode: 0o600,
  nlink: 1,
  nonblockFlag: FIFO_NONBLOCK_FLAG,
  maximumOpenReadMs: DESCRIPTOR_FIFO_TIMEOUT_MS,
});

function exactText(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`p3c_${label}`);
  return value;
}

export function descriptorFifoPolicyAccepts(mode: number, nlink: number, flags: number): boolean {
  return (
    mode === DESCRIPTOR_FIFO_POLICY.mode &&
    nlink === DESCRIPTOR_FIFO_POLICY.nlink &&
    (flags & 0o3) === 0 &&
    (flags & DESCRIPTOR_FIFO_POLICY.nonblockFlag) !== 0
  );
}

function statFd(fd: number): Promise<BigIntStats> {
  return new Promise((resolve, reject) => {
    fstat(fd, { bigint: true }, (error, stat) => (error ? reject(error) : resolve(stat)));
  });
}

function readFd(fd: number, buffer: Buffer, position: number | null): Promise<number> {
  return new Promise((resolve, reject) => {
    read(fd, buffer, 0, buffer.length, position, (error, bytesRead) =>
      error ? reject(error) : resolve(bytesRead)
    );
  });
}

export interface PreflightAdmission {
  readonly descriptor: IntegrationDescriptor;
  readonly roots: Readonly<Record<RootName, RootAnchor>>;
  readonly closures: Readonly<{
    harness: ClosureEvidence;
    toolchain: ClosureEvidence;
    productRuntime: ClosureEvidence;
    browserBundle: ClosureEvidence;
    p3b2: ClosureEvidence;
  }>;
  readonly execution: Readonly<{
    ownerEntry: FileAnchor;
    supervisor: FileAnchor;
    openCode: FileAnchor;
    browserDescriptor: FileAnchor;
    productCompositionDescriptor: FileAnchor;
  }>;
  readonly control: Readonly<{
    freezeId: string;
    reviewId: string;
    authorizationId: string;
  }>;
}

async function readDescriptorFd(fd: number): Promise<Buffer> {
  const before = await statFd(fd);
  const expectedUid = process.getuid?.();
  const expectedGid = process.getgid?.();
  const privateRegular =
    before.isFile() && before.nlink === 1n && Number(before.mode & 0o777n) === 0o400;
  const fdInfo = await readFile(`/proc/self/fdinfo/${fd}`, 'utf8');
  const flags = fdInfo.match(/^flags:\s+([0-7]+)$/mu);
  const parsedFlags = flags ? Number.parseInt(flags[1], 8) : -1;
  const privateFifo =
    before.isFIFO() &&
    descriptorFifoPolicyAccepts(Number(before.mode & 0o777n), Number(before.nlink), parsedFlags);
  if (
    (!privateRegular && !privateFifo) ||
    expectedUid === undefined ||
    expectedGid === undefined ||
    before.uid !== BigInt(expectedUid) ||
    before.gid !== BigInt(expectedGid) ||
    !flags ||
    (parsedFlags & 0o3) !== 0
  )
    throw new Error('p3c_descriptor_fd_type');
  const chunks: Buffer[] = [];
  let total = 0;
  let position: number | null = before.isFile() ? 0 : null;
  const deadline = Date.now() + DESCRIPTOR_FIFO_TIMEOUT_MS;
  for (;;) {
    const chunk = Buffer.alloc(Math.min(64 * 1024, MAX_DESCRIPTOR_BYTES + 1 - total));
    let bytesRead: number;
    try {
      bytesRead = await readFd(fd, chunk, position);
    } catch (error) {
      if (
        privateFifo &&
        (error as NodeJS.ErrnoException).code === 'EAGAIN' &&
        Date.now() < deadline
      ) {
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
        continue;
      }
      throw error;
    }
    if (bytesRead === 0) break;
    chunks.push(chunk.subarray(0, bytesRead));
    total += bytesRead;
    if (total > MAX_DESCRIPTOR_BYTES) throw new Error('p3c_descriptor_fd_oversize');
    if (position !== null) position += bytesRead;
    if (privateFifo && Date.now() >= deadline) throw new Error('p3c_descriptor_fifo_timeout');
  }
  const after = await statFd(fd);
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.mode !== after.mode ||
    before.nlink !== after.nlink ||
    before.uid !== after.uid ||
    before.gid !== after.gid ||
    (before.isFile() &&
      (before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs))
  )
    throw new Error('p3c_descriptor_fd_rotated');
  if (total === 0) throw new Error('p3c_descriptor_fd_empty');
  return Buffer.concat(chunks, total);
}

export async function readIntegrationDescriptor(): Promise<IntegrationDescriptor> {
  return parseIntegrationDescriptor(await readDescriptorFd(INTEGRATION_DESCRIPTOR_FD));
}

function assertPinRoot(pin: FilePin, root: RootName, label: string): void {
  if (pin.root !== root) throw new Error(`p3c_${label}_root`);
}

function assertDescriptorBindings(descriptor: IntegrationDescriptor): void {
  for (const [label, pin] of Object.entries({
    freeze: descriptor.control.freeze,
    review: descriptor.control.harnessReview,
    authorization: descriptor.control.oneRunAuthorization,
    reviewerKey: descriptor.control.harnessReviewerPublicKey,
    runAuthorizationKey: descriptor.control.runAuthorizationPublicKey,
  }))
    assertPinRoot(pin, 'controllerAuthority', `control_${label}`);
  assertPinRoot(descriptor.product.harnessClosure.manifest, 'harness', 'harness');
  assertPinRoot(descriptor.product.runEntry, 'harness', 'harness_run_entry');
  assertPinRoot(descriptor.product.runtimeClosure.manifest, 'productRuntime', 'product_runtime');
  assertPinRoot(descriptor.product.compositionEntry, 'productRuntime', 'product_composition_entry');
  assertPinRoot(
    descriptor.product.compositionDescriptor,
    'productRuntime',
    'product_composition_descriptor'
  );
  assertPinRoot(descriptor.product.browserBundle.manifest, 'browserBundle', 'browser_bundle');
  assertPinRoot(descriptor.browser.descriptor, 'browserBundle', 'browser_descriptor');
  assertPinRoot(descriptor.product.playwrightEntry, 'browserBundle', 'playwright_entry');
  assertPinRoot(descriptor.product.playwrightConfig, 'browserBundle', 'playwright_config');
  assertPinRoot(descriptor.product.playwrightSpec, 'browserBundle', 'playwright_spec');
  assertPinRoot(descriptor.product.chromiumExecutable, 'browserBundle', 'chromium_executable');
  assertPinRoot(descriptor.toolchain.closure.manifest, 'toolchain', 'toolchain_closure');
  assertPinRoot(descriptor.toolchain.node, 'toolchain', 'toolchain_node');
  assertPinRoot(descriptor.toolchain.loader, 'toolchain', 'toolchain_loader');
  for (const [label, pin] of Object.entries({
    entry: descriptor.p3b2.entry,
    supervisor: descriptor.p3b2.supervisor,
    recipe: descriptor.p3b2.recipe,
    closure: descriptor.p3b2.closure.manifest,
  }))
    assertPinRoot(pin, 'p3b2', `p3b2_${label}`);
  for (const [label, pin] of Object.entries({
    receipt: descriptor.openCode.acquisitionReceipt,
    manifest: descriptor.openCode.releaseManifest,
    provenance: descriptor.openCode.buildProvenanceBundle,
    zip: descriptor.openCode.actionsArtifactZip,
    archive: descriptor.openCode.linuxX64Archive,
    binary: descriptor.openCode.linuxX64Binary,
  }))
    assertPinRoot(pin, 'openCode', `opencode_${label}`);
  if (
    descriptor.openCode.releaseManifest.sha256 !== OPENCODE_IDENTITIES.releaseManifestSha256 ||
    descriptor.openCode.actionsArtifactZip.sha256 !==
      OPENCODE_IDENTITIES.actionsArtifactZipSha256 ||
    descriptor.openCode.buildProvenanceBundle.sha256 !==
      OPENCODE_IDENTITIES.buildProvenanceBundleSha256 ||
    descriptor.openCode.linuxX64Archive.sha256 !== OPENCODE_IDENTITIES.linuxX64ArchiveSha256 ||
    descriptor.openCode.linuxX64Binary.sha256 !== OPENCODE_IDENTITIES.linuxX64BinarySha256 ||
    descriptor.p3b2.entry.mode !== 0o555 ||
    descriptor.p3b2.supervisor.mode !== 0o555 ||
    descriptor.openCode.linuxX64Binary.mode !== 0o555 ||
    descriptor.product.compositionEntry.mode !== 0o555 ||
    descriptor.product.playwrightEntry.mode !== 0o555 ||
    descriptor.product.playwrightConfig.mode !== 0o444 ||
    descriptor.product.playwrightSpec.mode !== 0o444 ||
    descriptor.product.chromiumExecutable.mode !== 0o555
  )
    throw new Error('p3c_descriptor_file_binding');
}

async function assertExecutingInputs(
  descriptor: IntegrationDescriptor,
  runEntry: FileAnchor,
  node: FileAnchor,
  loader: FileAnchor,
  executingRunPath: string
): Promise<void> {
  const expectedRunPath = `${runEntry.root.pin.path}/${runEntry.pin.relativePath}`;
  const expectedLoaderPath = `${loader.root.pin.path}/${loader.pin.relativePath}`;
  if (
    (await realpath(executingRunPath)) !== expectedRunPath ||
    process.version !== descriptor.toolchain.nodeVersion ||
    canonicalJson(process.execArgv) !== canonicalJson(['--import', expectedLoaderPath])
  )
    throw new Error('p3c_executing_harness_binding');
  const executing = await open(executingRunPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  const launcher = await open('/proc/self/exe', constants.O_RDONLY);
  try {
    const [runStat, launcherStat] = await Promise.all([
      executing.stat({ bigint: true }),
      launcher.stat({ bigint: true }),
    ]);
    if (
      String(runStat.dev) !== runEntry.identity.device ||
      String(runStat.ino) !== runEntry.identity.inode ||
      String(launcherStat.dev) !== node.identity.device ||
      String(launcherStat.ino) !== node.identity.inode
    )
      throw new Error('p3c_executing_input_identity');
  } finally {
    await Promise.allSettled([executing.close(), launcher.close()]);
  }
}

function parseCanonicalObject(bytes: Buffer, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Error(`p3c_${label}_json`);
  }
  if (canonicalJson(value) !== bytes.toString('utf8')) throw new Error(`p3c_${label}_noncanonical`);
  return value as Record<string, unknown>;
}

function contentAddress(
  item: Record<string, unknown>,
  identityField: string,
  domain: string,
  omittedFields: readonly string[] = []
): string {
  const unsigned = { ...item };
  delete unsigned[identityField];
  for (const field of omittedFields) delete unsigned[field];
  return sha256(`${domain}\0${canonicalJson(unsigned)}`);
}

function exactIdentityTuple(value: unknown, label: string): Record<string, unknown> {
  return exactRecord(value, ['device', 'inode', 'mountId'], label);
}

function verifyAuthoritySignature(
  publicKeyBytes: Buffer,
  document: Record<string, unknown>,
  signatureField: string,
  label: string
): void {
  const signature = document[signatureField];
  if (
    typeof signature !== 'string' ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(signature)
  )
    throw new Error(`p3c_${label}_signature_frame`);
  const unsigned = { ...document };
  delete unsigned[signatureField];
  let key: ReturnType<typeof createPublicKey>;
  try {
    key = createPublicKey({ key: publicKeyBytes, format: 'der', type: 'spki' });
  } catch {
    throw new Error('p3c_controller_public_key');
  }
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('p3c_controller_public_key_type');
  if (
    !verifySignature(
      null,
      Buffer.from(canonicalJson(unsigned)),
      key,
      Buffer.from(signature, 'base64')
    )
  )
    throw new Error(`p3c_${label}_signature`);
}

function signerKeyId(publicKeyBytes: Buffer, role: 'harness-reviewer' | 'run-authorizer'): string {
  return sha256(`agent-teams.p3c.${role}-key-id/v1\0${publicKeyBytes.toString('base64')}`);
}

export interface ControllerTrustAnchor {
  readonly schemaVersion: 1;
  readonly purpose: 'agent-teams.p3c.controller-trust-anchor/v1';
  readonly authorityEpoch: number;
  readonly harnessReviewerPublicKeySha256: string;
  readonly runAuthorizationPublicKeySha256: string;
  readonly revokedSignerKeyIds: readonly string[];
}

export function parseControllerTrustAnchor(value: unknown): ControllerTrustAnchor {
  const anchor = exactRecord(
    value,
    [
      'schemaVersion',
      'purpose',
      'authorityEpoch',
      'harnessReviewerPublicKeySha256',
      'runAuthorizationPublicKeySha256',
      'revokedSignerKeyIds',
    ],
    'controller_trust_anchor'
  );
  if (
    anchor.schemaVersion !== 1 ||
    anchor.purpose !== 'agent-teams.p3c.controller-trust-anchor/v1' ||
    !Number.isSafeInteger(anchor.authorityEpoch) ||
    (anchor.authorityEpoch as number) < 1 ||
    typeof anchor.harnessReviewerPublicKeySha256 !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(anchor.harnessReviewerPublicKeySha256) ||
    typeof anchor.runAuthorizationPublicKeySha256 !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(anchor.runAuthorizationPublicKeySha256) ||
    anchor.harnessReviewerPublicKeySha256 === anchor.runAuthorizationPublicKeySha256 ||
    !Array.isArray(anchor.revokedSignerKeyIds) ||
    anchor.revokedSignerKeyIds.some(
      (keyId) => typeof keyId !== 'string' || !/^[0-9a-f]{64}$/u.test(keyId)
    ) ||
    new Set(anchor.revokedSignerKeyIds as string[]).size !== anchor.revokedSignerKeyIds.length
  )
    throw new Error('p3c_controller_trust_anchor');
  return Object.freeze({
    schemaVersion: 1,
    purpose: 'agent-teams.p3c.controller-trust-anchor/v1',
    authorityEpoch: anchor.authorityEpoch as number,
    harnessReviewerPublicKeySha256: anchor.harnessReviewerPublicKeySha256,
    runAuthorizationPublicKeySha256: anchor.runAuthorizationPublicKeySha256,
    revokedSignerKeyIds: Object.freeze([...(anchor.revokedSignerKeyIds as string[])]),
  }) as ControllerTrustAnchor;
}

function controllerTrustAnchorFromEnvironment(): ControllerTrustAnchor {
  const source = process.env[CONTROLLER_TRUST_ANCHOR_ENV];
  if (source === undefined) throw new Error('p3c_controller_trust_anchor_missing');
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error('p3c_controller_trust_anchor_json');
  }
  if (canonicalJson(value) !== source) throw new Error('p3c_controller_trust_anchor_noncanonical');
  return parseControllerTrustAnchor(value);
}

export function verifyControlDocuments(
  descriptor: IntegrationDescriptor,
  freezeBytes: Buffer,
  reviewBytes: Buffer,
  authorizationBytes: Buffer,
  reviewerPublicKeyBytes: Buffer,
  runAuthorizationPublicKeyBytes: Buffer,
  trustAnchor: ControllerTrustAnchor
): void {
  const freeze = exactRecord(
    parseCanonicalObject(freezeBytes, 'p3c1_freeze'),
    [
      'schemaVersion',
      'purpose',
      'lane',
      'controllerNonce',
      'freezeId',
      'authority',
      'reviewedHarness',
      'p3b2',
      'openCode',
      'productComposition',
      'browser',
      'attemptLedger',
      'maximumFinalRuns',
      'authorityPolicy',
      'harnessReviewerPublicKeySha256',
      'runAuthorizationPublicKeySha256',
      'productionGates',
    ],
    'p3c1_freeze'
  );
  const reviewedHarness = exactRecord(
    freeze.reviewedHarness,
    ['commit', 'closureMerkleRoot'],
    'p3c1_reviewed_harness'
  );
  const p3b2 = exactRecord(
    freeze.p3b2,
    [
      'sourceBaseCommit',
      'resultCommit',
      'entrySha256',
      'supervisorSha256',
      'recipeSha256',
      'closureMerkleRoot',
      'candidateOpenCodeSha256',
      'accepted',
    ],
    'p3c1_p3b2'
  );
  const openCode = exactRecord(
    freeze.openCode,
    [
      'identities',
      'provenanceReceiptSha256',
      'releaseManifestSha256',
      'buildProvenanceBundleSha256',
      'archiveSha256',
      'binarySha256',
      'accepted',
      'productionEligible',
    ],
    'p3c1_opencode'
  );
  const product = exactRecord(
    freeze.productComposition,
    ['entrySha256', 'descriptorSha256', 'runtimeClosureMerkleRoot'],
    'p3c1_product_composition'
  );
  const browser = exactRecord(
    freeze.browser,
    [
      'bundleMerkleRoot',
      'playwrightEntrySha256',
      'playwrightConfigSha256',
      'playwrightSpecSha256',
      'chromiumExecutableSha256',
      'workers',
      'retries',
    ],
    'p3c1_browser'
  );
  const attemptLedger = exactIdentityTuple(freeze.attemptLedger, 'p3c1_attempt_ledger');
  const authorityPolicy = parseControllerTrustAnchor(freeze.authorityPolicy);
  const reviewerKeyId = signerKeyId(reviewerPublicKeyBytes, 'harness-reviewer');
  const authorizerKeyId = signerKeyId(runAuthorizationPublicKeyBytes, 'run-authorizer');
  if (
    freeze.schemaVersion !== 1 ||
    freeze.purpose !== P3C1_FREEZE_PURPOSE ||
    freeze.lane !== P3C_LANE ||
    freeze.controllerNonce !== descriptor.controllerNonce ||
    freeze.maximumFinalRuns !== MAXIMUM_FINAL_RUNS ||
    canonicalJson(authorityPolicy) !== canonicalJson(trustAnchor) ||
    freeze.freezeId !== descriptor.control.freezeId ||
    contentAddress(freeze, 'freezeId', 'agent-teams.p3c.p3c1-freeze-id/v1') !==
      descriptor.control.freezeId ||
    canonicalJson(freeze.authority) !== canonicalJson(descriptor.authority) ||
    reviewedHarness.commit !== descriptor.product.finalHarnessCommit ||
    reviewedHarness.closureMerkleRoot !== descriptor.product.harnessClosure.merkleRoot ||
    p3b2.sourceBaseCommit !== descriptor.p3b2.sourceBaseCommit ||
    p3b2.resultCommit !== descriptor.p3b2.resultCommit ||
    p3b2.entrySha256 !== descriptor.p3b2.entry.sha256 ||
    p3b2.supervisorSha256 !== descriptor.p3b2.supervisor.sha256 ||
    p3b2.recipeSha256 !== descriptor.p3b2.recipeSha256 ||
    p3b2.closureMerkleRoot !== descriptor.p3b2.closure.merkleRoot ||
    p3b2.candidateOpenCodeSha256 !== OPENCODE_IDENTITIES.linuxX64BinarySha256 ||
    p3b2.accepted !== true ||
    canonicalJson(openCode.identities) !== canonicalJson(OPENCODE_IDENTITIES) ||
    openCode.provenanceReceiptSha256 !== descriptor.openCode.acquisitionReceipt.sha256 ||
    openCode.releaseManifestSha256 !== descriptor.openCode.releaseManifest.sha256 ||
    openCode.buildProvenanceBundleSha256 !== descriptor.openCode.buildProvenanceBundle.sha256 ||
    openCode.archiveSha256 !== descriptor.openCode.linuxX64Archive.sha256 ||
    openCode.binarySha256 !== descriptor.openCode.linuxX64Binary.sha256 ||
    openCode.accepted !== true ||
    openCode.productionEligible !== false ||
    product.entrySha256 !== descriptor.product.compositionEntry.sha256 ||
    product.descriptorSha256 !== descriptor.product.compositionDescriptor.sha256 ||
    product.runtimeClosureMerkleRoot !== descriptor.product.runtimeClosure.merkleRoot ||
    browser.bundleMerkleRoot !== descriptor.product.browserBundle.merkleRoot ||
    browser.playwrightEntrySha256 !== descriptor.product.playwrightEntry.sha256 ||
    browser.playwrightConfigSha256 !== descriptor.product.playwrightConfig.sha256 ||
    browser.playwrightSpecSha256 !== descriptor.product.playwrightSpec.sha256 ||
    browser.chromiumExecutableSha256 !== descriptor.product.chromiumExecutable.sha256 ||
    browser.workers !== 1 ||
    browser.retries !== 0 ||
    canonicalJson(attemptLedger) !==
      canonicalJson({
        device: descriptor.roots.sandboxParent.device,
        inode: descriptor.roots.sandboxParent.inode,
        mountId: descriptor.roots.sandboxParent.mountId,
      }) ||
    freeze.harnessReviewerPublicKeySha256 !== descriptor.control.harnessReviewerPublicKey.sha256 ||
    freeze.runAuthorizationPublicKeySha256 !==
      descriptor.control.runAuthorizationPublicKey.sha256 ||
    sha256(reviewerPublicKeyBytes) !== descriptor.control.harnessReviewerPublicKey.sha256 ||
    sha256(runAuthorizationPublicKeyBytes) !==
      descriptor.control.runAuthorizationPublicKey.sha256 ||
    sha256(reviewerPublicKeyBytes) === sha256(runAuthorizationPublicKeyBytes) ||
    sha256(reviewerPublicKeyBytes) !== trustAnchor.harnessReviewerPublicKeySha256 ||
    sha256(runAuthorizationPublicKeyBytes) !== trustAnchor.runAuthorizationPublicKeySha256 ||
    trustAnchor.revokedSignerKeyIds.includes(reviewerKeyId) ||
    trustAnchor.revokedSignerKeyIds.includes(authorizerKeyId) ||
    canonicalJson(freeze.productionGates) !== canonicalJson(descriptor.productionGates)
  )
    throw new Error('p3c_p3c1_freeze_binding');

  const review = exactRecord(
    parseCanonicalObject(reviewBytes, 'harness_review'),
    [
      'schemaVersion',
      'purpose',
      'lane',
      'freezeId',
      'reviewId',
      'reviewedHarnessCommit',
      'harnessClosureMerkleRoot',
      'result',
      'p0',
      'p1',
      'p2',
      'signerKeyId',
      'signatureBase64',
    ],
    'harness_review'
  );
  if (
    review.schemaVersion !== 1 ||
    review.purpose !== HARNESS_REVIEW_PURPOSE ||
    review.lane !== P3C_LANE ||
    review.freezeId !== descriptor.control.freezeId ||
    review.reviewId !== descriptor.control.reviewId ||
    contentAddress(review, 'reviewId', 'agent-teams.p3c.harness-review-id/v1', [
      'signatureBase64',
    ]) !== descriptor.control.reviewId ||
    review.reviewedHarnessCommit !== descriptor.product.finalHarnessCommit ||
    review.harnessClosureMerkleRoot !== descriptor.product.harnessClosure.merkleRoot ||
    review.result !== 'accepted' ||
    review.p0 !== 0 ||
    review.p1 !== 0 ||
    review.p2 !== 0 ||
    review.signerKeyId !== reviewerKeyId
  )
    throw new Error('p3c_harness_review_binding');
  verifyAuthoritySignature(reviewerPublicKeyBytes, review, 'signatureBase64', 'harness_review');

  const authorization = exactRecord(
    parseCanonicalObject(authorizationBytes, 'one_run_authorization'),
    [
      'schemaVersion',
      'purpose',
      'lane',
      'freezeId',
      'reviewId',
      'authorizationId',
      'controllerNonce',
      'attemptLedger',
      'maximumFinalRuns',
      'authorizedAttempts',
      'disposition',
      'signerKeyId',
      'signatureBase64',
    ],
    'one_run_authorization'
  );
  if (
    authorization.schemaVersion !== 1 ||
    authorization.purpose !== ONE_RUN_AUTHORIZATION_PURPOSE ||
    authorization.lane !== P3C_LANE ||
    authorization.freezeId !== descriptor.control.freezeId ||
    authorization.reviewId !== descriptor.control.reviewId ||
    authorization.authorizationId !== descriptor.control.authorizationId ||
    contentAddress(
      authorization,
      'authorizationId',
      'agent-teams.p3c.one-run-authorization-id/v1',
      ['signatureBase64']
    ) !== descriptor.control.authorizationId ||
    authorization.controllerNonce !== descriptor.controllerNonce ||
    authorization.maximumFinalRuns !== MAXIMUM_FINAL_RUNS ||
    canonicalJson(
      exactIdentityTuple(authorization.attemptLedger, 'authorization_attempt_ledger')
    ) !== canonicalJson(attemptLedger) ||
    authorization.authorizedAttempts !== 1 ||
    authorization.disposition !== 'authorize-once' ||
    authorization.signerKeyId !== authorizerKeyId ||
    authorization.signerKeyId === review.signerKeyId
  )
    throw new Error('p3c_one_run_authorization_binding');
  verifyAuthoritySignature(
    runAuthorizationPublicKeyBytes,
    authorization,
    'signatureBase64',
    'one_run_authorization'
  );
}

function verifyAcquisitionReceipt(bytes: Buffer): void {
  const value = parseCanonicalObject(bytes, 'acquisition_receipt');
  const receipt = exactRecord(
    value,
    [
      'schemaVersion',
      'purpose',
      'identities',
      'result',
      'reviewId',
      'receiptId',
      'signedBuildProvenance',
      'productionEligible',
      'releaseEligible',
    ],
    'acquisition_receipt'
  );
  if (
    receipt.schemaVersion !== 1 ||
    receipt.purpose !== 'agent-teams.p3c.oc-provenance/v1' ||
    canonicalJson(receipt.identities) !== canonicalJson(OPENCODE_IDENTITIES) ||
    receipt.result !== 'accepted' ||
    typeof receipt.reviewId !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(receipt.reviewId) ||
    typeof receipt.receiptId !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(receipt.receiptId) ||
    contentAddress(receipt, 'receiptId', 'agent-teams.p3c.oc-provenance-receipt-id/v1') !==
      receipt.receiptId ||
    receipt.signedBuildProvenance !== true ||
    receipt.productionEligible !== false ||
    receipt.releaseEligible !== false
  )
    throw new Error('p3c_acquisition_receipt_binding');
}

export function verifyReleaseManifest(bytes: Buffer): void {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Error('p3c_release_manifest_json');
  }
  const manifest = exactRecord(
    value,
    ['schemaVersion', 'workflow', 'release', 'assets'],
    'release_manifest'
  );
  const workflow = exactRecord(
    manifest.workflow,
    ['repository', 'workflow', 'runId', 'runAttempt', 'actor', 'ref', 'sha'],
    'release_manifest_workflow'
  );
  const release = exactRecord(
    manifest.release,
    [
      'version',
      'tag',
      'sourceCommit',
      'sourceTree',
      'artifactTree',
      'baseCommit',
      'patchSha256',
      'bunVersion',
      'productionEligible',
      'patchSize',
    ],
    'release_manifest_release'
  );
  if (!Array.isArray(manifest.assets) || manifest.assets.length !== 5)
    throw new Error('p3c_release_manifest_assets');
  const assets = manifest.assets.map((value, index) =>
    exactRecord(
      value,
      [
        'os',
        'arch',
        'archive',
        'archiveSha256',
        'archiveSize',
        'binaryPath',
        'binarySha256',
        'binarySize',
        'platform',
        'signing',
      ],
      `release_manifest_asset_${index}`
    )
  );
  const platforms = assets.map((asset) => {
    if (typeof asset.os !== 'string' || typeof asset.arch !== 'string') {
      throw new Error('p3c_release_manifest_asset_platform_type');
    }
    return `${asset.os}:${asset.arch}`;
  });
  const invalidAsset = assets.some((asset) => {
    const signing = exactRecord(
      asset.signing,
      ['binaryStatus', 'reason', 'provenanceAction', 'provenanceStatus'],
      'release_manifest_asset_signing'
    );
    return (
      typeof asset.os !== 'string' ||
      !['linux', 'darwin', 'windows'].includes(asset.os) ||
      typeof asset.arch !== 'string' ||
      !['x64', 'arm64'].includes(asset.arch) ||
      asset.platform !== `opencode-${asset.os}-${asset.arch}` ||
      typeof asset.archive !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(asset.archive) ||
      typeof asset.binaryPath !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,511}$/u.test(asset.binaryPath) ||
      asset.binaryPath.split('/').some((part) => !part || part === '.' || part === '..') ||
      typeof asset.archiveSha256 !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(asset.archiveSha256) ||
      typeof asset.binarySha256 !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(asset.binarySha256) ||
      !Number.isSafeInteger(asset.archiveSize) ||
      (asset.archiveSize as number) < 1 ||
      !Number.isSafeInteger(asset.binarySize) ||
      (asset.binarySize as number) < 1 ||
      signing.binaryStatus !== 'unsigned' ||
      signing.reason !== 'non-production fork prerelease' ||
      signing.provenanceAction !==
        'actions/attest-build-provenance@4d101475d8b20a2381f78447822ac1eab6504dd8' ||
      signing.provenanceStatus !== 'required-after-manifest'
    );
  });
  const linux = assets.filter((asset) => asset.os === 'linux' && asset.arch === 'x64');
  if (
    manifest.schemaVersion !== 1 ||
    typeof workflow.repository !== 'string' ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(workflow.repository) ||
    typeof workflow.workflow !== 'string' ||
    workflow.workflow.length < 1 ||
    workflow.runId !== OPENCODE_IDENTITIES.workflowRunId ||
    workflow.runAttempt !== OPENCODE_IDENTITIES.workflowRunAttempt ||
    typeof workflow.actor !== 'string' ||
    workflow.actor.length < 1 ||
    workflow.ref !== OPENCODE_IDENTITIES.workflowRef ||
    workflow.sha !== OPENCODE_IDENTITIES.workflowMergeCommit ||
    release.version !== '1.18.23-agentteams.1' ||
    release.tag !== 'v1.18.23-agentteams.1' ||
    release.sourceCommit !== OPENCODE_IDENTITIES.releaseSourceCommit ||
    release.sourceTree !== OPENCODE_IDENTITIES.releaseSourceTree ||
    typeof release.artifactTree !== 'string' ||
    !/^[0-9a-f]{40}$/u.test(release.artifactTree) ||
    release.baseCommit !== OPENCODE_IDENTITIES.releaseBaseCommit ||
    typeof release.patchSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(release.patchSha256) ||
    release.bunVersion !== '1.3.14' ||
    release.productionEligible !== false ||
    !Number.isSafeInteger(release.patchSize) ||
    (release.patchSize as number) < 1 ||
    invalidAsset ||
    new Set(platforms).size !== assets.length ||
    linux.length !== 1 ||
    linux[0].archiveSha256 !== OPENCODE_IDENTITIES.linuxX64ArchiveSha256 ||
    linux[0].binarySha256 !== OPENCODE_IDENTITIES.linuxX64BinarySha256 ||
    typeof linux[0].archive !== 'string' ||
    typeof linux[0].binaryPath !== 'string' ||
    !Number.isSafeInteger(linux[0].archiveSize) ||
    !Number.isSafeInteger(linux[0].binarySize)
  )
    throw new Error('p3c_release_manifest_binding');
}

export function verifyBuildProvenanceBundle(bundleBytes: Buffer, manifestBytes: Buffer): void {
  let bundleValue: unknown;
  let manifestValue: unknown;
  try {
    bundleValue = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bundleBytes));
    manifestValue = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes));
  } catch {
    throw new Error('p3c_build_provenance_json');
  }
  const bundle = exactRecord(
    bundleValue,
    ['mediaType', 'verificationMaterial', 'dsseEnvelope'],
    'build_provenance_bundle'
  );
  const envelope = exactRecord(
    bundle.dsseEnvelope,
    ['payloadType', 'payload', 'signatures'],
    'build_provenance_envelope'
  );
  const verificationMaterial = exactRecord(
    bundle.verificationMaterial,
    ['certificate', 'tlogEntries', 'timestampVerificationData'],
    'build_provenance_verification_material'
  );
  const certificate = exactRecord(
    verificationMaterial.certificate,
    ['rawBytes'],
    'build_provenance_certificate'
  );
  if (
    bundle.mediaType !== 'application/vnd.dev.sigstore.bundle.v0.3+json' ||
    envelope.payloadType !== 'application/vnd.in-toto+json' ||
    typeof envelope.payload !== 'string' ||
    typeof certificate.rawBytes !== 'string' ||
    !Array.isArray(envelope.signatures) ||
    envelope.signatures.length !== 1 ||
    !Array.isArray(verificationMaterial.tlogEntries) ||
    verificationMaterial.tlogEntries.length !== 1
  )
    throw new Error('p3c_build_provenance_bundle_shape');
  const signature = exactRecord(envelope.signatures[0], ['sig'], 'build_provenance_signature');
  if (typeof signature.sig !== 'string') throw new Error('p3c_build_provenance_signature');
  const payload = Buffer.from(envelope.payload, 'base64');
  if (payload.toString('base64') !== envelope.payload)
    throw new Error('p3c_build_provenance_payload_frame');
  const payloadType = Buffer.from(envelope.payloadType);
  const pae = Buffer.concat([
    Buffer.from(`DSSEv1 ${payloadType.length} `),
    payloadType,
    Buffer.from(` ${payload.length} `),
    payload,
  ]);
  let signingCertificate: X509Certificate;
  try {
    signingCertificate = new X509Certificate(Buffer.from(certificate.rawBytes, 'base64'));
  } catch {
    throw new Error('p3c_build_provenance_certificate');
  }
  if (
    !verifySignature(
      'sha256',
      pae,
      signingCertificate.publicKey,
      Buffer.from(signature.sig, 'base64')
    )
  )
    throw new Error('p3c_build_provenance_dsse_signature');
  const statement = exactRecord(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload)) as unknown,
    ['_type', 'subject', 'predicateType', 'predicate'],
    'build_provenance_statement'
  );
  const manifest = exactRecord(
    manifestValue,
    ['schemaVersion', 'workflow', 'release', 'assets'],
    'build_provenance_manifest'
  );
  if (!Array.isArray(manifest.assets) || !Array.isArray(statement.subject))
    throw new Error('p3c_build_provenance_subjects');
  const expectedSubjects = [
    ...manifest.assets.map((asset, index) => {
      const item = exactRecord(
        asset,
        [
          'os',
          'arch',
          'archive',
          'archiveSha256',
          'archiveSize',
          'binaryPath',
          'binarySha256',
          'binarySize',
          'platform',
          'signing',
        ],
        `build_provenance_manifest_asset_${index}`
      );
      return {
        name: exactText(item.archive, /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u, 'subject_archive'),
        digest: {
          sha256: exactText(item.archiveSha256, /^[0-9a-f]{64}$/u, 'subject_archive_sha'),
        },
      };
    }),
    { name: 'release-manifest.json', digest: { sha256: sha256(manifestBytes) } },
  ].sort((left, right) =>
    Buffer.from(left.name, 'utf8').compare(Buffer.from(right.name, 'utf8'))
  );
  const actualSubjects = statement.subject
    .map((subject, index) => {
      const item = exactRecord(subject, ['name', 'digest'], `build_provenance_subject_${index}`);
      const digest = exactRecord(
        item.digest,
        ['sha256'],
        `build_provenance_subject_digest_${index}`
      );
      return {
        name: exactText(item.name, /^[A-Za-z0-9][A-Za-z0-9._/-]{0,511}$/u, 'subject_name'),
        digest: { sha256: exactText(digest.sha256, /^[0-9a-f]{64}$/u, 'subject_sha') },
      };
    })
    .sort((left, right) =>
      Buffer.from(left.name, 'utf8').compare(Buffer.from(right.name, 'utf8'))
    );
  const predicate = exactRecord(
    statement.predicate,
    ['buildDefinition', 'runDetails'],
    'build_provenance_predicate'
  );
  const runDetails = exactRecord(
    predicate.runDetails,
    ['builder', 'metadata'],
    'build_provenance_run'
  );
  const metadata = exactRecord(runDetails.metadata, ['invocationId'], 'build_provenance_metadata');
  const certificateSubjectAltName = signingCertificate.subjectAltName ?? '';
  if (
    statement._type !== 'https://in-toto.io/Statement/v1' ||
    statement.predicateType !== 'https://slsa.dev/provenance/v1' ||
    canonicalJson(actualSubjects) !== canonicalJson(expectedSubjects) ||
    metadata.invocationId !==
      `https://github.com/777genius/opencode-anomaly/actions/runs/${OPENCODE_IDENTITIES.workflowRunId}/attempts/${OPENCODE_IDENTITIES.workflowRunAttempt}` ||
    !certificateSubjectAltName.includes(
      `https://github.com/777genius/opencode-anomaly/.github/workflows/hardened-cli-release.yml@${OPENCODE_IDENTITIES.workflowRef}`
    )
  )
    throw new Error('p3c_build_provenance_binding');
}

export function verifyP3B2Recipe(bytes: Buffer, descriptor: IntegrationDescriptor): void {
  const recipe = exactRecord(
    parseCanonicalObject(bytes, 'p3b2_recipe'),
    [
      'schemaVersion',
      'purpose',
      'sourceBaseCommit',
      'resultCommit',
      'entry',
      'supervisor',
      'closureMerkleRoot',
      'candidateOpenCodeSha256',
      'argv',
      'sourceTreeRequired',
      'accepted',
    ],
    'p3b2_recipe'
  );
  const entry = exactRecord(recipe.entry, ['relativePath', 'sha256'], 'p3b2_recipe_entry');
  const supervisor = exactRecord(
    recipe.supervisor,
    ['relativePath', 'sha256'],
    'p3b2_recipe_supervisor'
  );
  if (
    recipe.schemaVersion !== 1 ||
    recipe.purpose !== 'agent-teams.p3b2.built-actual-owner-entry/v1' ||
    recipe.sourceBaseCommit !== descriptor.p3b2.sourceBaseCommit ||
    recipe.resultCommit !== descriptor.p3b2.resultCommit ||
    entry.relativePath !== descriptor.p3b2.entry.relativePath ||
    entry.sha256 !== descriptor.p3b2.entry.sha256 ||
    supervisor.relativePath !== descriptor.p3b2.supervisor.relativePath ||
    supervisor.sha256 !== descriptor.p3b2.supervisor.sha256 ||
    recipe.closureMerkleRoot !== descriptor.p3b2.closure.merkleRoot ||
    recipe.candidateOpenCodeSha256 !== OPENCODE_IDENTITIES.linuxX64BinarySha256 ||
    canonicalJson(recipe.argv) !==
      canonicalJson(['--runtime-manifest', '/sandbox/runtime-manifest.json']) ||
    recipe.sourceTreeRequired !== false ||
    recipe.accepted !== true
  )
    throw new Error('p3c_p3b2_recipe_binding');
}

function verifyProductCompositionDescriptor(
  bytes: Buffer,
  descriptor: IntegrationDescriptor
): void {
  const composition = exactRecord(
    parseCanonicalObject(bytes, 'product_composition'),
    [
      'schemaVersion',
      'purpose',
      'auditedProductCommit',
      'auditedProductTree',
      'finalHarnessCommit',
      'entryRelativePath',
      'entrySha256',
      'runtimeClosureMerkleRoot',
      'argv',
    ],
    'product_composition'
  );
  if (
    composition.schemaVersion !== 1 ||
    composition.purpose !== 'agent-teams.p3c.product-composition-entry/v1' ||
    composition.auditedProductCommit !== descriptor.authority.auditedProductCommit ||
    composition.auditedProductTree !== descriptor.authority.auditedProductTree ||
    composition.finalHarnessCommit !== descriptor.product.finalHarnessCommit ||
    composition.entryRelativePath !== descriptor.product.compositionEntry.relativePath ||
    composition.entrySha256 !== descriptor.product.compositionEntry.sha256 ||
    composition.runtimeClosureMerkleRoot !== descriptor.product.runtimeClosure.merkleRoot ||
    canonicalJson(composition.argv) !== canonicalJson([])
  )
    throw new Error('p3c_product_composition_binding');
}

function verifyBrowserDescriptor(bytes: Buffer, descriptor: IntegrationDescriptor): void {
  const value = parseCanonicalObject(bytes, 'browser_descriptor');
  const browser = exactRecord(
    value,
    [
      'schemaVersion',
      'purpose',
      'controllerNonce',
      'origin',
      'matrixRows',
      'observationFd',
      'scenario',
      'playwright',
    ],
    'browser_descriptor'
  );
  const scenario = exactRecord(
    browser.scenario,
    [
      'authenticatedActorTeamId',
      'targetTeamAId',
      'targetTeamBId',
      'teamARunId',
      'teamBRunId',
      'allow',
      'deny',
      'teamBRequest',
    ],
    'browser_scenario'
  );
  const approvalKeys = ['approvalId', 'generation', 'idempotencyKey', 'previewRef'] as const;
  const allow = exactRecord(scenario.allow, approvalKeys, 'browser_allow');
  const deny = exactRecord(scenario.deny, approvalKeys, 'browser_deny');
  const teamBRequest = exactRecord(scenario.teamBRequest, approvalKeys, 'browser_team_b_request');
  const playwright = exactRecord(
    browser.playwright,
    [
      'entryRelativePath',
      'entrySha256',
      'configRelativePath',
      'configSha256',
      'specRelativePath',
      'specSha256',
      'chromiumRelativePath',
      'chromiumSha256',
      'workers',
      'retries',
      'argv',
    ],
    'browser_playwright'
  );
  const expectedPlaywrightArgv = [
    `/browser/${descriptor.product.playwrightEntry.relativePath}`,
    'test',
    `/browser/${descriptor.product.playwrightSpec.relativePath}`,
    '--config',
    `/browser/${descriptor.product.playwrightConfig.relativePath}`,
    '--workers=1',
    '--retries=0',
  ];
  const approvalValid = (value: Record<string, unknown>): boolean =>
    typeof value.approvalId === 'string' &&
    /^approval_[0-9a-f]{32}$/u.test(value.approvalId) &&
    typeof value.generation === 'string' &&
    /^generation_[A-Za-z0-9][A-Za-z0-9._-]{0,245}$/u.test(value.generation) &&
    typeof value.idempotencyKey === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value.idempotencyKey) &&
    typeof value.previewRef === 'string' &&
    /^approval_preview_[A-Za-z0-9][A-Za-z0-9._-]{0,239}$/u.test(value.previewRef);
  if (
    browser.schemaVersion !== 1 ||
    browser.purpose !== 'agent-teams.p3c.browser-descriptor/v1' ||
    browser.controllerNonce !== descriptor.controllerNonce ||
    browser.origin !== PRODUCT_ORIGIN ||
    canonicalJson(browser.matrixRows) !== canonicalJson(MATRIX_ROWS) ||
    browser.observationFd !== BROWSER_OBSERVATION_FD ||
    playwright.entryRelativePath !== descriptor.product.playwrightEntry.relativePath ||
    playwright.entrySha256 !== descriptor.product.playwrightEntry.sha256 ||
    playwright.configRelativePath !== descriptor.product.playwrightConfig.relativePath ||
    playwright.configSha256 !== descriptor.product.playwrightConfig.sha256 ||
    playwright.specRelativePath !== descriptor.product.playwrightSpec.relativePath ||
    playwright.specSha256 !== descriptor.product.playwrightSpec.sha256 ||
    playwright.chromiumRelativePath !== descriptor.product.chromiumExecutable.relativePath ||
    playwright.chromiumSha256 !== descriptor.product.chromiumExecutable.sha256 ||
    playwright.workers !== 1 ||
    playwright.retries !== 0 ||
    canonicalJson(playwright.argv) !== canonicalJson(expectedPlaywrightArgv) ||
    typeof scenario.authenticatedActorTeamId !== 'string' ||
    !/^team_[0-9a-f]{32}$/u.test(scenario.authenticatedActorTeamId) ||
    scenario.authenticatedActorTeamId !== scenario.targetTeamAId ||
    typeof scenario.targetTeamBId !== 'string' ||
    !/^team_[0-9a-f]{32}$/u.test(scenario.targetTeamBId) ||
    scenario.targetTeamAId === scenario.targetTeamBId ||
    typeof scenario.teamARunId !== 'string' ||
    !/^run_[0-9a-f]{32}$/u.test(scenario.teamARunId) ||
    typeof scenario.teamBRunId !== 'string' ||
    !/^run_[0-9a-f]{32}$/u.test(scenario.teamBRunId) ||
    scenario.teamARunId === scenario.teamBRunId ||
    !approvalValid(allow) ||
    !approvalValid(deny) ||
    !approvalValid(teamBRequest) ||
    allow.approvalId === deny.approvalId ||
    allow.idempotencyKey === deny.idempotencyKey ||
    new Set([allow.approvalId, deny.approvalId, teamBRequest.approvalId]).size !== 3 ||
    new Set([allow.previewRef, deny.previewRef, teamBRequest.previewRef]).size !== 3
  )
    throw new Error('p3c_browser_descriptor_binding');
}

async function openAndRead(
  root: RootAnchor,
  pin: FilePin,
  maximum: number
): Promise<{ anchor: FileAnchor; bytes: Buffer }> {
  const anchor = await openFileAnchor(root, pin);
  try {
    return { anchor, bytes: await readStable(anchor, maximum) };
  } catch (error) {
    await anchor.handle.close();
    throw error;
  }
}

async function openAndVerify(root: RootAnchor, pin: FilePin, maximum: number): Promise<FileAnchor> {
  const anchor = await openFileAnchor(root, pin);
  try {
    await verifyStableDigest(anchor, maximum);
    return anchor;
  } catch (error) {
    await anchor.handle.close();
    throw error;
  }
}

export async function admitIntegration(
  descriptor: IntegrationDescriptor,
  executingRunPath: string
): Promise<PreflightAdmission> {
  assertDescriptorBindings(descriptor);
  const openedRoots: RootAnchor[] = [];
  const openedFiles: FileAnchor[] = [];
  try {
    const roots = {} as Record<RootName, RootAnchor>;
    for (const name of ROOT_NAMES) {
      const root = await openRootAnchor(name, descriptor.roots[name]);
      roots[name] = root;
      openedRoots.push(root);
    }
    for (const name of ['sandboxParent', 'evidenceRoot'] as const) {
      if ((await readdir(procFdPath(roots[name].handle))).length !== 0)
        throw new Error(`p3c_${name}_not_empty`);
    }

    const [harness, toolchain, productRuntime, browserBundle, p3b2] = await Promise.all([
      verifyClosure(roots.harness, descriptor.product.harnessClosure),
      verifyClosure(roots.toolchain, descriptor.toolchain.closure),
      verifyClosure(roots.productRuntime, descriptor.product.runtimeClosure),
      verifyClosure(roots.browserBundle, descriptor.product.browserBundle),
      verifyClosure(roots.p3b2, descriptor.p3b2.closure),
    ]);

    const read = async (root: RootAnchor, pin: FilePin, maximum: number) => {
      const result = await openAndRead(root, pin, maximum);
      openedFiles.push(result.anchor);
      return result;
    };
    const verify = async (root: RootAnchor, pin: FilePin, maximum: number) => {
      const anchor = await openAndVerify(root, pin, maximum);
      openedFiles.push(anchor);
      return anchor;
    };
    const runEntry = await verify(roots.harness, descriptor.product.runEntry, 4 * 1024 * 1024);
    const node = await verify(roots.toolchain, descriptor.toolchain.node, 256 * 1024 * 1024);
    const loader = await verify(roots.toolchain, descriptor.toolchain.loader, 32 * 1024 * 1024);
    await assertExecutingInputs(descriptor, runEntry, node, loader, executingRunPath);
    const freeze = await read(
      roots.controllerAuthority,
      descriptor.control.freeze,
      4 * 1024 * 1024
    );
    const harnessReview = await read(
      roots.controllerAuthority,
      descriptor.control.harnessReview,
      4 * 1024 * 1024
    );
    const oneRunAuthorization = await read(
      roots.controllerAuthority,
      descriptor.control.oneRunAuthorization,
      4 * 1024 * 1024
    );
    const harnessReviewerPublicKey = await read(
      roots.controllerAuthority,
      descriptor.control.harnessReviewerPublicKey,
      64 * 1024
    );
    const runAuthorizationPublicKey = await read(
      roots.controllerAuthority,
      descriptor.control.runAuthorizationPublicKey,
      64 * 1024
    );
    verifyControlDocuments(
      descriptor,
      freeze.bytes,
      harnessReview.bytes,
      oneRunAuthorization.bytes,
      harnessReviewerPublicKey.bytes,
      runAuthorizationPublicKey.bytes,
      controllerTrustAnchorFromEnvironment()
    );
    const ownerEntry = await verify(roots.p3b2, descriptor.p3b2.entry, 1024 ** 3);
    const supervisor = await verify(roots.p3b2, descriptor.p3b2.supervisor, 1024 ** 3);
    const recipe = await read(roots.p3b2, descriptor.p3b2.recipe, 16 * 1024 * 1024);
    verifyP3B2Recipe(recipe.bytes, descriptor);
    const compositionEntry = await verify(
      roots.productRuntime,
      descriptor.product.compositionEntry,
      1024 ** 3
    );
    const compositionDescriptor = await read(
      roots.productRuntime,
      descriptor.product.compositionDescriptor,
      4 * 1024 * 1024
    );
    verifyProductCompositionDescriptor(compositionDescriptor.bytes, descriptor);
    const playwrightEntry = await verify(
      roots.browserBundle,
      descriptor.product.playwrightEntry,
      1024 ** 3
    );
    const playwrightConfig = await verify(
      roots.browserBundle,
      descriptor.product.playwrightConfig,
      4 * 1024 * 1024
    );
    const playwrightSpec = await verify(
      roots.browserBundle,
      descriptor.product.playwrightSpec,
      16 * 1024 * 1024
    );
    const chromiumExecutable = await verify(
      roots.browserBundle,
      descriptor.product.chromiumExecutable,
      1024 ** 3
    );
    const receipt = await read(
      roots.openCode,
      descriptor.openCode.acquisitionReceipt,
      4 * 1024 * 1024
    );
    const releaseManifest = await read(
      roots.openCode,
      descriptor.openCode.releaseManifest,
      16 * 1024 * 1024
    );
    const buildProvenanceBundle = await read(
      roots.openCode,
      descriptor.openCode.buildProvenanceBundle,
      4 * 1024 * 1024
    );
    const actionsZip = await verify(
      roots.openCode,
      descriptor.openCode.actionsArtifactZip,
      1024 ** 3
    );
    const platformArchive = await verify(
      roots.openCode,
      descriptor.openCode.linuxX64Archive,
      1024 ** 3
    );
    const openCode = await verify(roots.openCode, descriptor.openCode.linuxX64Binary, 1024 ** 3);
    const browserDescriptor = await read(
      roots.browserBundle,
      descriptor.browser.descriptor,
      4 * 1024 * 1024
    );
    verifyAcquisitionReceipt(receipt.bytes);
    verifyReleaseManifest(releaseManifest.bytes);
    verifyBuildProvenanceBundle(buildProvenanceBundle.bytes, releaseManifest.bytes);
    verifyBrowserDescriptor(browserDescriptor.bytes, descriptor);

    await closeAnchors([
      recipe.anchor,
      runEntry,
      node,
      loader,
      receipt.anchor,
      releaseManifest.anchor,
      buildProvenanceBundle.anchor,
      actionsZip,
      platformArchive,
      freeze.anchor,
      harnessReview.anchor,
      oneRunAuthorization.anchor,
      harnessReviewerPublicKey.anchor,
      runAuthorizationPublicKey.anchor,
      compositionEntry,
      playwrightEntry,
      playwrightConfig,
      playwrightSpec,
      chromiumExecutable,
    ]);
    return Object.freeze({
      descriptor,
      roots: Object.freeze(roots),
      closures: Object.freeze({
        harness,
        toolchain,
        productRuntime,
        browserBundle,
        p3b2,
      }),
      control: Object.freeze({
        freezeId: descriptor.control.freezeId,
        reviewId: descriptor.control.reviewId,
        authorizationId: descriptor.control.authorizationId,
      }),
      execution: Object.freeze({
        ownerEntry,
        supervisor,
        openCode,
        browserDescriptor: browserDescriptor.anchor,
        productCompositionDescriptor: compositionDescriptor.anchor,
      }),
    });
  } catch (error) {
    await closeAnchors([...openedFiles, ...openedRoots]);
    throw error;
  }
}

export async function closeAdmission(admission: PreflightAdmission): Promise<void> {
  await closeAnchors([...Object.values(admission.execution), ...Object.values(admission.roots)]);
}

export async function consumeOneRunAuthorization(
  admission: PreflightAdmission
): Promise<WrittenFileEvidence> {
  // The ledger deliberately shares the durable sandbox-parent root. It therefore survives removal
  // of the nonce-specific run directory and prevents a new nonce or authorization document from
  // obtaining a fresh counter. There is no automatic ambiguous-result retry path.
  const ledger = admission.roots.sandboxParent;
  await assertRootCurrent(ledger);
  if ((await readdir(procFdPath(ledger.handle))).includes(GLOBAL_FINAL_RUN_RECORD))
    throw new Error('p3c_authorization_already_consumed');
  const bytes = Buffer.from(
    canonicalJson({
      schemaVersion: 1,
      purpose: CONSUMED_ATTEMPT_PURPOSE,
      lane: P3C_LANE,
      freezeId: admission.control.freezeId,
      reviewId: admission.control.reviewId,
      authorizationId: admission.control.authorizationId,
      controllerNonce: admission.descriptor.controllerNonce,
      attemptNumber: 1,
      state: 'consumed-before-spawn',
      spawnStarted: false,
    })
  );
  const record = await writeExclusive(ledger, GLOBAL_FINAL_RUN_RECORD, bytes, 0o400);
  await ledger.handle.sync();
  const names = await readdir(procFdPath(ledger.handle));
  if (names.filter((name) => name === GLOBAL_FINAL_RUN_RECORD).length !== 1)
    throw new Error('p3c_consumed_attempt_ledger_race');
  await assertRootCurrent(ledger);
  return record;
}

export async function assertOneRunAuthorizationConsumed(
  admission: PreflightAdmission,
  record: WrittenFileEvidence
): Promise<void> {
  const expectedName = GLOBAL_FINAL_RUN_RECORD;
  if (
    record.root !== 'sandboxParent' ||
    record.relativePath !== expectedName ||
    record.mode !== 0o400 ||
    record.nlink !== 1
  )
    throw new Error('p3c_consumed_attempt_evidence');
  const names = await readdir(procFdPath(admission.roots.sandboxParent.handle));
  if (names.filter((name) => name === expectedName).length !== 1)
    throw new Error('p3c_consumed_attempt_ledger_changed');
  const anchor = await openFileAnchor(admission.roots.sandboxParent, {
    root: 'sandboxParent',
    relativePath: record.relativePath,
    sha256: record.sha256,
    size: record.size,
    mode: 0o400,
    device: record.device,
    inode: record.inode,
    nlink: 1,
  });
  try {
    await readStable(anchor, 64 * 1024);
  } finally {
    await anchor.handle.close();
  }
}
