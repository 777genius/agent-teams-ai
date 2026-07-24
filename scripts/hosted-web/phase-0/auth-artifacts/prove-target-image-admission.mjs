#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { evaluateFinalImageTerminalAbsence, repoRoot } from './auth-artifacts-spike.mjs';

export const REQUIRED_CANONICAL_SOURCE_COMMIT = '42ec333848e29e97c41699b9fed73ed199740e3f';
export const REQUIRED_CANONICAL_SOURCE_TREE = '4bc04a743c20ea48e06ada55c761d03881117cac';
export const TARGET_IMAGE_DECISION_PATH =
  'docs/research/hosted-web/phase-0/auth-artifacts/target-image-admission.json';

const AUTHORITY_PATHS = [
  'docker/Dockerfile',
  'docker/docker-compose.yml',
  'docs/research/hosted-web/phase-0/auth-artifacts/observed-artifact-scan.json',
  'docs/research/hosted-web/phase-0/host-primitives/target-host-envelope.md',
  'docs/research/hosted-web/phase-0/provider-runtime/credential-exposure-matrix.json',
  'docs/research/hosted-web/phase-0/provider-runtime/execution-topology.json',
  'docs/research/hosted-web/phase-0/w4-w6-contract/controller-artifact-contract.json',
];

const REQUIRED_ARTIFACT_PATHS = Object.freeze({
  'agent-teams-instance-lock': '/app/bin/agent-teams-instance-lock',
  'agent-teams-process-anchor': '/app/bin/agent-teams-process-anchor',
  'agent-teams-workspace-guard': '/app/bin/agent-teams-workspace-guard',
});

const REQUIRED_PROVIDERS = ['anthropic', 'codex', 'gemini', 'opencode'];

export const TERMINAL_SENSITIVE_SURFACES = Object.freeze([
  'capabilities',
  'files',
  'migrations',
  'packages',
  'ports',
  'processes',
  'rendererChunks',
  'routes',
  'volumes',
]);

const sha256Text = (value) => createHash('sha256').update(value).digest('hex');
const isSha256 = (value) => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);

function runGit(args) {
  const result = spawnSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args[0]} failed: ${(result.stderr ?? '').trim()}`);
  }
  return result.stdout.trimEnd();
}

function readCanonicalSource(path) {
  return `${runGit(['show', `${REQUIRED_CANONICAL_SOURCE_COMMIT}:${path}`])}\n`;
}

function readCanonicalJson(path) {
  return JSON.parse(readCanonicalSource(path));
}

export function evaluateTargetImageAdmission({ image, controllerArtifacts, providerCanaries }) {
  const violations = [];
  if (!isSha256(image?.identity?.digest)) violations.push('image:immutable_digest_missing');
  if (!isSha256(image?.identity?.manifestDigest)) {
    violations.push('image:immutable_manifest_digest_missing');
  }
  if (!isSha256(image?.identity?.configDigest)) {
    violations.push('image:immutable_config_digest_missing');
  }
  if (
    !Array.isArray(image?.identity?.baseImageDigests) ||
    !image.identity.baseImageDigests.length
  ) {
    violations.push('image:pinned_base_image_missing');
  } else if (image.identity.baseImageDigests.some((digest) => !isSha256(digest))) {
    violations.push('image:base_image_not_digest_pinned');
  }

  const profile = image?.profile;
  if (profile?.os !== 'debian-slim') violations.push('profile:debian_slim_unproved');
  if (profile?.architecture !== 'linux-x64') violations.push('profile:linux_x64_unproved');
  if (profile?.nodeMajor !== 24) violations.push('profile:node_24_unproved');
  if (!Number.isInteger(profile?.uid) || profile.uid <= 0) {
    violations.push('profile:non_root_uid_missing');
  }
  if (!Number.isInteger(profile?.gid) || profile.gid <= 0) {
    violations.push('profile:non_root_gid_missing');
  }
  if (profile?.readOnlyRoot !== true) violations.push('profile:read_only_root_unproved');
  if (profile?.noNewPrivileges !== true) violations.push('profile:no_new_privileges_unproved');
  if (JSON.stringify(profile?.capabilityDrop) !== JSON.stringify(['ALL'])) {
    violations.push('profile:capability_drop_all_unproved');
  }
  if (!isSha256(profile?.seccompProfileDigest)) {
    violations.push('profile:seccomp_digest_missing');
  }
  if (profile?.init?.present !== true || !profile?.init?.path) {
    violations.push('profile:minimal_init_unproved');
  }
  if (profile?.launcherBeforeNode !== true) {
    violations.push('profile:launcher_before_node_unproved');
  }
  const startupOrder = profile?.startupOrder;
  if (!Array.isArray(startupOrder)) {
    violations.push('profile:startup_order_missing');
  } else {
    const nodeIndex = startupOrder.indexOf('node');
    const initIndex = startupOrder.indexOf(profile?.init?.path);
    const lockIndex = startupOrder.indexOf(REQUIRED_ARTIFACT_PATHS['agent-teams-instance-lock']);
    const anchorIndex = startupOrder.indexOf(REQUIRED_ARTIFACT_PATHS['agent-teams-process-anchor']);
    if (
      new Set(startupOrder).size !== startupOrder.length ||
      initIndex !== 0 ||
      lockIndex < 0 ||
      anchorIndex < 0 ||
      nodeIndex < 0 ||
      lockIndex >= nodeIndex ||
      anchorIndex >= nodeIndex
    ) {
      violations.push('profile:startup_order_invalid');
    }
  }

  const inventory = image?.inventory;
  if (inventory?.complete !== true) violations.push('inventory:completeness_unproved');
  if (
    !isSha256(inventory?.observedFromImageDigest) ||
    inventory.observedFromImageDigest !== image?.identity?.digest
  ) {
    violations.push('inventory:image_digest_binding_mismatch');
  }
  if (!isSha256(inventory?.scannerDigest)) violations.push('inventory:scanner_digest_missing');

  if (!Array.isArray(controllerArtifacts) || !controllerArtifacts.length) {
    violations.push('composition:controller_artifacts_missing');
  } else {
    const artifactIds = controllerArtifacts.map(({ artifactId }) => artifactId).sort();
    if (
      JSON.stringify(artifactIds) !== JSON.stringify(Object.keys(REQUIRED_ARTIFACT_PATHS).sort())
    ) {
      violations.push('composition:artifact_set_mismatch');
    }
    for (const artifact of controllerArtifacts) {
      const prefix = `composition:${artifact?.artifactId ?? 'unknown'}`;
      if (artifact?.finalImagePath !== REQUIRED_ARTIFACT_PATHS[artifact?.artifactId]) {
        violations.push(`${prefix}:final_image_path_mismatch`);
      }
      if (!isSha256(artifact?.binaryDigest)) violations.push(`${prefix}:binary_digest_missing`);
      if (!isSha256(artifact?.builderImageDigest)) {
        violations.push(`${prefix}:builder_image_digest_missing`);
      }
      if (!artifact?.compilerIdentity) violations.push(`${prefix}:compiler_identity_missing`);
      if (!Number.isInteger(artifact?.uid)) violations.push(`${prefix}:uid_missing`);
      if (!Number.isInteger(artifact?.gid)) violations.push(`${prefix}:gid_missing`);
      if (!Number.isInteger(artifact?.mode)) violations.push(`${prefix}:mode_missing`);
      if (
        artifact?.finalImagePath &&
        (!Array.isArray(inventory?.files) || !inventory.files.includes(artifact.finalImagePath))
      ) {
        violations.push(`${prefix}:not_in_file_inventory`);
      }
    }
  }

  if (
    Array.isArray(startupOrder) &&
    Array.isArray(inventory?.processes) &&
    startupOrder.some((process) => !inventory.processes.includes(process))
  ) {
    violations.push('inventory:startup_process_missing');
  }

  const terminal = evaluateFinalImageTerminalAbsence(inventory ?? {});
  violations.push(...terminal.violations.map((violation) => `terminal_negative:${violation}`));

  if (providerCanaries?.status !== 'passed_target_image') {
    violations.push('provider_runtime:target_image_canaries_unproved');
  }
  if (providerCanaries?.rawCredentialValueRecorded !== false) {
    violations.push('provider_runtime:credential_redaction_unproved');
  }
  const providerRecords = providerCanaries?.records;
  if (
    !Array.isArray(providerRecords) ||
    JSON.stringify(providerRecords.map(({ provider }) => provider).sort()) !==
      JSON.stringify(REQUIRED_PROVIDERS)
  ) {
    violations.push('provider_runtime:provider_set_incomplete');
  } else if (
    providerRecords.some(
      (record) =>
        record.executedInTargetImage !== true ||
        record.targetImageDigest !== image?.identity?.digest ||
        !isSha256(record.canaryEvidenceDigest) ||
        record.expectedCanaryPresent !== true ||
        record.rawCredentialValueRecorded !== false ||
        record.outputRedactionVerified !== true ||
        !Array.isArray(record.crossProviderCanaryKeys) ||
        record.crossProviderCanaryKeys.length !== 0
    )
  ) {
    violations.push('provider_runtime:canary_record_invalid');
  }

  return {
    admitted: violations.length === 0,
    disposition: violations.length === 0 ? 'admitted' : 'fail_closed',
    violations: [...new Set(violations)].sort(),
    terminalNegative:
      terminal.passes && violations.every((value) => !value.startsWith('terminal_negative:')),
  };
}

const CANARY_KEYS = Object.freeze({
  anthropic: 'ANTHROPIC_API_KEY',
  codex: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  opencode: 'OPENCODE_CONFIG_CONTENT',
});

export function runProviderCanaryFixture() {
  const allKeys = Object.values(CANARY_KEYS);
  const records = [];
  const rawCanaries = [];
  for (const [provider, expectedKey] of Object.entries(CANARY_KEYS)) {
    const canary = ['phase0', provider, 'credential', 'canary'].join(':');
    rawCanaries.push(canary);
    const environment = {
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOME: '/tmp/phase0-provider-fixture-home',
      CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
      CLAUDE_CODE_ENTRY_PROVIDER: provider,
      [expectedKey]: canary,
    };
    const observed = allKeys.filter((key) => Object.hasOwn(environment, key));
    const record = {
      provider,
      expectedKey,
      expectedCanaryPresent: observed.includes(expectedKey),
      crossProviderCanaryKeys: observed.filter((key) => key !== expectedKey),
      canaryRendering: Object.fromEntries(observed.map((key) => [key, '[REDACTED]'])),
      rawCredentialValueRecorded: false,
      fixtureEvaluationPassed: true,
    };
    const serialized = JSON.stringify(record);
    if (rawCanaries.some((value) => serialized.includes(value))) {
      throw new Error(`provider canary fixture emitted a raw credential for ${provider}`);
    }
    records.push(record);
  }
  const passed = records.every(
    (record) =>
      record.expectedCanaryPresent &&
      record.crossProviderCanaryKeys.length === 0 &&
      record.rawCredentialValueRecorded === false &&
      record.fixtureEvaluationPassed === true
  );
  return {
    status: passed ? 'passed_fixture_only' : 'failed_fixture',
    executionBoundary: 'synthetic_environment_records_no_project_opened',
    rawCredentialValueRecorded: false,
    redactionToken: '[REDACTED]',
    records,
    limitation:
      'This fixture proves only deterministic admission-harness behavior; it is not target-image provider execution.',
  };
}

function projectControllerArtifacts(controllerContract) {
  return controllerContract.artifacts.map((artifact) => ({
    artifactId: artifact.artifactId,
    finalImagePath: artifact.finalImagePath,
    binaryDigest: artifact.binarySha256 ? `sha256:${artifact.binarySha256}` : null,
    builderImageDigest: artifact.builderImageDigest,
    compilerIdentity: artifact.compilerIdentity,
    uid: artifact.uid,
    gid: artifact.gid,
    mode: artifact.mode,
  }));
}

export function collectTargetImageDecision() {
  const sourceTree = runGit(['rev-parse', `${REQUIRED_CANONICAL_SOURCE_COMMIT}^{tree}`]);
  if (sourceTree !== REQUIRED_CANONICAL_SOURCE_TREE) {
    throw new Error(`canonical source tree mismatch: ${sourceTree}`);
  }
  const controllerContract = readCanonicalJson(
    'docs/research/hosted-web/phase-0/w4-w6-contract/controller-artifact-contract.json'
  );
  const standalone = readCanonicalJson(
    'docs/research/hosted-web/phase-0/auth-artifacts/observed-artifact-scan.json'
  );
  const dockerfile = readCanonicalSource('docker/Dockerfile');
  const providerFixture = runProviderCanaryFixture();
  const controllerArtifacts = projectControllerArtifacts(controllerContract);
  const admission = evaluateTargetImageAdmission({
    image: null,
    controllerArtifacts,
    providerCanaries: providerFixture,
  });

  return {
    schemaVersion: 2,
    recordType: 'phase-0-target-image-capability-narrowing-decision',
    decision: {
      id: 'P0.D.TARGET_IMAGE',
      state: 'accepted',
      outcome: 'capability_narrowed',
      phase0Gate: 'closed_by_accepted_narrowing',
      exactImageEarliestOwner: 'phase-5',
      rationale:
        'Phase 0 characterizes source and contracts but does not implement the production composition that Phase 5 must build; exact-image admission before Phase 5 would be circular.',
      phase0Capability:
        'Preserve the complete fail-closed admission contract and canonical-source gaps without claiming an image exists.',
      deferredCapability:
        'No hosted route, mutation, provider runtime, credential canary, production composition, or terminal-negative image readiness is admitted.',
    },
    sourceIdentity: {
      canonicalCommit: REQUIRED_CANONICAL_SOURCE_COMMIT,
      canonicalTree: REQUIRED_CANONICAL_SOURCE_TREE,
      verificationRelationship: 'repository_head_is_source_or_descendant',
      evidenceIdentityPolicy:
        'The verifier reports repositoryHeadAtVerification separately; it never substitutes that mutable commit into this immutable source decision.',
    },
    scope: {
      sandboxAndSyntheticFixturesOnly: true,
      realUserProjectsOpened: false,
      dockerSocketRequiredForPhase0Decision: false,
      liveContainerRuntimeObservationInDeterministicFacts: false,
      phase1AuthorizedOrImplemented: false,
    },
    authorities: AUTHORITY_PATHS.map((path) => ({
      path,
      sourceCommit: REQUIRED_CANONICAL_SOURCE_COMMIT,
      sha256: sha256Text(readCanonicalSource(path)),
    })),
    canonicalSourceFacts: {
      currentCandidate: {
        dockerfileBaseDigestPinned: /^FROM\s+[^\s]+@sha256:[a-f0-9]{64}/m.test(dockerfile),
        finalImageDigestDeclared: false,
        nonRootUserDeclared: /^USER\s+[^\s]+/m.test(dockerfile),
        initEntrypointDeclared: /^ENTRYPOINT\s+/m.test(dockerfile),
        controllerArtifactsCopied: controllerContract.artifacts.every((artifact) =>
          dockerfile.includes(artifact.finalImagePath)
        ),
        terminalAbsence: standalone.terminalAbsence,
      },
      controllerArtifacts,
    },
    providerRuntimeCanaryFixture: providerFixture,
    phase5AdmissionGate: {
      state: 'fail_closed',
      admitted: false,
      admissionRequiredBefore: [
        'phase-5 route admission',
        'phase-5 capability advertisement',
        'phase-6 non-loopback mutation enablement',
      ],
      terminalSensitiveSurfaces: TERMINAL_SENSITIVE_SURFACES,
      canonicalSourceGapCount: admission.violations.length,
      canonicalSourceGaps: admission.violations,
      terminalNegative: admission.terminalNegative,
      requiredEvidence:
        'One reviewed immutable target-image manifest/profile and an instantiated digest with complete digest-bound inventory, native provenance/ownership/modes, startup-order proof, target-executed provider canaries, and terminal-negative scans over every named surface.',
    },
    claims: {
      exactImageInstantiated: false,
      exactHostedCompositionProved: false,
      providerRuntimeTargetProved: false,
      credentialCanariesTargetProved: false,
      terminalNegativeAdmission: false,
      phase1AuthorizedOrImplemented: false,
    },
  };
}

function normalizationKey(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value.path ?? value.id ?? value.provider ?? value.artifactId ?? JSON.stringify(value);
  }
  return JSON.stringify(value);
}

export function normalizeDecisionFacts(value) {
  if (Array.isArray(value)) {
    // Canonicalize arrays order-insensitively for the drift digest, using a
    // locale-independent code-unit comparator so the digest is deterministic
    // across ICU locales.
    return value.map(normalizeDecisionFacts).sort((left, right) => {
      const leftKey = normalizationKey(left);
      const rightKey = normalizationKey(right);
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, normalizeDecisionFacts(value[key])])
    );
  }
  return value;
}

function normalizedDigest(value) {
  return sha256Text(JSON.stringify(normalizeDecisionFacts(value)));
}

export function collectEvidenceIdentity(repositoryHeadAtVerification) {
  const repositoryHead = repositoryHeadAtVerification ?? runGit(['rev-parse', '--verify', 'HEAD']);
  const relationshipResult = spawnSync(
    'git',
    ['merge-base', '--is-ancestor', REQUIRED_CANONICAL_SOURCE_COMMIT, repositoryHead],
    { cwd: repoRoot, encoding: 'utf8', timeout: 30_000 }
  );
  return {
    repositoryHeadAtVerification: repositoryHead,
    canonicalSourceCommit: REQUIRED_CANONICAL_SOURCE_COMMIT,
    sourceRelationship:
      relationshipResult.status === 0 ? 'source_or_descendant' : 'not_source_or_descendant',
  };
}

export function verifyCommittedTargetImageDecision(
  committed,
  { repositoryHeadAtVerification, sourceRelationship } = {}
) {
  const expected = collectTargetImageDecision();
  const evidenceIdentity = repositoryHeadAtVerification
    ? {
        repositoryHeadAtVerification,
        canonicalSourceCommit: REQUIRED_CANONICAL_SOURCE_COMMIT,
        sourceRelationship: sourceRelationship ?? 'not_source_or_descendant',
      }
    : collectEvidenceIdentity();
  const expectedFactDigest = normalizedDigest(expected);
  const committedFactDigest = normalizedDigest(committed);
  const normalizedFactsMatch = committedFactDigest === expectedFactDigest;
  const sourceIdentityValid =
    committed?.sourceIdentity?.canonicalCommit === REQUIRED_CANONICAL_SOURCE_COMMIT &&
    committed?.sourceIdentity?.canonicalTree === REQUIRED_CANONICAL_SOURCE_TREE;
  const authorityProvenanceValid = expected.authorities.every((expectedAuthority) => {
    const observed = committed?.authorities?.find(
      ({ path, sourceCommit }) =>
        path === expectedAuthority.path && sourceCommit === REQUIRED_CANONICAL_SOURCE_COMMIT
    );
    return observed?.sha256 === expectedAuthority.sha256;
  });
  const sourceRelationshipValid = evidenceIdentity.sourceRelationship === 'source_or_descendant';
  return {
    ok:
      normalizedFactsMatch &&
      sourceIdentityValid &&
      authorityProvenanceValid &&
      sourceRelationshipValid,
    normalizedFactsMatch,
    sourceIdentityValid,
    authorityProvenanceValid,
    sourceRelationshipValid,
    committedFactDigest,
    expectedFactDigest,
    evidenceIdentity,
    expected,
  };
}

function main() {
  const decision = collectTargetImageDecision();
  const verification = verifyCommittedTargetImageDecision(decision);
  process.stdout.write(`${JSON.stringify(decision, null, 2)}\n`);
  // Independent gates: both flags are honored when passed together. Admission
  // failure (exit 2) takes precedence over source-relationship failure (exit 1);
  // with no flags the command stays a diagnostic dump that exits 0.
  if (process.argv.includes('--verify-source-relationship') && !verification.ok) {
    process.exitCode = 1;
  }
  if (process.argv.includes('--require-admission') && !decision.phase5AdmissionGate.admitted) {
    process.exitCode = 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
