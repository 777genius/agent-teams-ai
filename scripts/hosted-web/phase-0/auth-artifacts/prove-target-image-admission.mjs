#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderHostedContainerHardeningCompose } from '../../../ci/verify-hosted-container-hardening.mjs';

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

const INSTANCE_LOCK_BINARY = '/app/bin/agent-teams-instance-lock';
const INSTANCE_LOCK_PARENT = '/data/.agent-teams/instance-lock';
const INSTANCE_LOCK_ANCHOR = '/data/.agent-teams/instance-lock/instance.lock';
const PERSISTENT_STATE_ROOT = '/data/.agent-teams';
const PERSISTENT_APPLICATION_ROOT = '/data/.agent-teams/data';
const HOSTED_ENTRYPOINT = '/usr/local/bin/hosted-entrypoint';
const HOSTED_NODE = '/usr/local/bin/node';
const HOSTED_PROFILES = Object.freeze(['personal', 'keycloak']);

function parseActiveDockerInstructions(dockerfile) {
  const instructions = [];
  let logical = '';
  for (const physical of dockerfile.split(/\r?\n/u)) {
    const trimmed = physical.trim();
    if (!logical && (trimmed === '' || trimmed.startsWith('#'))) continue;
    logical = logical ? `${logical} ${trimmed}` : trimmed;
    if (logical.endsWith('\\')) {
      logical = logical.slice(0, -1).trimEnd();
      continue;
    }
    const match = /^([A-Za-z]+)\s+(.+)$/u.exec(logical);
    if (match) instructions.push({ opcode: match[1].toUpperCase(), value: match[2].trim() });
    logical = '';
  }
  return instructions;
}

function normalizeMode(mode) {
  if (typeof mode === 'number') return (mode & 0o7777).toString(8).padStart(4, '0');
  if (typeof mode !== 'string') return null;
  const match = /(?:^|[^0-7])([0-7]{3,4})$/u.exec(mode);
  return match ? match[1].padStart(4, '0') : null;
}

function effectiveImageValue(service, property, imageValue) {
  const value = service?.[property];
  return value === undefined || value === null ? imageValue : value;
}

function effectiveServiceEntrypoint(service, imageConfig) {
  return effectiveImageValue(service, 'entrypoint', imageConfig?.Entrypoint);
}

function persistentStateVolume(service) {
  return service?.volumes?.find(
    (mount) =>
      mount?.type === 'volume' &&
      mount?.target === PERSISTENT_STATE_ROOT &&
      mount?.read_only !== true &&
      mount?.volume?.nocopy !== true
  );
}

function persistentApplicationVolume(service) {
  return service?.volumes?.find(
    (mount) =>
      mount?.type === 'volume' &&
      mount?.target === PERSISTENT_APPLICATION_ROOT &&
      mount?.read_only !== true &&
      mount?.volume?.nocopy !== true
  );
}

function hasPreservedApplicationVolumeIdentity(renderedCompose) {
  const volumes = renderedCompose?.volumes;
  const lockVolumeName = volumes?.['agent-teams-data']?.name;
  const applicationVolumeName = volumes?.['agent-teams-application-data']?.name;
  if (typeof lockVolumeName !== 'string' || typeof applicationVolumeName !== 'string') return false;
  const oldSuffix = '_agent-teams-data';
  const lockSuffix = '_agent-teams-instance-lock';
  return (
    applicationVolumeName.endsWith(oldSuffix) &&
    lockVolumeName.endsWith(lockSuffix) &&
    applicationVolumeName.slice(0, -oldSuffix.length) ===
      lockVolumeName.slice(0, -lockSuffix.length)
  );
}

function usesHostedFinalImage(service) {
  const build = service?.build;
  if (!build || typeof build !== 'object' || build.target) return false;
  const dockerfile = String(build.dockerfile ?? 'Dockerfile').replaceAll('\\', '/');
  return dockerfile === 'docker/Dockerfile' || dockerfile.endsWith('/docker/Dockerfile');
}

export function evaluateDockerInstanceLockStartup({
  dockerfile,
  entrypoint,
  imageProbe,
  renderedComposes,
  migrationProof,
}) {
  const violations = [];
  const instructions = parseActiveDockerInstructions(dockerfile);
  const fromIndexes = instructions
    .map((instruction, index) => (instruction.opcode === 'FROM' ? index : -1))
    .filter((index) => index >= 0);
  const finalInstructions = instructions.slice(fromIndexes.at(-1));
  const activeValues = (opcode, collection = instructions) =>
    collection.filter((instruction) => instruction.opcode === opcode).map(({ value }) => value);
  const builderCompile =
    /node scripts\/hosted-web\/build-instance-lock\.mjs\s+--output \/app\/bin\/agent-teams-instance-lock/u;
  const artifactCopy =
    '--from=builder /app/bin/agent-teams-instance-lock ./bin/agent-teams-instance-lock';
  const entrypointCopy = 'COPY docker/hosted-entrypoint.sh /usr/local/bin/hosted-entrypoint';
  const entrypointDeclaration = `["${HOSTED_ENTRYPOINT}"]`;
  const nodeCommand = `["${HOSTED_NODE}", "/app/dist-standalone/index.cjs"]`;

  if (!activeValues('RUN').some((value) => builderCompile.test(value))) {
    violations.push('dockerfile:builder_compile_missing');
  }
  if (!activeValues('COPY', finalInstructions).includes(artifactCopy)) {
    violations.push('dockerfile:artifact_copy_missing');
  }
  if (!activeValues('COPY', finalInstructions).includes(entrypointCopy.replace(/^COPY\s+/u, ''))) {
    violations.push('dockerfile:entrypoint_copy_missing');
  }
  if (activeValues('USER', finalInstructions).at(-1) !== 'node') {
    violations.push('dockerfile:non_root_runtime_missing');
  }
  if (activeValues('ENTRYPOINT', finalInstructions).at(-1) !== entrypointDeclaration) {
    violations.push('dockerfile:instance_lock_entrypoint_missing');
  }
  const finalCommand = activeValues('CMD', finalInstructions).at(-1);
  if (finalCommand !== nodeCommand) violations.push('dockerfile:absolute_node_cmd_missing');
  if (/^\["node"/u.test(finalCommand ?? '')) violations.push('dockerfile:direct_node_bypass');

  const finalOpcodes = finalInstructions.map(({ opcode }) => opcode);
  if (
    !(
      finalCommand === nodeCommand &&
      finalOpcodes.lastIndexOf('USER') < finalOpcodes.lastIndexOf('ENTRYPOINT') &&
      finalOpcodes.lastIndexOf('ENTRYPOINT') < finalOpcodes.lastIndexOf('CMD')
    )
  ) {
    violations.push('dockerfile:startup_order_invalid');
  }

  if (!entrypoint.includes(`exec ${INSTANCE_LOCK_BINARY}`)) {
    violations.push('entrypoint:instance_lock_exec_missing');
  }
  if (!entrypoint.includes('"$lock_parent" "$lock_name" "$lock_device" "$lock_inode" -- "$@"')) {
    violations.push('entrypoint:argv_boundary_missing');
  }
  if (/\beval\b|\b(?:ba)?sh\s+-c\b|\$\*/u.test(entrypoint)) {
    violations.push('entrypoint:shell_injection_surface');
  }
  const unqualifiedStat = /\$\(stat\s|[`;|&]\s*stat\s|^\s*stat\s/mu;
  if (unqualifiedStat.test(entrypoint) || !entrypoint.includes('/usr/bin/stat')) {
    violations.push('entrypoint:path_resolved_stat');
  }
  if (
    !entrypoint.includes('/usr/bin/id -g') ||
    !entrypoint.includes('"$state_security" != "0:${runtime_gid}:1770"') ||
    !entrypoint.includes("!= '0:0:555'") ||
    !entrypoint.includes("!= '0:0:444'")
  ) {
    violations.push('entrypoint:mutable_lock_ancestor');
  }

  const imageConfig = imageProbe?.Config;
  if (JSON.stringify(imageConfig?.Entrypoint) !== JSON.stringify([HOSTED_ENTRYPOINT])) {
    violations.push('image:entrypoint_mismatch');
  }
  if (
    JSON.stringify(imageConfig?.Cmd) !==
    JSON.stringify([HOSTED_NODE, '/app/dist-standalone/index.cjs'])
  ) {
    violations.push('image:cmd_mismatch');
  }
  if (imageConfig?.User !== 'node') violations.push('image:non_root_user_mismatch');
  if (!/^sha256:[a-f0-9]{64}$/u.test(imageProbe?.Id ?? '')) {
    violations.push('image:identity_missing');
  }
  if (imageProbe?.Files?.[HOSTED_ENTRYPOINT]?.sha256 !== sha256Text(entrypoint)) {
    violations.push('image:entrypoint_content_mismatch');
  }
  for (const [path, expectedUid, expectedGid, expectedMode] of [
    [PERSISTENT_STATE_ROOT, 0, 1000, '1770'],
    [HOSTED_ENTRYPOINT, 0, 0, '0555'],
    [INSTANCE_LOCK_BINARY, 0, 0, '0555'],
    [INSTANCE_LOCK_PARENT, 0, 0, '0555'],
    [INSTANCE_LOCK_ANCHOR, 0, 0, '0444'],
  ]) {
    const observed = imageProbe?.Files?.[path];
    if (observed?.uid !== expectedUid || observed?.gid !== expectedGid) {
      violations.push(`image:file_owner_mismatch:${path}`);
    }
    if (normalizeMode(observed?.mode) !== expectedMode) {
      violations.push(`image:file_mode_mismatch:${path}`);
    }
  }
  for (const profile of HOSTED_PROFILES) {
    const composeServices = renderedComposes?.[profile]?.services;
    if (!composeServices || typeof composeServices !== 'object') {
      violations.push(`compose:rendered_profile_missing:${profile}`);
      continue;
    }
    if (!hasPreservedApplicationVolumeIdentity(renderedComposes[profile])) {
      violations.push(`compose:existing_application_volume_identity_not_preserved:${profile}`);
    }
    const expectedApplication = `agent-teams-${profile}`;
    if (!composeServices[expectedApplication]) {
      violations.push(`compose:service_missing:${profile}:${expectedApplication}`);
    } else if (
      persistentStateVolume(composeServices[expectedApplication])?.source !== 'agent-teams-data'
    ) {
      violations.push(`compose:shared_persistent_lock_missing:${profile}:${expectedApplication}`);
    } else if (
      persistentApplicationVolume(composeServices[expectedApplication])?.source !==
      'agent-teams-application-data'
    ) {
      violations.push(`compose:nested_application_data_missing:${profile}:${expectedApplication}`);
    } else if (
      composeServices[expectedApplication]?.environment?.AUTH_DATA_DIR !==
      PERSISTENT_APPLICATION_ROOT
    ) {
      violations.push(`compose:application_data_path_mismatch:${profile}:${expectedApplication}`);
    }
    const startupServices = Object.entries(composeServices).filter(([, service]) =>
      usesHostedFinalImage(service)
    );
    for (const [serviceName, service] of startupServices) {
      if (
        JSON.stringify(effectiveServiceEntrypoint(service, imageConfig)) !==
        JSON.stringify([HOSTED_ENTRYPOINT])
      ) {
        violations.push(`compose:entrypoint_bypass:${profile}:${serviceName}`);
      }
      const effectiveCommand = effectiveImageValue(service, 'command', imageConfig?.Cmd);
      if (
        !Array.isArray(effectiveCommand) ||
        typeof effectiveCommand[0] !== 'string' ||
        !effectiveCommand[0].startsWith('/')
      ) {
        violations.push(`compose:command_not_absolute_argv:${profile}:${serviceName}`);
      }
    }
  }
  const migrationEvaluation = evaluateDisposableInstanceLockMigrationProof(migrationProof);
  for (const violation of migrationEvaluation.violations) {
    violations.push(`upgrade:${violation}`);
  }

  return { ok: violations.length === 0, violations };
}

export function evaluateDisposableInstanceLockMigrationProof(proof) {
  const violations = [];
  if (
    proof?.format !== 'agent-teams-instance-lock-disposable-migration-proof/v1' ||
    proof?.status !== 'passed' ||
    !/^agent-teams-lock-upgrade-[a-f0-9]{32}$/u.test(proof?.projectName ?? '')
  ) {
    violations.push('disposable_proof_identity_invalid');
  }
  for (const artifact of ['marker', 'database']) {
    const seeded = proof?.seededSha256?.[artifact];
    if (!/^[a-f0-9]{64}$/u.test(seeded ?? '')) {
      violations.push(`seed_${artifact}_digest_invalid`);
      continue;
    }
    for (const profile of HOSTED_PROFILES) {
      if (proof?.profiles?.[profile]?.observedSha256?.[artifact] !== seeded) {
        violations.push(`${profile}_${artifact}_bytes_not_preserved`);
      }
    }
  }
  for (const profile of HOSTED_PROFILES) {
    const observation = proof?.profiles?.[profile];
    if (
      observation?.applicationDataPath !== PERSISTENT_APPLICATION_ROOT ||
      observation?.applicationVolume !== `${proof?.projectName}_agent-teams-data` ||
      observation?.lockParentVolume !== `${proof?.projectName}_agent-teams-instance-lock`
    ) {
      violations.push(`${profile}_nested_volume_identity_invalid`);
    }
    if (
      observation?.lockParent?.uid !== 0 ||
      observation?.lockParent?.gid !== 0 ||
      normalizeMode(observation?.lockParent?.mode) !== '0555' ||
      observation?.lockAnchor?.uid !== 0 ||
      observation?.lockAnchor?.gid !== 0 ||
      normalizeMode(observation?.lockAnchor?.mode) !== '0444' ||
      observation?.lockAnchor?.isFile !== true
    ) {
      violations.push(`${profile}_root_owned_lock_anchor_invalid`);
    }
  }
  return { ok: violations.length === 0, violations };
}

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
