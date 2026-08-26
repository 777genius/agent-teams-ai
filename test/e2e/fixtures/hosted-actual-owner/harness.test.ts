import { spawn as spawnChild } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { once } from 'node:events';
import { constants } from 'node:fs';
import {
  access,
  chmod,
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
  openFileAnchor,
  openRootAnchor,
} from '../../../../scripts/e2e/hosted-actual-owner/anchors';
import {
  canonicalJson,
  type FilePin,
  MATRIX_ROWS,
  MAXIMUM_FINAL_RUNS,
  OPENCODE_IDENTITIES,
  OWNED_PATHS,
  P3B_SOURCE_COMMIT,
  P3C_LANE,
  PACKET_BASE_COMMIT,
  parseIntegrationDescriptor,
  PRODUCT_AUTHORITY_COMMIT,
  RAW_ORIGINS,
  type RawOrigin,
  type RootName,
  type RootPin,
  sha256,
} from '../../../../scripts/e2e/hosted-actual-owner/contracts';
import {
  assembleEvidence,
  canonicalRowIdentity,
  deriveEvidence,
  EVIDENCE_REQUIREMENTS,
  makeRawRecord,
  makeSemanticPayload,
  observedSemanticIdentity,
  retainEvidence,
  semanticDecisionForEvent,
  type SemanticIdentity,
  semanticScopeForEvent,
} from '../../../../scripts/e2e/hosted-actual-owner/evidence';
import {
  assertOneRunAuthorizationConsumed,
  consumeOneRunAuthorization,
  DESCRIPTOR_FIFO_POLICY,
  descriptorFifoPolicyAccepts,
  type PreflightAdmission,
  verifyControlDocuments,
  verifyReleaseManifest,
} from '../../../../scripts/e2e/hosted-actual-owner/preflight';
import {
  buildSupervisorPlan,
  captureDetachedProcessAnchor,
  censusOwnedProcesses,
  collectBoundedStream,
  exactChildEnvironment,
  parseSupervisorTranscript,
  type ProcessExitEvidence,
  processOwnershipMarker,
  type ProcessStartEvidence,
  registerProvisionalDetachedProcessAnchor,
  settleFailedProcessCapture,
  SUPERVISOR_PROTOCOL,
  type SupervisorOutcome,
  type SupervisorPlan,
  terminateAnchoredProcessGroup,
} from '../../../../scripts/e2e/hosted-actual-owner/processes';
import {
  assertSandboxCurrent,
  cleanupSandbox,
  createSandbox,
} from '../../../../scripts/e2e/hosted-actual-owner/sandbox';
import {
  assertNoSecretLikeBytes,
  closureDigestForTest,
  type ClosureEntry,
  readStable,
  verifyClosure,
  type WrittenFileEvidence,
} from '../../../../scripts/e2e/hosted-actual-owner/secure-files';
import { parseHostedTeamApprovalPage } from '../../../../src/features/team-approvals/contracts/hosted';

import type { DriverResult } from '../../../../scripts/e2e/hosted-actual-owner/driver';
import type { RunResult } from '../../../../scripts/e2e/hosted-actual-owner/run';

const repositoryRoot = process.cwd();
type CompileHarnessSurfaces = DriverResult | RunResult;
const compileHarnessSurfaces: CompileHarnessSurfaces | null = null;
void compileHarnessSurfaces;

function digest(label: string): string {
  return sha256(`p3c-deterministic-fixture:${label}`);
}

function filePin(
  root: RootName,
  label: string,
  sha = digest(label),
  mode: 256 | 292 | 365 = 0o400
): FilePin {
  return {
    root,
    relativePath: `${label}.bin`,
    sha256: sha,
    size: 1,
    mode,
    device: '1',
    inode: String(100 + label.length),
    nlink: 1,
  };
}

function closure(root: RootName, label: string) {
  const manifest = filePin(root, `${label}-manifest`);
  return {
    manifest,
    manifestSha256: manifest.sha256,
    merkleRoot: digest(`${label}:merkle`),
    fileCount: 1,
    totalBytes: 1,
  };
}

function validDescriptor(): Record<string, unknown> {
  const rootNames = [
    'harness',
    'toolchain',
    'productRuntime',
    'browserBundle',
    'p3b2',
    'openCode',
    'controllerAuthority',
    'sandboxParent',
    'evidenceRoot',
  ] as const;
  return {
    schemaVersion: 2,
    purpose: 'agent-teams.p3c.integration-descriptor/v2',
    integrationReady: true,
    executionAuthorized: true,
    controllerNonce: digest('controller-nonce'),
    authority: {
      productAuthorityCommit: PRODUCT_AUTHORITY_COMMIT,
      packetBaseCommit: PACKET_BASE_COMMIT,
      auditedProductCommit: 'd71671599c062244767494d392575cfacba5e1ff',
      auditedProductTree: 'af7fa38ec50893550ce14026c39b428f8dbfd1f2',
    },
    control: {
      lane: P3C_LANE,
      maximumFinalRuns: MAXIMUM_FINAL_RUNS,
      freezeId: digest('freeze-id'),
      reviewId: digest('review-id'),
      authorizationId: digest('authorization-id'),
      freeze: filePin('controllerAuthority', 'p3c1-freeze'),
      harnessReview: filePin('controllerAuthority', 'harness-review'),
      oneRunAuthorization: filePin('controllerAuthority', 'one-run-authorization'),
      harnessReviewerPublicKey: filePin('controllerAuthority', 'harness-reviewer-public-key'),
      runAuthorizationPublicKey: filePin('controllerAuthority', 'run-authorization-public-key'),
    },
    roots: Object.fromEntries(
      rootNames.map((name, index) => [
        name,
        {
          path: `/controller-private/${name}`,
          device: String(index + 1),
          inode: String(index + 11),
          mountId: String(index + 21),
          mode: 0o700,
        },
      ])
    ),
    product: {
      finalHarnessCommit: '1111111111111111111111111111111111111111',
      harnessClosure: closure('harness', 'harness'),
      runEntry: filePin('harness', 'run-entry'),
      runtimeClosure: closure('productRuntime', 'product'),
      compositionEntry: filePin(
        'productRuntime',
        'product-composition-entry',
        digest('product-composition-entry'),
        0o555
      ),
      compositionDescriptor: filePin('productRuntime', 'product-composition-descriptor'),
      browserBundle: closure('browserBundle', 'browser'),
      playwrightEntry: filePin(
        'browserBundle',
        'playwright-entry',
        digest('playwright-entry'),
        0o555
      ),
      playwrightConfig: filePin(
        'browserBundle',
        'playwright-config',
        digest('playwright-config'),
        0o444
      ),
      playwrightSpec: filePin('browserBundle', 'playwright-spec', digest('playwright-spec'), 0o444),
      chromiumExecutable: filePin('browserBundle', 'chromium', digest('chromium'), 0o555),
    },
    toolchain: {
      node: filePin('toolchain', 'node', digest('node'), 0o555),
      loader: filePin('toolchain', 'loader', digest('loader'), 0o444),
      closure: closure('toolchain', 'toolchain'),
      nodeVersion: 'v24.16.0',
    },
    p3b2: {
      sourceBaseCommit: P3B_SOURCE_COMMIT,
      resultCommit: '2222222222222222222222222222222222222222',
      entry: filePin('p3b2', 'owner-entry', digest('owner-entry'), 0o555),
      supervisor: filePin('p3b2', 'supervisor', digest('supervisor'), 0o555),
      recipe: filePin('p3b2', 'recipe'),
      closure: closure('p3b2', 'p3b2'),
      recipeSha256: digest('recipe'),
      independentlyAccepted: true,
    },
    openCode: {
      identities: OPENCODE_IDENTITIES,
      acquisitionReceipt: filePin('openCode', 'receipt'),
      buildProvenanceBundle: filePin(
        'openCode',
        'build-provenance-bundle',
        OPENCODE_IDENTITIES.buildProvenanceBundleSha256
      ),
      releaseManifest: filePin(
        'openCode',
        'release-manifest',
        OPENCODE_IDENTITIES.releaseManifestSha256
      ),
      actionsArtifactZip: filePin(
        'openCode',
        'actions-envelope',
        OPENCODE_IDENTITIES.actionsArtifactZipSha256
      ),
      linuxX64Archive: filePin(
        'openCode',
        'linux-archive',
        OPENCODE_IDENTITIES.linuxX64ArchiveSha256
      ),
      linuxX64Binary: filePin(
        'openCode',
        'opencode',
        OPENCODE_IDENTITIES.linuxX64BinarySha256,
        0o555
      ),
      signedBuildProvenance: true,
      productionEligible: false,
      releaseEligible: false,
    },
    browser: {
      origin: 'http://127.0.0.1:45131',
      descriptor: filePin('browserBundle', 'browser-descriptor'),
      workers: 1,
      retries: 0,
    },
    productionGates: {
      productActivation: false,
      orchestratorActivation: false,
      openCodeActivation: false,
      coordinatedActivation: false,
    },
  };
}

function testContentAddress(
  item: Record<string, unknown>,
  identityField: string,
  domain: string,
  omitted: readonly string[] = []
): string {
  const unsigned = { ...item };
  delete unsigned[identityField];
  for (const field of omitted) delete unsigned[field];
  return sha256(`${domain}\0${canonicalJson(unsigned)}`);
}

function signedControlFixture() {
  const raw = validDescriptor();
  const reviewerKeys = generateKeyPairSync('ed25519');
  const runAuthorizationKeys = generateKeyPairSync('ed25519');
  const reviewerPublicKeyBytes = reviewerKeys.publicKey.export({
    format: 'der',
    type: 'spki',
  });
  const runAuthorizationPublicKeyBytes = runAuthorizationKeys.publicKey.export({
    format: 'der',
    type: 'spki',
  });
  const trustAnchor = {
    schemaVersion: 1 as const,
    purpose: 'agent-teams.p3c.controller-trust-anchor/v1' as const,
    authorityEpoch: 1,
    harnessReviewerPublicKeySha256: sha256(reviewerPublicKeyBytes),
    runAuthorizationPublicKeySha256: sha256(runAuthorizationPublicKeyBytes),
    revokedSignerKeyIds: [] as string[],
  };
  const control = raw.control as Record<string, unknown>;
  const reviewerKeyPin = control.harnessReviewerPublicKey as Record<string, unknown>;
  reviewerKeyPin.sha256 = sha256(reviewerPublicKeyBytes);
  reviewerKeyPin.size = reviewerPublicKeyBytes.length;
  const runAuthorizationKeyPin = control.runAuthorizationPublicKey as Record<string, unknown>;
  runAuthorizationKeyPin.sha256 = sha256(runAuthorizationPublicKeyBytes);
  runAuthorizationKeyPin.size = runAuthorizationPublicKeyBytes.length;
  const seed = parseIntegrationDescriptor(Buffer.from(canonicalJson(raw)));
  const { product, p3b2, openCode, roots } = seed;
  const freeze: Record<string, unknown> = {
    schemaVersion: 1,
    purpose: 'agent-teams.p3c.p3c1-freeze/v1',
    lane: P3C_LANE,
    controllerNonce: raw.controllerNonce,
    freezeId: '',
    authority: raw.authority,
    reviewedHarness: {
      commit: product.finalHarnessCommit,
      closureMerkleRoot: product.harnessClosure.merkleRoot,
    },
    p3b2: {
      sourceBaseCommit: p3b2.sourceBaseCommit,
      resultCommit: p3b2.resultCommit,
      entrySha256: p3b2.entry.sha256,
      supervisorSha256: p3b2.supervisor.sha256,
      recipeSha256: p3b2.recipeSha256,
      closureMerkleRoot: p3b2.closure.merkleRoot,
      accepted: true,
    },
    openCode: {
      identities: openCode.identities,
      provenanceReceiptSha256: openCode.acquisitionReceipt.sha256,
      releaseManifestSha256: openCode.releaseManifest.sha256,
      buildProvenanceBundleSha256: openCode.buildProvenanceBundle.sha256,
      archiveSha256: openCode.linuxX64Archive.sha256,
      binarySha256: openCode.linuxX64Binary.sha256,
      accepted: true,
      productionEligible: false,
    },
    productComposition: {
      entrySha256: product.compositionEntry.sha256,
      descriptorSha256: product.compositionDescriptor.sha256,
      runtimeClosureMerkleRoot: product.runtimeClosure.merkleRoot,
    },
    browser: {
      bundleMerkleRoot: product.browserBundle.merkleRoot,
      playwrightEntrySha256: product.playwrightEntry.sha256,
      playwrightConfigSha256: product.playwrightConfig.sha256,
      playwrightSpecSha256: product.playwrightSpec.sha256,
      chromiumExecutableSha256: product.chromiumExecutable.sha256,
      workers: 1,
      retries: 0,
    },
    attemptLedger: {
      device: roots.sandboxParent.device,
      inode: roots.sandboxParent.inode,
      mountId: roots.sandboxParent.mountId,
    },
    maximumFinalRuns: MAXIMUM_FINAL_RUNS,
    authorityPolicy: trustAnchor,
    harnessReviewerPublicKeySha256: sha256(reviewerPublicKeyBytes),
    runAuthorizationPublicKeySha256: sha256(runAuthorizationPublicKeyBytes),
    productionGates: raw.productionGates,
  };
  freeze.freezeId = testContentAddress(freeze, 'freezeId', 'agent-teams.p3c.p3c1-freeze-id/v1');
  control.freezeId = freeze.freezeId;
  const review: Record<string, unknown> = {
    schemaVersion: 1,
    purpose: 'agent-teams.p3c.harness-review/v1',
    lane: P3C_LANE,
    freezeId: freeze.freezeId,
    reviewId: '',
    reviewedHarnessCommit: product.finalHarnessCommit,
    harnessClosureMerkleRoot: product.harnessClosure.merkleRoot,
    result: 'accepted',
    p0: 0,
    p1: 0,
    p2: 0,
    signerKeyId: sha256(
      `agent-teams.p3c.harness-reviewer-key-id/v1\0${Buffer.from(reviewerPublicKeyBytes).toString('base64')}`
    ),
    signatureBase64: '',
  };
  review.reviewId = testContentAddress(review, 'reviewId', 'agent-teams.p3c.harness-review-id/v1', [
    'signatureBase64',
  ]);
  control.reviewId = review.reviewId;
  const unsignedReview = { ...review };
  delete unsignedReview.signatureBase64;
  review.signatureBase64 = sign(
    null,
    Buffer.from(canonicalJson(unsignedReview)),
    reviewerKeys.privateKey
  ).toString('base64');
  const authorization: Record<string, unknown> = {
    schemaVersion: 1,
    purpose: 'agent-teams.p3c.controller-one-run-authorization/v1',
    lane: P3C_LANE,
    freezeId: freeze.freezeId,
    reviewId: review.reviewId,
    authorizationId: '',
    controllerNonce: raw.controllerNonce,
    attemptLedger: freeze.attemptLedger,
    maximumFinalRuns: MAXIMUM_FINAL_RUNS,
    authorizedAttempts: 1,
    disposition: 'authorize-once',
    signerKeyId: sha256(
      `agent-teams.p3c.run-authorizer-key-id/v1\0${Buffer.from(runAuthorizationPublicKeyBytes).toString('base64')}`
    ),
    signatureBase64: '',
  };
  authorization.authorizationId = testContentAddress(
    authorization,
    'authorizationId',
    'agent-teams.p3c.one-run-authorization-id/v1',
    ['signatureBase64']
  );
  control.authorizationId = authorization.authorizationId;
  const unsignedAuthorization = { ...authorization };
  delete unsignedAuthorization.signatureBase64;
  authorization.signatureBase64 = sign(
    null,
    Buffer.from(canonicalJson(unsignedAuthorization)),
    runAuthorizationKeys.privateKey
  ).toString('base64');
  return {
    descriptor: parseIntegrationDescriptor(Buffer.from(canonicalJson(raw))),
    freeze: Buffer.from(canonicalJson(freeze)),
    review: Buffer.from(canonicalJson(review)),
    authorization: Buffer.from(canonicalJson(authorization)),
    reviewerPublicKey: Buffer.from(reviewerPublicKeyBytes),
    runAuthorizationPublicKey: Buffer.from(runAuthorizationPublicKeyBytes),
    trustAnchor,
  };
}

async function temporaryPrivateDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'p3c-deterministic-'));
  await chmod(path, 0o700);
  return realpath(path);
}

async function rootPin(path: string): Promise<RootPin> {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  );
  try {
    const stat = await handle.stat({ bigint: true });
    const info = await readFile(`/proc/self/fdinfo/${handle.fd}`, 'utf8');
    const mount = info.match(/^mnt_id:\s+(\d+)$/mu)?.[1];
    if (!mount) throw new Error('fixture_mount_missing');
    return {
      path,
      device: String(stat.dev),
      inode: String(stat.ino),
      mountId: mount,
      mode: 0o700,
    };
  } finally {
    await handle.close();
  }
}

async function pinnedFile(
  root: RootName,
  path: string,
  relativePath: string,
  mode: 256 | 292 | 365
): Promise<FilePin> {
  const stat = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const value = await stat.stat({ bigint: true });
    const bytes = await stat.readFile();
    return {
      root,
      relativePath,
      sha256: sha256(bytes),
      size: bytes.length,
      mode,
      device: String(value.dev),
      inode: String(value.ino),
      nlink: 1,
    };
  } finally {
    await stat.close();
  }
}

describe('P3.C exact contract', () => {
  it('owns exactly the fourteen authorized paths', async () => {
    expect(OWNED_PATHS).toHaveLength(14);
    expect(new Set(OWNED_PATHS).size).toBe(14);
    await Promise.all(OWNED_PATHS.map((path) => access(join(repositoryRoot, path))));
  });

  it('accepts only canonical, integrated, exact-identity descriptors', async () => {
    const valid = validDescriptor();
    expect(
      parseIntegrationDescriptor(Buffer.from(canonicalJson(valid))).authority.productAuthorityCommit
    ).toBe(PRODUCT_AUTHORITY_COMMIT);
    expect(() => parseIntegrationDescriptor(Buffer.from(`${canonicalJson(valid)}\n`))).toThrow(
      'p3c_descriptor_noncanonical'
    );
    const unintegrated = JSON.parse(
      await readFile(
        join(
          repositoryRoot,
          'test/e2e/fixtures/hosted-actual-owner/integration-manifest.unintegrated.json'
        ),
        'utf8'
      )
    ) as Record<string, unknown>;
    const unintegratedControl = unintegrated.control as Record<string, unknown>;
    expect(Object.keys(unintegratedControl).sort()).toEqual(
      [
        'authorizationId',
        'freeze',
        'freezeId',
        'harnessReview',
        'harnessReviewerPublicKey',
        'lane',
        'maximumFinalRuns',
        'oneRunAuthorization',
        'reviewId',
        'runAuthorizationPublicKey',
      ].sort()
    );
    expect(unintegratedControl).not.toHaveProperty('controllerPublicKey');
    expect(() => parseIntegrationDescriptor(Buffer.from(canonicalJson(unintegrated)))).toThrow(
      'p3c_descriptor_not_integrated'
    );
    const sourceAlias = structuredClone(valid) as typeof valid;
    (sourceAlias.p3b2 as Record<string, unknown>).resultCommit = P3B_SOURCE_COMMIT;
    expect(() => parseIntegrationDescriptor(Buffer.from(canonicalJson(sourceAlias)))).toThrow(
      'p3c_p3b2_not_accepted_result'
    );
    const gateDrift = structuredClone(valid) as typeof valid;
    (gateDrift.productionGates as Record<string, unknown>).productActivation = true;
    expect(() => parseIntegrationDescriptor(Buffer.from(canonicalJson(gateDrift)))).toThrow(
      'p3c_production_gate_drift'
    );
    const wrongLane = structuredClone(valid) as typeof valid;
    (wrongLane.control as Record<string, unknown>).lane = 'P3.B2.BUILT_ACTUAL_OWNER_ENTRY';
    expect(() => parseIntegrationDescriptor(Buffer.from(canonicalJson(wrongLane)))).toThrow(
      'p3c_wrong_lane_or_run_limit'
    );
    const backingAlias = structuredClone(valid) as typeof valid;
    const roots = backingAlias.roots as Record<string, Record<string, unknown>>;
    roots.evidenceRoot.device = roots.sandboxParent.device;
    roots.evidenceRoot.inode = roots.sandboxParent.inode;
    expect(() => parseIntegrationDescriptor(Buffer.from(canonicalJson(backingAlias)))).toThrow(
      'p3c_root_backing_alias'
    );
    const parallelBrowser = structuredClone(valid) as typeof valid;
    (parallelBrowser.browser as Record<string, unknown>).workers = 2;
    expect(() => parseIntegrationDescriptor(Buffer.from(canonicalJson(parallelBrowser)))).toThrow(
      'p3c_browser_origin_or_workers'
    );
    const retryingBrowser = structuredClone(valid) as typeof valid;
    (retryingBrowser.browser as Record<string, unknown>).retries = 1;
    expect(() => parseIntegrationDescriptor(Buffer.from(canonicalJson(retryingBrowser)))).toThrow(
      'p3c_browser_origin_or_workers'
    );
    const collapsedSigners = structuredClone(valid) as typeof valid;
    const collapsedControl = collapsedSigners.control as Record<string, unknown>;
    collapsedControl.runAuthorizationPublicKey = collapsedControl.harnessReviewerPublicKey;
    expect(() => parseIntegrationDescriptor(Buffer.from(canonicalJson(collapsedSigners)))).toThrow(
      'p3c_control_signer_identity_collapsed'
    );
  });

  it('requires a hash-joined, controller-signed freeze, review, and one-run authorization', () => {
    const fixture = signedControlFixture();
    expect(() =>
      verifyControlDocuments(
        fixture.descriptor,
        fixture.freeze,
        fixture.review,
        fixture.authorization,
        fixture.reviewerPublicKey,
        fixture.runAuthorizationPublicKey,
        fixture.trustAnchor
      )
    ).not.toThrow();
    const forged = JSON.parse(fixture.authorization.toString('utf8')) as Record<string, unknown>;
    forged.signatureBase64 = Buffer.alloc(64).toString('base64');
    expect(() =>
      verifyControlDocuments(
        fixture.descriptor,
        fixture.freeze,
        fixture.review,
        Buffer.from(canonicalJson(forged)),
        fixture.reviewerPublicKey,
        fixture.runAuthorizationPublicKey,
        fixture.trustAnchor
      )
    ).toThrow('p3c_one_run_authorization_signature');
    expect(() =>
      verifyControlDocuments(
        fixture.descriptor,
        fixture.freeze,
        fixture.review,
        fixture.authorization,
        fixture.runAuthorizationPublicKey,
        fixture.reviewerPublicKey,
        fixture.trustAnchor
      )
    ).toThrow();
    const descriptorSelectedTrust = {
      ...fixture.trustAnchor,
      harnessReviewerPublicKeySha256: digest('descriptor-selected-reviewer'),
    };
    expect(() =>
      verifyControlDocuments(
        fixture.descriptor,
        fixture.freeze,
        fixture.review,
        fixture.authorization,
        fixture.reviewerPublicKey,
        fixture.runAuthorizationPublicKey,
        descriptorSelectedTrust
      )
    ).toThrow('p3c_p3c1_freeze_binding');
  });

  it('structurally cross-checks exact OpenCode release-manifest bytes', () => {
    const platforms = [
      ['linux', 'x64'],
      ['linux', 'arm64'],
      ['darwin', 'x64'],
      ['darwin', 'arm64'],
      ['windows', 'x64'],
    ] as const;
    const manifest = {
      schemaVersion: 1,
      workflow: {
        repository: 'example/opencode',
        workflow: 'release',
        runId: OPENCODE_IDENTITIES.workflowRunId,
        runAttempt: OPENCODE_IDENTITIES.workflowRunAttempt,
        actor: 'release-automation',
        ref: OPENCODE_IDENTITIES.workflowRef,
        sha: OPENCODE_IDENTITIES.workflowMergeCommit,
      },
      release: {
        version: '1.18.23-agentteams.1',
        tag: 'v1.18.23-agentteams.1',
        sourceCommit: OPENCODE_IDENTITIES.releaseSourceCommit,
        sourceTree: OPENCODE_IDENTITIES.releaseSourceTree,
        artifactTree: '1111111111111111111111111111111111111111',
        baseCommit: OPENCODE_IDENTITIES.releaseBaseCommit,
        patchSha256: digest('reviewed-patch'),
        bunVersion: '1.3.14',
        productionEligible: false,
        patchSize: 1,
      },
      assets: platforms.map(([os, arch]) => ({
        os,
        arch,
        archive: `opencode-${os}-${arch}.tar.gz`,
        archiveSha256:
          os === 'linux' && arch === 'x64'
            ? OPENCODE_IDENTITIES.linuxX64ArchiveSha256
            : digest(`archive:${os}:${arch}`),
        archiveSize: 10,
        binaryPath: `opencode-${os}-${arch}/opencode`,
        binarySha256:
          os === 'linux' && arch === 'x64'
            ? OPENCODE_IDENTITIES.linuxX64BinarySha256
            : digest(`binary:${os}:${arch}`),
        binarySize: 5,
        platform: `opencode-${os}-${arch}`,
        signing: {
          binaryStatus: 'unsigned',
          reason: 'non-production fork prerelease',
          provenanceAction:
            'actions/attest-build-provenance@4d101475d8b20a2381f78447822ac1eab6504dd8',
          provenanceStatus: 'required-after-manifest',
        },
      })),
    };
    expect(() =>
      verifyReleaseManifest(Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`))
    ).not.toThrow();
    manifest.assets[0].binarySha256 = digest('wrong-linux-binary');
    expect(() => verifyReleaseManifest(Buffer.from(JSON.stringify(manifest)))).toThrow(
      'p3c_release_manifest_binding'
    );
  });
});

describe('retained evidence redaction', () => {
  it.each([
    '{"token":"omitted"}',
    '{"apiKey":"omitted"}',
    '{"authorization":"omitted"}',
    '{"cookie":"omitted"}',
    '{"csrf":"omitted"}',
    '{"actionNonce":"omitted"}',
    '{"decisionBearer":"omitted"}',
    '{"promptBody":{"redacted":true}}',
    '{"providerBody":{"redacted":true}}',
  ])('rejects forbidden retained structure %s', (source) => {
    expect(() => assertNoSecretLikeBytes(Buffer.from(source))).toThrow('p3c_secret_like_evidence');
  });
});

describe('descriptor-relative filesystem safety', () => {
  it('binds a private root and stable single-link file to exact identities and digest', async () => {
    const path = await temporaryPrivateDirectory();
    const leaf = join(path, 'input.bin');
    const bytes = Buffer.from('deterministic-input');
    await writeFile(leaf, bytes, { flag: 'wx', mode: 0o400 });
    const root = await openRootAnchor('openCode', await rootPin(path));
    const pin = await pinnedFile('openCode', leaf, 'input.bin', 0o400);
    const file = await openFileAnchor(root, pin);
    expect(await readStable(file)).toEqual(bytes);
    await file.handle.close();
    await root.handle.close();
    await unlink(leaf);
    await rmdir(path);
  });

  it('rejects links and undeclared closure members', async () => {
    const path = await temporaryPrivateDirectory();
    const entryPath = join(path, 'entry.bin');
    const aliasPath = join(path, 'alias.bin');
    const linkedPath = join(path, 'linked.bin');
    const entryBytes = Buffer.from('entry');
    await writeFile(entryPath, entryBytes, { flag: 'wx', mode: 0o444 });
    await link(entryPath, aliasPath);
    const linkedPin = await pinnedFile('p3b2', entryPath, 'entry.bin', 0o444);
    const root = await openRootAnchor('p3b2', await rootPin(path));
    await expect(openFileAnchor(root, { ...linkedPin, nlink: 1 })).rejects.toThrow(
      'p3c_anchor_file_pin'
    );
    await unlink(aliasPath);
    await symlink('entry.bin', linkedPath);
    await expect(
      openFileAnchor(root, { ...linkedPin, relativePath: 'linked.bin' })
    ).rejects.toThrow();
    await unlink(linkedPath);

    const refreshedPin = await pinnedFile('p3b2', entryPath, 'entry.bin', 0o444);
    const entry: ClosureEntry = {
      path: 'entry.bin',
      mode: 0o444,
      size: entryBytes.length,
      sha256: refreshedPin.sha256,
    };
    const manifestBytes = Buffer.from(canonicalJson([entry]));
    const manifestPath = join(path, 'manifest.json');
    await writeFile(manifestPath, manifestBytes, { flag: 'wx', mode: 0o400 });
    const manifest = await pinnedFile('p3b2', manifestPath, 'manifest.json', 0o400);
    const closurePin = {
      manifest,
      manifestSha256: manifest.sha256,
      merkleRoot: closureDigestForTest([entry]),
      fileCount: 1,
      totalBytes: entryBytes.length,
    };
    await expect(verifyClosure(root, closurePin)).resolves.toMatchObject({
      fileCount: 1,
    });
    const extraPath = join(path, 'extra.bin');
    await writeFile(extraPath, Buffer.from('extra'), {
      flag: 'wx',
      mode: 0o444,
    });
    await expect(verifyClosure(root, closurePin)).rejects.toThrow('p3c_closure_disagreement');
    await root.handle.close();
    await unlink(extraPath);
    await unlink(manifestPath);
    await unlink(entryPath);
    await rmdir(path);
  });
});

describe('single disposable sandbox', () => {
  it('preserves on unproved drain and removes only after marker and zero-survivor proof', async () => {
    const path = await temporaryPrivateDirectory();
    const root = await openRootAnchor('sandboxParent', await rootPin(path));
    const sandbox = await createSandbox(root, digest('sandbox-controller'));
    await expect(assertSandboxCurrent(sandbox)).resolves.toBeUndefined();
    for (const name of ['home', 'config', 'cache', 'data', 'state', 'run'] as const)
      expect((await stat(sandbox.paths[name])).mode & 0o777).toBe(0o700);
    expect((await cleanupSandbox(sandbox, false)).disposition).toBe('preserved');
    await expect(assertSandboxCurrent(sandbox)).resolves.toBeUndefined();
    expect((await cleanupSandbox(sandbox, true)).disposition).toBe('removed');
    await root.handle.close();
    await rmdir(path);
  });

  it('rejects a same-name replacement of every pinned child directory', async () => {
    const path = await temporaryPrivateDirectory();
    const root = await openRootAnchor('sandboxParent', await rootPin(path));
    const sandbox = await createSandbox(root, digest('sandbox-child-replacement'));
    await rename(sandbox.paths.cache, `${sandbox.paths.cache}-original`);
    await mkdir(sandbox.paths.cache, { mode: 0o700 });
    await expect(assertSandboxCurrent(sandbox)).rejects.toThrow(
      'p3c_sandbox_child_identity_changed:cache'
    );
    await sandbox.handle.close();
    await root.handle.close();
    await rm(join(path, sandbox.name), { recursive: true });
    await rmdir(path);
  });

  it('keeps child paths descriptor-confined after the parent pathname is replaced', async () => {
    const path = await temporaryPrivateDirectory();
    const movedPath = `${path}-moved`;
    const root = await openRootAnchor('sandboxParent', await rootPin(path));
    const sandbox = await createSandbox(root, digest('sandbox-parent-replacement'));
    await rename(path, movedPath);
    await mkdir(join(path, sandbox.name, 'cache'), {
      mode: 0o700,
      recursive: true,
    });
    expect(await realpath(sandbox.paths.cache)).toBe(join(movedPath, sandbox.name, 'cache'));
    await expect(assertSandboxCurrent(sandbox)).rejects.toThrow(
      'p3c_anchor_root_no_longer_current'
    );
    await sandbox.handle.close();
    await root.handle.close();
    await rm(path, { recursive: true });
    await rm(movedPath, { recursive: true });
  });
});

describe('one-run authorization consumption', () => {
  it('atomically persists one attempt before spawn and rejects a fresh descriptor replay', async () => {
    const path = await temporaryPrivateDirectory();
    const root = await openRootAnchor('sandboxParent', await rootPin(path));
    const admission = {
      roots: { sandboxParent: root },
      descriptor: { controllerNonce: digest('consume-controller') },
      control: {
        freezeId: digest('consume-freeze'),
        reviewId: digest('consume-review'),
        authorizationId: digest('consume-authorization'),
      },
    } as unknown as PreflightAdmission;
    const consumed = await consumeOneRunAuthorization(admission);
    expect(consumed.relativePath).toBe('actual-owner-final-run-000001.json');
    await expect(assertOneRunAuthorizationConsumed(admission, consumed)).resolves.toBeUndefined();
    const freshSelfAssertion = {
      ...admission,
      control: {
        ...admission.control,
        authorizationId: digest('fresh-self-assertion'),
      },
    } as PreflightAdmission;
    await expect(consumeOneRunAuthorization(freshSelfAssertion)).rejects.toThrow(
      'p3c_authorization_already_consumed'
    );
    const sandbox = await createSandbox(root, admission.descriptor.controllerNonce);
    expect((await cleanupSandbox(sandbox, true)).disposition).toBe('removed');
    await expect(assertOneRunAuthorizationConsumed(admission, consumed)).resolves.toBeUndefined();
    await root.handle.close();
    await unlink(join(path, consumed.relativePath));
    await rmdir(path);
  });

  it('allows exactly one global winner across concurrent nonces and survives controller restart', async () => {
    const path = await temporaryPrivateDirectory();
    const root = await openRootAnchor('sandboxParent', await rootPin(path));
    const admission = (label: string) =>
      ({
        roots: { sandboxParent: root },
        descriptor: { controllerNonce: digest(`concurrent-controller:${label}`) },
        control: {
          freezeId: digest(`concurrent-freeze:${label}`),
          reviewId: digest(`concurrent-review:${label}`),
          authorizationId: digest(`concurrent-authorization:${label}`),
        },
      }) as unknown as PreflightAdmission;
    const contenders = [admission('a'), admission('b')];
    const results = await Promise.allSettled(contenders.map(consumeOneRunAuthorization));
    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(1);
    const winnerIndex = results.findIndex(({ status }) => status === 'fulfilled');
    const winner = results[winnerIndex] as PromiseFulfilledResult<WrittenFileEvidence>;
    await expect(
      assertOneRunAuthorizationConsumed(contenders[winnerIndex], winner.value)
    ).resolves.toBeUndefined();
    await expect(consumeOneRunAuthorization(admission('restart'))).rejects.toThrow(
      'p3c_authorization_already_consumed'
    );
    await root.handle.close();
    await unlink(join(path, winner.value.relativePath));
    await rmdir(path);
  });
});

describe('bounded private descriptor FIFO', () => {
  it('rejects public modes, writable descriptors, and blocking readers', () => {
    expect(DESCRIPTOR_FIFO_POLICY.maximumOpenReadMs).toBe(5_000);
    expect(descriptorFifoPolicyAccepts(0o600, 1, 0o4000)).toBe(true);
    expect(descriptorFifoPolicyAccepts(0o644, 1, 0o4000)).toBe(false);
    expect(descriptorFifoPolicyAccepts(0o600, 2, 0o4000)).toBe(false);
    expect(descriptorFifoPolicyAccepts(0o600, 1, 0)).toBe(false);
    expect(descriptorFifoPolicyAccepts(0o600, 1, 0o4001)).toBe(false);
  });
});

describe('spawn isolation contract', () => {
  it('constructs a private allowlist without ambient token or proxy variables', () => {
    const environment = exactChildEnvironment();
    expect(environment).toEqual({
      HOME: '/sandbox/home',
      XDG_CONFIG_HOME: '/sandbox/config',
      XDG_CACHE_HOME: '/sandbox/cache',
      XDG_DATA_HOME: '/sandbox/data',
      XDG_STATE_HOME: '/sandbox/state',
      XDG_RUNTIME_DIR: '/sandbox/run',
      TMPDIR: '/sandbox/tmp',
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      TZ: 'UTC',
      CI: '1',
    });
    expect(
      Object.keys(environment).some((key) =>
        /(?:token|key|auth|credential|proxy|npm|git|ssh|path|node_options)/iu.test(key)
      )
    ).toBe(false);
  });

  it('pins the supervisor executable independently from the owner entry', () => {
    const descriptor = parseIntegrationDescriptor(Buffer.from(canonicalJson(validDescriptor())));
    const admission = {
      descriptor,
      execution: {
        ownerEntry: { pin: descriptor.p3b2.entry },
        supervisor: { pin: descriptor.p3b2.supervisor },
        openCode: { pin: descriptor.openCode.linuxX64Binary },
      },
    } as unknown as PreflightAdmission;
    const sandbox = {
      runId: digest('plan-run'),
      device: '1',
      inode: '2',
      mountId: '3',
      directoryIdentities: {
        run: { device: '1', inode: '30', mountId: '3' },
        project: { device: '1', inode: '31', mountId: '3' },
      },
    } as unknown as Parameters<typeof buildSupervisorPlan>[1];
    const plan = buildSupervisorPlan(admission, sandbox);
    expect(plan.expectedExecutableSha256.supervisor).toBe(descriptor.p3b2.supervisor.sha256);
    expect(plan.expectedExecutableSha256.supervisor).not.toBe(descriptor.p3b2.entry.sha256);
    expect(plan.expectedArgv.browser).toEqual(
      expect.arrayContaining(['--workers=1', '--retries=0'])
    );
    expect(plan.processOwnership.escapedDescendants).toBe('independent-proc-census');
  });
});

function supervisorPlan(): SupervisorPlan {
  const chromium = [
    'chromium-browser',
    'chromium-network',
    'chromium-gpu',
    'chromium-renderer',
  ] as const;
  return {
    schemaVersion: 2,
    protocol: SUPERVISOR_PROTOCOL,
    controllerNonce: digest('process-controller'),
    runId: digest('process-run'),
    maximumRuntimeMs: 900000,
    shutdownGraceMs: 5000,
    network: {
      namespace: 'new',
      mountNamespace: 'new',
      loopbackOnly: true,
      outbound: 'deny',
      expectedListeners: [
        { address: '127.0.0.1', port: 4096, role: 'opencode' },
        { address: '127.0.0.1', port: 45131, role: 'product' },
      ],
    },
    filesystem: {
      mountNamespace: 'new',
      pidNamespace: 'new',
      pivotRoot: true,
      rootFilesystem: 'private-tmpfs',
      ambientHostFilesystem: 'deny',
      expectedTopLevelEntries: [
        'browser',
        'composition',
        'dev',
        'opencode',
        'owner',
        'p3b2',
        'proc',
        'product',
        'sandbox',
        'toolchain',
      ],
      expectedMounts: [
        { target: '/', access: 'private', sourceDescriptor: null },
        { target: '/proc', access: 'private', sourceDescriptor: null },
        { target: '/dev', access: 'private', sourceDescriptor: null },
        { target: '/product', access: 'read-only', sourceDescriptor: 4 },
        { target: '/browser', access: 'read-only', sourceDescriptor: 5 },
        { target: '/owner', access: 'read-only', sourceDescriptor: 6 },
        { target: '/opencode', access: 'read-only', sourceDescriptor: 7 },
        { target: '/sandbox', access: 'read-write', sourceDescriptor: 10 },
        { target: '/toolchain', access: 'read-only', sourceDescriptor: 11 },
        { target: '/p3b2', access: 'read-only', sourceDescriptor: 12 },
        { target: '/composition', access: 'read-only', sourceDescriptor: 13 },
      ],
      ambientPathProbes: ['/host', '/home', '/root', '/tmp', '/var/data'],
    },
    processOwnership: {
      environmentKey: 'P3C_PROCESS_OWNERSHIP_MARKER',
      marker: processOwnershipMarker(digest('process-controller'), digest('process-run')),
      census: '/proc',
      identity: 'pid-start-time',
      signals: ['SIGTERM', 'SIGKILL'],
      escapedDescendants: 'independent-proc-census',
    },
    cleanupAudit: {
      injectionPoints: ['owner', 'opencode'],
      escapedCensusKinds: ['setsid', 'double-fork'],
      escalationSignals: ['SIGTERM', 'SIGKILL'],
      outsideSandboxSentinelPath: '/outside-sandbox-sentinel',
    },
    sandbox: {
      descriptor: 10,
      device: '1',
      inode: '2',
      mountId: '3',
      mountPath: '/sandbox',
    },
    inputs: {
      productRuntimeDescriptor: 4,
      browserBundleDescriptor: 5,
      ownerEntryDescriptor: 6,
      openCodeDescriptor: 7,
      browserDescriptor: 8,
      toolchainDescriptor: 11,
      p3b2Descriptor: 12,
      productCompositionDescriptor: 13,
      nodeRelativePath: 'node.bin',
      loaderRelativePath: 'loader.bin',
    },
    closures: {
      productRuntime: closure('productRuntime', 'plan-product'),
      browserBundle: closure('browserBundle', 'plan-browser'),
      toolchain: closure('toolchain', 'plan-toolchain'),
      p3b2: closure('p3b2', 'plan-p3b2'),
    },
    expectedCwd: {
      supervisor: { device: '1', inode: '30' },
      opencode: { device: '1', inode: '31' },
      owner: { device: '1', inode: '31' },
      product: { device: '1', inode: '31' },
      browser: { device: '1', inode: '31' },
    },
    expectedExecutableSha256: {
      owner: digest('owner-executable'),
      opencode: digest('opencode-executable'),
      supervisor: digest('supervisor-executable'),
      product: digest('node-executable'),
      browser: digest('node-executable'),
      'chromium-browser': digest('chromium-executable'),
      'chromium-network': digest('chromium-executable'),
      'chromium-gpu': digest('chromium-executable'),
      'chromium-renderer': digest('chromium-executable'),
    },
    expectedExecutableDevice: {
      owner: '11',
      opencode: '12',
      supervisor: '13',
      product: '14',
      browser: '14',
      'chromium-browser': '15',
      'chromium-network': '15',
      'chromium-gpu': '15',
      'chromium-renderer': '15',
    },
    expectedExecutableInode: {
      owner: '21',
      opencode: '22',
      supervisor: '23',
      product: '24',
      browser: '24',
      'chromium-browser': '25',
      'chromium-network': '25',
      'chromium-gpu': '25',
      'chromium-renderer': '25',
    },
    expectedArgv: {
      supervisor: ['--p3c-supervisor'],
      opencode: ['serve', '--hostname', '127.0.0.1', '--port', '4096'],
      owner: ['--p3c-acceptance-manifest-fd=3'],
      product: ['--p3c-composition-descriptor-fd=3', '--host=127.0.0.1', '--port=45131'],
      browser: [
        '/browser/playwright-entry.bin',
        'test',
        '/browser/playwright-spec.bin',
        '--config',
        '/browser/playwright-config.bin',
        '--workers=1',
        '--retries=0',
      ],
    },
    startSchedule: [
      {
        role: 'opencode',
        instanceId: 'opencode-1',
        generation: 1,
        restartBoundary: 'initial',
      },
      {
        role: 'owner',
        instanceId: 'owner-1',
        generation: 1,
        restartBoundary: 'initial',
      },
      {
        role: 'product',
        instanceId: 'product-1',
        generation: 1,
        restartBoundary: 'initial',
      },
      {
        role: 'browser',
        instanceId: 'browser-1',
        generation: 1,
        restartBoundary: 'initial',
      },
      {
        role: 'owner',
        instanceId: 'owner-2',
        generation: 2,
        restartBoundary: 'after-pending-before-decision',
      },
      {
        role: 'owner',
        instanceId: 'owner-3',
        generation: 3,
        restartBoundary: 'after-decision-before-provider',
      },
      {
        role: 'owner',
        instanceId: 'owner-4',
        generation: 4,
        restartBoundary: 'after-effect-before-owner-recording',
      },
    ],
    chromiumDescendants: chromium,
    playwrightWorkers: 1,
    playwrightRetries: 0,
  };
}

function supervisorTranscript(plan: SupervisorPlan): Buffer {
  const lines: unknown[] = [
    {
      schemaVersion: 2,
      protocol: SUPERVISOR_PROTOCOL,
      type: 'hello',
      sequence: 1,
      controllerNonce: plan.controllerNonce,
      runId: plan.runId,
      planSha256: sha256(canonicalJson(plan)),
      kernelFeatures: [
        'pidfd_open',
        'pidfd_send_signal',
        'openat2',
        'execveat',
        'mount_namespace',
        'network_namespace',
        'pid_namespace',
        'pivot_root',
      ],
      playwrightWorkers: 1,
      playwrightRetries: 0,
      supervisorPid: 900,
      supervisorPidfdInode: '901',
      supervisorStartTime: '902',
      supervisorObservedMonotonicNs: '10',
      supervisorStartToken: digest('start:supervisor'),
      processOwnershipMarkerSha256: sha256(plan.processOwnership.marker),
      supervisorExecutableDevice: plan.expectedExecutableDevice.supervisor,
      supervisorExecutableInode: plan.expectedExecutableInode.supervisor,
      supervisorExecutableSha256: plan.expectedExecutableSha256.supervisor,
      supervisorArgvSha256: sha256(canonicalJson(plan.expectedArgv.supervisor)),
      supervisorCwdDevice: plan.expectedCwd.supervisor.device,
      supervisorCwdInode: plan.expectedCwd.supervisor.inode,
    },
  ];
  const starts: ProcessStartEvidence[] = [];
  const replacementExits: ProcessExitEvidence[] = [];
  let previousOwner: ProcessStartEvidence | undefined;
  let previousOwnerSocket: Record<string, unknown> | undefined;
  plan.startSchedule.forEach((expected, index) => {
    if (expected.role === 'owner' && expected.generation > 1) {
      const replacement = {
        schemaVersion: 2,
        protocol: SUPERVISOR_PROTOCOL,
        type: 'owner-replacement',
        sequence: lines.length + 1,
        controllerNonce: plan.controllerNonce,
        runId: plan.runId,
        observerStartToken: digest('start:supervisor'),
        previousOwnerStartToken: previousOwner!.startToken,
        previousOwnerPidfdInode: previousOwner!.pidfdInode,
        previousGeneration: previousOwner!.generation,
        previousExitCause: 'restart-boundary-complete',
        previousExitObservedMonotonicNs: String(20 + lines.length),
        previousOwnerSurvivorStartTokens: [],
        invalidatedSocket: previousOwnerSocket,
        postInvalidationCurrentOwnerStartTokens: [],
        postInvalidationCurrentSocketOwners: [],
        nextGeneration: expected.generation,
      };
      lines.push(replacement);
      replacementExits.push({
        startToken: previousOwner!.startToken,
        pidfdInode: previousOwner!.pidfdInode,
        observedMonotonicNs: replacement.previousExitObservedMonotonicNs,
        observerStartToken: digest('start:supervisor'),
        disposition: 'replacement-boundary-exit',
      });
    }
    const start = {
      schemaVersion: 2,
      protocol: SUPERVISOR_PROTOCOL,
      type: 'process-start',
      sequence: lines.length + 1,
      controllerNonce: plan.controllerNonce,
      runId: plan.runId,
      role: expected.role,
      instanceId: expected.instanceId,
      generation: expected.generation,
      restartBoundary: expected.restartBoundary,
      pid: 1000 + index,
      pidfdInode: String(2000 + index),
      startTime: String(3000 + index),
      observedMonotonicNs: String(20 + lines.length),
      startToken: digest(`start:${expected.instanceId}`),
      parentStartToken: digest('start:supervisor'),
      observerStartToken: digest('start:supervisor'),
      ownershipMarkerSha256: sha256(plan.processOwnership.marker),
      executableDevice: plan.expectedExecutableDevice[expected.role],
      executableInode: plan.expectedExecutableInode[expected.role],
      executableSha256: plan.expectedExecutableSha256[expected.role],
      argvSha256: sha256(canonicalJson(plan.expectedArgv[expected.role])),
      cwdDevice: plan.expectedCwd[expected.role].device,
      cwdInode: plan.expectedCwd[expected.role].inode,
    };
    lines.push(start);
    starts.push(start);
    if (expected.role === 'owner') {
      previousOwner = start;
      previousOwnerSocket = {
        device: String(6000 + expected.generation),
        inode: String(6100 + expected.generation),
        generation: expected.generation,
        ownerStartToken: start.startToken,
      };
      lines.push({
        schemaVersion: 2,
        protocol: SUPERVISOR_PROTOCOL,
        type: 'owner-current',
        sequence: lines.length + 1,
        controllerNonce: plan.controllerNonce,
        runId: plan.runId,
        observerStartToken: digest('start:supervisor'),
        generation: expected.generation,
        currentOwnerStartTokens: [start.startToken],
        currentSocketOwners: [previousOwnerSocket],
      });
    }
  });
  const browser = starts.find(({ role }) => role === 'browser')!;
  let chromiumParent = '';
  const descendants = plan.chromiumDescendants.map((role, index) => {
    const start = {
      schemaVersion: 2,
      protocol: SUPERVISOR_PROTOCOL,
      type: 'descendant-start',
      sequence: lines.length + 1,
      controllerNonce: plan.controllerNonce,
      runId: plan.runId,
      role,
      instanceId: `${role}-1`,
      generation: 1,
      restartBoundary: 'initial',
      pid: 2000 + index,
      pidfdInode: String(4000 + index),
      startTime: String(5000 + index),
      observedMonotonicNs: String(40 + index),
      startToken: digest(`start:${role}`),
      parentStartToken: role === 'chromium-browser' ? browser.startToken : chromiumParent,
      observerStartToken: digest('start:supervisor'),
      ownershipMarkerSha256: sha256(plan.processOwnership.marker),
      executableDevice: plan.expectedExecutableDevice[role],
      executableInode: plan.expectedExecutableInode[role],
      executableSha256: plan.expectedExecutableSha256[role],
      argvSha256: digest(`argv:${role}`),
      cwdDevice: plan.expectedCwd.browser.device,
      cwdInode: plan.expectedCwd.browser.inode,
    };
    if (role === 'chromium-browser') chromiumParent = start.startToken;
    lines.push(start);
    return start;
  });
  const descendantEnumeration = {
    schemaVersion: 2,
    protocol: SUPERVISOR_PROTOCOL,
    type: 'descendant-enumeration',
    sequence: lines.length + 1,
    controllerNonce: plan.controllerNonce,
    runId: plan.runId,
    observerStartToken: digest('start:supervisor'),
    browserRootStartToken: browser.startToken,
    enumeratedStartTokens: descendants.map(({ startToken }) => startToken).sort(),
    unexpectedStartTokens: [],
    ownershipAmbiguities: [],
    complete: true,
  };
  lines.push(descendantEnumeration);
  const filesystem = {
    schemaVersion: 2,
    protocol: SUPERVISOR_PROTOCOL,
    type: 'filesystem-evidence',
    sequence: lines.length + 1,
    controllerNonce: plan.controllerNonce,
    runId: plan.runId,
    mountNamespaceInode: '7101',
    parentMountNamespaceInode: '7100',
    pidNamespaceInode: '7201',
    parentPidNamespaceInode: '7200',
    rootDevice: '7301',
    rootInode: '7302',
    topLevelEntries: plan.filesystem.expectedTopLevelEntries,
    mounts: plan.filesystem.expectedMounts,
    ambientPathProbes: plan.filesystem.ambientPathProbes.map((path) => ({
      path,
      result: 'absent',
    })),
    complete: true,
  };
  lines.push(filesystem);
  const network = {
    schemaVersion: 2,
    protocol: SUPERVISOR_PROTOCOL,
    type: 'network-evidence',
    sequence: lines.length + 1,
    controllerNonce: plan.controllerNonce,
    runId: plan.runId,
    namespaceInode: '7001',
    parentNamespaceInode: '7000',
    interfaces: [
      {
        name: 'lo',
        flags: ['LOOPBACK', 'UP'],
        addresses: ['127.0.0.1/8', '::1/128'],
      },
    ],
    routes: [
      { destination: '127.0.0.0/8', interface: 'lo', scope: 'host' },
      { destination: '::1/128', interface: 'lo', scope: 'host' },
    ],
    listeners: plan.network.expectedListeners,
    outboundProbes: [
      { destination: '198.51.100.1:443', result: 'denied' },
      { destination: '[2001:db8::1]:443', result: 'denied' },
    ],
  };
  lines.push(network);
  const replacedOwnerTokens = new Set(replacementExits.map(({ startToken }) => startToken));
  const finalExits = [...starts, ...descendants]
    .filter(({ startToken }) => !replacedOwnerTokens.has(startToken))
    .reverse()
    .map((start, index) => {
      const exit = {
        schemaVersion: 2,
        protocol: SUPERVISOR_PROTOCOL,
        type: 'process-exit',
        sequence: lines.length + 1,
        controllerNonce: plan.controllerNonce,
        runId: plan.runId,
        startToken: start.startToken,
        pidfdInode: start.pidfdInode,
        observedMonotonicNs: String(1000 + index),
        observerStartToken: digest('start:supervisor'),
        disposition: 'controlled-exit',
      };
      lines.push(exit);
      return exit;
    });
  const exits = [...replacementExits, ...finalExits];
  const injectedProcessStartTokens = [
    digest('cleanup-injected-owner'),
    digest('cleanup-injected-opencode'),
  ];
  const sentinelDigest = digest('outside-sandbox-sentinel');
  const cleanupAudit = {
    schemaVersion: 2,
    protocol: SUPERVISOR_PROTOCOL,
    type: 'cleanup-audit',
    sequence: lines.length + 1,
    controllerNonce: plan.controllerNonce,
    runId: plan.runId,
    observerStartToken: digest('start:supervisor'),
    injectionPoints: plan.cleanupAudit.injectionPoints,
    injectedProcessStartTokens,
    escapedCensusKinds: plan.cleanupAudit.escapedCensusKinds,
    escapedDescendantStartTokens: [
      digest('cleanup-escaped-setsid'),
      digest('cleanup-escaped-double-fork'),
    ],
    escalationSignals: plan.cleanupAudit.escalationSignals,
    exitCauses: plan.cleanupAudit.injectionPoints.map((injectionPoint, index) => ({
      injectionPoint,
      startToken: injectedProcessStartTokens[index],
      cause: 'sigkill-after-grace',
    })),
    postDrainEscapedDescendantStartTokens: [],
    postDrainIndependentCensus: true,
    outsideSandboxSentinel: {
      path: plan.cleanupAudit.outsideSandboxSentinelPath,
      digestBefore: sentinelDigest,
      digestAfter: sentinelDigest,
      mutationObserved: false,
    },
  };
  lines.push(cleanupAudit);
  const cleanupAuditRecordSha256 = sha256(canonicalJson(cleanupAudit));
  const processEvidenceSetId = sha256(
    `agent-teams.p3c.process-evidence-set/v1\0${canonicalJson({
      networkRecordSha256: sha256(canonicalJson(network)),
      filesystemRecordSha256: sha256(canonicalJson(filesystem)),
      descendantEnumerationRecordSha256: sha256(canonicalJson(descendantEnumeration)),
      ownedStartTokens: [...starts, ...descendants].map(({ startToken }) => startToken).sort(),
      closedPidfdInodes: [...starts, ...descendants].map(({ pidfdInode }) => pidfdInode).sort(),
      exitedStartTokens: exits.map(({ startToken }) => startToken),
      cleanupAuditRecordSha256,
    })}`
  );
  const drain = {
    schemaVersion: 2,
    protocol: SUPERVISOR_PROTOCOL,
    type: 'drain',
    sequence: lines.length + 1,
    controllerNonce: plan.controllerNonce,
    runId: plan.runId,
    observerStartToken: digest('start:supervisor'),
    ownedStartTokens: [...starts, ...descendants].map(({ startToken }) => startToken).sort(),
    closedPidfdInodes: [...starts, ...descendants].map(({ pidfdInode }) => pidfdInode).sort(),
    survivorStartTokens: [],
    ownershipAmbiguities: [],
    descendantEnumerationRecordSha256: sha256(canonicalJson(descendantEnumeration)),
    postTerminationDescendantStartTokens: [],
    cleanupAuditRecordSha256,
    processEvidenceSetId,
    bounded: true,
    zeroOwnedSurvivors: true,
  };
  lines.push(drain);
  const producerRoles: Readonly<Record<RawOrigin, readonly string[]>> = {
    browser: ['browser'],
    'product-http': ['product'],
    'product-sse': ['product'],
    'owner-wal': ['owner'],
    opencode: ['opencode'],
    supervisor: ['supervisor'],
  };
  lines.push({
    schemaVersion: 2,
    protocol: SUPERVISOR_PROTOCOL,
    type: 'result',
    sequence: lines.length + 1,
    controllerNonce: plan.controllerNonce,
    runId: plan.runId,
    planSha256: sha256(canonicalJson(plan)),
    networkRecordSha256: sha256(canonicalJson(network)),
    filesystemRecordSha256: sha256(canonicalJson(filesystem)),
    drainRecordSha256: sha256(canonicalJson(drain)),
    boundedShutdown: true,
    zeroOwnedSurvivors: true,
    completeBrowserProcessTree: true,
    playwrightWorkers: 1,
    playwrightRetries: 0,
    readyInstances: starts.map(({ instanceId }) => instanceId),
    exitedStartTokens: exits.map(({ startToken }) => startToken),
    rawFiles: Object.fromEntries(
      RAW_ORIGINS.map((origin, index) => {
        const producers =
          origin === 'supervisor'
            ? [{ startToken: digest('start:supervisor'), pidfdInode: '901' }]
            : starts.filter(({ role }) => producerRoles[origin].includes(role));
        return [
          origin,
          {
            path: `/sandbox/raw/${origin}.ndjson`,
            sha256: digest(`raw:${origin}`),
            size: 1,
            captureDevice: String(8000 + index),
            captureInode: String(9000 + index),
            producerStartTokens: producers.map(({ startToken }) => startToken).sort(),
            producerPidfdInodes: producers.map(({ pidfdInode }) => pidfdInode).sort(),
            parentCreatedExclusive: true,
            writerDescriptorsClosed: true,
            sealedBeforeParse: true,
          },
        ];
      })
    ),
  });
  return Buffer.from(`${lines.map(canonicalJson).join('\n')}\n`);
}

describe('process ownership transcript', () => {
  it('requires replacement owners, complete Chromium descendants, network isolation, and drain', () => {
    const plan = supervisorPlan();
    const transcript = supervisorTranscript(plan);
    const outcome = parseSupervisorTranscript(transcript, plan);
    expect(outcome).toMatchObject({ zeroOwnedSurvivors: true });
    expect(outcome.starts.filter(({ role }) => role === 'owner')).toHaveLength(4);
    expect(outcome.descendants.map(({ role }) => role)).toEqual(plan.chromiumDescendants);
    expect(outcome.network.namespaceInode).not.toBe(outcome.network.parentNamespaceInode);
    const changed = Buffer.from(
      transcript.toString('utf8').replace('"zeroOwnedSurvivors":true', '"zeroOwnedSurvivors":false')
    );
    expect(() => parseSupervisorTranscript(changed, plan)).toThrow('p3c_supervisor_drain');
    const wrongParent = Buffer.from(
      transcript
        .toString('utf8')
        .replace(
          `"parentStartToken":"${digest('start:supervisor')}"`,
          `"parentStartToken":"${digest('start:wrong-parent')}"`
        )
    );
    expect(() => parseSupervisorTranscript(wrongParent, plan)).toThrow(
      'p3c_supervisor_start_binding'
    );
    const overlappingOwners = Buffer.from(
      transcript
        .toString('utf8')
        .replace(
          '"postInvalidationCurrentOwnerStartTokens":[]',
          `"postInvalidationCurrentOwnerStartTokens":["${digest('start:owner-1')}"]`
        )
    );
    expect(() => parseSupervisorTranscript(overlappingOwners, plan)).toThrow(
      'p3c_supervisor_owner_replacement'
    );
    const escapedSurvivor = Buffer.from(
      transcript
        .toString('utf8')
        .replace(
          '"postDrainEscapedDescendantStartTokens":[]',
          `"postDrainEscapedDescendantStartTokens":["${digest('cleanup-escaped-setsid')}"]`
        )
    );
    expect(() => parseSupervisorTranscript(escapedSurvivor, plan)).toThrow(
      'p3c_supervisor_cleanup_audit'
    );
    const sentinelMutation = Buffer.from(
      transcript.toString('utf8').replace('"mutationObserved":false', '"mutationObserved":true')
    );
    expect(() => parseSupervisorTranscript(sentinelMutation, plan)).toThrow(
      'p3c_supervisor_cleanup_audit'
    );
    for (const [needle, replacement, expected] of [
      ['"playwrightWorkers":1', '"playwrightWorkers":2', 'p3c_supervisor_hello'],
      ['"playwrightRetries":0', '"playwrightRetries":1', 'p3c_supervisor_hello'],
      ['"namespaceInode":"7001"', '"namespaceInode":"7000"', 'p3c_supervisor_network_binding'],
      ['"address":"127.0.0.1"', '"address":"0.0.0.0"', 'p3c_supervisor_network_binding'],
      [
        '"survivorStartTokens":[]',
        `"survivorStartTokens":["${digest('start:owner-4')}"]`,
        'p3c_supervisor_drain',
      ],
      [
        '"unexpectedStartTokens":[]',
        `"unexpectedStartTokens":["${digest('start:extra-chromium')}"]`,
        'p3c_supervisor_descendant_enumeration',
      ],
      [
        '"postTerminationDescendantStartTokens":[]',
        `"postTerminationDescendantStartTokens":["${digest('start:chromium-renderer')}"]`,
        'p3c_supervisor_drain',
      ],
    ] as const) {
      const adversarial = Buffer.from(transcript.toString('utf8').replace(needle, replacement));
      expect(() => parseSupervisorTranscript(adversarial, plan)).toThrow(expected);
    }

    const documents = transcript.toString('utf8').trimEnd().split('\n');
    const enumerationIndex = documents.findIndex((line) =>
      line.includes('"type":"descendant-enumeration"')
    );
    documents.splice(enumerationIndex, 0, documents[enumerationIndex - 1]);
    expect(() => parseSupervisorTranscript(Buffer.from(`${documents.join('\n')}\n`), plan)).toThrow(
      'p3c_supervisor_unexpected_descendant'
    );
  });

  it('rejects every missing Chromium census role and every Chromium executable digest mismatch', () => {
    const plan = supervisorPlan();
    for (const role of plan.chromiumDescendants) {
      const documents = supervisorTranscript(plan)
        .toString('utf8')
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const index = documents.findIndex(
        (document) => document.type === 'descendant-start' && document.role === role
      );
      expect(index).toBeGreaterThan(0);
      const withoutRole = documents.filter((_, documentIndex) => documentIndex !== index);
      expect(() =>
        parseSupervisorTranscript(
          Buffer.from(`${withoutRole.map(canonicalJson).join('\n')}\n`),
          plan
        )
      ).toThrow(/p3c_supervisor_descendant_(?:binding|keys)/u);

      documents[index]!.executableSha256 = digest(`wrong:${role}`);
      expect(() =>
        parseSupervisorTranscript(Buffer.from(`${documents.map(canonicalJson).join('\n')}\n`), plan)
      ).toThrow('p3c_supervisor_descendant_binding');
    }
  });

  it('rejects non-empty ownership ambiguities and duplicate Chromium start tokens', () => {
    const plan = supervisorPlan();
    const documents = supervisorTranscript(plan)
      .toString('utf8')
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const enumeration = documents.find((document) => document.type === 'descendant-enumeration');
    expect(enumeration).toBeDefined();
    enumeration!.ownershipAmbiguities = ['duplicate-chromium-start-token'];
    expect(() =>
      parseSupervisorTranscript(Buffer.from(`${documents.map(canonicalJson).join('\n')}\n`), plan)
    ).toThrow('p3c_supervisor_descendant_enumeration');

    const colliding = supervisorTranscript(plan)
      .toString('utf8')
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const browser = colliding.find(
      (document) => document.type === 'descendant-start' && document.role === 'chromium-browser'
    );
    const renderer = colliding.find(
      (document) => document.type === 'descendant-start' && document.role === 'chromium-renderer'
    );
    expect(browser).toBeDefined();
    expect(renderer).toBeDefined();
    renderer!.startToken = browser!.startToken;
    expect(() =>
      parseSupervisorTranscript(Buffer.from(`${colliding.map(canonicalJson).join('\n')}\n`), plan)
    ).toThrow(/p3c_supervisor_descendant_(?:binding|enumeration)/u);
  });

  it('rejects incomplete filesystem census and any ambient host-root visibility', () => {
    const plan = supervisorPlan();
    const mutateFilesystem = (mutate: (document: Record<string, unknown>) => void) => {
      const documents = supervisorTranscript(plan)
        .toString('utf8')
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const filesystem = documents.find((document) => document.type === 'filesystem-evidence');
      expect(filesystem).toBeDefined();
      mutate(filesystem!);
      return Buffer.from(`${documents.map(canonicalJson).join('\n')}\n`);
    };
    expect(() =>
      parseSupervisorTranscript(
        mutateFilesystem((filesystem) => {
          filesystem.topLevelEntries = (filesystem.topLevelEntries as unknown[]).slice(1);
        }),
        plan
      )
    ).toThrow('p3c_supervisor_filesystem_binding');
    expect(() =>
      parseSupervisorTranscript(
        mutateFilesystem((filesystem) => {
          const probes = filesystem.ambientPathProbes as Record<string, unknown>[];
          probes[0]!.result = 'visible';
        }),
        plan
      )
    ).toThrow('p3c_supervisor_filesystem_binding');
  });
});

describe('bounded supervisor shutdown fixtures', () => {
  it('fully drains an oversize stream before rejecting it', async () => {
    const stream = new PassThrough();
    const collected = collectBoundedStream(stream, 4);
    stream.write('12345');
    stream.end('tail');
    await expect(collected).rejects.toThrow('p3c_supervisor_stream_oversize');
    expect(stream.readableEnded).toBe(true);
  });

  it('TERM/KILLs a verified owned group while its direct leader remains live and leaves zero survivors', async () => {
    const marker = processOwnershipMarker(digest('shutdown-controller'), digest('shutdown-run'));
    const descendantSource =
      "process.on('SIGTERM',()=>{});process.stdout.write('ready\\n');setInterval(()=>{},1000)";
    const supervisorSource = [
      "const {spawn}=require('node:child_process')",
      "process.on('SIGTERM',()=>{})",
      `const descendant=spawn(process.execPath,['-e',${JSON.stringify(descendantSource)}],{stdio:['ignore','pipe','ignore']})`,
      "descendant.stdout.once('data',()=>process.stdout.write(String(descendant.pid)+'\\n'))",
      'setInterval(()=>{},1000)',
    ].join(';');
    const child = spawnChild(process.execPath, ['-e', supervisorSource], {
      detached: true,
      env: exactChildEnvironment(marker),
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const anchor = await captureDetachedProcessAnchor(child, marker);
    const [descendantBytes] = (await once(child.stdout!, 'data')) as [Buffer];
    const descendantPid = Number(descendantBytes.toString('utf8').trim());
    const descendantStat = await readFile(`/proc/${descendantPid}/stat`, 'utf8');
    const descendantStatFields = descendantStat
      .slice(descendantStat.lastIndexOf(')') + 2)
      .trim()
      .split(/\s+/u);
    expect(Number(descendantStatFields[2])).toBe(anchor.processGroupId);
    const exited = once(child, 'exit');
    const groupSignals: NodeJS.Signals[] = [];
    let leaderAliveBeforeKill = false;
    await terminateAnchoredProcessGroup(anchor, 2_000, marker, {
      signalProcessGroup: (processGroupId, signal) => {
        expect(processGroupId).toBe(anchor.processGroupId);
        groupSignals.push(signal);
        if (signal === 'SIGKILL') {
          leaderAliveBeforeKill = child.exitCode === null && child.signalCode === null;
        }
        process.kill(-processGroupId, signal);
      },
    });
    await exited;
    expect(groupSignals[0]).toBe('SIGTERM');
    expect(groupSignals).toContain('SIGKILL');
    expect(groupSignals.at(-1)).toBe('SIGKILL');
    expect(leaderAliveBeforeKill).toBe(true);
    await expect(censusOwnedProcesses(marker)).resolves.toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(() => process.kill(-anchor.processGroupId, 0)).toThrow(
      expect.objectContaining({ code: 'ESRCH' })
    );
    expect(() => process.kill(descendantPid, 0)).toThrow(
      expect.objectContaining({ code: 'ESRCH' })
    );
  });

  it('fails closed on marker mismatch without signaling the child', async () => {
    const marker = processOwnershipMarker(digest('marker-controller'), digest('marker-run'));
    const owned = spawnChild(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      detached: true,
      env: exactChildEnvironment(marker),
      stdio: 'ignore',
    });
    const ownedAnchor = await captureDetachedProcessAnchor(owned, marker);
    let signals = 0;
    try {
      await expect(
        terminateAnchoredProcessGroup(ownedAnchor, 100, marker, {
          readProcessEnvironment: async () => Buffer.from('P3C_PROCESS_OWNERSHIP_MARKER=wrong'),
          signalProcessGroup: () => {
            signals += 1;
            return true;
          },
        })
      ).rejects.toThrow('p3c_supervisor_process_marker_changed');
      expect(signals).toBe(0);
      expect(() => process.kill(ownedAnchor.pid, 0)).not.toThrow();
    } finally {
      owned.kill('SIGKILL');
      await once(owned, 'exit');
    }
  });

  it('signals the retained negative PGID and fails closed when an exited leader group cannot drain', async () => {
    const marker = processOwnershipMarker(digest('reuse-controller'), digest('reuse-run'));
    const child = spawnChild(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      detached: true,
      env: exactChildEnvironment(marker),
      stdio: 'ignore',
    });
    const anchor = await captureDetachedProcessAnchor(child, marker);
    const path = await temporaryPrivateDirectory();
    const root = await openRootAnchor('sandboxParent', await rootPin(path));
    const sandbox = await createSandbox(root, digest('reuse-sandbox'));
    let identityReads = 0;
    let signals = 0;
    let markerReads = 0;
    try {
      await expect(
        terminateAnchoredProcessGroup(anchor, 100, marker, {
          readProcessEnvironment: async () => {
            markerReads += 1;
            return Buffer.from(`P3C_PROCESS_OWNERSHIP_MARKER=${marker}\0`);
          },
          readProcessIdentity: async () => {
            identityReads += 1;
            return anchor;
          },
          childHasExited: () => true,
          processGroupHasMembers: () => true,
          signalProcessGroup: () => {
            signals += 1;
            return true;
          },
        })
      ).rejects.toThrow('p3c_supervisor_leader_exited_before_owned_cleanup');
      expect(identityReads).toBe(0);
      expect(markerReads).toBe(0);
      expect(signals).toBeGreaterThan(0);
      expect(() => process.kill(anchor.pid, 0)).not.toThrow();
      expect((await cleanupSandbox(sandbox, false)).disposition).toBe('preserved');
      await expect(assertSandboxCurrent(sandbox)).resolves.toBeUndefined();
    } finally {
      process.kill(-anchor.processGroupId, 'SIGKILL');
      await once(child, 'exit');
      await settleFailedProcessCapture(marker, 100, {
        processGroupHasMembers: () => false,
      });
      await cleanupSandbox(sandbox, true);
      await root.handle.close();
      await rmdir(path);
    }
  });

  it.each(['stat', 'marker'] as const)(
    'keeps capture %s ENOENT explicitly unverified and never signals its provisional group',
    async (failurePoint) => {
      const marker = processOwnershipMarker(
        digest(`capture-${failurePoint}-controller`),
        digest(`capture-${failurePoint}-run`)
      );
      const child = spawnChild(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
        detached: true,
        env: exactChildEnvironment(marker),
        stdio: 'ignore',
      });
      const provisional = registerProvisionalDetachedProcessAnchor(child, marker);
      const enoent = () => {
        throw Object.assign(new Error('simulated capture ENOENT'), { code: 'ENOENT' });
      };
      const path = await temporaryPrivateDirectory();
      const root = await openRootAnchor('sandboxParent', await rootPin(path));
      const sandbox = await createSandbox(root, digest(`capture-${failurePoint}-sandbox`));
      let groupSignals = 0;
      let directSignals = 0;
      try {
        await expect(
          captureDetachedProcessAnchor(
            child,
            marker,
            failurePoint === 'stat'
              ? { readSpawnedProcessStat: enoent }
              : { readProcessEnvironment: async () => enoent() },
            provisional
          )
        ).rejects.toMatchObject({ code: 'ENOENT' });
        expect(provisional.verification).toBe('unverified-provisional');
        await expect(
          censusOwnedProcesses(marker, { processGroupHasMembers: () => true })
        ).rejects.toThrow('p3c_process_census_unverified_provisional');
        await expect(
          settleFailedProcessCapture(marker, 25, {
            processGroupHasMembers: () => true,
            signalProcessGroup: () => {
              groupSignals += 1;
            },
            signalDirectChild: () => {
              directSignals += 1;
              return true;
            },
          })
        ).rejects.toThrow('p3c_supervisor_capture_unverified_group_occupied');
        expect(groupSignals).toBe(0);
        expect(directSignals).toBe(2);
        expect((await cleanupSandbox(sandbox, false)).disposition).toBe('preserved');
        await expect(assertSandboxCurrent(sandbox)).resolves.toBeUndefined();
      } finally {
        process.kill(-provisional.processGroupId, 'SIGKILL');
        await once(child, 'exit');
        await settleFailedProcessCapture(marker, 100, {
          processGroupHasMembers: () => false,
        });
        await cleanupSandbox(sandbox, true);
        await root.handle.close();
        await rmdir(path);
      }
    }
  );

  it('settles a failed provisional capture only after nonempty then two empty group censuses', async () => {
    const marker = processOwnershipMarker(
      digest('capture-drain-controller'),
      digest('capture-drain-run')
    );
    const child = spawnChild(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      detached: true,
      env: exactChildEnvironment(marker),
      stdio: 'ignore',
    });
    const provisional = registerProvisionalDetachedProcessAnchor(child, marker);
    const observations = [true, false, false];
    let censuses = 0;
    let directChildExited = false;
    try {
      await expect(
        captureDetachedProcessAnchor(
          child,
          marker,
          {
            readSpawnedProcessStat: () => {
              throw Object.assign(new Error('simulated capture ENOENT'), { code: 'ENOENT' });
            },
          },
          provisional
        )
      ).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(
        settleFailedProcessCapture(marker, 100, {
          processGroupHasMembers: () => observations[censuses++] ?? false,
          signalProcessGroup: () => {
            throw new Error('unverified process group must not be signalled');
          },
          signalDirectChild: () => {
            directChildExited = true;
            return true;
          },
          childHasExited: () => directChildExited,
        })
      ).resolves.toBeUndefined();
      expect(censuses).toBe(3);
      await expect(censusOwnedProcesses(marker)).resolves.toEqual([]);
    } finally {
      process.kill(-provisional.processGroupId, 'SIGKILL');
      await once(child, 'exit');
    }
  });

  it.each(['ENOENT', 'ESRCH'] as const)(
    'requires two meaningful empty group censuses after an early %s identity read',
    async (code) => {
      const marker = processOwnershipMarker(
        digest(`identity-${code}-controller`),
        digest(`identity-${code}-run`)
      );
      const child = spawnChild(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
        detached: true,
        env: exactChildEnvironment(marker),
        stdio: 'ignore',
      });
      const anchor = await captureDetachedProcessAnchor(child, marker);
      const groupCensusEvolution = [false, true, false, false];
      let groupCensuses = 0;
      let signals = 0;
      try {
        await expect(
          terminateAnchoredProcessGroup(anchor, 250, marker, {
            readProcessIdentity: async () => {
              throw Object.assign(new Error(`simulated ${code}`), { code });
            },
            processGroupHasMembers: () => {
              const observation = groupCensusEvolution[groupCensuses];
              groupCensuses += 1;
              return observation ?? false;
            },
            signalProcessGroup: () => {
              signals += 1;
            },
          })
        ).resolves.toBeUndefined();
        expect(groupCensuses).toBe(4);
        expect(signals).toBe(1);
      } finally {
        child.kill('SIGKILL');
        await once(child, 'exit');
      }
    }
  );

  it.each(['ENOENT', 'ESRCH'] as const)(
    'uses the retained group anchor after an early %s identity read and still fails closed if occupied',
    async (code) => {
      const marker = processOwnershipMarker(
        digest(`missing-${code}-controller`),
        digest(`missing-${code}-run`)
      );
      const child = spawnChild(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
        detached: true,
        env: exactChildEnvironment(marker),
        stdio: 'ignore',
      });
      const anchor = await captureDetachedProcessAnchor(child, marker);
      let signals = 0;
      try {
        await expect(
          terminateAnchoredProcessGroup(anchor, 25, marker, {
            readProcessIdentity: async () => {
              throw Object.assign(new Error(`simulated ${code}`), { code });
            },
            processGroupHasMembers: () => true,
            signalProcessGroup: () => {
              signals += 1;
            },
          })
        ).rejects.toThrow('p3c_supervisor_leader_missing_group_occupied');
        expect(signals).toBeGreaterThan(0);
        expect(() => process.kill(anchor.pid, 0)).not.toThrow();
      } finally {
        process.kill(-anchor.processGroupId, 'SIGKILL');
        await once(child, 'exit');
        await settleFailedProcessCapture(marker, 100, {
          processGroupHasMembers: () => false,
        });
      }
    }
  );

  it('bounds every admitted environ read and continues safe cleanup after deadline or oversize', async () => {
    const environMarker = processOwnershipMarker(
      digest('environ-timeout-controller'),
      digest('environ-timeout-run')
    );
    const environChild = spawnChild(
      process.execPath,
      ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
      { detached: true, env: exactChildEnvironment(environMarker), stdio: 'ignore' }
    );
    const environAnchor = await captureDetachedProcessAnchor(environChild, environMarker);
    const environExit = once(environChild, 'exit');
    let environReads = 0;
    const environFailure = await terminateAnchoredProcessGroup(
      environAnchor,
      5_000,
      environMarker,
      {
        processEnvironmentTimeoutMs: 25,
        readProcessEnvironment: async () => {
          environReads += 1;
          if (environReads === 1) return new Promise<Buffer>(() => undefined);
          return Buffer.from(`P3C_PROCESS_OWNERSHIP_MARKER=${environMarker}\0`);
        },
      }
    ).then(
      () => undefined,
      (error: unknown) => error
    );
    expect(environFailure).toBeInstanceOf(Error);
    expect(
      [environFailure, ...((environFailure as AggregateError).errors ?? [])].some((error) =>
        String((error as Error).message).includes('p3c_process_environ_timeout')
      )
    ).toBe(true);
    await environExit;
    expect(environReads).toBeGreaterThan(1);

    const oversizeChild = spawnChild(
      process.execPath,
      ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
      { detached: true, env: exactChildEnvironment(environMarker), stdio: 'ignore' }
    );
    const oversizeAnchor = await captureDetachedProcessAnchor(oversizeChild, environMarker);
    const oversizeExit = once(oversizeChild, 'exit');
    let oversizeReads = 0;
    const oversizeFailure = await terminateAnchoredProcessGroup(
      oversizeAnchor,
      5_000,
      environMarker,
      {
        readProcessEnvironment: async () => {
          oversizeReads += 1;
          if (oversizeReads === 1) return Buffer.alloc(256 * 1024 + 1);
          return Buffer.from(`P3C_PROCESS_OWNERSHIP_MARKER=${environMarker}\0`);
        },
      }
    ).then(
      () => undefined,
      (error: unknown) => error
    );
    expect(oversizeFailure).toBeInstanceOf(Error);
    expect(
      [oversizeFailure, ...((oversizeFailure as AggregateError).errors ?? [])].some((error) =>
        String((error as Error).message).includes('p3c_process_environ_oversize')
      )
    ).toBe(true);
    await oversizeExit;
    expect(oversizeReads).toBeGreaterThan(1);

    await expect(censusOwnedProcesses(environMarker)).resolves.toEqual([]);
  });

  it('censuses only the deterministic run-owned registry, never unrelated host processes', async () => {
    const marker = processOwnershipMarker(digest('registry-controller'), digest('registry-run'));
    const unrelated = spawnChild(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      detached: true,
      env: exactChildEnvironment(marker),
      stdio: 'ignore',
    });
    let reads = 0;
    try {
      await expect(
        censusOwnedProcesses(marker, {
          readProcessEnvironment: async () => {
            reads += 1;
            return Buffer.from(`P3C_PROCESS_OWNERSHIP_MARKER=${marker}\0`);
          },
        })
      ).resolves.toEqual([]);
      expect(reads).toBe(0);
    } finally {
      unrelated.kill('SIGKILL');
      await once(unrelated, 'exit');
    }
  });
});

function fixtureObservedIdentity(
  controllerNonce: string,
  harnessRunId: string,
  row: (typeof MATRIX_ROWS)[number],
  event: string,
  overrides: Partial<SemanticIdentity> = {}
): SemanticIdentity {
  const scope = semanticScopeForEvent(row, event);
  const id = (kind: string) => digest(`observed:${scope}:${kind}`).slice(0, 32);
  const crossTeam = row === '08_cross_team_isolation';
  const teamBId = `team_${digest('observed:team-b').slice(0, 32)}`;
  const actorTeamId =
    crossTeam && /^team_b_/u.test(event)
      ? teamBId
      : `team_${digest('observed:team-a').slice(0, 32)}`;
  return observedSemanticIdentity({
    lane: P3C_LANE,
    controllerNonce,
    harnessRunId,
    authenticatedActorTeamId: actorTeamId,
    targetTeamRunId: `run_${digest(crossTeam ? 'observed:team-b-run' : 'observed:team-a-run').slice(0, 32)}`,
    targetTeamId: crossTeam ? teamBId : actorTeamId,
    approvalId: `approval_${id('approval')}`,
    generationId: `generation_observed-${id('generation')}`,
    idempotencyKey: `idempotency_observed-${id('idempotency')}`,
    previewRef: `approval_preview_observed-${id('preview')}`,
    decision: semanticDecisionForEvent(row, event),
    ...overrides,
  });
}

function fixtureObservedBodies(
  origin: RawOrigin,
  event: string,
  identity: SemanticIdentity,
  providerEffectId: string
): {
  readonly observedRequestBody?: Buffer;
  readonly observedResponseBody?: Buffer;
  readonly observedPageExchanges?: readonly {
    readonly request: Buffer;
    readonly response: Buffer;
  }[];
} {
  const bytes = (value: Readonly<Record<string, unknown>>) => Buffer.from(canonicalJson(value));
  if (origin === 'product-http') {
    const isReconciliation = /^reconcile_/u.test(event);
    const isPreview = /(?:approval_preview|team_b_preview|cross_team_preview)/u.test(event);
    const isPage =
      event === 'pending_observed' ||
      event === 'terminal_state_observed' ||
      event === 'team_b_item_observed' ||
      event === 'cross_team_list_rejected' ||
      event === 'cross_team_read_rejected';
    const request = isPage
      ? {
          schemaVersion: 1,
          teamId: identity.targetTeamId,
          expectedRunId: identity.targetTeamRunId,
          cursor: null,
          limit: 32,
        }
      : isPreview
        ? {
            schemaVersion: 1,
            teamId: identity.targetTeamId,
            expectedRunId: identity.targetTeamRunId,
            approvalId: identity.approvalId,
            expectedGeneration: identity.generationId,
            previewRef: identity.previewRef,
          }
        : isReconciliation
          ? {
              schemaVersion: 1,
              teamId: identity.targetTeamId,
              expectedRunId: identity.targetTeamRunId,
              approvalId: identity.approvalId,
              expectedGeneration: identity.generationId,
              idempotencyKey: identity.idempotencyKey,
              reconciliationRef: `reconciliation_${sha256(
                `agent-teams.p3c.reconciliation-ref/v1\0${canonicalJson(identity)}`
              ).slice(0, 32)}`,
            }
          : {
              schemaVersion: 1,
              teamId: identity.targetTeamId,
              expectedRunId: identity.targetTeamRunId,
              approvalId: identity.approvalId,
              expectedGeneration: identity.generationId,
              idempotencyKey: identity.idempotencyKey,
              decision: identity.decision === 'allow' ? 'allow' : 'deny',
            };
    const rejected = /rejected|routes_absent/u.test(event);
    const response = rejected
      ? {
          schemaVersion: 1,
          kind: 'error',
          error: { code: 'forbidden', reason: 'request_rejected' },
          retryable: false,
        }
      : isPreview
        ? {
            schemaVersion: 1,
            kind: 'approval_preview',
            teamId: identity.targetTeamId,
            runId: identity.targetTeamRunId,
            approvalId: identity.approvalId,
            generation: identity.generationId,
            content: '[redacted]',
            byteLength: 10,
            truncated: false,
            isBinary: false,
          }
        : isPage
          ? {
              schemaVersion: 1,
              kind: 'approval_page',
              teamId: identity.targetTeamId,
              items: [
                {
                  teamId: identity.targetTeamId,
                  runId: identity.targetTeamRunId,
                  approvalId: identity.approvalId,
                  generation: identity.generationId,
                  category: 'other',
                  summary: '[redacted]',
                  requestedAtMs: 1,
                  expiresAtMs: null,
                  previewRef: identity.previewRef,
                },
              ],
              nextCursor: null,
              truncated: false,
              budget: {
                itemLimit: 32,
                byteLimit: 131072,
                timeLimitMs: 250,
                usedItems: 1,
                usedBytes: 1,
                elapsedMs: 1,
              },
            }
          : {
              schemaVersion: 1,
              outcome: 'committed',
              teamId: identity.targetTeamId,
              runId: identity.targetTeamRunId,
              approvalId: identity.approvalId,
              generation: identity.generationId,
              decision: identity.decision === 'allow' ? 'allow' : 'deny',
            };
    const pageCursor = `cursor_${digest(`approval-page:${event}`)}`;
    const pageExchanges =
      isPage && !rejected
        ? [
            {
              request,
              response: { ...response, nextCursor: pageCursor, truncated: true },
            },
            {
              request: { ...request, cursor: pageCursor },
              response: {
                ...response,
                items: [],
                nextCursor: null,
                truncated: false,
                budget: {
                  ...((response as Record<string, unknown>).budget as Record<string, unknown>),
                  usedItems: 0,
                },
              },
            },
          ]
        : null;
    return {
      observedRequestBody: bytes(pageExchanges?.[0].request ?? request),
      observedResponseBody: bytes(pageExchanges?.[0].response ?? response),
      ...(pageExchanges === null
        ? {}
        : {
            observedPageExchanges: pageExchanges.map((exchange) => ({
              request: bytes(exchange.request),
              response: bytes(exchange.response),
            })),
          }),
    };
  }
  if (origin === 'opencode') {
    return {
      observedRequestBody: bytes({
        schemaVersion: 1,
        kind: 'conditional-decision-request',
        approvalId: identity.approvalId,
        generation: identity.generationId,
        decision: identity.decision,
        providerEffectId,
      }),
      observedResponseBody: bytes({
        schemaVersion: 1,
        kind: /^(?:(?:allow|deny)_effect|reconcile_not_delivered_retry_effect)$/u.test(event)
          ? 'provider-effect'
          : 'conditional-decision-result',
        approvalId: identity.approvalId,
        generation: identity.generationId,
        decision: identity.decision,
        providerEffectId,
        outcome: /^(?:(?:allow|deny)_effect|reconcile_not_delivered_retry_effect)$/u.test(event)
          ? 'committed'
          : /^effect_total_(?:two|three)$/u.test(event)
            ? 'total_observed'
            : 'observed',
      }),
    };
  }
  return {};
}

function rawEvidence(): {
  raw: Readonly<Record<RawOrigin, Buffer>>;
  outcome: SupervisorOutcome;
  controllerNonce: string;
} {
  const controllerNonce = digest('evidence-controller');
  const runId = digest('evidence-run');
  const starts = {
    browser: digest('start:browser'),
    product: digest('start:product'),
    owner1: digest('start:owner-1'),
    owner2: digest('start:owner-2'),
    owner3: digest('start:owner-3'),
    owner4: digest('start:owner-4'),
    opencode: digest('start:opencode'),
    supervisor: digest('start:supervisor'),
  };
  const byOrigin = Object.fromEntries(
    RAW_ORIGINS.map((origin) => [origin, []])
  ) as unknown as Record<RawOrigin, unknown[]>;
  const sequence = Object.fromEntries(RAW_ORIGINS.map((origin) => [origin, 0])) as Record<
    RawOrigin,
    number
  >;
  let globalMonotonicSequence = 0;
  const observedProviderEffectSha256s: string[] = [];
  for (const row of MATRIX_ROWS) {
    for (const [origin, event, effectCount] of EVIDENCE_REQUIREMENTS[row]) {
      sequence[origin] += 1;
      globalMonotonicSequence += 1;
      const identity = fixtureObservedIdentity(controllerNonce, runId, row, event);
      const providerEffectId = `effect_${digest(
        `observed-provider-effect-id:${semanticScopeForEvent(row, event)}`
      ).slice(0, 32)}`;
      const observedBodies = fixtureObservedBodies(origin, event, identity, providerEffectId);
      if (
        origin === 'opencode' &&
        /^(?:(?:allow|deny)_effect|reconcile_not_delivered_retry_effect)$/u.test(event)
      ) {
        observedProviderEffectSha256s.push(sha256(observedBodies.observedResponseBody!));
      }
      const correlation = sha256(
        `agent-teams.p3c.row-identity/v1\0${controllerNonce}\0${row}\0${sha256(
          canonicalJson(canonicalRowIdentity(row, identity))
        )}`
      );
      let role: keyof typeof starts =
        origin === 'browser'
          ? 'browser'
          : origin === 'owner-wal'
            ? 'owner1'
            : origin === 'opencode'
              ? 'opencode'
              : origin === 'supervisor'
                ? 'supervisor'
                : 'product';
      if (origin === 'owner-wal') {
        if (
          /boundary_three|after_effect|truth_reconstructed|stale_sockets|reconcile|reconciliation|operator_required|automatic_retry/u.test(
            event
          )
        )
          role = 'owner4';
        else if (/boundary_two|after_decision|stale_generations/u.test(event)) role = 'owner3';
        else if (/restart|restored|boundary_one/u.test(event)) role = 'owner2';
      }
      byOrigin[origin].push(
        makeRawRecord({
          controllerNonce,
          origin,
          row,
          sequence: sequence[origin],
          monotonicNs: String(globalMonotonicSequence * 1000),
          processStartToken: starts[role],
          event,
          correlation,
          effectCount,
          payload: makeSemanticPayload({
            origin,
            row,
            event,
            identity,
            providerEffectId,
            ...observedBodies,
            effectSetSha256s: /^effect_total_(?:two|three)$/u.test(event)
              ? [...observedProviderEffectSha256s]
              : undefined,
            processEvidenceSetId:
              origin === 'supervisor' ? digest('process-evidence-set') : undefined,
            observedBrowserStatus:
              origin === 'browser' && row === '08_cross_team_isolation' ? 403 : undefined,
          }),
        })
      );
    }
  }
  const raw = Object.fromEntries(
    RAW_ORIGINS.map((origin) => [
      origin,
      Buffer.from(`${byOrigin[origin].map(canonicalJson).join('\n')}\n`),
    ])
  ) as Record<RawOrigin, Buffer>;
  const rootStarts = [
    ['opencode', 'opencode-1', 1, 'initial', starts.opencode],
    ['owner', 'owner-1', 1, 'initial', starts.owner1],
    ['product', 'product-1', 1, 'initial', starts.product],
    ['browser', 'browser-1', 1, 'initial', starts.browser],
    ['owner', 'owner-2', 2, 'after-pending-before-decision', starts.owner2],
    ['owner', 'owner-3', 3, 'after-decision-before-provider', starts.owner3],
    ['owner', 'owner-4', 4, 'after-effect-before-owner-recording', starts.owner4],
  ] as const;
  const processStarts = rootStarts.map(
    ([role, instanceId, generation, restartBoundary, startToken], index) => ({
      role,
      instanceId,
      generation,
      restartBoundary,
      pid: 5000 + index,
      pidfdInode: String(6000 + index),
      startTime: String(7000 + index),
      startToken,
      observedMonotonicNs: '1',
      executableDevice: '1',
      executableInode: String(7500 + index),
      executableSha256: digest(`exec:${role}`),
      argvSha256: digest(`argv:${instanceId}`),
      parentStartToken: starts.supervisor,
      observerStartToken: starts.supervisor,
      cwdDevice: '1',
      cwdInode: String(8000 + index),
    })
  );
  const outcome: SupervisorOutcome = {
    controllerNonce,
    runId,
    zeroOwnedSurvivors: true,
    supervisorStart: {
      role: 'supervisor',
      instanceId: 'supervisor-1',
      generation: 1,
      restartBoundary: 'initial',
      pid: 4999,
      pidfdInode: '5999',
      startTime: '6999',
      observedMonotonicNs: '1',
      startToken: starts.supervisor,
      parentStartToken: null,
      observerStartToken: null,
      executableDevice: '1',
      executableInode: '7499',
      executableSha256: digest('exec:supervisor'),
      argvSha256: digest('argv:supervisor'),
      cwdDevice: '1',
      cwdInode: '7999',
    },
    starts: processStarts,
    descendants: [],
    exits: processStarts.map(({ startToken, pidfdInode }, index) => ({
      startToken,
      pidfdInode,
      observedMonotonicNs: String(9000 + index),
      observerStartToken: starts.supervisor,
      disposition: 'controlled-exit' as const,
    })),
    network: {
      namespaceInode: '101',
      parentNamespaceInode: '100',
      interfaces: [],
      routes: [],
      listeners: [],
      outboundProbes: [],
      recordSha256: digest('network'),
    },
    filesystem: {
      mountNamespaceInode: '201',
      parentMountNamespaceInode: '200',
      pidNamespaceInode: '301',
      parentPidNamespaceInode: '300',
      rootDevice: '401',
      rootInode: '402',
      recordSha256: digest('filesystem'),
    },
    processEvidenceSetId: digest('process-evidence-set'),
    rawFiles: Object.fromEntries(
      RAW_ORIGINS.map((origin, index) => {
        const roles =
          origin === 'browser'
            ? ['browser']
            : origin === 'owner-wal'
              ? ['owner']
              : origin === 'opencode'
                ? ['opencode']
                : origin === 'supervisor'
                  ? ['supervisor']
                  : ['product'];
        const producers =
          origin === 'supervisor'
            ? [{ startToken: starts.supervisor, pidfdInode: '5999' }]
            : processStarts.filter(({ role }) => roles.includes(role));
        return [
          origin,
          {
            path: `/sandbox/raw/${origin}.ndjson`,
            sha256: sha256(raw[origin]),
            size: raw[origin].length,
            captureDevice: String(8100 + index),
            captureInode: String(9100 + index),
            producerStartTokens: producers.map(({ startToken }) => startToken).sort(),
            producerPidfdInodes: producers.map(({ pidfdInode }) => pidfdInode).sort(),
            parentCreatedExclusive: true as const,
            writerDescriptorsClosed: true as const,
            sealedBeforeParse: true as const,
          },
        ];
      })
    ) as unknown as SupervisorOutcome['rawFiles'],
    transcriptSha256: digest('transcript'),
    transcript: Buffer.from('deterministic-supervisor-transcript'),
  };
  return { raw: Object.freeze(raw), outcome, controllerNonce };
}

function replaceRawOrigin(
  fixture: ReturnType<typeof rawEvidence>,
  origin: RawOrigin,
  bytes: Buffer
): ReturnType<typeof rawEvidence> {
  return {
    ...fixture,
    raw: { ...fixture.raw, [origin]: bytes },
    outcome: {
      ...fixture.outcome,
      rawFiles: {
        ...fixture.outcome.rawFiles,
        [origin]: {
          path: `/sandbox/raw/${origin}.ndjson`,
          sha256: sha256(bytes),
          size: bytes.length,
        },
      },
    },
  };
}

function mutateSemanticEvent(
  fixture: ReturnType<typeof rawEvidence>,
  origin: RawOrigin,
  event: string,
  mutate: (semantic: Record<string, unknown>) => void
): ReturnType<typeof rawEvidence> {
  const lines = fixture.raw[origin]
    .toString('utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const index = lines.findIndex((record) => record.event === event);
  if (index < 0) throw new Error(`fixture_event_missing:${event}`);
  const original = lines[index];
  const payload = JSON.parse(
    Buffer.from(original.payloadBase64 as string, 'base64').toString('utf8')
  ) as Record<string, unknown>;
  const semanticBytes = Buffer.from(payload.recordBase64 as string, 'base64');
  const semantic = JSON.parse(semanticBytes.toString('utf8')) as Record<string, unknown>;
  mutate(semantic);
  const changedSemanticBytes = Buffer.from(canonicalJson(semantic));
  const changedPayload = {
    ...payload,
    recordBase64: changedSemanticBytes.toString('base64'),
    recordSha256: sha256(changedSemanticBytes),
  };
  lines[index] = makeRawRecord({
    controllerNonce: original.controllerNonce as string,
    origin,
    row: original.row as (typeof MATRIX_ROWS)[number],
    sequence: original.sequence as number,
    monotonicNs: original.monotonicNs as string,
    processStartToken: original.processStartToken as string,
    event: original.event as string,
    correlation: sha256(
      `agent-teams.p3c.row-identity/v1\0${String(original.controllerNonce)}\0${String(original.row)}\0${sha256(
        canonicalJson(
          canonicalRowIdentity(
            original.row as (typeof MATRIX_ROWS)[number],
            semantic.identity as SemanticIdentity
          )
        )
      )}`
    ),
    effectCount: original.effectCount as number,
    payload: changedPayload,
  }) as unknown as Record<string, unknown>;
  return replaceRawOrigin(fixture, origin, Buffer.from(`${lines.map(canonicalJson).join('\n')}\n`));
}

function mutateAllSemanticRecords(
  fixture: ReturnType<typeof rawEvidence>,
  mutate: (
    origin: RawOrigin,
    event: string,
    row: (typeof MATRIX_ROWS)[number],
    semantic: Record<string, unknown>
  ) => void
): ReturnType<typeof rawEvidence> {
  let changed = fixture;
  for (const origin of RAW_ORIGINS) {
    const records = changed.raw[origin]
      .toString('utf8')
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .map((original) => {
        const row = original.row as (typeof MATRIX_ROWS)[number];
        const event = original.event as string;
        const payload = JSON.parse(
          Buffer.from(original.payloadBase64 as string, 'base64').toString('utf8')
        ) as Record<string, unknown>;
        const semantic = JSON.parse(
          Buffer.from(payload.recordBase64 as string, 'base64').toString('utf8')
        ) as Record<string, unknown>;
        mutate(origin, event, row, semantic);
        const semanticBytes = Buffer.from(canonicalJson(semantic));
        const changedPayload = {
          ...payload,
          recordBase64: semanticBytes.toString('base64'),
          recordSha256: sha256(semanticBytes),
        };
        return makeRawRecord({
          controllerNonce: original.controllerNonce as string,
          origin,
          row,
          sequence: original.sequence as number,
          monotonicNs: original.monotonicNs as string,
          processStartToken: original.processStartToken as string,
          event,
          correlation: sha256(
            `agent-teams.p3c.row-identity/v1\0${String(original.controllerNonce)}\0${row}\0${sha256(
              canonicalJson(canonicalRowIdentity(row, semantic.identity as SemanticIdentity))
            )}`
          ),
          effectCount: original.effectCount as number,
          payload: changedPayload,
        });
      });
    changed = replaceRawOrigin(
      changed,
      origin,
      Buffer.from(`${records.map(canonicalJson).join('\n')}\n`)
    );
  }
  return changed;
}

function mutateRedactedBody(
  structure: Record<string, unknown>,
  mutate: (body: Record<string, unknown>) => void
): void {
  const body = JSON.parse(
    Buffer.from(structure.bodyBase64 as string, 'base64').toString('utf8')
  ) as Record<string, unknown>;
  mutate(body);
  const bytes = Buffer.from(canonicalJson(body));
  structure.bodyBase64 = bytes.toString('base64');
  structure.sha256 = sha256(bytes);
}

function mutateFirstRetainedPageResponse(
  semantic: Record<string, unknown>,
  mutate: (body: Record<string, unknown>) => void
): void {
  const transport = semantic.transport as Record<string, unknown>;
  const exchanges = transport.pageExchanges as Record<string, unknown>[];
  for (const structure of [
    transport.response as Record<string, unknown>,
    exchanges[0].response as Record<string, unknown>,
  ])
    mutateRedactedBody(structure, mutate);
}

function mutateOuterEvent(
  fixture: ReturnType<typeof rawEvidence>,
  origin: RawOrigin,
  event: string,
  mutate: (record: Record<string, unknown>) => void
): ReturnType<typeof rawEvidence> {
  const records = fixture.raw[origin]
    .toString('utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const index = records.findIndex((record) => record.event === event);
  if (index < 0) throw new Error(`fixture_event_missing:${event}`);
  const original = { ...records[index] };
  mutate(original);
  records[index] = makeRawRecord({
    controllerNonce: original.controllerNonce as string,
    origin,
    row: original.row as (typeof MATRIX_ROWS)[number],
    sequence: original.sequence as number,
    monotonicNs: original.monotonicNs as string,
    processStartToken: original.processStartToken as string,
    event: original.event as string,
    correlation: original.correlation as string,
    effectCount: original.effectCount as number,
    payload: JSON.parse(
      Buffer.from(original.payloadBase64 as string, 'base64').toString('utf8')
    ) as unknown,
  }) as unknown as Record<string, unknown>;
  return replaceRawOrigin(
    fixture,
    origin,
    Buffer.from(`${records.map(canonicalJson).join('\n')}\n`)
  );
}

describe('raw evidence validation', () => {
  it('publishes through staged names, writes READY last, and seals the final parent', async () => {
    const fixture = rawEvidence();
    const outcome = {
      ...fixture.outcome,
      transcriptSha256: sha256(fixture.outcome.transcript),
    };
    const path = await temporaryPrivateDirectory();
    const root = await openRootAnchor('evidenceRoot', await rootPin(path));
    const cleanup = {
      disposition: 'removed' as const,
      runId: outcome.runId,
      path: '/marker-owned-sandbox/removed',
      markerVerified: true,
      zeroOwnedSurvivors: true,
      reason: null,
    };
    const document = assembleEvidence({
      raw: fixture.raw,
      controllerNonce: fixture.controllerNonce,
      runId: outcome.runId,
      outcome,
      cleanup,
    });
    const digests = await retainEvidence(root, fixture.raw, document, outcome.transcript);
    expect(Object.keys(digests)).toContain('READY.json');
    expect((await stat(path)).mode & 0o777).toBe(0o500);
    const names = await (await import('node:fs/promises')).readdir(path);
    expect(names.some((name) => name.startsWith('.stage-'))).toBe(false);
    const ready = JSON.parse(await readFile(join(path, 'READY.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(ready).toMatchObject({
      purpose: 'agent-teams.p3c.evidence-ready/v1',
      evidenceDigest: document.evidenceDigest,
    });
    await root.handle.chmod(0o700);
    await root.handle.close();
    await rm(path, { recursive: true });
  });

  it('accepts only complete product/provider-observed semantic identities', () => {
    const valid = fixtureObservedIdentity(
      digest('observed-identity-controller'),
      digest('observed-identity-run'),
      '02_browser_allow_deny',
      'allow_submitted'
    );
    expect(valid.previewRef).toMatch(/^approval_preview_/u);
    const missingEffect = { ...valid } as Record<string, unknown>;
    delete missingEffect.previewRef;
    expect(() => observedSemanticIdentity(missingEffect as unknown as SemanticIdentity)).toThrow(
      'p3c_semantic_identity_keys'
    );
  });

  it('derives every row only from process-bound canonical raw records', () => {
    const fixture = rawEvidence();
    const evidence = deriveEvidence(fixture.raw, fixture.controllerNonce, fixture.outcome);
    expect(evidence.rows.map(({ row }) => row)).toEqual(MATRIX_ROWS);
    expect(Object.keys(evidence.origins).sort()).toEqual([...RAW_ORIGINS].sort());
    expect(evidence.exactlyOnce).toMatchObject({
      globallyUniqueProviderEffectIds: true,
      observedNormalRetryCount: 0,
      normalProviderEffects: [
        { decision: 'allow', attempt: 1, retryObserved: false },
        { decision: 'deny', attempt: 1, retryObserved: false },
      ],
    });
    expect(
      new Set(
        evidence.exactlyOnce.normalProviderEffects.map(({ providerEffectId }) => providerEffectId)
      ).size
    ).toBe(2);
    expect(
      evidence.rows.every(({ records }) =>
        records.every(({ byteStart, byteEnd, lineSha256 }) =>
          Boolean(byteStart >= 0 && byteEnd > byteStart && /^[0-9a-f]{64}$/u.test(lineSha256))
        )
      )
    ).toBe(true);
  });

  it('accepts the actual Playwright row-08 list/preview/decision topology', () => {
    const fixture = rawEvidence();
    const topology = fixture.raw.browser
      .toString('utf8')
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((record) => record.row === '08_cross_team_isolation')
      .map((record) => {
        const payload = JSON.parse(
          Buffer.from(record.payloadBase64 as string, 'base64').toString('utf8')
        ) as Record<string, unknown>;
        const semantic = JSON.parse(
          Buffer.from(payload.recordBase64 as string, 'base64').toString('utf8')
        ) as Record<string, unknown>;
        return [record.event, (semantic.identity as SemanticIdentity).decision] as const;
      });
    expect(topology).toEqual([
      ['cross_team_list_rejected', 'none'],
      ['cross_team_preview_rejected', 'none'],
      ['cross_team_decide_rejected', 'deny'],
    ]);
    expect(() =>
      deriveEvidence(fixture.raw, fixture.controllerNonce, fixture.outcome)
    ).not.toThrow();
  });

  it('fails closed when a required raw record is absent', () => {
    const fixture = rawEvidence();
    const browserLines = fixture.raw.browser.toString('utf8').trimEnd().split('\n');
    const raw = {
      ...fixture.raw,
      browser: Buffer.from(`${browserLines.slice(0, -1).join('\n')}\n`),
    };
    const outcome = {
      ...fixture.outcome,
      rawFiles: {
        ...fixture.outcome.rawFiles,
        browser: {
          ...fixture.outcome.rawFiles.browser,
          path: '/sandbox/raw/browser.ndjson',
          sha256: sha256(raw.browser),
          size: raw.browser.length,
        },
      },
    };
    expect(() => deriveEvidence(raw, fixture.controllerNonce, outcome)).toThrow(
      'p3c_evidence_matrix'
    );
  });

  it('rejects a matching outer label backed by the wrong semantic record schema', () => {
    const fixture = rawEvidence();
    const lines = fixture.raw.browser.toString('utf8').trimEnd().split('\n');
    const original = JSON.parse(lines[0]) as Record<string, unknown>;
    const row = original.row as (typeof MATRIX_ROWS)[number];
    const identity = fixtureObservedIdentity(
      fixture.controllerNonce,
      fixture.outcome.runId,
      row,
      original.event as string
    );
    const adversarial = makeRawRecord({
      controllerNonce: fixture.controllerNonce,
      origin: 'browser',
      row,
      sequence: original.sequence as number,
      monotonicNs: original.monotonicNs as string,
      processStartToken: original.processStartToken as string,
      event: original.event as string,
      correlation: original.correlation as string,
      effectCount: original.effectCount as number,
      payload: makeSemanticPayload({
        origin: 'browser',
        row,
        event: 'deny_submitted',
        identity,
      }),
    });
    lines[0] = canonicalJson(adversarial);
    const changed = replaceRawOrigin(fixture, 'browser', Buffer.from(`${lines.join('\n')}\n`));
    expect(() => deriveEvidence(changed.raw, changed.controllerNonce, changed.outcome)).toThrow(
      'p3c_semantic_record_binding'
    );
  });

  it('rejects identities whose correlation no longer joins team through effect', () => {
    const fixture = rawEvidence();
    const lines = fixture.raw.browser.toString('utf8').trimEnd().split('\n');
    const original = JSON.parse(lines[1]) as Record<string, unknown>;
    const row = original.row as (typeof MATRIX_ROWS)[number];
    const identity = fixtureObservedIdentity(
      fixture.controllerNonce,
      fixture.outcome.runId,
      row,
      original.event as string,
      { targetTeamId: `team_${digest('different-team').slice(0, 32)}` }
    );
    const adversarial = makeRawRecord({
      controllerNonce: fixture.controllerNonce,
      origin: 'browser',
      row,
      sequence: original.sequence as number,
      monotonicNs: original.monotonicNs as string,
      processStartToken: original.processStartToken as string,
      event: original.event as string,
      correlation: original.correlation as string,
      effectCount: original.effectCount as number,
      payload: makeSemanticPayload({
        origin: 'browser',
        row,
        event: original.event as string,
        identity,
      }),
    });
    lines[1] = canonicalJson(adversarial);
    const changed = replaceRawOrigin(fixture, 'browser', Buffer.from(`${lines.join('\n')}\n`));
    expect(() => deriveEvidence(changed.raw, changed.controllerNonce, changed.outcome)).toThrow(
      'p3c_evidence_correlation'
    );
  });

  it('binds a distinct authenticated actor to one real Team B run/request', () => {
    const fixture = rawEvidence();
    const teamBObservedEvents = fixture.raw['product-http']
      .toString('utf8')
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((record) =>
        /^team_b_(?:item|preview_request|preview_result)_observed$/u.test(String(record.event))
      );
    expect(teamBObservedEvents.map(({ event }) => event).sort()).toEqual([
      'team_b_item_observed',
      'team_b_preview_request_observed',
      'team_b_preview_result_observed',
    ]);
    const collapsedActor = mutateSemanticEvent(
      fixture,
      'product-http',
      'cross_team_list_rejected',
      (semantic) => {
        const identity = semantic.identity as Record<string, unknown>;
        identity.targetTeamId = identity.authenticatedActorTeamId;
        (semantic.causal as Record<string, unknown>).chainId = sha256(
          `agent-teams.p3c.causal-chain/v1\0${canonicalJson(identity)}`
        );
        const request = (semantic.transport as Record<string, unknown>).request as Record<
          string,
          unknown
        >;
        const body = JSON.parse(
          Buffer.from(request.bodyBase64 as string, 'base64').toString('utf8')
        ) as Record<string, unknown>;
        body.teamId = identity.targetTeamId;
        const bytes = Buffer.from(canonicalJson(body));
        request.bodyBase64 = bytes.toString('base64');
        request.sha256 = sha256(bytes);
      }
    );
    expect(() =>
      deriveEvidence(collapsedActor.raw, collapsedActor.controllerNonce, collapsedActor.outcome)
    ).toThrow('p3c_evidence_actor_target_binding');

    const substitutedRequest = mutateSemanticEvent(
      fixture,
      'product-http',
      'cross_team_read_rejected',
      (semantic) => {
        const identity = semantic.identity as Record<string, unknown>;
        identity.previewRef = `approval_preview_${digest('substituted-team-b-request').slice(
          0,
          32
        )}`;
        (semantic.causal as Record<string, unknown>).chainId = sha256(
          `agent-teams.p3c.causal-chain/v1\0${canonicalJson(identity)}`
        );
      }
    );
    expect(() =>
      deriveEvidence(
        substitutedRequest.raw,
        substitutedRequest.controllerNonce,
        substitutedRequest.outcome
      )
    ).toThrow('p3c_evidence_cross_team_real_request_binding');
  });

  it('rejects a consistently rehashed Team C actor substitution against the captured browser actor', () => {
    const teamC = `team_${digest('observed:team-c').slice(0, 32)}`;
    const rejectedEvents = [
      ['browser', 'cross_team_list_rejected'],
      ['browser', 'cross_team_preview_rejected'],
      ['browser', 'cross_team_decide_rejected'],
      ['product-http', 'cross_team_list_rejected'],
      ['product-http', 'cross_team_preview_rejected'],
      ['product-http', 'cross_team_read_rejected'],
      ['product-http', 'cross_team_decide_rejected'],
      ['product-http', 'cross_team_reconcile_rejected'],
      ['product-sse', 'cross_team_subscribe_rejected'],
      ['owner-wal', 'partitions_unchanged'],
      ['opencode', 'cross_team_effect_delta_zero'],
    ] as const;
    const changed = rejectedEvents.reduce(
      (current, [origin, event]) =>
        mutateSemanticEvent(current, origin, event, (semantic) => {
          const identity = semantic.identity as Record<string, unknown>;
          identity.authenticatedActorTeamId = teamC;
          if (origin === 'browser')
            (semantic.transport as Record<string, unknown>).authenticatedActorTeamId = teamC;
          if (origin === 'owner-wal') {
            const transport = semantic.transport as Record<string, unknown>;
            const retained = transport.record as Record<string, unknown>;
            const record = JSON.parse(
              Buffer.from(retained.bodyBase64 as string, 'base64').toString('utf8')
            ) as Record<string, unknown>;
            const reconciliationRef = `reconciliation_${sha256(
              `agent-teams.p3c.reconciliation-ref/v1\0${canonicalJson(identity)}`
            ).slice(0, 32)}`;
            const leaseId = `lease_${sha256(
              `agent-teams.p3c.reconciliation-lease/v1\0${canonicalJson(identity)}`
            ).slice(0, 32)}`;
            const writerFence = {
              ownerGeneration: 1,
              fenceDigest: sha256(
                `agent-teams.p3c.owner-writer-fence/v1\0${1}\0${canonicalJson(identity)}`
              ),
            };
            record.identity = identity;
            record.reconciliationRef = reconciliationRef;
            record.leaseId = leaseId;
            record.writerFence = writerFence;
            transport.reconciliationRef = reconciliationRef;
            transport.leaseId = leaseId;
            transport.writerFence = writerFence;
            const bytes = Buffer.from(canonicalJson(record));
            retained.bodyBase64 = bytes.toString('base64');
            retained.sha256 = sha256(bytes);
            transport.length = bytes.length;
            transport.recordSha256 = sha256(bytes);
          }
          (semantic.causal as Record<string, unknown>).chainId = sha256(
            `agent-teams.p3c.causal-chain/v1\0${canonicalJson(identity)}`
          );
        }),
      rawEvidence()
    );
    expect(() => deriveEvidence(changed.raw, changed.controllerNonce, changed.outcome)).toThrow(
      'p3c_evidence_cross_team_authenticated_actor_binding'
    );
  });

  it('requires the Team B item, preview request, and preview result in observed order', () => {
    const fixture = rawEvidence();
    const records = fixture.raw['product-http']
      .toString('utf8')
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const request = records.find((record) => record.event === 'team_b_preview_request_observed')!;
    const result = records.find((record) => record.event === 'team_b_preview_result_observed')!;
    const requestTime = request.monotonicNs;
    request.monotonicNs = result.monotonicNs;
    result.monotonicNs = requestTime;
    records.sort((left, right) =>
      BigInt(left.monotonicNs as string) < BigInt(right.monotonicNs as string) ? -1 : 1
    );
    const resequenced = records.map((record, index) =>
      makeRawRecord({
        controllerNonce: record.controllerNonce as string,
        origin: 'product-http',
        row: record.row as (typeof MATRIX_ROWS)[number],
        sequence: index + 1,
        monotonicNs: record.monotonicNs as string,
        processStartToken: record.processStartToken as string,
        event: record.event as string,
        correlation: record.correlation as string,
        effectCount: record.effectCount as number,
        payload: JSON.parse(
          Buffer.from(record.payloadBase64 as string, 'base64').toString('utf8')
        ) as unknown,
      })
    );
    const changed = replaceRawOrigin(
      fixture,
      'product-http',
      Buffer.from(`${resequenced.map(canonicalJson).join('\n')}\n`)
    );
    expect(() => deriveEvidence(changed.raw, changed.controllerNonce, changed.outcome)).toThrow(
      'p3c_evidence_cross_team_observation_order'
    );
  });

  it('rejects placeholder HTTP paths instead of the exact page/preview/decisions families', () => {
    const fixture = rawEvidence();
    const previewOuter = fixture.raw['product-http']
      .toString('utf8')
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((record) => record.event === 'approval_preview_observed')!;
    const previewPayload = JSON.parse(
      Buffer.from(previewOuter.payloadBase64 as string, 'base64').toString('utf8')
    ) as Record<string, unknown>;
    const previewSemantic = JSON.parse(
      Buffer.from(previewPayload.recordBase64 as string, 'base64').toString('utf8')
    ) as Record<string, unknown>;
    expect((previewSemantic.transport as Record<string, unknown>).path).toBe(
      '/api/hosted/v1/team-approvals/preview'
    );
    const changed = mutateSemanticEvent(fixture, 'product-http', 'allow_accepted', (semantic) => {
      (semantic.transport as Record<string, unknown>).path = '/api/hosted/v1/team-approvals';
    });
    expect(() => deriveEvidence(changed.raw, changed.controllerNonce, changed.outcome)).toThrow(
      'p3c_semantic_http'
    );
    const wrongPageFamily = mutateSemanticEvent(
      fixture,
      'product-http',
      'pending_observed',
      (semantic) => {
        const transport = semantic.transport as Record<string, unknown>;
        transport.endpointFamily = 'decisions';
        transport.path = '/api/hosted/v1/team-approvals/decisions';
      }
    );
    expect(() =>
      deriveEvidence(wrongPageFamily.raw, wrongPageFamily.controllerNonce, wrongPageFamily.outcome)
    ).toThrow('p3c_semantic_http');
    const wrongPreviewPath = mutateSemanticEvent(
      fixture,
      'product-http',
      'approval_preview_observed',
      (semantic) => {
        const transport = semantic.transport as Record<string, unknown>;
        transport.path = '/api/hosted/v1/team-approvals/preview/';
      }
    );
    expect(() =>
      deriveEvidence(
        wrongPreviewPath.raw,
        wrongPreviewPath.controllerNonce,
        wrongPreviewPath.outcome
      )
    ).toThrow('p3c_semantic_http');
    const wrongPreviewFamily = mutateSemanticEvent(
      fixture,
      'product-http',
      'cross_team_preview_rejected',
      (semantic) => {
        const transport = semantic.transport as Record<string, unknown>;
        transport.endpointFamily = 'page';
        transport.path = '/api/hosted/v1/team-approvals/page';
      }
    );
    expect(() =>
      deriveEvidence(
        wrongPreviewFamily.raw,
        wrongPreviewFamily.controllerNonce,
        wrongPreviewFamily.outcome
      )
    ).toThrow('p3c_semantic_http');
  });

  it('rejects label-only or digest-drifted redacted structural bodies', () => {
    const fixture = rawEvidence();
    const changed = mutateSemanticEvent(
      fixture,
      'product-http',
      'approval_preview_observed',
      (semantic) => {
        const request = (semantic.transport as Record<string, unknown>).request as Record<
          string,
          unknown
        >;
        request.sha256 = digest('not-the-retained-body');
      }
    );
    expect(() => deriveEvidence(changed.raw, changed.controllerNonce, changed.outcome)).toThrow(
      'p3c_http_request_redacted_body_digest'
    );
  });

  it('rejects a substituted and correctly rehashed observed HTTP body', () => {
    const fixture = rawEvidence();
    const changed = mutateSemanticEvent(
      fixture,
      'product-http',
      'approval_preview_observed',
      (semantic) => {
        const request = (semantic.transport as Record<string, unknown>).request as Record<
          string,
          unknown
        >;
        const body = JSON.parse(
          Buffer.from(request.bodyBase64 as string, 'base64').toString('utf8')
        ) as Record<string, unknown>;
        body.previewRef = `approval_preview_${digest('substituted-preview').slice(0, 32)}`;
        const bytes = Buffer.from(canonicalJson(body));
        request.bodyBase64 = bytes.toString('base64');
        request.sha256 = sha256(bytes);
      }
    );
    expect(() => deriveEvidence(changed.raw, changed.controllerNonce, changed.outcome)).toThrow(
      'p3c_semantic_http_body_binding'
    );
  });

  it('retains the exact preview contract payload and rejects an extra requestId key', () => {
    const fixture = rawEvidence();
    const previewRecord = fixture.raw['product-http']
      .toString('utf8')
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((record) => record.event === 'approval_preview_observed')!;
    const payload = JSON.parse(
      Buffer.from(previewRecord.payloadBase64 as string, 'base64').toString('utf8')
    ) as Record<string, unknown>;
    const semantic = JSON.parse(
      Buffer.from(payload.recordBase64 as string, 'base64').toString('utf8')
    ) as Record<string, unknown>;
    const retainedRequest = (semantic.transport as Record<string, unknown>).request as Record<
      string,
      unknown
    >;
    const requestBody = JSON.parse(
      Buffer.from(retainedRequest.bodyBase64 as string, 'base64').toString('utf8')
    ) as Record<string, unknown>;
    expect(Object.keys(requestBody).sort()).toEqual(
      [
        'approvalId',
        'expectedGeneration',
        'expectedRunId',
        'previewRef',
        'schemaVersion',
        'teamId',
      ].sort()
    );
    expect(requestBody.previewRef).toMatch(/^approval_preview_/u);
    expect(requestBody).not.toHaveProperty('requestId');

    const changed = mutateSemanticEvent(
      fixture,
      'product-http',
      'approval_preview_observed',
      (changedSemantic) => {
        const request = (changedSemantic.transport as Record<string, unknown>).request as Record<
          string,
          unknown
        >;
        const body = JSON.parse(
          Buffer.from(request.bodyBase64 as string, 'base64').toString('utf8')
        ) as Record<string, unknown>;
        body.requestId = `request_${digest('forbidden-contract-key').slice(0, 32)}`;
        const bytes = Buffer.from(canonicalJson(body));
        request.bodyBase64 = bytes.toString('base64');
        request.sha256 = sha256(bytes);
      }
    );
    expect(() => deriveEvidence(changed.raw, changed.controllerNonce, changed.outcome)).toThrow(
      'p3c_semantic_http_body_binding'
    );
  });

  it('rejects invented product-contract keys in observed items and receipts', () => {
    const adversaries = [
      {
        event: 'team_b_item_observed',
        mutate(body: Record<string, unknown>): void {
          const items = body.items as Record<string, unknown>[];
          items[0].requestId = `request_${digest('invented-item-request').slice(0, 32)}`;
        },
        expected: 'p3c_http_page_item_keys',
      },
      {
        event: 'allow_accepted',
        mutate(body: Record<string, unknown>): void {
          body.effectId = `effect_${digest('invented-receipt-effect').slice(0, 32)}`;
        },
        expected: 'p3c_http_decision_receipt_keys',
      },
    ] as const;
    for (const adversary of adversaries) {
      const fixture = rawEvidence();
      const changed = mutateSemanticEvent(fixture, 'product-http', adversary.event, (semantic) => {
        if (adversary.event === 'team_b_item_observed') {
          mutateFirstRetainedPageResponse(semantic, adversary.mutate);
        } else {
          const response = (semantic.transport as Record<string, unknown>).response as Record<
            string,
            unknown
          >;
          mutateRedactedBody(response, adversary.mutate);
        }
      });
      expect(() => deriveEvidence(changed.raw, changed.controllerNonce, changed.outcome)).toThrow(
        adversary.expected
      );
    }
  });

  it('mirrors the complete pinned approval-page parser contract', () => {
    const fixture = rawEvidence();
    const record = fixture.raw['product-http']
      .toString('utf8')
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((candidate) => candidate.event === 'team_b_item_observed')!;
    const payload = JSON.parse(
      Buffer.from(record.payloadBase64 as string, 'base64').toString('utf8')
    ) as Record<string, unknown>;
    const semantic = JSON.parse(
      Buffer.from(payload.recordBase64 as string, 'base64').toString('utf8')
    ) as Record<string, unknown>;
    const response = (semantic.transport as Record<string, unknown>).response as Record<
      string,
      unknown
    >;
    const validPage = JSON.parse(
      Buffer.from(response.bodyBase64 as string, 'base64').toString('utf8')
    ) as Record<string, unknown>;
    expect(parseHostedTeamApprovalPage(validPage).ok).toBe(true);

    const duplicate = structuredClone(validPage);
    (duplicate.items as unknown[]).push(structuredClone((duplicate.items as unknown[])[0]));
    (duplicate.budget as Record<string, unknown>).usedItems = 2;
    expect(parseHostedTeamApprovalPage(duplicate).ok).toBe(false);

    const invalidCursor = structuredClone(validPage);
    invalidCursor.truncated = true;
    invalidCursor.nextCursor = 'invalid';
    expect(parseHostedTeamApprovalPage(invalidCursor).ok).toBe(false);

    const overlongCursor = structuredClone(validPage);
    overlongCursor.truncated = true;
    overlongCursor.nextCursor = `cursor_${'a'.repeat(250)}`;
    expect(String(overlongCursor.nextCursor)).toHaveLength(257);
    expect(parseHostedTeamApprovalPage(overlongCursor).ok).toBe(false);
  });

  it('rejects a correctly rehashed page with a duplicate approval ID', () => {
    const fixture = rawEvidence();
    const changed = mutateSemanticEvent(
      fixture,
      'product-http',
      'team_b_item_observed',
      (semantic) => {
        mutateFirstRetainedPageResponse(semantic, (body) => {
          const items = body.items as Record<string, unknown>[];
          items.push(structuredClone(items[0]));
          (body.budget as Record<string, unknown>).usedItems = 2;
        });
      }
    );
    expect(() => deriveEvidence(changed.raw, changed.controllerNonce, changed.outcome)).toThrow(
      'p3c_semantic_http_page_duplicate_approval'
    );
  });

  it('rejects a correctly rehashed page with an invalid cursor token', () => {
    const fixture = rawEvidence();
    const changed = mutateSemanticEvent(
      fixture,
      'product-http',
      'team_b_item_observed',
      (semantic) => {
        mutateFirstRetainedPageResponse(semantic, (body) => {
          body.truncated = true;
          body.nextCursor = 'invalid';
        });
      }
    );
    expect(() => deriveEvidence(changed.raw, changed.controllerNonce, changed.outcome)).toThrow(
      'p3c_semantic_http_page_body'
    );
  });

  it('accepts and binds a complete multi-page approval traversal', () => {
    const fixture = rawEvidence();
    expect(() =>
      deriveEvidence(fixture.raw, fixture.controllerNonce, fixture.outcome)
    ).not.toThrow();
    const record = fixture.raw['product-http']
      .toString('utf8')
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((candidate) => candidate.event === 'pending_observed')!;
    const payload = JSON.parse(
      Buffer.from(record.payloadBase64 as string, 'base64').toString('utf8')
    ) as Record<string, unknown>;
    const semantic = JSON.parse(
      Buffer.from(payload.recordBase64 as string, 'base64').toString('utf8')
    ) as Record<string, unknown>;
    expect(
      ((semantic.transport as Record<string, unknown>).pageExchanges as unknown[]).length
    ).toBe(2);
  });

  it('rejects an approval ID duplicated only on a later retained page', () => {
    const fixture = rawEvidence();
    const changed = mutateSemanticEvent(fixture, 'product-http', 'pending_observed', (semantic) => {
      const exchanges = (semantic.transport as Record<string, unknown>).pageExchanges as Record<
        string,
        unknown
      >[];
      const firstResponse = exchanges[0].response as Record<string, unknown>;
      const firstBody = JSON.parse(
        Buffer.from(firstResponse.bodyBase64 as string, 'base64').toString('utf8')
      ) as Record<string, unknown>;
      mutateRedactedBody(exchanges[1].response as Record<string, unknown>, (body) => {
        body.items = [structuredClone((firstBody.items as unknown[])[0])];
        (body.budget as Record<string, unknown>).usedItems = 1;
      });
    });
    expect(() => deriveEvidence(changed.raw, changed.controllerNonce, changed.outcome)).toThrow(
      'p3c_semantic_http_page_duplicate_approval'
    );
  });

  it('rejects a manipulated later retained page after every digest is rehashed', () => {
    const fixture = rawEvidence();
    const changed = mutateSemanticEvent(fixture, 'product-http', 'pending_observed', (semantic) => {
      const exchanges = (semantic.transport as Record<string, unknown>).pageExchanges as Record<
        string,
        unknown
      >[];
      mutateRedactedBody(exchanges[1].response as Record<string, unknown>, (body) => {
        body.teamId = `team_${digest('hidden-team-c').slice(0, 32)}`;
      });
    });
    expect(() => deriveEvidence(changed.raw, changed.controllerNonce, changed.outcome)).toThrow(
      'p3c_semantic_http_page_body'
    );
  });

  it('rejects a retained approval-page cursor cycle', () => {
    const fixture = rawEvidence();
    const changed = mutateSemanticEvent(fixture, 'product-http', 'pending_observed', (semantic) => {
      const exchanges = (semantic.transport as Record<string, unknown>).pageExchanges as Record<
        string,
        unknown
      >[];
      const terminal = structuredClone(exchanges[1]);
      const requestBody = JSON.parse(
        Buffer.from(
          (exchanges[1].request as Record<string, unknown>).bodyBase64 as string,
          'base64'
        ).toString('utf8')
      ) as Record<string, unknown>;
      mutateRedactedBody(exchanges[1].response as Record<string, unknown>, (body) => {
        body.truncated = true;
        body.nextCursor = requestBody.cursor;
      });
      exchanges.push(terminal);
    });
    expect(() => deriveEvidence(changed.raw, changed.controllerNonce, changed.outcome)).toThrow(
      'p3c_semantic_http_page_cursor_cycle'
    );
  });

  it('rejects a truncated approval page with no retained successor', () => {
    const fixture = rawEvidence();
    const changed = mutateSemanticEvent(fixture, 'product-http', 'pending_observed', (semantic) => {
      const exchanges = (semantic.transport as Record<string, unknown>).pageExchanges as Record<
        string,
        unknown
      >[];
      exchanges.pop();
    });
    expect(() => deriveEvidence(changed.raw, changed.controllerNonce, changed.outcome)).toThrow(
      'p3c_semantic_http_page_missing_tail'
    );
  });

  it('rejects fully rehashed allow/deny SSE label substitution', () => {
    const fixture = rawEvidence();
    const records = fixture.raw['product-sse']
      .toString('utf8')
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const index = records.findIndex((record) => record.event === 'terminal_events_observed');
    const original = records[index];
    const row = original.row as (typeof MATRIX_ROWS)[number];
    const identity = fixtureObservedIdentity(
      fixture.controllerNonce,
      fixture.outcome.runId,
      row,
      'allow_terminal_fsynced'
    );
    const payload = JSON.parse(
      canonicalJson(
        makeSemanticPayload({
          origin: 'product-sse',
          row,
          event: 'allow_terminal_fsynced',
          identity,
        })
      )
    ) as Record<string, unknown>;
    const semantic = JSON.parse(
      Buffer.from(payload.recordBase64 as string, 'base64').toString('utf8')
    ) as Record<string, unknown>;
    const transport = semantic.transport as Record<string, unknown>;
    transport.eventType = 'deny_terminal_fsynced';
    mutateRedactedBody(transport.data as Record<string, unknown>, (body) => {
      body.event = 'deny_terminal_fsynced';
      body.decision = 'deny';
    });
    const semanticBytes = Buffer.from(canonicalJson(semantic));
    payload.recordBase64 = semanticBytes.toString('base64');
    payload.recordSha256 = sha256(semanticBytes);
    records[index] = makeRawRecord({
      controllerNonce: fixture.controllerNonce,
      origin: 'product-sse',
      row,
      sequence: original.sequence as number,
      monotonicNs: original.monotonicNs as string,
      processStartToken: original.processStartToken as string,
      event: 'allow_terminal_fsynced',
      correlation: sha256(
        `agent-teams.p3c.row-identity/v1\0${fixture.controllerNonce}\0${row}\0${sha256(
          canonicalJson(canonicalRowIdentity(row, identity))
        )}`
      ),
      effectCount: original.effectCount as number,
      payload,
    }) as unknown as Record<string, unknown>;
    const changed = replaceRawOrigin(
      fixture,
      'product-sse',
      Buffer.from(`${records.map(canonicalJson).join('\n')}\n`)
    );
    expect(() => deriveEvidence(changed.raw, changed.controllerNonce, changed.outcome)).toThrow(
      'p3c_semantic_sse_label_binding'
    );
  });

  it('rejects fully rehashed allow/deny WAL state substitution', () => {
    const fixture = rawEvidence();
    const changed = mutateSemanticEvent(
      fixture,
      'owner-wal',
      'allow_terminal_fsynced',
      (semantic) => {
        const transport = semantic.transport as Record<string, unknown>;
        transport.state = 'deny_terminal_fsynced';
        const retained = transport.record as Record<string, unknown>;
        mutateRedactedBody(retained, (body) => {
          body.event = 'deny_terminal_fsynced';
          body.state = 'deny_terminal_fsynced';
          body.decision = 'deny';
        });
        transport.recordSha256 = retained.sha256;
        transport.length = Buffer.from(retained.bodyBase64 as string, 'base64').length;
      }
    );
    expect(() => deriveEvidence(changed.raw, changed.controllerNonce, changed.outcome)).toThrow(
      'p3c_semantic_wal'
    );
  });

  it('rejects a substituted and correctly rehashed observed OpenCode body', () => {
    const fixture = rawEvidence();
    const changed = mutateSemanticEvent(fixture, 'opencode', 'allow_effect', (semantic) => {
      const response = (semantic.transport as Record<string, unknown>).response as Record<
        string,
        unknown
      >;
      const body = JSON.parse(
        Buffer.from(response.bodyBase64 as string, 'base64').toString('utf8')
      ) as Record<string, unknown>;
      body.outcome = 'observed';
      const bytes = Buffer.from(canonicalJson(body));
      response.bodyBase64 = bytes.toString('base64');
      response.sha256 = sha256(bytes);
    });
    expect(() => deriveEvidence(changed.raw, changed.controllerNonce, changed.outcome)).toThrow(
      'p3c_semantic_opencode_body_binding'
    );
  });

  it('rejects a retry claim on a nominal provider effect', () => {
    const fixture = rawEvidence();
    const changed = mutateSemanticEvent(fixture, 'opencode', 'allow_effect', (semantic) => {
      const causal = semantic.causal as Record<string, unknown>;
      causal.attempt = 2;
      causal.retryObserved = true;
      const transport = semantic.transport as Record<string, unknown>;
      transport.attempt = 2;
      transport.retryObserved = true;
    });
    expect(() => deriveEvidence(changed.raw, changed.controllerNonce, changed.outcome)).toThrow(
      'p3c_semantic_causal_binding'
    );
  });

  it('rejects provider-effect identity drift inside an exactly-once causal chain', () => {
    const fixture = rawEvidence();
    const changed = mutateSemanticEvent(fixture, 'opencode', 'allow_effect', (semantic) => {
      const causal = semantic.causal as Record<string, unknown>;
      causal.providerEffectId = `effect_${digest('drifted-provider-effect').slice(0, 32)}`;
      (semantic.transport as Record<string, unknown>).providerEffectId = causal.providerEffectId;
    });
    expect(() => deriveEvidence(changed.raw, changed.controllerNonce, changed.outcome)).toThrow(
      'p3c_semantic_opencode_body_binding'
    );
  });

  it('rejects a fully rehashed reciprocal allow/deny semantic and effect substitution', () => {
    const allowEffectId = `effect_${digest('observed-provider-effect-id:decision:allow').slice(
      0,
      32
    )}`;
    const denyEffectId = `effect_${digest('observed-provider-effect-id:decision:deny').slice(
      0,
      32
    )}`;
    const effectSha256s: string[] = [];
    const swapEffectId = (value: unknown): unknown =>
      value === allowEffectId ? denyEffectId : value === denyEffectId ? allowEffectId : value;
    const changed = mutateAllSemanticRecords(rawEvidence(), (origin, event, row, semantic) => {
      const expectedDecision = semanticDecisionForEvent(row, event);
      if (expectedDecision === 'allow' || expectedDecision === 'deny') {
        const substitutedDecision = expectedDecision === 'allow' ? 'deny' : 'allow';
        const identity = semantic.identity as Record<string, unknown>;
        identity.decision = substitutedDecision;
        const causal = semantic.causal as Record<string, unknown>;
        causal.providerEffectId = swapEffectId(causal.providerEffectId);
        causal.chainId = sha256(`agent-teams.p3c.causal-chain/v1\0${canonicalJson(identity)}`);
        const transport = semantic.transport as Record<string, unknown>;
        if (origin === 'browser') transport.decision = substitutedDecision;
        if (origin === 'owner-wal' || origin === 'opencode')
          transport.providerEffectId = swapEffectId(transport.providerEffectId);
        if (origin === 'product-http' || origin === 'opencode') {
          for (const field of ['request', 'response'] as const) {
            mutateRedactedBody(transport[field] as Record<string, unknown>, (body) => {
              if ('decision' in body) body.decision = substitutedDecision;
              if ('providerEffectId' in body)
                body.providerEffectId = swapEffectId(body.providerEffectId);
            });
          }
        }
        if (
          origin === 'opencode' &&
          /^(?:(?:allow|deny)_effect|reconcile_not_delivered_retry_effect)$/u.test(event)
        ) {
          effectSha256s.push((transport.response as Record<string, unknown>).sha256 as string);
        }
      }
      if (origin === 'opencode' && event === 'effect_total_two') {
        const transport = semantic.transport as Record<string, unknown>;
        transport.effectSetSha256s = [...effectSha256s];
        transport.effectSetDigest = sha256(
          `agent-teams.p3c.provider-effect-set/v1\0${canonicalJson([...effectSha256s].sort())}`
        );
      }
    });
    expect(effectSha256s).toHaveLength(2);
    expect(() => deriveEvidence(changed.raw, changed.controllerNonce, changed.outcome)).toThrow(
      'p3c_semantic_decision_binding'
    );
  });

  it.each(['allow', 'deny'] as const)(
    'rejects a null provider-effect ID on an actual %s effect record after rehashing',
    (decision) => {
      const fixture = rawEvidence();
      const changed = mutateSemanticEvent(fixture, 'opencode', `${decision}_effect`, (semantic) => {
        (semantic.causal as Record<string, unknown>).providerEffectId = null;
        const transport = semantic.transport as Record<string, unknown>;
        transport.providerEffectId = null;
        for (const field of ['request', 'response'] as const) {
          mutateRedactedBody(transport[field] as Record<string, unknown>, (body) => {
            body.providerEffectId = null;
          });
        }
      });
      expect(() => deriveEvidence(changed.raw, changed.controllerNonce, changed.outcome)).toThrow(
        'p3c_semantic_causal_binding'
      );
    }
  );

  it.each(['allow', 'deny'] as const)(
    'rejects a borrowed provider-effect ID on %s after all direct effect joins are rehashed',
    (decision) => {
      const fixture = rawEvidence();
      const borrowedDecision = decision === 'allow' ? 'deny' : 'allow';
      const borrowed = `effect_${digest(
        `observed-provider-effect-id:decision:${borrowedDecision}`
      ).slice(0, 32)}`;
      const changed = mutateSemanticEvent(fixture, 'opencode', `${decision}_effect`, (semantic) => {
        (semantic.causal as Record<string, unknown>).providerEffectId = borrowed;
        const transport = semantic.transport as Record<string, unknown>;
        transport.providerEffectId = borrowed;
        for (const field of ['request', 'response'] as const) {
          mutateRedactedBody(transport[field] as Record<string, unknown>, (body) => {
            body.providerEffectId = borrowed;
          });
        }
      });
      expect(() => deriveEvidence(changed.raw, changed.controllerNonce, changed.outcome)).toThrow(
        `p3c_exactly_once_causal_order:${decision}`
      );
    }
  );

  it('cryptographically joins effect_total_two to both observed provider effects', () => {
    const fixture = rawEvidence();
    const evidence = deriveEvidence(fixture.raw, fixture.controllerNonce, fixture.outcome);
    expect(evidence.exactlyOnce.normalProviderEffects).toHaveLength(2);
    const changed = mutateSemanticEvent(fixture, 'opencode', 'effect_total_two', (semantic) => {
      const transport = semantic.transport as Record<string, unknown>;
      transport.effectSetSha256s = [
        digest('observed-provider-effect:allow_effect'),
        digest('substituted-provider-effect'),
      ];
      transport.effectSetDigest = sha256(
        `agent-teams.p3c.provider-effect-set/v1\0${canonicalJson(
          [...(transport.effectSetSha256s as string[])].sort()
        )}`
      );
    });
    expect(() => deriveEvidence(changed.raw, changed.controllerNonce, changed.outcome)).toThrow(
      'p3c_provider_effect_total_join'
    );
  });

  it('rejects a forged total digest even when the retained effect set is unchanged', () => {
    const fixture = rawEvidence();
    const changed = mutateSemanticEvent(fixture, 'opencode', 'effect_total_two', (semantic) => {
      (semantic.transport as Record<string, unknown>).effectSetDigest = digest(
        'forged-effect-set-digest'
      );
    });
    expect(() => deriveEvidence(changed.raw, changed.controllerNonce, changed.outcome)).toThrow(
      'p3c_provider_effect_total_join'
    );
  });

  it('rejects a forged caller-asserted provider-effect digest', () => {
    const fixture = rawEvidence();
    const changed = mutateSemanticEvent(fixture, 'opencode', 'allow_effect', (semantic) => {
      (semantic.transport as Record<string, unknown>).providerEffectSha256 = digest(
        'forged-caller-effect-digest'
      );
    });
    expect(() => deriveEvidence(changed.raw, changed.controllerNonce, changed.outcome)).toThrow(
      'p3c_semantic_opencode_keys'
    );
  });

  it('rejects effect_total_two resequenced before either committed provider effect', () => {
    const fixture = rawEvidence();
    const records = fixture.raw.opencode
      .toString('utf8')
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const denyEffect = records.find((record) => record.event === 'deny_effect')!;
    const total = records.find((record) => record.event === 'effect_total_two')!;
    total.monotonicNs = String(BigInt(denyEffect.monotonicNs as string) - 1n);
    records.sort((left, right) =>
      BigInt(left.monotonicNs as string) < BigInt(right.monotonicNs as string) ? -1 : 1
    );
    const resequenced = records.map((record, index) =>
      makeRawRecord({
        controllerNonce: record.controllerNonce as string,
        origin: 'opencode',
        row: record.row as (typeof MATRIX_ROWS)[number],
        sequence: index + 1,
        monotonicNs: record.monotonicNs as string,
        processStartToken: record.processStartToken as string,
        event: record.event as string,
        correlation: record.correlation as string,
        effectCount: record.effectCount as number,
        payload: JSON.parse(
          Buffer.from(record.payloadBase64 as string, 'base64').toString('utf8')
        ) as unknown,
      })
    );
    const changed = replaceRawOrigin(
      fixture,
      'opencode',
      Buffer.from(`${resequenced.map(canonicalJson).join('\n')}\n`)
    );
    expect(() => deriveEvidence(changed.raw, changed.controllerNonce, changed.outcome)).toThrow(
      'p3c_provider_effect_total_order'
    );
  });

  it('enforces globally ordered monotonic records and cumulative effectCount', () => {
    const fixture = rawEvidence();
    const decreasing = mutateOuterEvent(
      fixture,
      'product-http',
      'wrong_lane_routes_absent',
      (record) => {
        record.effectCount = 1;
      }
    );
    expect(() =>
      deriveEvidence(decreasing.raw, decreasing.controllerNonce, decreasing.outcome)
    ).toThrow('p3c_evidence_global_causal_order');

    const reordered = mutateOuterEvent(fixture, 'owner-wal', 'allow_terminal_fsynced', (record) => {
      record.monotonicNs = '5500';
    });
    expect(() =>
      deriveEvidence(reordered.raw, reordered.controllerNonce, reordered.outcome)
    ).toThrow('p3c_evidence_global_causal_order');
  });

  it('rejects a terminal WAL observation that precedes its provider response', () => {
    const fixture = rawEvidence();
    const records = fixture.raw['owner-wal']
      .toString('utf8')
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const index = records.findIndex((record) => record.event === 'allow_terminal_fsynced');
    const original = records[index];
    const payload = JSON.parse(
      Buffer.from(original.payloadBase64 as string, 'base64').toString('utf8')
    ) as unknown;
    records[index] = makeRawRecord({
      controllerNonce: original.controllerNonce as string,
      origin: 'owner-wal',
      row: original.row as (typeof MATRIX_ROWS)[number],
      sequence: original.sequence as number,
      monotonicNs: '5500',
      processStartToken: original.processStartToken as string,
      event: original.event as string,
      correlation: original.correlation as string,
      effectCount: original.effectCount as number,
      payload,
    }) as unknown as Record<string, unknown>;
    const changed = replaceRawOrigin(
      fixture,
      'owner-wal',
      Buffer.from(`${records.map(canonicalJson).join('\n')}\n`)
    );
    expect(() => deriveEvidence(changed.raw, changed.controllerNonce, changed.outcome)).toThrow(
      'p3c_evidence_global_causal_order'
    );
  });

  it.each([
    ['product-http', 'reconcile_while_lease_open_rejected'],
    ['product-http', 'reconcile_identity_mismatch_rejected'],
    ['product-http', 'wrong_lane_routes_absent'],
    ['product-http', 'wrong_socket_path_routes_absent'],
    ['product-http', 'wrong_socket_device_routes_absent'],
    ['product-http', 'wrong_socket_inode_routes_absent'],
    ['product-http', 'replaced_socket_routes_absent'],
    ['product-http', 'wrong_socket_uid_routes_absent'],
    ['product-http', 'wrong_socket_gid_routes_absent'],
    ['product-http', 'wrong_socket_mode_routes_absent'],
    ['product-http', 'dead_owner_routes_absent'],
    ['supervisor', 'forced_owner_failure_drained'],
    ['supervisor', 'forced_opencode_failure_drained'],
  ] as const)('requires distinct adversarial evidence %s:%s', (origin, event) => {
    const fixture = rawEvidence();
    const records = fixture.raw[origin]
      .toString('utf8')
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((record) => record.event !== event)
      .map((record, index) =>
        makeRawRecord({
          controllerNonce: record.controllerNonce as string,
          origin,
          row: record.row as (typeof MATRIX_ROWS)[number],
          sequence: index + 1,
          monotonicNs: record.monotonicNs as string,
          processStartToken: record.processStartToken as string,
          event: record.event as string,
          correlation: record.correlation as string,
          effectCount: record.effectCount as number,
          payload: JSON.parse(
            Buffer.from(record.payloadBase64 as string, 'base64').toString('utf8')
          ) as unknown,
        })
      );
    const changed = replaceRawOrigin(
      fixture,
      origin,
      Buffer.from(`${records.map(canonicalJson).join('\n')}\n`)
    );
    expect(() => deriveEvidence(changed.raw, changed.controllerNonce, changed.outcome)).toThrow(
      'p3c_evidence_matrix'
    );
  });
});
