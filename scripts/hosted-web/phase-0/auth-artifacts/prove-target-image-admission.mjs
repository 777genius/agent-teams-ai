#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderHostedContainerHardeningCompose } from '../../../ci/verify-hosted-container-hardening.mjs';

import { repoRoot } from './auth-artifacts-spike.mjs';
import {
  AUTHORITY_PATHS,
  evaluateDisposableInstanceLockMigrationProof,
  evaluateDockerInstanceLockStartup,
  evaluateTargetImageAdmission,
  HOSTED_ENTRYPOINT,
  HOSTED_NODE,
  HOSTED_PROFILES,
  INSTANCE_LOCK_ANCHOR,
  INSTANCE_LOCK_PARENT,
  normalizeDecisionFacts,
  PERSISTENT_APPLICATION_ROOT,
  PERSISTENT_STATE_ROOT,
  projectControllerArtifacts,
  REQUIRED_CANONICAL_SOURCE_COMMIT,
  REQUIRED_CANONICAL_SOURCE_TREE,
  runProviderCanaryFixture,
  TARGET_IMAGE_DECISION_PATH,
  TERMINAL_SENSITIVE_SURFACES,
} from './target-image-admission-policy.mjs';

export {
  evaluateDisposableInstanceLockMigrationProof,
  evaluateDockerInstanceLockStartup,
  evaluateTargetImageAdmission,
  normalizeDecisionFacts,
  REQUIRED_CANONICAL_SOURCE_COMMIT,
  REQUIRED_CANONICAL_SOURCE_TREE,
  runProviderCanaryFixture,
  TARGET_IMAGE_DECISION_PATH,
  TERMINAL_SENSITIVE_SURFACES,
};

function runDockerJson(dockerBinary, args) {
  const result = spawnSync(dockerBinary, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 5 * 1024 * 1024,
  });
  if (result.status !== 0 || result.error) {
    throw new Error(`docker ${args[0]} failed`);
  }
  return JSON.parse(result.stdout);
}

function runDocker(dockerBinary, args, options = {}) {
  const result = spawnSync(dockerBinary, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: 'utf8',
    env: options.environment ?? process.env,
    maxBuffer: 5 * 1024 * 1024,
  });
  if (result.status !== 0 || result.error) {
    throw new Error(`docker ${args[0]} failed: ${(result.stderr ?? '').trim()}`);
  }
  return result.stdout;
}

function disposableComposeEnvironment(projectName, sandboxRoot) {
  const secretsDirectory = join(sandboxRoot, 'secrets');
  const claudeDirectory = join(sandboxRoot, 'claude');
  mkdirSync(secretsDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(claudeDirectory, { recursive: true, mode: 0o700 });
  for (const secretName of [
    'oidc_client_secret',
    'keycloak_admin_password',
    'keycloak_database_password',
  ]) {
    writeFileSync(join(secretsDirectory, secretName), randomUUID().replaceAll('-', ''), {
      mode: 0o600,
    });
  }
  return {
    ...process.env,
    COMPOSE_PROJECT_NAME: projectName,
    CLAUDE_DIR: claudeDirectory,
    HOSTED_SECRETS_DIR: secretsDirectory,
    NODE_IMAGE_DIGEST: `sha256:${'a'.repeat(64)}`,
    KEYCLOAK_IMAGE_DIGEST: `sha256:${'b'.repeat(64)}`,
    POSTGRES_IMAGE_DIGEST: `sha256:${'c'.repeat(64)}`,
    CADDY_IMAGE_DIGEST: `sha256:${'d'.repeat(64)}`,
  };
}

export function proveDisposableInstanceLockMigration(imageReference, options = {}) {
  if (typeof imageReference !== 'string' || imageReference.length === 0) {
    throw new Error('a built image reference is required');
  }
  const dockerBinary = options.dockerBinary ?? '/usr/bin/docker';
  const projectName =
    options.projectName ?? `agent-teams-lock-upgrade-${randomUUID().replaceAll('-', '')}`;
  if (!/^agent-teams-lock-upgrade-[a-f0-9]{32}$/u.test(projectName)) {
    throw new Error('disposable project name is invalid');
  }

  const sandboxRoot = mkdtempSync(join(tmpdir(), 'agent-teams-lock-upgrade-'));
  const environment = disposableComposeEnvironment(projectName, sandboxRoot);
  const applicationVolume = `${projectName}_agent-teams-data`;
  const lockParentVolume = `${projectName}_agent-teams-instance-lock`;
  const composeFile = join(repoRoot, 'docker/docker-compose.yml');
  const serviceTags = HOSTED_PROFILES.map((profile) => `${projectName}-agent-teams-${profile}`);
  const createdVolumes = [];
  const createdTags = [];
  const markerBytes = Buffer.from(`legacy-marker:${projectName}\n`, 'utf8');
  const databaseBytes = Buffer.concat([
    Buffer.from('SQLite format 3\0', 'binary'),
    createHash('sha256').update(`legacy-database:${projectName}`).digest(),
  ]);
  const seededSha256 = {
    marker: sha256Text(markerBytes),
    database: sha256Text(databaseBytes),
  };
  const profiles = {};

  try {
    for (const resource of [applicationVolume, lockParentVolume]) {
      const existing = spawnSync(dockerBinary, ['volume', 'inspect', resource], {
        cwd: repoRoot,
        encoding: 'utf8',
      });
      if (existing.status === 0) throw new Error(`disposable volume already exists: ${resource}`);
    }
    for (const tag of serviceTags) {
      const existing = spawnSync(dockerBinary, ['image', 'inspect', tag], {
        cwd: repoRoot,
        encoding: 'utf8',
      });
      if (existing.status === 0) throw new Error(`disposable image tag already exists: ${tag}`);
    }

    runDocker(dockerBinary, ['volume', 'create', applicationVolume], { environment });
    createdVolumes.push(applicationVolume);
    const seedProgram = [
      "const { mkdirSync, writeFileSync } = require('node:fs');",
      "mkdirSync('/legacy/hosted-auth-secrets', { recursive: true });",
      `writeFileSync('/legacy/upgrade-marker.bin', Buffer.from('${markerBytes.toString('hex')}', 'hex'));`,
      `writeFileSync('/legacy/internal-storage.sqlite', Buffer.from('${databaseBytes.toString('hex')}', 'hex'));`,
    ].join('');
    runDocker(
      dockerBinary,
      [
        'run',
        '--rm',
        '--entrypoint',
        HOSTED_NODE,
        '--mount',
        `type=volume,source=${applicationVolume},target=/legacy`,
        imageReference,
        '-e',
        seedProgram,
      ],
      { environment }
    );

    for (const [index, profile] of HOSTED_PROFILES.entries()) {
      const serviceName = `agent-teams-${profile}`;
      const serviceTag = serviceTags[index];
      runDocker(dockerBinary, ['tag', imageReference, serviceTag], { environment });
      createdTags.push(serviceTag);
      const rendered = renderHostedContainerHardeningCompose({
        profile,
        root: repoRoot,
        dockerBinary,
        environment,
      });
      const renderedService = rendered.services?.[serviceName];
      if (
        rendered.volumes?.['agent-teams-application-data']?.name !== applicationVolume ||
        rendered.volumes?.['agent-teams-data']?.name !== lockParentVolume ||
        renderedService?.environment?.AUTH_DATA_DIR !== PERSISTENT_APPLICATION_ROOT
      ) {
        throw new Error(`rendered migration contract failed for ${profile}`);
      }

      const probeProgram = [
        "const { createHash } = require('node:crypto');",
        "const { readFileSync, statSync } = require('node:fs');",
        "const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');",
        "const shape = (path) => { const value = statSync(path); return { uid: value.uid, gid: value.gid, mode: (value.mode & 0o7777).toString(8).padStart(4, '0'), isFile: value.isFile() }; };",
        `process.stdout.write('MIGRATION_PROOF:' + JSON.stringify({ observedSha256: { marker: digest('${PERSISTENT_APPLICATION_ROOT}/upgrade-marker.bin'), database: digest('${PERSISTENT_APPLICATION_ROOT}/internal-storage.sqlite') }, applicationDataPath: '${PERSISTENT_APPLICATION_ROOT}', applicationVolume: '${applicationVolume}', lockParentVolume: '${lockParentVolume}', lockParent: shape('${INSTANCE_LOCK_PARENT}'), lockAnchor: shape('${INSTANCE_LOCK_ANCHOR}') }) + '\\n');`,
      ].join('');
      const output = runDocker(
        dockerBinary,
        [
          'compose',
          '-f',
          composeFile,
          '--project-name',
          projectName,
          '--profile',
          profile,
          'run',
          '--rm',
          '--no-deps',
          '--no-build',
          serviceName,
          HOSTED_NODE,
          '-e',
          probeProgram,
        ],
        { environment }
      );
      const proofLine = output.split(/\r?\n/u).find((line) => line.startsWith('MIGRATION_PROOF:'));
      if (!proofLine) throw new Error(`migration observation missing for ${profile}`);
      profiles[profile] = JSON.parse(proofLine.slice('MIGRATION_PROOF:'.length));
    }

    const proof = {
      format: 'agent-teams-instance-lock-disposable-migration-proof/v1',
      status: 'passed',
      projectName,
      seededSha256,
      profiles,
    };
    const evaluation = evaluateDisposableInstanceLockMigrationProof(proof);
    if (!evaluation.ok)
      throw new Error(`disposable migration proof failed: ${evaluation.violations}`);
    return proof;
  } finally {
    spawnSync(
      dockerBinary,
      [
        'compose',
        '-f',
        composeFile,
        '--project-name',
        projectName,
        '--profile',
        'personal',
        '--profile',
        'keycloak',
        'down',
        '--volumes',
        '--remove-orphans',
      ],
      { cwd: repoRoot, encoding: 'utf8', env: environment }
    );
    for (const tag of createdTags) {
      spawnSync(dockerBinary, ['image', 'rm', tag], { cwd: repoRoot, encoding: 'utf8' });
    }
    for (const volume of [...createdVolumes, lockParentVolume]) {
      spawnSync(dockerBinary, ['volume', 'rm', volume], { cwd: repoRoot, encoding: 'utf8' });
    }
    rmSync(sandboxRoot, { recursive: true, force: true });
  }
}

export function collectBuiltDockerInstanceLockStartupProof(imageReference, options = {}) {
  if (typeof imageReference !== 'string' || imageReference.length === 0) {
    throw new Error('a built image reference is required');
  }
  const dockerBinary = options.dockerBinary ?? '/usr/bin/docker';
  const imageInspect = runDockerJson(dockerBinary, ['image', 'inspect', imageReference]);
  if (!Array.isArray(imageInspect) || imageInspect.length !== 1) {
    throw new Error('docker image inspect returned an unexpected image count');
  }
  const files = {};
  for (const path of [
    PERSISTENT_STATE_ROOT,
    HOSTED_ENTRYPOINT,
    INSTANCE_LOCK_BINARY,
    INSTANCE_LOCK_PARENT,
    INSTANCE_LOCK_ANCHOR,
  ]) {
    const probe = spawnSync(
      dockerBinary,
      ['run', '--rm', '--entrypoint', '/usr/bin/stat', imageReference, '-c', '%u:%g:%a', path],
      { cwd: repoRoot, encoding: 'utf8' }
    );
    if (probe.status !== 0 || probe.error) throw new Error(`built image stat failed for ${path}`);
    const match = /^(\d+):(\d+):([0-7]{3,4})$/u.exec(probe.stdout.trim());
    if (!match) throw new Error(`built image stat was invalid for ${path}`);
    files[path] = { uid: Number(match[1]), gid: Number(match[2]), mode: match[3] };
  }
  const entrypointBytesProbe = spawnSync(
    dockerBinary,
    ['run', '--rm', '--entrypoint', '/bin/cat', imageReference, HOSTED_ENTRYPOINT],
    { cwd: repoRoot, encoding: null, maxBuffer: 1024 * 1024 }
  );
  if (
    entrypointBytesProbe.status !== 0 ||
    entrypointBytesProbe.error ||
    !Buffer.isBuffer(entrypointBytesProbe.stdout)
  ) {
    throw new Error('built image entrypoint byte collection failed');
  }
  files[HOSTED_ENTRYPOINT].sha256 = createHash('sha256')
    .update(entrypointBytesProbe.stdout)
    .digest('hex');
  return {
    dockerfile: readFileSync(resolve(repoRoot, 'docker/Dockerfile'), 'utf8'),
    entrypoint: readFileSync(resolve(repoRoot, 'docker/hosted-entrypoint.sh'), 'utf8'),
    imageProbe: { ...imageInspect[0], Files: files },
    renderedComposes: Object.fromEntries(
      HOSTED_PROFILES.map((profile) => [
        profile,
        renderHostedContainerHardeningCompose({
          profile,
          root: repoRoot,
          dockerBinary,
          environment: options.environment,
        }),
      ])
    ),
    migrationProof: proveDisposableInstanceLockMigration(imageReference, {
      dockerBinary,
    }),
  };
}

const sha256Text = (value) => createHash('sha256').update(value).digest('hex');

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
  if (process.argv.includes('--verify-instance-lock-startup')) {
    const valueAfter = (flag) => {
      const index = process.argv.indexOf(flag);
      if (index < 0 || !process.argv[index + 1]) {
        throw new Error(`missing required ${flag} path`);
      }
      return process.argv[index + 1];
    };
    const result = evaluateDockerInstanceLockStartup(
      collectBuiltDockerInstanceLockStartupProof(valueAfter('--image'))
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) process.exitCode = 1;
    return;
  }
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
