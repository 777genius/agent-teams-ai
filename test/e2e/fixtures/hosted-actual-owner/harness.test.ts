import { spawn as spawnChild } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { once } from 'node:events';
import { closeSync, constants, openSync } from 'node:fs';
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
  ORDERED_PRODUCER_IDENTITIES,
  OWNED_PATHS,
  OWNER_CHILD_PROTOCOL,
  P3B_SOURCE_COMMIT,
  P3C_LANE,
  PACKET_BASE_COMMIT,
  parseActualOwnerRuntimeManifest,
  parseIntegrationDescriptor,
  parseProducerCandidateSignatureSidecar,
  parseSignedProducerCandidatePayload,
  PRODUCER_CANDIDATE_SIGNATURE_DOMAIN,
  PRODUCER_PROVENANCE_CONTRACT,
  PRODUCER_PROVENANCE_CONTRACT_SHA256,
  PRODUCT_AUTHORITY_COMMIT,
  RAW_ORIGINS,
  type RawOrigin,
  REJECTED_HISTORICAL_OPENCODE_IDENTITIES,
  REQUIRED_OPENCODE_ACQUISITION,
  type RootName,
  type RootPin,
  RUNTIME_CAPTURE_NAMES,
  RUNTIME_CAPTURE_PRODUCER_MAPPINGS,
  RUNTIME_CAPTURE_STREAMS,
  type RuntimeCaptureName,
  sha256,
} from '../../../../scripts/e2e/hosted-actual-owner/contracts';
import {
  assertLiveCaptureMode,
  type DriverResult,
} from '../../../../scripts/e2e/hosted-actual-owner/driver';
import {
  assembleEvidence,
  assertNativeSemanticCrossJoin,
  canonicalRowIdentity,
  deriveEvidence,
  EVIDENCE_REQUIREMENTS,
  makeRawRecord,
  makeSemanticPayload,
  observedSemanticIdentity,
  parseNativeRuntimeCapture,
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
  verifyP3B2Recipe,
  verifyReleaseManifest,
  verifySignedProducerCandidate,
} from '../../../../scripts/e2e/hosted-actual-owner/preflight';
import {
  acceptCanonicalChildDescriptorPublication,
  buildSupervisorPlan,
  captureDetachedProcessAnchor,
  censusOwnedProcesses,
  collectBoundedStream,
  exactChildEnvironment,
  observeCurrentWrapperDescriptorsBeforeSpawn,
  observeParentDescriptorsBeforeSpawn,
  observeParentDescriptorsClosed,
  PARENT_DESCRIPTOR_ROLES,
  parseOwnerChildDescriptorCleanup,
  parseSupervisorTranscript,
  type ProcessExitEvidence,
  processOwnershipMarker,
  type ProcessStartEvidence,
  producerCaptureSealManifestSha256,
  readCurrentWrapperProcessStartIdentity,
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

import type { RunResult } from '../../../../scripts/e2e/hosted-actual-owner/run';

const repositoryRoot = process.cwd();
type CompileHarnessSurfaces = DriverResult | RunResult;
const compileHarnessSurfaces: CompileHarnessSurfaces | null = null;
void compileHarnessSurfaces;

function digest(label: string): string {
  return sha256(`p3c-deterministic-fixture:${label}`);
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function expectUnusedBase64PadBitAlias(canonical: string): string {
  const canonicalBytes = Buffer.from(canonical, 'base64');
  expect(canonicalBytes).toHaveLength(64);
  expect(canonicalBytes.toString('base64')).toBe(canonical);
  expect(canonical.endsWith('==')).toBe(true);

  const finalSextetOffset = canonical.length - 3;
  const finalSextet = BASE64_ALPHABET.indexOf(canonical[finalSextetOffset]!);
  expect(finalSextet).toBeGreaterThanOrEqual(0);
  expect(finalSextet & 0x0f).toBe(0);
  const aliased = `${canonical.slice(0, finalSextetOffset)}${BASE64_ALPHABET[finalSextet | 1]}${canonical.slice(finalSextetOffset + 1)}`;

  expect(aliased).not.toBe(canonical);
  expect(Buffer.from(aliased, 'base64')).toEqual(canonicalBytes);
  return aliased;
}

const TEST_OPENCODE_IDENTITIES = Object.freeze({
  repository: REQUIRED_OPENCODE_ACQUISITION.repository,
  pullRequestHead: '2222222222222222222222222222222222222222',
  workflowMergeCommit: '3333333333333333333333333333333333333333',
  releaseSourceCommit: '4444444444444444444444444444444444444444',
  releaseSourceTree: '5555555555555555555555555555555555555555',
  releaseBaseCommit: '6666666666666666666666666666666666666666',
  workflowRunId: '17000000001',
  workflowRunAttempt: 2,
  workflowRef: 'refs/pull/17/merge',
  candidateArtifactId: '18000000001',
  provenanceArtifactId: '18000000002',
  candidateArtifactSha256: digest('r1-candidate-artifact'),
  provenanceArtifactSha256: digest('r1-provenance-artifact'),
  buildProvenanceBundleSha256: digest('r1-build-provenance-bundle'),
  releaseManifestSha256: digest('r1-release-manifest'),
  linuxX64ArchiveSha256: digest('r1-linux-archive'),
  linuxX64BinarySha256: digest('r1-opencode-binary'),
});

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
    inode: String(
      Number.parseInt(digest(`fixture-file-pin:${root}:${label}`).slice(0, 12), 16)
    ),
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
    producerCandidate: {
      payload: filePin('controllerAuthority', 'producer-candidate-payload'),
      signature: filePin('controllerAuthority', 'producer-candidate-signature'),
      signerPublicKey: filePin('controllerAuthority', 'producer-candidate-signer-public-key'),
      trustAnchorSha256: digest('producer-candidate-trust-anchor'),
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
      identities: TEST_OPENCODE_IDENTITIES,
      acquisitionReceipt: filePin('openCode', 'receipt'),
      provenanceArtifactZip: filePin(
        'openCode',
        'provenance-artifact-zip',
        TEST_OPENCODE_IDENTITIES.provenanceArtifactSha256
      ),
      buildProvenanceBundle: filePin(
        'openCode',
        'build-provenance-bundle',
        TEST_OPENCODE_IDENTITIES.buildProvenanceBundleSha256
      ),
      releaseManifest: filePin(
        'openCode',
        'release-manifest',
        TEST_OPENCODE_IDENTITIES.releaseManifestSha256
      ),
      actionsArtifactZip: filePin(
        'openCode',
        'actions-envelope',
        TEST_OPENCODE_IDENTITIES.candidateArtifactSha256
      ),
      linuxX64Archive: filePin(
        'openCode',
        'linux-archive',
        TEST_OPENCODE_IDENTITIES.linuxX64ArchiveSha256
      ),
      linuxX64Binary: filePin(
        'openCode',
        'opencode',
        TEST_OPENCODE_IDENTITIES.linuxX64BinarySha256,
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

function signedProducerCandidateFixture(
  descriptor: ReturnType<typeof parseIntegrationDescriptor>
) {
  const keys = generateKeyPairSync('ed25519');
  const publicKey = Buffer.from(keys.publicKey.export({ format: 'der', type: 'spki' }));
  const keyId = sha256(
    `agent-teams.p3c.producer-candidate-key-id/v1\0${publicKey.toString('base64')}`
  );
  const { product, toolchain, p3b2, openCode, authority } = descriptor;
  const payload = {
    contract: PRODUCER_PROVENANCE_CONTRACT.contract,
    contractSha256: PRODUCER_PROVENANCE_CONTRACT_SHA256,
    openCodeProvenance: {
      repository: TEST_OPENCODE_IDENTITIES.repository,
      pullRequestHead: TEST_OPENCODE_IDENTITIES.pullRequestHead,
      workflowMergeCommit: TEST_OPENCODE_IDENTITIES.workflowMergeCommit,
      releaseSourceCommit: TEST_OPENCODE_IDENTITIES.releaseSourceCommit,
      releaseSourceTree: TEST_OPENCODE_IDENTITIES.releaseSourceTree,
      releaseBaseCommit: TEST_OPENCODE_IDENTITIES.releaseBaseCommit,
      workflowRunId: TEST_OPENCODE_IDENTITIES.workflowRunId,
      workflowRunAttempt: TEST_OPENCODE_IDENTITIES.workflowRunAttempt,
      workflowRef: TEST_OPENCODE_IDENTITIES.workflowRef,
      candidateArtifactId: TEST_OPENCODE_IDENTITIES.candidateArtifactId,
      candidateArtifactSha256: TEST_OPENCODE_IDENTITIES.candidateArtifactSha256,
      provenanceArtifactId: TEST_OPENCODE_IDENTITIES.provenanceArtifactId,
      provenanceArtifactSha256: TEST_OPENCODE_IDENTITIES.provenanceArtifactSha256,
      buildProvenanceBundleSha256: TEST_OPENCODE_IDENTITIES.buildProvenanceBundleSha256,
    },
    producers: [
      {
        ...ORDERED_PRODUCER_IDENTITIES[0],
        artifactManifestSha256: product.browserBundle.manifestSha256,
        executableSha256: toolchain.node.sha256,
        moduleSha256: product.playwrightSpec.sha256,
        sourceRepository: '777genius/agent-teams-ai',
        sourceCommit: product.finalHarnessCommit,
        sourceTree: '7777777777777777777777777777777777777777',
      },
      {
        ...ORDERED_PRODUCER_IDENTITIES[1],
        artifactManifestSha256: openCode.releaseManifest.sha256,
        executableSha256: openCode.linuxX64Binary.sha256,
        moduleSha256: openCode.linuxX64Binary.sha256,
        sourceRepository: TEST_OPENCODE_IDENTITIES.repository,
        sourceCommit: TEST_OPENCODE_IDENTITIES.releaseSourceCommit,
        sourceTree: TEST_OPENCODE_IDENTITIES.releaseSourceTree,
      },
      {
        ...ORDERED_PRODUCER_IDENTITIES[2],
        artifactManifestSha256: p3b2.closure.manifestSha256,
        executableSha256: p3b2.entry.sha256,
        moduleSha256: p3b2.entry.sha256,
        sourceRepository: '777genius/agent_teams_orchestrator',
        sourceCommit: p3b2.resultCommit,
        sourceTree: '8888888888888888888888888888888888888888',
      },
      {
        ...ORDERED_PRODUCER_IDENTITIES[3],
        artifactManifestSha256: product.runtimeClosure.manifestSha256,
        executableSha256: product.compositionEntry.sha256,
        moduleSha256: product.compositionEntry.sha256,
        sourceRepository: '777genius/agent-teams-ai',
        sourceCommit: authority.auditedProductCommit,
        sourceTree: authority.auditedProductTree,
      },
    ],
    productionEligible: false,
    purpose: 'agent-teams.p3c.producer-candidate/v1',
    releaseEligible: false,
    schemaVersion: 1,
    signedBuildProvenanceRequired: true,
  };
  const payloadBytes = Buffer.from(canonicalJson(payload));
  const signature = sign(
    null,
    Buffer.concat([Buffer.from(PRODUCER_CANDIDATE_SIGNATURE_DOMAIN), payloadBytes]),
    keys.privateKey
  );
  const sidecar = {
    algorithm: 'ed25519',
    keyId,
    payloadSha256: sha256(payloadBytes),
    signature: signature.toString('base64'),
  };
  return Object.freeze({
    keys,
    publicKey,
    keyId,
    payload,
    payloadBytes,
    signatureBytes: Buffer.from(canonicalJson(sidecar)),
  });
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
  const control = raw.control as Record<string, unknown>;
  const reviewerKeyPin = control.harnessReviewerPublicKey as Record<string, unknown>;
  reviewerKeyPin.sha256 = sha256(reviewerPublicKeyBytes);
  reviewerKeyPin.size = reviewerPublicKeyBytes.length;
  const runAuthorizationKeyPin = control.runAuthorizationPublicKey as Record<string, unknown>;
  runAuthorizationKeyPin.sha256 = sha256(runAuthorizationPublicKeyBytes);
  runAuthorizationKeyPin.size = runAuthorizationPublicKeyBytes.length;
  const candidate = signedProducerCandidateFixture(
    parseIntegrationDescriptor(Buffer.from(canonicalJson(raw)))
  );
  const producerCandidate = raw.producerCandidate as Record<string, unknown>;
  const candidatePayloadPin = producerCandidate.payload as Record<string, unknown>;
  candidatePayloadPin.sha256 = sha256(candidate.payloadBytes);
  candidatePayloadPin.size = candidate.payloadBytes.length;
  const candidateSignaturePin = producerCandidate.signature as Record<string, unknown>;
  candidateSignaturePin.sha256 = sha256(candidate.signatureBytes);
  candidateSignaturePin.size = candidate.signatureBytes.length;
  const candidateSignerPin = producerCandidate.signerPublicKey as Record<string, unknown>;
  candidateSignerPin.sha256 = sha256(candidate.publicKey);
  candidateSignerPin.size = candidate.publicKey.length;
  const trustAnchor = {
    schemaVersion: 2 as const,
    purpose: 'agent-teams.p3c.controller-trust-anchor/v2' as const,
    authorityEpoch: 1,
    harnessReviewerPublicKeySha256: sha256(reviewerPublicKeyBytes),
    runAuthorizationPublicKeySha256: sha256(runAuthorizationPublicKeyBytes),
    producerCandidatePublicKeySha256: sha256(candidate.publicKey),
    producerCandidateSignerKeyId: candidate.keyId,
    revokedSignerKeyIds: [] as string[],
  };
  producerCandidate.trustAnchorSha256 = sha256(canonicalJson(trustAnchor));
  const seed = parseIntegrationDescriptor(Buffer.from(canonicalJson(raw)));
  const verifiedProducerCandidate = verifySignedProducerCandidate(
    seed,
    candidate.payloadBytes,
    candidate.signatureBytes,
    candidate.publicKey,
    trustAnchor
  );
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
      candidateOpenCodeSha256: openCode.linuxX64Binary.sha256,
      accepted: true,
    },
    openCode: {
      identities: openCode.identities,
      provenanceReceiptSha256: openCode.acquisitionReceipt.sha256,
      provenanceArtifactZipSha256: openCode.provenanceArtifactZip.sha256,
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
    producerCandidatePublicKeySha256: sha256(candidate.publicKey),
    producerCandidate: verifiedProducerCandidate.binding,
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
    producerCandidate: Object.freeze({
      ...candidate,
      binding: verifiedProducerCandidate.binding,
      parsedPayload: verifiedProducerCandidate.payload,
      parsedSignature: verifiedProducerCandidate.signature,
    }),
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

describe('signed producer candidate shape', () => {
  const candidateFixture = signedControlFixture().producerCandidate;
  const payload = candidateFixture.payload;
  const payloadBytes = Buffer.from(canonicalJson(payload));

  it('requires exact producer order and false eligibility', () => {
    expect(parseSignedProducerCandidatePayload(payloadBytes)).toEqual(payload);
    const reordered = { ...payload, producers: [...payload.producers].reverse() };
    expect(() =>
      parseSignedProducerCandidatePayload(Buffer.from(canonicalJson(reordered)))
    ).toThrow(/p3c_producer_candidate_producer_0/u);
    expect(() =>
      parseSignedProducerCandidatePayload(
        Buffer.from(canonicalJson({ ...payload, productionEligible: true }))
      )
    ).toThrow('p3c_producer_candidate_contract');
  });

  it('rejects explicitly missing and duplicate producer roles', () => {
    const missing = { ...payload, producers: payload.producers.slice(0, -1) };
    expect(() =>
      parseSignedProducerCandidatePayload(Buffer.from(canonicalJson(missing)))
    ).toThrow('p3c_producer_candidate_contract');

    const duplicate = structuredClone(payload);
    duplicate.producers[3] = structuredClone(duplicate.producers[0]!);
    expect(() =>
      parseSignedProducerCandidatePayload(Buffer.from(canonicalJson(duplicate)))
    ).toThrow('p3c_producer_candidate_roles');
  });

  it('rejects a raw UTF-8 BOM in the signed candidate and detached signature sidecar', () => {
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    expect(() =>
      parseSignedProducerCandidatePayload(Buffer.concat([bom, payloadBytes]))
    ).toThrow('p3c_producer_candidate_frame');

    const sidecar = {
      algorithm: 'ed25519',
      keyId: candidateFixture.keyId,
      payloadSha256: sha256(payloadBytes),
      signature: Buffer.alloc(64, 7).toString('base64'),
    };
    expect(() =>
      parseProducerCandidateSignatureSidecar(
        Buffer.concat([bom, Buffer.from(canonicalJson(sidecar))]),
        payloadBytes
      )
    ).toThrow('p3c_producer_candidate_signature_frame');
  });

  it('keeps candidate, provenance artifact, and provenance bundle identities distinct', () => {
    for (const [targetIdentity, sourceIdentity] of [
      ['candidateArtifactSha256', 'provenanceArtifactSha256'],
      ['candidateArtifactSha256', 'buildProvenanceBundleSha256'],
      ['buildProvenanceBundleSha256', 'provenanceArtifactSha256'],
    ] as const) {
      const collapsed = structuredClone(payload);
      const provenance = collapsed.openCodeProvenance as unknown as Record<string, unknown>;
      provenance[targetIdentity] = provenance[sourceIdentity];
      expect(() =>
        parseSignedProducerCandidatePayload(Buffer.from(canonicalJson(collapsed)))
      ).toThrow('p3c_producer_candidate_opencode_provenance');
    }
  });

  it('binds the detached signature shape to exact candidate bytes', () => {
    const sidecar = {
      algorithm: 'ed25519',
      keyId: candidateFixture.keyId,
      payloadSha256: sha256(payloadBytes),
      signature: Buffer.alloc(64, 7).toString('base64'),
    };
    expect(
      parseProducerCandidateSignatureSidecar(Buffer.from(canonicalJson(sidecar)), payloadBytes)
    ).toEqual(sidecar);
    const aliasedSidecar = {
      ...sidecar,
      signature: expectUnusedBase64PadBitAlias(sidecar.signature),
    };
    expect(() =>
      parseProducerCandidateSignatureSidecar(
        Buffer.from(canonicalJson(aliasedSidecar)),
        payloadBytes
      )
    ).toThrow('p3c_producer_candidate_signature');
    expect(() =>
      parseProducerCandidateSignatureSidecar(
        Buffer.from(canonicalJson(sidecar)),
        Buffer.from(`${payloadBytes.toString('utf8')}\n`)
      )
    ).toThrow('p3c_producer_candidate_signature');
  });

  it('cryptographically rejects forged, untrusted, revoked, and inconsistent candidates', () => {
    const fixture = signedControlFixture();
    expect(() =>
      verifySignedProducerCandidate(
        fixture.descriptor,
        fixture.producerCandidate.payloadBytes,
        fixture.producerCandidate.signatureBytes,
        fixture.producerCandidate.publicKey,
        fixture.trustAnchor
      )
    ).not.toThrow();

    const aliasedSidecar = JSON.parse(
      fixture.producerCandidate.signatureBytes.toString('utf8')
    ) as Record<string, unknown>;
    aliasedSidecar.signature = expectUnusedBase64PadBitAlias(aliasedSidecar.signature as string);
    const aliasedSidecarBytes = Buffer.from(canonicalJson(aliasedSidecar));
    const aliasedDescriptor = structuredClone(fixture.descriptor);
    const aliasedSignaturePin = aliasedDescriptor.producerCandidate
      .signature as unknown as Record<string, unknown>;
    aliasedSignaturePin.sha256 = sha256(aliasedSidecarBytes);
    aliasedSignaturePin.size = aliasedSidecarBytes.length;
    expect(() =>
      verifySignedProducerCandidate(
        aliasedDescriptor,
        fixture.producerCandidate.payloadBytes,
        aliasedSidecarBytes,
        fixture.producerCandidate.publicKey,
        fixture.trustAnchor
      )
    ).toThrow('p3c_producer_candidate_signature');

    const forgedSidecar = JSON.parse(
      fixture.producerCandidate.signatureBytes.toString('utf8')
    ) as Record<string, unknown>;
    forgedSidecar.signature = Buffer.alloc(64).toString('base64');
    const forgedSidecarBytes = Buffer.from(canonicalJson(forgedSidecar));
    const forgedDescriptor = structuredClone(fixture.descriptor);
    const forgedSignaturePin = forgedDescriptor.producerCandidate
      .signature as unknown as Record<string, unknown>;
    forgedSignaturePin.sha256 = sha256(forgedSidecarBytes);
    forgedSignaturePin.size = forgedSidecarBytes.length;
    expect(() =>
      verifySignedProducerCandidate(
        forgedDescriptor,
        fixture.producerCandidate.payloadBytes,
        forgedSidecarBytes,
        fixture.producerCandidate.publicKey,
        fixture.trustAnchor
      )
    ).toThrow('p3c_producer_candidate_signature_binding');

    expect(() =>
      verifySignedProducerCandidate(
        fixture.descriptor,
        fixture.producerCandidate.payloadBytes,
        fixture.producerCandidate.signatureBytes,
        fixture.producerCandidate.publicKey,
        { ...fixture.trustAnchor, authorityEpoch: 2 }
      )
    ).toThrow('p3c_producer_candidate_signature_binding');

    const unrelatedKey = Buffer.from(
      generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' })
    );
    expect(() =>
      verifySignedProducerCandidate(
        fixture.descriptor,
        fixture.producerCandidate.payloadBytes,
        fixture.producerCandidate.signatureBytes,
        unrelatedKey,
        fixture.trustAnchor
      )
    ).toThrow('p3c_producer_candidate_signature_binding');

    const revokedTrustAnchor = {
      ...fixture.trustAnchor,
      revokedSignerKeyIds: [fixture.producerCandidate.keyId],
    };
    const revokedDescriptor = structuredClone(fixture.descriptor);
    (revokedDescriptor.producerCandidate as unknown as Record<string, unknown>).trustAnchorSha256 =
      sha256(canonicalJson(revokedTrustAnchor));
    expect(() =>
      verifySignedProducerCandidate(
        revokedDescriptor,
        fixture.producerCandidate.payloadBytes,
        fixture.producerCandidate.signatureBytes,
        fixture.producerCandidate.publicKey,
        revokedTrustAnchor
      )
    ).toThrow('p3c_producer_candidate_signature_binding');

    const verifyResignedMutation = (
      mutate: (payload: Record<string, unknown>) => void,
      expectedError: string
    ) => {
      const changedPayload = structuredClone(
        fixture.producerCandidate.payload
      ) as unknown as Record<string, unknown>;
      mutate(changedPayload);
      const changedPayloadBytes = Buffer.from(canonicalJson(changedPayload));
      const changedSignature = sign(
        null,
        Buffer.concat([
          Buffer.from(PRODUCER_CANDIDATE_SIGNATURE_DOMAIN),
          changedPayloadBytes,
        ]),
        fixture.producerCandidate.keys.privateKey
      );
      const changedSidecarBytes = Buffer.from(
        canonicalJson({
          algorithm: 'ed25519',
          keyId: fixture.producerCandidate.keyId,
          payloadSha256: sha256(changedPayloadBytes),
          signature: changedSignature.toString('base64'),
        })
      );
      const changedDescriptor = structuredClone(fixture.descriptor);
      const changedCandidate = changedDescriptor.producerCandidate as unknown as Record<
        string,
        Record<string, unknown>
      >;
      changedCandidate.payload.sha256 = sha256(changedPayloadBytes);
      changedCandidate.payload.size = changedPayloadBytes.length;
      changedCandidate.signature.sha256 = sha256(changedSidecarBytes);
      changedCandidate.signature.size = changedSidecarBytes.length;
      expect(() =>
        verifySignedProducerCandidate(
          changedDescriptor,
          changedPayloadBytes,
          changedSidecarBytes,
          fixture.producerCandidate.publicKey,
          fixture.trustAnchor
        )
      ).toThrow(expectedError);
    };

    verifyResignedMutation((changedPayload) => {
      const producers = changedPayload.producers as Record<string, unknown>[];
      producers[1]!.sourceTree = '9'.repeat(40);
    }, 'p3c_producer_candidate_opencode_binding');
    verifyResignedMutation((changedPayload) => {
      const provenance = changedPayload.openCodeProvenance as Record<string, unknown>;
      provenance.candidateArtifactSha256 = digest('forged-candidate-artifact');
    }, 'p3c_producer_candidate_provenance_binding');
    verifyResignedMutation((changedPayload) => {
      const provenance = changedPayload.openCodeProvenance as Record<string, unknown>;
      provenance.buildProvenanceBundleSha256 = digest('forged-build-provenance-bundle');
    }, 'p3c_producer_candidate_provenance_binding');
    for (const [field, value] of [
      ['pullRequestHead', 'a'.repeat(40)],
      ['workflowMergeCommit', 'b'.repeat(40)],
      ['releaseSourceCommit', 'c'.repeat(40)],
      ['releaseSourceTree', 'd'.repeat(40)],
      ['releaseBaseCommit', 'e'.repeat(40)],
      ['workflowRunId', '17000000002'],
      ['workflowRunAttempt', 3],
      ['workflowRef', 'refs/pull/18/merge'],
      ['candidateArtifactId', '18000000003'],
      ['provenanceArtifactId', '18000000004'],
      ['provenanceArtifactSha256', digest('forged-provenance-artifact')],
    ] as const) {
      verifyResignedMutation((changedPayload) => {
        const provenance = changedPayload.openCodeProvenance as Record<string, unknown>;
        provenance[field] = value;
      }, 'p3c_producer_candidate_provenance_binding');
    }
    verifyResignedMutation((changedPayload) => {
      const producers = changedPayload.producers as Record<string, unknown>[];
      producers[2]!.moduleSha256 = digest('forged-owner-module');
    }, 'p3c_producer_candidate_owner_binding');
  });
});

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
    expect(() =>
      parseIntegrationDescriptor(
        Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(canonicalJson(valid))])
      )
    ).toThrow('p3c_descriptor_encoding');
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
    for (const [targetIdentity, targetPin, sourceIdentity] of [
      ['candidateArtifactSha256', 'actionsArtifactZip', 'provenanceArtifactSha256'],
      ['candidateArtifactSha256', 'actionsArtifactZip', 'buildProvenanceBundleSha256'],
      ['buildProvenanceBundleSha256', 'buildProvenanceBundle', 'provenanceArtifactSha256'],
    ] as const) {
      const conflatedProvenance = structuredClone(valid) as typeof valid;
      const conflatedOpenCode = conflatedProvenance.openCode as Record<string, unknown>;
      const conflatedIdentities = conflatedOpenCode.identities as Record<string, unknown>;
      conflatedIdentities[targetIdentity] = conflatedIdentities[sourceIdentity];
      (conflatedOpenCode[targetPin] as Record<string, unknown>).sha256 =
        conflatedIdentities[sourceIdentity];
      expect(() =>
        parseIntegrationDescriptor(Buffer.from(canonicalJson(conflatedProvenance)))
      ).toThrow('p3c_opencode_provenance_artifact_bundle_identity_collapsed');
    }
    const sameArtifactId = structuredClone(valid) as typeof valid;
    const sameArtifactIdOpenCode = sameArtifactId.openCode as Record<string, unknown>;
    const sameArtifactIdIdentities = sameArtifactIdOpenCode.identities as Record<string, unknown>;
    sameArtifactIdIdentities.provenanceArtifactId =
      sameArtifactIdIdentities.candidateArtifactId;
    expect(() =>
      parseIntegrationDescriptor(Buffer.from(canonicalJson(sameArtifactId)))
    ).toThrow('p3c_opencode_artifact_id_collapsed');

    for (const [targetPin, sourcePin] of [
      ['provenanceArtifactZip', 'actionsArtifactZip'],
      ['buildProvenanceBundle', 'provenanceArtifactZip'],
    ] as const) {
      const hardLinked = structuredClone(valid) as typeof valid;
      const openCode = hardLinked.openCode as Record<string, Record<string, unknown>>;
      openCode[targetPin]!.device = openCode[sourcePin]!.device;
      openCode[targetPin]!.inode = openCode[sourcePin]!.inode;
      expect(() =>
        parseIntegrationDescriptor(Buffer.from(canonicalJson(hardLinked)))
      ).toThrow('p3c_opencode_artifact_backing_identity_collapsed');
    }
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
        fixture.trustAnchor,
        fixture.producerCandidate.binding
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
        fixture.trustAnchor,
        fixture.producerCandidate.binding
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
        fixture.trustAnchor,
        fixture.producerCandidate.binding
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
        descriptorSelectedTrust,
        fixture.producerCandidate.binding
      )
    ).toThrow('p3c_p3c1_freeze_binding');

    const candidateTamperedFreeze = JSON.parse(fixture.freeze.toString('utf8')) as Record<
      string,
      unknown
    >;
    const frozenCandidate = candidateTamperedFreeze.producerCandidate as Record<string, unknown>;
    frozenCandidate.payloadSha256 = digest('tampered-frozen-candidate');
    expect(() =>
      verifyControlDocuments(
        fixture.descriptor,
        Buffer.from(canonicalJson(candidateTamperedFreeze)),
        fixture.review,
        fixture.authorization,
        fixture.reviewerPublicKey,
        fixture.runAuthorizationPublicKey,
        fixture.trustAnchor,
        fixture.producerCandidate.binding
      )
    ).toThrow('p3c_p3c1_freeze_binding');
  });

  it.each([
    ['p3c1_freeze', 'freeze'],
    ['harness_review', 'review'],
    ['one_run_authorization', 'authorization'],
  ] as const)('rejects a raw UTF-8 BOM in the canonical %s document', (label, field) => {
    const fixture = signedControlFixture();
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    expect(() =>
      verifyControlDocuments(
        fixture.descriptor,
        field === 'freeze' ? Buffer.concat([bom, fixture.freeze]) : fixture.freeze,
        field === 'review' ? Buffer.concat([bom, fixture.review]) : fixture.review,
        field === 'authorization'
          ? Buffer.concat([bom, fixture.authorization])
          : fixture.authorization,
        fixture.reviewerPublicKey,
        fixture.runAuthorizationPublicKey,
        fixture.trustAnchor,
        fixture.producerCandidate.binding
      )
    ).toThrow(`p3c_${label}_frame`);
  });

  it('rejects a harness review signature with non-canonical base64 pad bits', () => {
    const fixture = signedControlFixture();
    const review = JSON.parse(fixture.review.toString('utf8')) as Record<string, unknown>;
    review.signatureBase64 = expectUnusedBase64PadBitAlias(review.signatureBase64 as string);
    expect(() =>
      verifyControlDocuments(
        fixture.descriptor,
        fixture.freeze,
        Buffer.from(canonicalJson(review)),
        fixture.authorization,
        fixture.reviewerPublicKey,
        fixture.runAuthorizationPublicKey,
        fixture.trustAnchor,
        fixture.producerCandidate.binding
      )
    ).toThrow('p3c_harness_review_signature_frame');
  });

  it('rejects a one-run authorization signature with non-canonical base64 pad bits', () => {
    const fixture = signedControlFixture();
    const authorization = JSON.parse(fixture.authorization.toString('utf8')) as Record<
      string,
      unknown
    >;
    authorization.signatureBase64 = expectUnusedBase64PadBitAlias(
      authorization.signatureBase64 as string
    );
    expect(() =>
      verifyControlDocuments(
        fixture.descriptor,
        fixture.freeze,
        fixture.review,
        Buffer.from(canonicalJson(authorization)),
        fixture.reviewerPublicKey,
        fixture.runAuthorizationPublicKey,
        fixture.trustAnchor,
        fixture.producerCandidate.binding
      )
    ).toThrow('p3c_one_run_authorization_signature_frame');
  });

  it('structurally cross-checks exact OpenCode release-manifest bytes', () => {
    const descriptor = parseIntegrationDescriptor(Buffer.from(canonicalJson(validDescriptor())));
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
        repository: TEST_OPENCODE_IDENTITIES.repository,
        workflow: 'release',
        runId: TEST_OPENCODE_IDENTITIES.workflowRunId,
        runAttempt: TEST_OPENCODE_IDENTITIES.workflowRunAttempt,
        actor: 'release-automation',
        ref: TEST_OPENCODE_IDENTITIES.workflowRef,
        sha: TEST_OPENCODE_IDENTITIES.workflowMergeCommit,
      },
      release: {
        version: '1.18.23-agentteams.1',
        tag: 'v1.18.23-agentteams.1',
        sourceCommit: TEST_OPENCODE_IDENTITIES.releaseSourceCommit,
        sourceTree: TEST_OPENCODE_IDENTITIES.releaseSourceTree,
        artifactTree: '1111111111111111111111111111111111111111',
        baseCommit: TEST_OPENCODE_IDENTITIES.releaseBaseCommit,
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
            ? TEST_OPENCODE_IDENTITIES.linuxX64ArchiveSha256
            : digest(`archive:${os}:${arch}`),
        archiveSize: 10,
        binaryPath: `opencode-${os}-${arch}/opencode`,
        binarySha256:
          os === 'linux' && arch === 'x64'
            ? TEST_OPENCODE_IDENTITIES.linuxX64BinarySha256
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
      verifyReleaseManifest(Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`), descriptor)
    ).not.toThrow();
    manifest.assets[0].binarySha256 = digest('wrong-linux-binary');
    expect(() => verifyReleaseManifest(Buffer.from(JSON.stringify(manifest)), descriptor)).toThrow(
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
  it('pins the accepted P3.B2 entry, supervisor, closure, recipe argv, and candidate digest', () => {
    const descriptor = parseIntegrationDescriptor(Buffer.from(canonicalJson(validDescriptor())));
    const recipe = {
      schemaVersion: 1,
      purpose: 'agent-teams.p3b2.built-actual-owner-entry/v1',
      sourceBaseCommit: descriptor.p3b2.sourceBaseCommit,
      resultCommit: descriptor.p3b2.resultCommit,
      entry: {
        relativePath: descriptor.p3b2.entry.relativePath,
        sha256: descriptor.p3b2.entry.sha256,
      },
      supervisor: {
        relativePath: descriptor.p3b2.supervisor.relativePath,
        sha256: descriptor.p3b2.supervisor.sha256,
      },
      closureMerkleRoot: descriptor.p3b2.closure.merkleRoot,
      candidateOpenCodeSha256: TEST_OPENCODE_IDENTITIES.linuxX64BinarySha256,
      argv: ['--runtime-manifest', '/sandbox/runtime-manifest.json'],
      sourceTreeRequired: false,
      accepted: true,
    };
    expect(() => verifyP3B2Recipe(Buffer.from(canonicalJson(recipe)), descriptor)).not.toThrow();
    expect(() =>
      verifyP3B2Recipe(
        Buffer.from(canonicalJson({ ...recipe, candidateOpenCodeSha256: '9'.repeat(64) })),
        descriptor
      )
    ).toThrow('p3c_p3b2_recipe_binding');
  });

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
    const fixture = signedControlFixture();
    const descriptor = fixture.descriptor;
    const admission = {
      descriptor,
      producerCandidate: {
        binding: fixture.producerCandidate.binding,
        payload: fixture.producerCandidate.parsedPayload,
      },
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
  const candidate = signedControlFixture().producerCandidate;
  const producer = (role: 'browser' | 'opencode' | 'owner' | 'product-producer') =>
    candidate.parsedPayload.producers.find((identity) => identity.role === role)!;
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
    runtimeManifest: {
      schemaVersion: 1,
      purpose: 'agent-teams.hosted-actual-owner-e2e/v1',
      runId: digest('process-run'),
      sandboxRoot: '/sandbox',
      markerPath: '/sandbox/.p3c-sandbox.json',
      evidenceRoot: '/sandbox/evidence',
      driverBaseUrl: 'http://127.0.0.1:45130/',
      productBaseUrl: 'http://127.0.0.1:45131/',
      approvalPath: '/api/hosted/v1/team-approvals/decisions',
      browser: { workers: 1, retries: 0 },
      capture: {
        conditionalPostLedgerPath: '/sandbox/capture/conditionalPostLedgerPath.ndjson',
        negativeResultsPath: '/sandbox/capture/negativeResultsPath.ndjson',
        openCodeTimelinePath: '/sandbox/capture/openCodeTimelinePath.ndjson',
        ownerWalTimelinePath: '/sandbox/capture/ownerWalTimelinePath.ndjson',
        productTimelinePath: '/sandbox/capture/productTimelinePath.ndjson',
        protectedEffectLedgerPath: '/sandbox/capture/protectedEffectLedgerPath.ndjson',
      },
      captureEmissionContract: {
        contract: PRODUCER_PROVENANCE_CONTRACT.contract,
        version: PRODUCER_PROVENANCE_CONTRACT.version,
        contractSha256: PRODUCER_PROVENANCE_CONTRACT_SHA256,
        environment: PRODUCER_PROVENANCE_CONTRACT.environment,
        framing: PRODUCER_PROVENANCE_CONTRACT.framing,
        descriptorSlots: PRODUCER_PROVENANCE_CONTRACT.descriptorSlots,
        verifierMayProduceBytes: false,
        producerNativeIdentitiesComposed: true,
        captureAuthority: 'verified-signed-four-producer-candidate',
        producerCandidate: candidate.binding,
        captureMappings: RUNTIME_CAPTURE_PRODUCER_MAPPINGS,
      },
      refs: {
        openCode: producer('opencode').sourceCommit,
        openCodeExecutableSha256: producer('opencode').executableSha256,
        orchestrator: producer('owner').sourceCommit,
        product: producer('browser').sourceCommit,
      },
    },
    ownerChildProtocol: {
      wrapperArgv: ['--runtime-manifest', '/sandbox/runtime-manifest.json'],
      sealedArgv: [
        '--hosted-actual-owner-sealed-protocol=v1',
        '--runtime-manifest',
        '/sandbox/runtime-manifest.json',
      ],
      childLocalDescriptors: { sealedLauncherLease: 3, bootstrap: 4, activationV2: 5 },
      descriptorContract: OWNER_CHILD_PROTOCOL,
      parentSourceDescriptors: 'arbitrary-distinct-owned',
      closeParentCopiesAfterSpawn: true,
      compatibilityProbing: false,
      socketPathReconnect: false,
    },
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
    expectedProducerArtifactSha256: {
      owner: producer('owner').artifactManifestSha256,
      opencode: producer('opencode').artifactManifestSha256,
      product: producer('product-producer').artifactManifestSha256,
      browser: producer('browser').artifactManifestSha256,
    },
    expectedProducerModuleSha256: {
      owner: producer('owner').moduleSha256,
      opencode: producer('opencode').moduleSha256,
      product: producer('product-producer').moduleSha256,
      browser: producer('browser').moduleSha256,
    },
    expectedArgv: {
      supervisor: [],
      opencode: ['serve', '--hostname', '127.0.0.1', '--port', '4096'],
      owner: ['--runtime-manifest', '/sandbox/runtime-manifest.json'],
      product: [],
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

describe('signed producer runtime manifest', () => {
  it('requires the exact frozen candidate, capture mappings, and source/hash refs', () => {
    const plan = supervisorPlan();
    const manifest = plan.runtimeManifest;
    const candidate = manifest.captureEmissionContract.producerCandidate;
    expect(parseActualOwnerRuntimeManifest(manifest, candidate).captureEmissionContract).toEqual(
      manifest.captureEmissionContract
    );

    const changedRef = structuredClone(manifest);
    (changedRef.refs as unknown as Record<string, unknown>).openCode = 'f'.repeat(40);
    expect(() => parseActualOwnerRuntimeManifest(changedRef, candidate)).toThrow(
      'p3c_runtime_refs_invalid'
    );

    const changedCandidate = structuredClone(manifest);
    const embeddedCandidate = changedCandidate.captureEmissionContract
      .producerCandidate as unknown as Record<string, unknown>;
    embeddedCandidate.payloadSha256 = digest('runtime-candidate-substitution');
    expect(() => parseActualOwnerRuntimeManifest(changedCandidate, candidate)).toThrow(
      'p3c_runtime_capture_emission_contract'
    );

    const changedMappings = structuredClone(manifest);
    const mappings = changedMappings.captureEmissionContract.captureMappings as unknown as Record<
      string,
      Record<string, unknown>
    >;
    mappings.ownerWalTimelinePath.role = 'opencode';
    expect(() => parseActualOwnerRuntimeManifest(changedMappings, candidate)).toThrow(
      'p3c_runtime_capture_emission_contract'
    );
  });
});

function supervisorTranscript(
  plan: SupervisorPlan,
  firstOwnerObservation?: Readonly<{
    readonly pid: number;
    readonly startToken: string;
    readonly lifecycle: ReturnType<typeof observeParentDescriptorsClosed>;
    readonly childPublication: ReturnType<typeof acceptCanonicalChildDescriptorPublication>;
  }>
): Buffer {
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
      pid:
        expected.role === 'owner' &&
        expected.generation === 1 &&
        firstOwnerObservation !== undefined
          ? firstOwnerObservation.pid
          : 1000 + index,
      pidfdInode: String(2000 + index),
      startTime: String(3000 + index),
      observedMonotonicNs: String(20 + lines.length),
      startToken:
        expected.role === 'owner' &&
        expected.generation === 1 &&
        firstOwnerObservation !== undefined
          ? firstOwnerObservation.startToken
          : digest(`start:${expected.instanceId}`),
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
    ownerChildDescriptorCleanup: {
      schemaVersion: 2,
      contract: 'agent-teams.hosted-owner-child-parent-fd-cleanup/v2',
      records: starts
        .filter(({ role }) => role === 'owner')
        .map(({ pid, startToken }, ownerIndex) => {
          if (ownerIndex === 0 && firstOwnerObservation !== undefined) {
            return {
              ...firstOwnerObservation.lifecycle,
              childPublication: firstOwnerObservation.childPublication,
            };
          }
          const descriptors = PARENT_DESCRIPTOR_ROLES.map((role, descriptorIndex) => {
            const parentFd = 30 + ownerIndex * 3 + descriptorIndex;
            return {
              role,
              parentFd,
              beforeSpawn: {
                method: 'proc-fd-identity' as const,
                observedMonotonicNs: String(49_000 + ownerIndex * 100 + descriptorIndex),
                path: `/proc/${pid}/fd/${parentFd}`,
                device: String(20_000 + ownerIndex),
                inode: String(21_000 + descriptorIndex),
                mode: 0o600,
              },
              afterSpawn: {
                method: 'fstat-ebadf' as const,
                observedMonotonicNs: String(51_000 + ownerIndex * 100 + descriptorIndex),
                errno: 'EBADF' as const,
              },
            };
          });
          return {
            wrapperPid: pid,
            wrapperStartToken: startToken,
            spawnNonce: digest(`spawn-nonce:${startToken}`),
            spawnBoundaryMonotonicNs: String(50_000 + ownerIndex * 100),
            childPublication: {
              schemaVersion: 1,
              contract: 'agent-teams.hosted-owner-child-fd-map/v1',
              wrapperPid: pid,
              wrapperStartToken: startToken,
              spawnNonce: digest(`spawn-nonce:${startToken}`),
              descriptors: descriptors.map(({ role, beforeSpawn }, descriptorIndex) => ({
                role,
                childFd: descriptorIndex + 3,
                device: beforeSpawn.device,
                inode: beforeSpawn.inode,
                mode: beforeSpawn.mode,
              })),
            },
            descriptors,
          };
        }),
    },
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
    captureFiles: Object.fromEntries(
      RUNTIME_CAPTURE_NAMES.map((name, index) => {
        const roles = {
          conditionalPostLedgerPath: 'product',
          negativeResultsPath: 'browser',
          openCodeTimelinePath: 'opencode',
          ownerWalTimelinePath: 'owner',
          productTimelinePath: 'product',
          protectedEffectLedgerPath: 'opencode',
        } as const;
        const slots = {
          conditionalPostLedgerPath: 9,
          negativeResultsPath: 9,
          openCodeTimelinePath: 9,
          ownerWalTimelinePath: 9,
          productTimelinePath: 10,
          protectedEffectLedgerPath: 10,
        } as const;
        const producers = starts.filter(({ role }) => role === roles[name]);
        const shards = producers.map((producer, shardIndex) => {
          const captureDevice = String(10_000 + index * 10 + shardIndex);
          const captureInode = String(11_000 + index * 10 + shardIndex);
          const captureSha256 = digest(`non-authoritative-capture:${name}:${shardIndex}`);
          const path =
            name === 'ownerWalTimelinePath'
              ? plan.runtimeManifest.capture[name].replace(
                  /\.ndjson$/u,
                  `.${producer.instanceId}.ndjson`
                )
              : plan.runtimeManifest.capture[name];
          const exit = exits.find(
            ({ startToken, pidfdInode }) =>
              startToken === producer.startToken && pidfdInode === producer.pidfdInode
          )!;
          const common = {
            path,
            stream: RUNTIME_CAPTURE_STREAMS[name],
            contractSha256: PRODUCER_PROVENANCE_CONTRACT_SHA256,
            captureDevice,
            captureInode,
            size: 2,
            sha256: captureSha256,
            producerPid: producer.pid,
            producerStartToken: producer.startToken,
            producerPidfdInode: producer.pidfdInode,
            producerRole: roles[name],
            producerFd: slots[name],
            producerArtifactSha256: plan.expectedProducerArtifactSha256[roles[name]],
            producerModuleSha256: plan.expectedProducerModuleSha256[roles[name]],
          };
          return {
            authority: 'kernel-observed',
            ...common,
            allocation: {
              observationMethod: 'openat-exclusive-no-follow',
              flags: 'O_CREAT|O_EXCL|O_NOFOLLOW|O_WRONLY|O_APPEND|O_CLOEXEC',
              mode: 0o600,
              nlink: 1,
              initialSize: 0,
              captureDevice,
              captureInode,
            },
            parentClose: {
              supervisorPid: 900,
              supervisorStartToken: digest('start:supervisor'),
              writerFd: 70 + index * 8 + shardIndex,
              descriptorPath: `/proc/900/fd/${70 + index * 8 + shardIndex}`,
              captureDevice,
              captureInode,
              observedOpenMonotonicNs: '11',
              spawnBoundaryMonotonicNs: '12',
              observedClosedMonotonicNs: '13',
              closeObservationMethod: 'fstat-ebadf',
              closedErrno: 'EBADF',
            },
            producerOpen: {
              descriptorPath: `/proc/${producer.pid}/fd/${slots[name]}`,
              captureDevice,
              captureInode,
              observationMethod: 'proc-fd-identity',
              observedMonotonicNs: '14',
            },
            producerClose: {
              observationMethod: 'pidfd-exact-exit',
              observedMonotonicNs: exit.observedMonotonicNs,
              descriptorPath: `/proc/${producer.pid}/fd/${slots[name]}`,
              producerStartToken: producer.startToken,
              producerPidfdInode: producer.pidfdInode,
            },
            descendantCensus: {
              observationMethod: 'proc-fd-inode-census',
              observedMonotonicNs: '2000',
              processEvidenceSetId,
              inspectedStartTokens: [...starts, ...descendants]
                .map(({ startToken }) => startToken)
                .sort(),
              retainedWriterCount: 0,
            },
            seal: {
              observationMethod: 'read-only-stable-hash',
              observedMonotonicNs: '2001',
              captureDevice,
              captureInode,
              mode: 0o400,
              nlink: 1,
              size: 2,
              sha256: captureSha256,
              manifestSha256: producerCaptureSealManifestSha256(common),
            },
          };
        });
        return [
          name,
          {
            stream: RUNTIME_CAPTURE_STREAMS[name],
            contractSha256: PRODUCER_PROVENANCE_CONTRACT_SHA256,
            shards,
          },
        ];
      })
    ),
  });
  return Buffer.from(`${lines.map(canonicalJson).join('\n')}\n`);
}

const descriptorProbeSource = (
  publication: 'valid' | 'partial' | 'malformed' | 'timeout',
  exitCode: number,
  binding: Readonly<{ wrapperPid: number; wrapperStartToken: string; spawnNonce: string }>
) => `
const { fstatSync } = require('node:fs');
const roles = ['sealed-launcher-lease', 'bootstrap', 'activation-v2'];
const descriptors = roles.map((role, index) => {
  const stat = fstatSync(index + 3, { bigint: true });
  return { role, childFd: index + 3, device: String(stat.dev), inode: String(stat.ino), mode: Number(stat.mode & 4095n) };
});
const publication = ${JSON.stringify(publication)};
const binding = ${JSON.stringify(binding)};
const validPublication = JSON.stringify({ schemaVersion: 1, contract: 'agent-teams.hosted-owner-child-fd-map/v1', ...binding, descriptors }) + '\\n';
if (publication === 'valid') process.stdout.write(validPublication);
if (publication === 'timeout') process.stdout.write(validPublication, () => process.stderr.write('descriptor-ready\\n'));
if (publication === 'partial') process.stdout.write(JSON.stringify({ schemaVersion: 1, contract: 'agent-teams.hosted-owner-child-fd-map/v1', ...binding, descriptors: descriptors.slice(0, 1) }) + '\\n');
if (publication === 'malformed') process.stdout.write('{not-json}\\n');
if (publication === 'timeout') setInterval(() => {}, 1000);
else process.exit(${exitCode});
`;

async function spawnRealCanonicalDescriptorProbe(options: {
  readonly publication?: 'valid' | 'partial' | 'malformed' | 'timeout';
  readonly exitCode?: number;
  readonly executable?: string;
}) {
  const root = await mkdtemp(join(tmpdir(), 'hosted-owner-child-fd-'));
  const paths = [join(root, 'lease'), join(root, 'bootstrap'), join(root, 'activation')];
  const fds: number[] = [];
  let child: ReturnType<typeof spawnChild> | null = null;
  try {
    await Promise.all(paths.map((path, index) => writeFile(path, `descriptor-${index}`)));
    for (const path of paths) fds.push(openSync(path, constants.O_RDONLY));
    const before = observeCurrentWrapperDescriptorsBeforeSpawn(fds);
    child = spawnChild(
      options.executable ?? process.execPath,
      [
        '--eval',
        descriptorProbeSource(options.publication ?? 'valid', options.exitCode ?? 0, before),
      ],
      { stdio: ['ignore', 'pipe', 'pipe', ...fds] }
    );
    const spawnBoundaryMonotonicNs = process.hrtime.bigint().toString();
    for (const fd of fds.splice(0)) closeSync(fd);
    const record = observeParentDescriptorsClosed(before, spawnBoundaryMonotonicNs);
    if (options.publication === 'timeout') {
      const fallback = setTimeout(() => child?.kill('SIGKILL'), 2_000);
      child.stderr?.once('data', () => {
        clearTimeout(fallback);
        child?.kill('SIGKILL');
      });
    }
    const stdout = collectBoundedStream(child.stdout, 16 * 1024);
    const stderr = collectBoundedStream(child.stderr, 16 * 1024);
    const [close, stdoutBytes, stderrBytes] = await Promise.all([
      once(child, 'close') as Promise<[number | null, NodeJS.Signals | null]>,
      stdout,
      stderr,
    ]);
    return Object.freeze({ before, record, close, stdoutBytes, stderrBytes });
  } finally {
    for (const fd of fds) closeSync(fd);
    child?.kill('SIGKILL');
    await rm(root, { recursive: true, force: true });
  }
}

function acceptRealDescriptorCleanup(
  record: ReturnType<typeof observeParentDescriptorsClosed>,
  childPublication: ReturnType<typeof acceptCanonicalChildDescriptorPublication>
) {
  return parseOwnerChildDescriptorCleanup(
    {
      schemaVersion: 2,
      contract: 'agent-teams.hosted-owner-child-parent-fd-cleanup/v2',
      records: [{ ...record, childPublication }],
    },
    [{ role: 'owner', pid: record.wrapperPid, startToken: record.wrapperStartToken }]
  );
}

describe('process ownership transcript', () => {
  it('rejects a descriptor that reuses any historical OpenCode artifact digest', () => {
    const descriptor = structuredClone(validDescriptor()) as ReturnType<typeof validDescriptor>;
    const openCode = descriptor.openCode as Record<string, unknown>;
    const identities = openCode.identities as Record<string, unknown>;
    identities.linuxX64BinarySha256 =
      REJECTED_HISTORICAL_OPENCODE_IDENTITIES.linuxX64BinarySha256;
    (openCode.linuxX64Binary as Record<string, unknown>).sha256 =
      REJECTED_HISTORICAL_OPENCODE_IDENTITIES.linuxX64BinarySha256;
    expect(() => parseIntegrationDescriptor(Buffer.from(canonicalJson(descriptor)))).toThrow(
      'p3c_rejected_historical_opencode_candidate'
    );
  });

  it('requires replacement owners, complete Chromium descendants, network isolation, and drain', () => {
    const plan = supervisorPlan();
    const transcript = supervisorTranscript(plan);
    const outcome = parseSupervisorTranscript(transcript, plan);
    expect(outcome).toMatchObject({ zeroOwnedSurvivors: true });
    expect(outcome.starts.filter(({ role }) => role === 'owner')).toHaveLength(4);
    expect(outcome.descendants.map(({ role }) => role)).toEqual(plan.chromiumDescendants);
    expect(outcome.network.namespaceInode).not.toBe(outcome.network.parentNamespaceInode);
    expect(outcome.ownerChildDescriptorCleanup.ownerStartTokens).toHaveLength(4);
    expect(outcome.captureFiles.ownerWalTimelinePath.shards).toHaveLength(4);
    expect(
      new Set(
        outcome.captureFiles.ownerWalTimelinePath.shards.map(
          ({ captureDevice, captureInode }) => `${captureDevice}:${captureInode}`
        )
      ).size
    ).toBe(4);
    for (const [needle, replacement] of [
      ['"producerPid":1000', '"producerPid":9999'],
      ['"producerFd":9', '"producerFd":8'],
      ['"captureInode":"11000"', '"captureInode":"99999"'],
      [
        `"producerArtifactSha256":"${plan.expectedProducerArtifactSha256.opencode}"`,
        `"producerArtifactSha256":"${digest('wrong-producer-artifact')}"`,
      ],
      ['"retainedWriterCount":0', '"retainedWriterCount":1'],
      ['"observationMethod":"pidfd-exact-exit"', '"observationMethod":"missing-close"'],
      ['"observationMethod":"read-only-stable-hash"', '"observationMethod":"unsealed"'],
    ] as const) {
      const adversarial = Buffer.from(transcript.toString('utf8').replace(needle, replacement));
      expect(() => parseSupervisorTranscript(adversarial, plan)).toThrow(/p3c_supervisor_capture/u);
    }
    const incompleteParentCleanup = Buffer.from(
      transcript.toString('utf8').replace('"errno":"EBADF"', '"errno":"EIO"')
    );
    expect(() => parseSupervisorTranscript(incompleteParentCleanup, plan)).toThrow(
      'p3c_supervisor_owner_child_descriptor_cleanup'
    );
    const temporallyInvalidParentCleanup = Buffer.from(
      transcript
        .toString('utf8')
        .replace('"spawnBoundaryMonotonicNs":"50000"', '"spawnBoundaryMonotonicNs":"48000"')
    );
    expect(() => parseSupervisorTranscript(temporallyInvalidParentCleanup, plan)).toThrow(
      'p3c_supervisor_owner_child_descriptor_cleanup'
    );
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

  it('accepts supervising-parent evidence from a real FD3/FD4/FD5 child spawn', async () => {
    const probe = await spawnRealCanonicalDescriptorProbe({});
    expect(probe.close).toEqual([0, null]);
    const publication = JSON.parse(probe.stdoutBytes.toString('utf8')) as unknown;
    const childPublication = acceptCanonicalChildDescriptorPublication(publication, probe.before);
    const accepted = acceptRealDescriptorCleanup(probe.record, childPublication);
    expect(accepted.records).toEqual([{ ...probe.record, childPublication }]);
    expect(probe.record.wrapperPid).toBe(process.pid);
    expect(probe.record.wrapperStartToken).toBe(
      readCurrentWrapperProcessStartIdentity().startToken
    );
  });

  it('accepts real child publication only through the final supervisor parser', async () => {
    const probe = await spawnRealCanonicalDescriptorProbe({});
    const childPublication = acceptCanonicalChildDescriptorPublication(
      JSON.parse(probe.stdoutBytes.toString('utf8')) as unknown,
      probe.before
    );
    const plan = supervisorPlan();
    const outcome = parseSupervisorTranscript(
      supervisorTranscript(plan, {
        pid: probe.record.wrapperPid,
        startToken: probe.record.wrapperStartToken,
        lifecycle: probe.record,
        childPublication,
      }),
      plan
    );
    expect(outcome.ownerChildDescriptorCleanup.records[0]).toEqual({
      ...probe.record,
      childPublication,
    });
  });

  it.each(['missing', 'malformed', 'reordered', 'identity-drifted', 'detached'] as const)(
    'rejects %s child publication in final supervisor acceptance',
    (mutation) => {
      const plan = supervisorPlan();
      const documents = supervisorTranscript(plan)
        .toString('utf8')
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const result = documents.at(-1)!;
      const cleanup = result.ownerChildDescriptorCleanup as {
        records: Array<Record<string, unknown>>;
      };
      const record = cleanup.records[0]!;
      const publication = record.childPublication as {
        wrapperPid: number;
        wrapperStartToken: string;
        spawnNonce: string;
        descriptors: Array<Record<string, unknown>>;
      };
      if (mutation === 'missing') delete record.childPublication;
      else if (mutation === 'malformed') publication.descriptors.length = 1;
      else if (mutation === 'reordered') publication.descriptors.reverse();
      else if (mutation === 'identity-drifted') publication.descriptors[0]!.inode = '999999';
      else {
        const detached = cleanup.records[1]!.childPublication as {
          wrapperPid: number;
          wrapperStartToken: string;
          spawnNonce: string;
        };
        record.childPublication = {
          ...publication,
          wrapperPid: detached.wrapperPid,
          wrapperStartToken: detached.wrapperStartToken,
          spawnNonce: detached.spawnNonce,
        };
        expect((record.childPublication as typeof publication).descriptors).toEqual(
          publication.descriptors
        );
      }
      expect(() =>
        parseSupervisorTranscript(Buffer.from(`${documents.map(canonicalJson).join('\n')}\n`), plan)
      ).toThrow(/p3c_(?:supervisor_owner_child_descriptor_cleanup|child_descriptor_publication)/u);
    }
  );

  it.each([
    ['partial publication', 'partial', 0],
    ['malformed publication', 'malformed', 0],
    ['child exit', 'valid', 7],
  ] as const)('requires canonical publication across %s', async (_label, publication, exitCode) => {
    const probe = await spawnRealCanonicalDescriptorProbe({ publication, exitCode });
    if (publication === 'valid') {
      expect(probe.close).toEqual([exitCode, null]);
      const childPublication = acceptCanonicalChildDescriptorPublication(
        JSON.parse(probe.stdoutBytes.toString('utf8')) as unknown,
        probe.before
      );
      expect(() => acceptRealDescriptorCleanup(probe.record, childPublication)).not.toThrow();
    } else {
      expect(() => {
        const value = JSON.parse(probe.stdoutBytes.toString('utf8')) as unknown;
        acceptCanonicalChildDescriptorPublication(value, probe.before);
      }).toThrow();
    }
  });

  it('retains authoritative cleanup when the child times out', async () => {
    const probe = await spawnRealCanonicalDescriptorProbe({ publication: 'timeout' });
    expect(probe.close).toEqual([null, 'SIGKILL']);
    const childPublication = acceptCanonicalChildDescriptorPublication(
      JSON.parse(probe.stdoutBytes.toString('utf8')) as unknown,
      probe.before
    );
    expect(() => acceptRealDescriptorCleanup(probe.record, childPublication)).not.toThrow();
  });

  it('retains authoritative cleanup when the child spawn fails', async () => {
    const fds = [
      openSync('/dev/null', constants.O_RDONLY),
      openSync('/dev/null', constants.O_RDONLY),
      openSync('/dev/null', constants.O_RDONLY),
    ];
    const before = observeCurrentWrapperDescriptorsBeforeSpawn(fds);
    const child = spawnChild('/definitely/missing/hosted-owner-child', [], {
      stdio: ['ignore', 'ignore', 'ignore', ...fds],
    });
    const spawnBoundaryMonotonicNs = process.hrtime.bigint().toString();
    for (const fd of fds) closeSync(fd);
    const record = observeParentDescriptorsClosed(before, spawnBoundaryMonotonicNs);
    const [error] = (await once(child, 'error')) as [NodeJS.ErrnoException];
    expect(error.code).toBe('ENOENT');
    expect(record.descriptors).toHaveLength(3);
  });

  it('retains authoritative cleanup through rollback and repeated cleanup', async () => {
    const probe = await spawnRealCanonicalDescriptorProbe({});
    const childPublication = acceptCanonicalChildDescriptorPublication(
      JSON.parse(probe.stdoutBytes.toString('utf8')) as unknown,
      probe.before
    );
    expect(() => {
      try {
        throw new Error('simulated-activation-rollback');
      } finally {
        acceptRealDescriptorCleanup(probe.record, childPublication);
      }
    }).toThrow('simulated-activation-rollback');
    expect(observeParentDescriptorsClosed(probe.before)).toEqual(
      expect.objectContaining({ wrapperStartToken: probe.record.wrapperStartToken })
    );
  });

  it('fails closed on missing proc descriptor identity', () => {
    const fds = [
      openSync('/dev/null', constants.O_RDONLY),
      openSync('/dev/null', constants.O_RDONLY),
      openSync('/dev/null', constants.O_RDONLY),
    ];
    try {
      const wrapper = readCurrentWrapperProcessStartIdentity();
      expect(() =>
        observeParentDescriptorsBeforeSpawn(wrapper.pid, wrapper.startToken, fds, {
          statProcDescriptor: () => {
            const error = new Error('missing proc') as NodeJS.ErrnoException;
            error.code = 'ENOENT';
            throw error;
          },
        })
      ).toThrow('missing proc');
    } finally {
      for (const fd of fds) closeSync(fd);
    }
  });

  it('rejects descriptor reuse after the parent close boundary', () => {
    const fds = [
      openSync('/dev/null', constants.O_RDONLY),
      openSync('/dev/null', constants.O_RDONLY),
      openSync('/dev/null', constants.O_RDONLY),
    ];
    const wrapper = readCurrentWrapperProcessStartIdentity();
    const before = observeParentDescriptorsBeforeSpawn(wrapper.pid, wrapper.startToken, fds);
    const reusedFd = fds[0]!;
    closeSync(reusedFd);
    const replacement = openSync('/dev/null', constants.O_RDONLY);
    try {
      expect(replacement).toBe(reusedFd);
      closeSync(fds[1]!);
      closeSync(fds[2]!);
      expect(() => observeParentDescriptorsClosed(before)).toThrow('p3c_parent_fd_copy_still_open');
    } finally {
      closeSync(replacement);
    }
  });

  it.each(['wrapper-replacement', 'reordered', 'duplicated', 'detached'] as const)(
    'rejects %s lifecycle evidence after a real spawn',
    async (mutation) => {
      const probe = await spawnRealCanonicalDescriptorProbe({});
      const childPublication = acceptCanonicalChildDescriptorPublication(
        JSON.parse(probe.stdoutBytes.toString('utf8')) as unknown,
        probe.before
      );
      const cleanup = {
        schemaVersion: 2,
        contract: 'agent-teams.hosted-owner-child-parent-fd-cleanup/v2',
        records: [{ ...probe.record, childPublication }],
      };
      const starts = [
        {
          role: 'owner' as const,
          pid: probe.record.wrapperPid,
          startToken: probe.record.wrapperStartToken,
        },
      ];
      if (mutation === 'wrapper-replacement') starts[0] = { ...starts[0]!, pid: process.pid + 1 };
      if (mutation === 'reordered') {
        cleanup.records = [
          {
            ...probe.record,
            childPublication,
            descriptors: [...probe.record.descriptors].reverse(),
          },
        ];
      }
      if (mutation === 'duplicated') {
        cleanup.records = [
          { ...probe.record, childPublication },
          { ...probe.record, childPublication },
        ];
      }
      if (mutation === 'detached') starts[0] = { ...starts[0]!, startToken: sha256('detached') };
      expect(() => parseOwnerChildDescriptorCleanup(cleanup, starts)).toThrow(
        'p3c_supervisor_owner_child_descriptor_cleanup'
      );
    }
  );

  it('fails closed while any exact parent descriptor remains open', () => {
    const fds = [
      openSync('/dev/null', constants.O_RDONLY),
      openSync('/dev/null', constants.O_RDONLY),
      openSync('/dev/null', constants.O_RDONLY),
    ];
    try {
      const before = observeParentDescriptorsBeforeSpawn(
        process.pid,
        sha256('wrapper:still-open'),
        fds
      );
      closeSync(fds[0]!);
      closeSync(fds[1]!);
      expect(() => observeParentDescriptorsClosed(before)).toThrow('p3c_parent_fd_copy_still_open');
    } finally {
      for (const fd of fds) {
        try {
          closeSync(fd);
        } catch {
          // Expected for descriptors already closed above.
        }
      }
    }
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
      expect(censuses).toBeGreaterThanOrEqual(3);
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
  captures: Readonly<Record<RuntimeCaptureName, readonly Buffer[]>>;
  outcome: SupervisorOutcome;
  controllerNonce: string;
  nonAuthoritative: true;
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
      const monotonicNs = String(globalMonotonicSequence * 1000);
      const payload = makeSemanticPayload({
        origin,
        row,
        event,
        identity,
        providerEffectId,
        ...observedBodies,
        effectSetSha256s: /^effect_total_(?:two|three)$/u.test(event)
          ? [...observedProviderEffectSha256s]
          : undefined,
        processEvidenceSetId: origin === 'supervisor' ? digest('process-evidence-set') : undefined,
        observedBrowserStatus:
          origin === 'browser' && row === '08_cross_team_isolation' ? 403 : undefined,
      });
      const rawRecord = makeRawRecord({
        controllerNonce,
        origin,
        row,
        sequence: sequence[origin],
        monotonicNs,
        processStartToken: starts[role],
        event,
        correlation,
        effectCount,
        payload,
      });
      byOrigin[origin].push(rawRecord);
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
  const captures = Object.freeze(
    Object.fromEntries(
      RUNTIME_CAPTURE_NAMES.map((name) => [name, Object.freeze([Buffer.from('{}\n')])])
    ) as Record<RuntimeCaptureName, readonly Buffer[]>
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
    ownerChildDescriptorCleanup: {
      contract: 'agent-teams.hosted-owner-child-parent-fd-cleanup/v2',
      ownerStartTokens: processStarts
        .filter(({ role }) => role === 'owner')
        .map(({ startToken }) => startToken),
      records: processStarts
        .filter(({ role }) => role === 'owner')
        .map(({ pid, startToken }, ownerIndex) => {
          const descriptors = PARENT_DESCRIPTOR_ROLES.map((role, descriptorIndex) => ({
            role,
            parentFd: 30 + ownerIndex * 3 + descriptorIndex,
            beforeSpawn: {
              method: 'proc-fd-identity' as const,
              observedMonotonicNs: String(49_000 + ownerIndex * 100 + descriptorIndex),
              path: `/proc/${pid}/fd/${30 + ownerIndex * 3 + descriptorIndex}`,
              device: String(20_000 + ownerIndex),
              inode: String(21_000 + descriptorIndex),
              mode: 0o600,
            },
            afterSpawn: {
              method: 'fstat-ebadf' as const,
              observedMonotonicNs: String(51_000 + ownerIndex * 100 + descriptorIndex),
              errno: 'EBADF' as const,
            },
          }));
          return {
            wrapperPid: pid,
            wrapperStartToken: startToken,
            spawnNonce: digest(`spawn-nonce:${startToken}`),
            spawnBoundaryMonotonicNs: String(50_000 + ownerIndex * 100),
            childPublication: {
              schemaVersion: 1 as const,
              contract: 'agent-teams.hosted-owner-child-fd-map/v1' as const,
              wrapperPid: pid,
              wrapperStartToken: startToken,
              spawnNonce: digest(`spawn-nonce:${startToken}`),
              descriptors: descriptors.map(({ role, beforeSpawn }, descriptorIndex) => ({
                role,
                childFd: (descriptorIndex + 3) as 3 | 4 | 5,
                device: beforeSpawn.device,
                inode: beforeSpawn.inode,
                mode: beforeSpawn.mode,
              })),
            },
            descriptors,
          };
        }),
    },
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
    captureFiles: Object.fromEntries(
      RUNTIME_CAPTURE_NAMES.map((name) => [name, {
        stream: RUNTIME_CAPTURE_STREAMS[name],
        contractSha256: PRODUCER_PROVENANCE_CONTRACT_SHA256,
        shards: [],
      }])
    ) as unknown as SupervisorOutcome['captureFiles'],
    transcriptSha256: digest('transcript'),
    transcript: Buffer.from('deterministic-supervisor-transcript'),
  };
  return {
    raw: Object.freeze(raw),
    captures: Object.freeze(captures),
    outcome,
    controllerNonce,
    nonAuthoritative: true,
  };
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

function nativeCrossJoinFixture(name: 'productTimelinePath' | 'ownerWalTimelinePath') {
  const fixture = rawEvidence();
  const origins =
    name === 'productTimelinePath'
      ? (['product-http', 'product-sse'] as const)
      : (['owner-wal'] as const);
  const role = name === 'productTimelinePath' ? 'product' : 'owner';
  const candidates = origins
    .flatMap((origin) =>
      fixture.raw[origin]
        .toString('utf8')
        .trimEnd()
        .split('\n')
        .map((line) => {
          const raw = JSON.parse(line) as Record<string, unknown>;
          const payload = JSON.parse(
            Buffer.from(raw.payloadBase64 as string, 'base64').toString('utf8')
          ) as Record<string, unknown>;
          const semanticRecord = JSON.parse(
            Buffer.from(payload.recordBase64 as string, 'base64').toString('utf8')
          ) as Record<string, unknown>;
          return { origin, raw, semanticRecord };
        })
    )
    .sort((left, right) =>
      BigInt(left.raw.monotonicNs as string) < BigInt(right.raw.monotonicNs as string) ? -1 : 1
    );
  // This golden isolates the ordered restart chain. The broad rawEvidence fixture reuses the
  // initial owner across independent matrix rows, so it is not an all-generations capture proof.
  const producers = fixture.outcome.starts.filter(
    (start) =>
      start.role === role &&
      (name !== 'ownerWalTimelinePath' || start.generation > 1)
  );
  const parsedShards = producers.map((producer, shardIndex) => {
    const semanticRecords = candidates
      .filter(({ raw }) => raw.processStartToken === producer.startToken)
      .map(({ origin, semanticRecord }, recordIndex) => {
        const transport = semanticRecord.transport as Record<string, unknown>;
        const retained = (value: unknown) => {
          const structure = value as Record<string, unknown>;
          const bytes = Buffer.from(structure.bodyBase64 as string, 'base64');
          return { bytes, sha256: structure.sha256 as string };
        };
        const native = (() => {
          if (name === 'ownerWalTimelinePath') {
            const record = retained(transport.record);
            return { wal: { byteSize: record.bytes.length, sha256: record.sha256 } };
          }
          if (origin === 'product-sse') {
            const data = retained(transport.data);
            const frame = `id: ${String(transport.eventId)}\nevent: ${String(transport.eventType)}\ndata: ${data.bytes.toString('utf8')}\n\n`;
            return {
              eventId: transport.eventId,
              eventType: transport.eventType,
              frameBytes: Buffer.byteLength(frame),
              frameKind: 'coordination_event',
              frameSha256: sha256(frame),
            };
          }
          const request = retained(transport.request);
          const response = retained(transport.response);
          const routeIds: Readonly<Record<string, string>> = Object.freeze({
            page: 'team-approvals.page.v1',
            preview: 'team-approvals.preview.v1',
            decisions: 'team-approvals.decision.v1',
          });
          return {
            method: transport.method,
            requestBodyBytes: request.bytes.length,
            requestBodySha256: request.sha256,
            responseBodyBytes: response.bytes.length,
            responseBodySha256: response.sha256,
            routeId: routeIds[transport.endpointFamily as string],
            status: transport.status,
          };
        })();
        return {
        stream: RUNTIME_CAPTURE_STREAMS[name],
        recordType:
          name === 'productTimelinePath'
            ? origin === 'product-sse'
              ? 'coordination-sse-write-succeeded'
              : 'approval-http-response-finalized'
            : 'owner-wal-published',
        sequence: recordIndex + 1,
        previousRecordSha256: digest(`cross-join-previous:${shardIndex}:${recordIndex}`),
        emissionNonce: digest(`cross-join-nonce:${shardIndex}:${recordIndex}`),
        producer: {},
        activation: { controllerNonce: fixture.controllerNonce, runId: fixture.outcome.runId },
        native,
        lineSha256: digest(`cross-join-line:${shardIndex}:${recordIndex}`),
        };
      });
    return {
      producerRole: role,
      semanticRecordCount: semanticRecords.length,
      records: [
        {
          native: {},
        },
        ...semanticRecords,
        {
          native: {},
        },
      ],
      finalLineSha256: digest(`cross-join-final:${shardIndex}`),
    };
  }) as unknown as Parameters<typeof assertNativeSemanticCrossJoin>[1];
  const expected = {
    shards: producers.map(({ startToken }) => ({ producerStartToken: startToken })),
  } as unknown as Parameters<typeof assertNativeSemanticCrossJoin>[4];
  return { fixture, parsedShards, expected };
}

describe('nonAuthoritative native capture parser goldens', () => {
  const controllerNonce = digest('native-parser-controller');
  const runId = digest('native-parser-run');
  const producer = Object.freeze({
    role: 'product-producer',
    pid: 4321,
    startTicks: '991',
    exeDev: '8',
    exeIno: '42',
    exeSha256: digest('native-parser-exe'),
    artifactManifestSha256: digest('native-parser-artifact'),
    implementationId: 'agent-teams.product.hosted-approval.v1',
    moduleSha256: digest('native-parser-module'),
  });
  const activation = Object.freeze({
    controllerNonce,
    runId,
    stackManifestSha256: digest('native-parser-stack-manifest'),
  });
  const open = Object.freeze({
    activation,
    contract: PRODUCER_PROVENANCE_CONTRACT.contract,
    version: PRODUCER_PROVENANCE_CONTRACT.version,
    contractSha256: PRODUCER_PROVENANCE_CONTRACT_SHA256,
    stream: RUNTIME_CAPTURE_STREAMS.productTimelinePath,
    recordType: 'producer-open',
    sequence: 0,
    previousRecordSha256: null,
    emissionNonce: digest('native-parser-open-nonce'),
    operationNonce: null,
    producer,
    native: { descriptor: { device: '9', fd: 10, inode: '10' } },
  });
  const openLine = canonicalJson(open);
  const processStartToken = digest('native-parser-process-start');
  const semanticRecord = Object.freeze({
    schemaVersion: 1,
    purpose: 'agent-teams.p3c.semantic-record/v1',
    origin: 'product-http',
    row: '01_direct_api_allow_deny',
    event: 'allow_submitted',
    identity: {},
    causal: {},
    transport: {},
  });
  const fixedControllerNonce = controllerNonce;
  const fixedRunId = runId;
  const fixedOpenLine = openLine;
  const fixedSemantic = Object.freeze({
    ...open,
    emissionNonce: digest('native-parser-semantic-nonce'),
    native: {
      actorId: 'actor_test', bootId: 'boot_test', deploymentId: 'deployment_test', method: 'POST',
      outcome: 'success', ownerAuthority: 'owner-authority_test', ownerGeneration: 7,
      ownerSessionId: 'owner-session_test', requestBodyBytes: 2,
      requestBodySha256: '4'.repeat(64), requestId: 'request_test', responseBodyBytes: 2,
      responseBodySha256: '5'.repeat(64), routeId: 'team-approvals.page.v1',
      sessionId: 'session_test', status: 200,
    },
    operationNonce: '3'.repeat(64),
    previousRecordSha256: sha256(`${fixedOpenLine}\n`),
    recordType: 'approval-http-response-finalized',
    sequence: 1,
  });
  const fixedSemanticLine = canonicalJson(fixedSemantic);
  const fixedClose = Object.freeze({
    ...open,
    emissionNonce: digest('native-parser-close-nonce'),
    native: {},
    previousRecordSha256: sha256(`${fixedSemanticLine}\n`),
    recordType: 'producer-close',
    sequence: 2,
  });
  const fixedCloseLine = canonicalJson(fixedClose);
  const fixedOpen = JSON.parse(fixedOpenLine) as Record<string, unknown>;
  const fixedGolden = Buffer.from(`${fixedOpenLine}\n${fixedSemanticLine}\n${fixedCloseLine}\n`);

  it('pins the exact hand-written r307 contract digest', () => {
    expect(PRODUCER_PROVENANCE_CONTRACT_SHA256).toBe(
      'acde43e62b8ab42cc5fd2bbecc22f1b96d68f456bfa188b8c63730751222f498'
    );
  });

  it('parses a fixed hand-authored nonAuthoritative golden without granting authority', () => {
    const parsed = parseNativeRuntimeCapture(
      'productTimelinePath',
      fixedGolden,
      fixedControllerNonce,
      fixedRunId,
      activation.stackManifestSha256
    );
    expect(parsed.semanticRecordCount).toBe(1);
    expect(parsed.records).toHaveLength(3);
  });

  it.each([
    'truncated',
    'reordered',
    'broken-chain',
    'same-role-substitution',
    'duplicate-nonce',
    'empty-stream',
  ] as const)(
    'rejects %s producer bytes',
    (mutation) => {
      const records = [fixedOpen, fixedSemantic].map(
        (record) => JSON.parse(JSON.stringify(record)) as Record<string, unknown>
      );
      let bytes: Buffer;
      if (mutation === 'truncated') {
        bytes = fixedGolden.subarray(0, -1);
      } else if (mutation === 'empty-stream') {
        bytes = Buffer.from(`${openLine}\n`);
      } else if (mutation === 'reordered') {
        bytes = Buffer.from(`${canonicalJson(records[1])}\n${canonicalJson(records[0])}\n`);
      } else {
        if (mutation === 'broken-chain') records[1]!.previousRecordSha256 = digest('wrong-chain');
        if (mutation === 'same-role-substitution') {
          records[1]!.recordType = 'conditional-post-observed';
        }
        if (mutation === 'duplicate-nonce') {
          records[1]!.emissionNonce = records[0]!.emissionNonce;
        }
        bytes = Buffer.from(`${records.map(canonicalJson).join('\n')}\n`);
      }
      expect(() =>
        parseNativeRuntimeCapture(
          'productTimelinePath',
          bytes,
          fixedControllerNonce,
          fixedRunId,
          activation.stackManifestSha256
        )
      ).toThrow(/p3c_(?:runtime_capture|native_capture)/u);
    }
  );

  it('rejects generic self-key native records and semantic digest substitution', () => {
    const generic = [fixedOpen, fixedSemantic].map(
      (record) => JSON.parse(JSON.stringify(record)) as Record<string, unknown>
    );
    generic[1]!.native = { join: {} };
    expect(() =>
      parseNativeRuntimeCapture(
        'productTimelinePath',
        Buffer.from(`${generic.map(canonicalJson).join('\n')}\n`),
        fixedControllerNonce,
        fixedRunId,
        activation.stackManifestSha256
      )
    ).toThrow(/p3c_(?:runtime_capture|native_capture)/u);

    const substituted = [fixedOpen, fixedSemantic].map(
      (record) => JSON.parse(JSON.stringify(record)) as Record<string, unknown>
    );
    (substituted[1]!.native as Record<string, unknown>).semanticRecordSha256 = digest(
      'substituted-semantic'
    );
    expect(() =>
      parseNativeRuntimeCapture(
        'productTimelinePath',
        Buffer.from(`${substituted.map(canonicalJson).join('\n')}\n`),
        fixedControllerNonce,
        fixedRunId,
        activation.stackManifestSha256
      )
    ).toThrow(/p3c_native_capture_productTimelinePath_approval-http-response-finalized/u);
  });

  it.each([
    ['owner-wal-attacker', (record: Record<string, unknown>) => {
      record.recordType = 'owner-wal-attacker';
    }],
    ['numeric-record-type', (record: Record<string, unknown>) => {
      record.recordType = 7;
    }],
    ['missing-operation', (record: Record<string, unknown>) => {
      delete record.operationNonce;
    }],
    ['empty-identity', (record: Record<string, unknown>) => {
      (record.native as Record<string, unknown>).actorId = '';
    }],
  ] as const)('rejects fixed full-envelope adversary %s', (_label, mutate) => {
    const changed = JSON.parse(fixedSemanticLine) as Record<string, unknown>;
    mutate(changed);
    expect(() =>
      parseNativeRuntimeCapture(
        'productTimelinePath',
        Buffer.from(`${fixedOpenLine}\n${canonicalJson(changed)}\n`),
        fixedControllerNonce,
        fixedRunId,
        activation.stackManifestSha256
      )
    ).toThrow(/p3c_(?:runtime_capture|native_capture)/u);
  });

  it.each([
    [
      'conditionalPostLedgerPath',
      'product',
      'conditional-post-accepted',
      'conditional-post',
      'product-http',
      'accepted',
    ],
    [
      'negativeResultsPath',
      'browser',
      'negative-result-rejected',
      'browser-negative-result',
      'browser',
      'missing_session_rejected',
    ],
    [
      'openCodeTimelinePath',
      'opencode',
      'opencode-handler-observed',
      'opencode-handler',
      'opencode',
      'allow_effect',
    ],
    [
      'ownerWalTimelinePath',
      'owner',
      'owner-wal-transition',
      'owner-wal',
      'owner-wal',
      'allow_committed',
    ],
    [
      'productTimelinePath',
      'product',
      'product-sse-observed',
      'product-sse',
      'product-sse',
      'allow_observed',
    ],
    [
      'protectedEffectLedgerPath',
      'opencode',
      'protected-effect-committed',
      'protected-effect',
      'opencode',
      'allow_effect',
    ],
  ] as const)(
    'rejects the legacy generic wrapper schema for %s',
    (name, role, recordType, captureKind, origin, event) => {
      const familyOpen = {
        ...open,
        stream: RUNTIME_CAPTURE_STREAMS[name],
        producer: { ...producer, role },
        emissionNonce: digest(`native-family-open:${name}`),
        native: {
          schemaVersion: 1,
          contractSha256: PRODUCER_PROVENANCE_CONTRACT_SHA256,
          captureKind:
            name === 'productTimelinePath' ? 'product-http-sse' : captureKind,
        },
      };
      const familySemanticRecord = { ...semanticRecord, origin, event };
      const familySemantic = {
        ...familyOpen,
        recordType,
        sequence: 1,
        previousRecordSha256: sha256(canonicalJson(familyOpen)),
        emissionNonce: digest(`native-family-semantic:${name}`),
        native: {
          schemaVersion: 1,
          contractSha256: PRODUCER_PROVENANCE_CONTRACT_SHA256,
          captureKind,
          processStartToken,
          semanticRecord: familySemanticRecord,
          semanticRecordSha256: sha256(canonicalJson(familySemanticRecord)),
          join: {
            rawOrigin: origin,
            rawRecordId: digest(`native-family-raw-record:${name}`),
            rawPayloadSha256: digest(`native-family-raw-payload:${name}`),
            semanticIdentitySha256: digest(`native-family-identity:${name}`),
            event,
          },
        },
      };
      const validBytes = Buffer.from(
        `${canonicalJson(familyOpen)}\n${canonicalJson(familySemantic)}\n`
      );
      expect(() =>
        parseNativeRuntimeCapture(
          name,
          validBytes,
          controllerNonce,
          runId,
          activation.stackManifestSha256
        )
      ).toThrow(/p3c_native_capture/u);
      const adversarial = JSON.parse(JSON.stringify(familySemantic)) as Record<string, unknown>;
      (adversarial.native as Record<string, unknown>).captureKind = 'attacker-generic-schema';
      expect(() =>
        parseNativeRuntimeCapture(
          name,
          Buffer.from(`${canonicalJson(familyOpen)}\n${canonicalJson(adversarial)}\n`),
          controllerNonce,
          runId,
          activation.stackManifestSha256
        )
      ).toThrow(/p3c_(?:runtime_capture_native_schema|native_capture)/u);
    }
  );

  it('rejects a producer nonce reused across separately parsed shards in one run', () => {
    const runNonces = new Set<string>();
    expect(() =>
      parseNativeRuntimeCapture(
        'productTimelinePath',
        fixedGolden,
        fixedControllerNonce,
        fixedRunId,
        activation.stackManifestSha256,
        runNonces
      )
    ).not.toThrow();
    expect(() =>
      parseNativeRuntimeCapture(
        'productTimelinePath',
        fixedGolden,
        fixedControllerNonce,
        fixedRunId,
        activation.stackManifestSha256,
        runNonces
      )
    ).toThrow('p3c_runtime_capture_binding:productTimelinePath:0');
  });

  it('rejects stable writable capture modes instead of trusting the sealed manifest claim', () => {
    expect(() => assertLiveCaptureMode(0o400, 0o400)).not.toThrow();
    expect(() => assertLiveCaptureMode(0o600, 0o400)).toThrow(
      'p3c_driver_capture_mode_disagreement'
    );
  });

  it.each(['resequence', 'rehash', 'owner-substitution', 'duplicate', 'missing'] as const)(
    'rejects an exact-cross-join %s exploit trace',
    (exploit) => {
      const { fixture, parsedShards, expected } = nativeCrossJoinFixture('productTimelinePath');
      expect(() =>
        assertNativeSemanticCrossJoin(
          'productTimelinePath',
          parsedShards,
          fixture.raw,
          fixture.controllerNonce,
          expected
        )
      ).not.toThrow();
      const changed = JSON.parse(JSON.stringify(parsedShards)) as unknown as Parameters<
        typeof assertNativeSemanticCrossJoin
      >[1];
      const records = changed[0]!.records as unknown as Record<string, unknown>[];
      if (exploit === 'resequence') [records[1], records[2]] = [records[2]!, records[1]!];
      if (exploit === 'rehash') {
        const native = records[1]!.native as Record<string, unknown>;
        if (records[1]!.recordType === 'coordination-sse-write-succeeded') {
          native.frameSha256 = digest('attacker-rehashed-frame');
        } else {
          native.requestBodySha256 = digest('attacker-rehashed-body');
        }
      }
      if (exploit === 'owner-substitution') {
        const native = records[1]!.native as Record<string, unknown>;
        if (records[1]!.recordType === 'coordination-sse-write-succeeded') {
          native.eventType = 'owner-event';
        } else {
          native.responseBodySha256 = digest('owner-body');
        }
      }
      if (exploit === 'duplicate') records[2] = JSON.parse(JSON.stringify(records[1]));
      if (exploit === 'missing') records.splice(1, 1);
      expect(() =>
        assertNativeSemanticCrossJoin(
          'productTimelinePath',
          changed,
          fixture.raw,
          fixture.controllerNonce,
          expected
        )
      ).toThrow(/p3c_runtime_capture_semantic_/u);
    }
  );

  it('rejects cross-owner mixing between ordered restarted-owner shards', () => {
    const { fixture, parsedShards, expected } = nativeCrossJoinFixture('ownerWalTimelinePath');
    expect(parsedShards).toHaveLength(3);
    expect(parsedShards.every((shard) => shard.semanticRecordCount > 0)).toBe(true);
    expect(() =>
      assertNativeSemanticCrossJoin(
        'ownerWalTimelinePath',
        parsedShards,
        fixture.raw,
        fixture.controllerNonce,
        expected
      )
    ).not.toThrow();
    const changed = JSON.parse(JSON.stringify(parsedShards)) as unknown as Parameters<
      typeof assertNativeSemanticCrossJoin
    >[1];
    const first = changed[0]!.records as unknown as Record<string, unknown>[];
    const second = changed[1]!.records as unknown as Record<string, unknown>[];
    first.push(second[1]!);
    second.splice(1, 1);
    expect(() =>
      assertNativeSemanticCrossJoin(
        'ownerWalTimelinePath',
        changed,
        fixture.raw,
        fixture.controllerNonce,
        expected
      )
    ).toThrow(/p3c_runtime_capture_semantic_/u);
  });
});

describe('raw evidence validation', () => {
  it('rejects raw-only evidence and non-authoritative fixture bytes without kernel proofs', () => {
    const fixture = rawEvidence();
    expect(() =>
      assembleEvidence({
        raw: fixture.raw,
        captures: fixture.captures,
        controllerNonce: fixture.controllerNonce,
        runId: fixture.outcome.runId,
        producerCandidatePayloadSha256: digest('non-authoritative-producer-candidate'),
        outcome: fixture.outcome,
        cleanup: {
          disposition: 'removed',
          runId: fixture.outcome.runId,
          path: '/marker-owned-sandbox/removed',
          markerVerified: true,
          zeroOwnedSurvivors: true,
          reason: null,
        },
      })
    ).toThrow('p3c_runtime_capture_producer_proof:conditionalPostLedgerPath');
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
