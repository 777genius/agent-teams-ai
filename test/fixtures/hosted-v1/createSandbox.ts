import { execFile } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const E2E_TEAM_NAME = 'sandbox-hosted-team';
export const E2E_TEAM_ID = `team_${'a'.repeat(32)}`;
export const E2E_WORKSPACE_ID = `workspace_${'c'.repeat(32)}`;
export const E2E_TEAM_RUNTIME_WORKSPACE_ID = `workspace_${'b'.repeat(32)}`;
export const E2E_RUNTIME_WORKSPACE_ID = '-workspaces-sandbox';
export const E2E_PROJECT_WORKSPACE_ID = `workspace_${'d'.repeat(32)}`;
export const E2E_FORBIDDEN_WORKSPACE_ID = `workspace_${'e'.repeat(32)}`;
export const E2E_BOOT_ID_PREFIX = 'boot_hosted-v1-e2e-';
const CREATED_AT = '2026-08-06T12:00:00.000Z';
export const HOSTED_V1_MOUNT_GENERATION_PURPOSE =
  'agent-teams.hosted-v1-e2e.mount-generation/v1' as const;
const HOSTED_V1_MOUNT_GENERATION_STATE_FILE = 'mount-generation.json';
const HOSTED_V1_MOUNT_GENERATION_LOCK_FILE = 'mount-generation.lock';
const HOSTED_V1_MOUNT_GENERATION_LOCK_TIMEOUT_MS = 5_000;

interface HostedV1MountGenerationState {
  readonly schemaVersion: 1;
  readonly purpose: typeof HOSTED_V1_MOUNT_GENERATION_PURPOSE;
  readonly marker: string;
  readonly generation: number;
}

interface HostedV1BootstrapRegistration {
  readonly mountBinding?: {
    readonly bootId?: unknown;
    readonly mountGeneration?: unknown;
    readonly observedAt?: unknown;
    readonly [key: string]: unknown;
  };
  readonly [key: string]: unknown;
}

interface HostedV1BootstrapDocument {
  readonly issuedAtMs?: unknown;
  readonly expiresAtMs?: unknown;
  readonly bootId?: unknown;
  readonly workspaceManifest?: {
    readonly registrations?: readonly HostedV1BootstrapRegistration[];
    readonly [key: string]: unknown;
  };
  readonly [key: string]: unknown;
}

export interface HostedV1Sandbox {
  readonly appDataDir: string;
  readonly bootstrap: string;
  readonly caddyDataDir: string;
  readonly claudeDir: string;
  readonly fakeRuntimeStateDir: string;
  readonly lifecycleHighWaterDir: string;
  readonly lifecycleLauncherDir: string;
  readonly lifecycleRunDir: string;
  readonly lifecycleTrustAnchor: string;
  readonly lifecycleTrustDir: string;
  readonly marker: string;
  readonly markerPath: string;
  readonly oidcAppDataDir: string;
  readonly runDir: string;
  readonly root: string;
  readonly workspaceDir: string;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

async function assertTempDescendant(root: string): Promise<void> {
  if (!isAbsolute(root)) throw new Error('hosted_e2e_root_not_canonical');
  const canonicalTemp = await realpath(tmpdir());
  const canonicalRoot = await realpath(root);
  const relation = relative(canonicalTemp, canonicalRoot);
  if (
    canonicalRoot !== root ||
    !relation ||
    relation === '..' ||
    relation.startsWith(`..${sep}`) ||
    isAbsolute(relation)
  ) {
    throw new Error('hosted_e2e_root_outside_temp');
  }
  const stat = await lstat(canonicalRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('hosted_e2e_root_invalid');
  }
}

export async function assertFreshHostedV1SandboxRoot(root: string): Promise<void> {
  await assertTempDescendant(root);
  if ((await readdir(root)).length !== 0) throw new Error('hosted_e2e_root_not_empty');
}

export async function assertHostedV1MarkerOwnedRoot(
  root: string,
  markerPath: string,
  expectedMarker: string
): Promise<void> {
  await assertTempDescendant(root);
  if (markerPath !== join(root, '.agent-teams-hosted-v1-e2e-owner.json')) {
    throw new Error('hosted_e2e_cleanup_marker_invalid');
  }
  const markerStat = await lstat(markerPath);
  if (!markerStat.isFile() || markerStat.isSymbolicLink()) {
    throw new Error('hosted_e2e_cleanup_marker_invalid');
  }
  const marker = JSON.parse(await readFile(markerPath, 'utf8')) as Record<string, unknown>;
  if (
    marker.schemaVersion !== 1 ||
    marker.purpose !== 'hosted-v1-browser-e2e' ||
    marker.marker !== expectedMarker ||
    !/^[0-9a-f]{48}$/.test(expectedMarker)
  ) {
    throw new Error('hosted_e2e_cleanup_marker_invalid');
  }
}

function parseHostedV1MountGenerationState(
  value: unknown,
  expectedMarker: string
): HostedV1MountGenerationState {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Reflect.ownKeys(value).length !== 4
  ) {
    throw new Error('hosted_e2e_mount_generation_state_invalid');
  }
  const state = value as Record<PropertyKey, unknown>;
  if (
    state.schemaVersion !== 1 ||
    state.purpose !== HOSTED_V1_MOUNT_GENERATION_PURPOSE ||
    state.marker !== expectedMarker ||
    !Number.isSafeInteger(state.generation) ||
    (state.generation as number) < 1
  ) {
    throw new Error('hosted_e2e_mount_generation_state_invalid');
  }
  return Object.freeze({
    schemaVersion: 1,
    purpose: HOSTED_V1_MOUNT_GENERATION_PURPOSE,
    marker: expectedMarker,
    generation: state.generation as number,
  });
}

async function readHostedV1MountGenerationState(
  statePath: string,
  expectedMarker: string
): Promise<HostedV1MountGenerationState> {
  const stat = await lstat(statePath);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size < 1 ||
    stat.size > 512 ||
    (stat.mode & 0o077) !== 0
  ) {
    throw new Error('hosted_e2e_mount_generation_state_invalid');
  }
  let value: unknown;
  try {
    value = JSON.parse(await readFile(statePath, 'utf8'));
  } catch {
    throw new Error('hosted_e2e_mount_generation_state_invalid');
  }
  return parseHostedV1MountGenerationState(value, expectedMarker);
}

async function replaceHostedV1MountGenerationState(
  statePath: string,
  state: HostedV1MountGenerationState
): Promise<void> {
  const stateRoot = resolve(statePath, '..');
  const temporaryPath = `${statePath}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
  try {
    const current = await lstat(statePath);
    const handle = await open(temporaryPath, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(state)}\n`, 'utf8');
      await handle.chown(current.uid, current.gid);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, statePath);
    const directory = await open(stateRoot, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

function parseHostedV1BootstrapForMountAdvance(
  bootstrap: string,
  currentGeneration: number,
  expectedBootId: string
): Readonly<{
  document: HostedV1BootstrapDocument;
  registration: HostedV1BootstrapRegistration;
}> {
  let value: unknown;
  try {
    value = JSON.parse(bootstrap);
  } catch {
    throw new Error('hosted_e2e_mount_generation_bootstrap_invalid');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('hosted_e2e_mount_generation_bootstrap_invalid');
  }
  const document = value as HostedV1BootstrapDocument;
  const registrations = document.workspaceManifest?.registrations;
  const registration = registrations?.length === 1 ? registrations[0] : undefined;
  const mountBinding = registration?.mountBinding;
  if (
    typeof document.bootId !== 'string' ||
    !/^boot_hosted-v1-e2e-[0-9a-f]{48}$/u.test(document.bootId) ||
    document.bootId !== expectedBootId ||
    !Number.isSafeInteger(document.issuedAtMs) ||
    !Number.isSafeInteger(document.expiresAtMs) ||
    registration === undefined ||
    mountBinding === undefined ||
    mountBinding.bootId !== document.bootId ||
    !Number.isSafeInteger(mountBinding.observedAt)
  ) {
    throw new Error('hosted_e2e_mount_generation_bootstrap_invalid');
  }
  if (mountBinding.mountGeneration !== currentGeneration) {
    if (
      Number.isSafeInteger(mountBinding.mountGeneration) &&
      (mountBinding.mountGeneration as number) < currentGeneration
    ) {
      throw new Error('hosted_e2e_mount_generation_stale');
    }
    throw new Error('hosted_e2e_mount_generation_bootstrap_invalid');
  }
  return Object.freeze({ document, registration });
}

async function acquireHostedV1MountGenerationLock(
  stateRoot: string
): Promise<Readonly<{ release(): Promise<void> }>> {
  const lockPath = join(stateRoot, HOSTED_V1_MOUNT_GENERATION_LOCK_FILE);
  const deadlineAtMs = Date.now() + HOSTED_V1_MOUNT_GENERATION_LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      let released = false;
      return Object.freeze({
        release: async () => {
          if (released) return;
          released = true;
          try {
            await handle.close();
          } finally {
            await rm(lockPath, { force: true });
          }
        },
      });
    } catch (error) {
      if (
        typeof error !== 'object' ||
        error === null ||
        !('code' in error) ||
        error.code !== 'EEXIST'
      ) {
        throw error;
      }
      if (Date.now() >= deadlineAtMs) {
        throw new Error('hosted_e2e_mount_generation_lock_timeout', { cause: error });
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
  }
}

/**
 * Advances the marker-owned fixture's mount epoch for a complete stack recreation. Fake-runtime
 * process-only restarts never call this driver, so WAL recovery retains the same mount authority.
 */
export async function advanceHostedV1MountGeneration(input: {
  readonly bootstrap: string;
  readonly fakeRuntimeStateDir: string;
  readonly markerPath: string;
  readonly nowMs?: number;
  readonly root: string;
}): Promise<Readonly<{ bootstrap: string; mountGeneration: number }>> {
  if (
    input.markerPath !== join(input.root, '.agent-teams-hosted-v1-e2e-owner.json') ||
    input.fakeRuntimeStateDir !== join(input.root, 'fake-runtime')
  ) {
    throw new Error('hosted_e2e_mount_generation_path_invalid');
  }
  const markerDocument = JSON.parse(await readFile(input.markerPath, 'utf8')) as {
    readonly marker?: unknown;
  };
  if (typeof markerDocument.marker !== 'string') {
    throw new Error('hosted_e2e_mount_generation_marker_invalid');
  }
  await assertHostedV1MarkerOwnedRoot(input.root, input.markerPath, markerDocument.marker);
  const stateRootStat = await lstat(input.fakeRuntimeStateDir);
  if (!stateRootStat.isDirectory() || stateRootStat.isSymbolicLink()) {
    throw new Error('hosted_e2e_mount_generation_path_invalid');
  }
  const lock = await acquireHostedV1MountGenerationLock(input.fakeRuntimeStateDir);
  try {
    const statePath = join(input.fakeRuntimeStateDir, HOSTED_V1_MOUNT_GENERATION_STATE_FILE);
    const current = await readHostedV1MountGenerationState(statePath, markerDocument.marker);
    const { document, registration } = parseHostedV1BootstrapForMountAdvance(
      input.bootstrap,
      current.generation,
      `${E2E_BOOT_ID_PREFIX}${markerDocument.marker}`
    );
    if (current.generation >= Number.MAX_SAFE_INTEGER) {
      throw new Error('hosted_e2e_mount_generation_exhausted');
    }
    const mountGeneration = current.generation + 1;
    const nowMs = input.nowMs ?? Date.now();
    if (
      !Number.isSafeInteger(nowMs) ||
      nowMs < 60_000 ||
      nowMs > Number.MAX_SAFE_INTEGER - 3_600_000
    ) {
      throw new Error('hosted_e2e_mount_generation_time_invalid');
    }
    const bootstrap = JSON.stringify({
      ...document,
      issuedAtMs: nowMs - 60_000,
      expiresAtMs: nowMs + 3_600_000,
      workspaceManifest: {
        ...document.workspaceManifest,
        registrations: [
          {
            ...registration,
            mountBinding: {
              ...registration.mountBinding,
              mountGeneration,
              observedAt: nowMs - 30_000,
            },
          },
        ],
      },
    });
    await replaceHostedV1MountGenerationState(statePath, {
      ...current,
      generation: mountGeneration,
    });
    return Object.freeze({ bootstrap, mountGeneration });
  } finally {
    await lock.release();
  }
}

export async function createHostedV1Sandbox(root: string): Promise<HostedV1Sandbox> {
  await assertFreshHostedV1SandboxRoot(root);
  const marker = randomBytes(24).toString('hex');
  const lifecycleTrustAnchor = randomBytes(32).toString('hex');
  const markerPath = join(root, '.agent-teams-hosted-v1-e2e-owner.json');
  const claudeDir = join(root, 'claude');
  const appDataDir = join(root, 'app-data');
  const oidcAppDataDir = join(root, 'oidc-app-data');
  const caddyDataDir = join(root, 'caddy-data');
  const fakeRuntimeStateDir = join(root, 'fake-runtime');
  const lifecycleHighWaterDir = join(root, 'lifecycle-high-water');
  const lifecycleLauncherDir = join(root, 'lifecycle-launcher');
  const lifecycleRunDir = join(root, 'lifecycle-run');
  const lifecycleTrustDir = join(root, 'lifecycle-trust');
  const runDir = join(root, 'run');
  const workspaceDir = join(root, 'workspace');
  const teamDir = join(claudeDir, 'teams', E2E_TEAM_NAME);
  const tasksDir = join(claudeDir, 'tasks', E2E_TEAM_NAME);
  const projectDir = join(claudeDir, 'projects', E2E_RUNTIME_WORKSPACE_ID);
  const storageDir = join(appDataDir, 'storage');
  const oidcStorageDir = join(oidcAppDataDir, 'storage');
  await writeFile(
    markerPath,
    `${JSON.stringify({ schemaVersion: 1, marker, purpose: 'hosted-v1-browser-e2e' })}\n`,
    { mode: 0o600 }
  );
  await Promise.all([
    mkdir(teamDir, { recursive: true }),
    mkdir(tasksDir, { recursive: true }),
    mkdir(projectDir, { recursive: true }),
    mkdir(storageDir, { recursive: true }),
    mkdir(join(appDataDir, 'logs'), { recursive: true }),
    mkdir(oidcStorageDir, { recursive: true }),
    mkdir(join(oidcAppDataDir, 'logs'), { recursive: true }),
    mkdir(caddyDataDir, { recursive: true }),
    mkdir(fakeRuntimeStateDir, { recursive: true }),
    mkdir(lifecycleHighWaterDir, { recursive: true }),
    mkdir(lifecycleLauncherDir, { recursive: true }),
    mkdir(lifecycleRunDir, { recursive: true }),
    mkdir(lifecycleTrustDir, { recursive: true }),
    mkdir(runDir, { recursive: true }),
    mkdir(workspaceDir, { recursive: true }),
  ]);
  await writeFile(
    join(fakeRuntimeStateDir, HOSTED_V1_MOUNT_GENERATION_STATE_FILE),
    `${JSON.stringify({
      schemaVersion: 1,
      purpose: HOSTED_V1_MOUNT_GENERATION_PURPOSE,
      marker,
      generation: 1,
    } satisfies HostedV1MountGenerationState)}\n`,
    { mode: 0o600 }
  );

  await writeFile(join(workspaceDir, 'README.md'), '# Marker-owned hosted v1 E2E workspace\n');
  await execFileAsync('git', ['init', '--quiet', '--initial-branch=main'], {
    cwd: workspaceDir,
  });
  await execFileAsync('git', ['add', 'README.md'], { cwd: workspaceDir });
  await execFileAsync(
    'git',
    [
      '-c',
      'user.name=Hosted V1 E2E',
      '-c',
      'user.email=hosted-v1-e2e.invalid',
      'commit',
      '--quiet',
      '-m',
      'Create marker-owned E2E workspace',
    ],
    { cwd: workspaceDir }
  );

  const identity = `${JSON.stringify(
    { schemaVersion: 1, teamId: E2E_TEAM_ID, createdAt: CREATED_AT },
    null,
    2
  )}\n`;
  await Promise.all([
    writeFile(join(teamDir, 'team.identity.json'), identity),
    writeFile(
      join(teamDir, 'config.json'),
      `${JSON.stringify({
        name: E2E_TEAM_NAME,
        members: [{ name: 'team-lead' }, { name: 'worker', memberId: `member_${'f'.repeat(32)}` }],
      })}\n`
    ),
    writeFile(
      join(tasksDir, '1.json'),
      `${JSON.stringify({
        id: '1',
        subject: 'Marker-owned browser E2E task',
        description: 'Sandbox task-board projection fixture',
        status: 'pending',
        blockedBy: [],
        blocks: [],
        related: [],
      })}\n`
    ),
    writeFile(
      join(projectDir, '00000000-0000-4000-8000-000000000001.jsonl'),
      `${JSON.stringify({ type: 'user', cwd: '/workspaces/sandbox', message: { content: 'fixture' } })}\n`
    ),
  ]);

  const now = Date.now();
  const bootId = `${E2E_BOOT_ID_PREFIX}${marker}`;
  const bootstrap = JSON.stringify({
    format: 'agent-teams.team-lifecycle-read-bootstrap/v1',
    issuedAtMs: now - 60_000,
    expiresAtMs: now + 3_600_000,
    actorId: `actor_hosted-v1-e2e-${marker}`,
    authorizedScope: 'scope_team-lifecycle.read',
    deploymentId: 'deployment_hosted-v1-e2e',
    bootId,
    workspaceId: E2E_TEAM_RUNTIME_WORKSPACE_ID,
    runtimeInstance: {
      deploymentId: 'deployment_hosted-v1-e2e',
      bootId,
      claudeRoot: { kind: 'claude', reference: '/data/.claude' },
      appDataRoot: { kind: 'app-data', reference: '/data/.agent-teams' },
      workspaceRoots: [{ kind: 'workspace', reference: '/workspaces/sandbox' }],
      tempRoot: { kind: 'temp', reference: '/tmp' },
      logsRoot: { kind: 'logs', reference: '/data/.agent-teams/logs' },
    },
    workspaceManifest: {
      version: 1,
      registrations: [
        {
          schemaVersion: 1,
          registrationKey: 'hosted-v1.e2e.sandbox',
          workspaceId: E2E_TEAM_RUNTIME_WORKSPACE_ID,
          displayName: 'Hosted v1 E2E sandbox',
          registrationRevision: 1,
          declaredRootHash: sha256('/workspaces/sandbox'),
          enabled: true,
          mountBinding: {
            bootId,
            mountGeneration: 1,
            observedAt: now - 30_000,
            health: 'healthy',
            allowedOperations: [],
          },
        },
      ],
    },
  });

  // Bounded-test-only launcher authority: provision the release pin and Ed25519 signing key before
  // the fake runtime starts. The private key is mounted only into that fake launcher/runtime
  // process, while the controller receives only the public pin and the separate frame-HMAC key.
  const lifecycleOwnerArtifactDigest = `sha256:${sha256(
    `agent-teams.hosted-v1-e2e.lifecycle-owner-artifact/v1\u0000${marker}`
  )}`;
  const lifecycleOwnerArtifact = {
    artifactDigest: lifecycleOwnerArtifactDigest,
    imageReference: `registry.invalid/agent-teams/hosted-v1-fake-runtime@${lifecycleOwnerArtifactDigest}`,
    artifactVersion: '1.0.0-e2e',
    protocolVersion: 2,
  };
  const lifecycleLauncherKeys = generateKeyPairSync('ed25519');
  const lifecycleLauncherPublicJwk = lifecycleLauncherKeys.publicKey.export({ format: 'jwk' });
  if (
    lifecycleLauncherPublicJwk.kty !== 'OKP' ||
    lifecycleLauncherPublicJwk.crv !== 'Ed25519' ||
    typeof lifecycleLauncherPublicJwk.x !== 'string'
  ) {
    throw new Error('hosted_e2e_lifecycle_launcher_public_key_invalid');
  }
  const lifecycleLauncherPublicKey = lifecycleLauncherPublicJwk.x;
  const lifecycleLauncherKeyId = sha256(Buffer.from(lifecycleLauncherPublicKey, 'base64url'));
  await Promise.all([
    writeFile(join(lifecycleTrustDir, 'trust-anchor'), `${lifecycleTrustAnchor}\n`, {
      mode: 0o400,
    }),
    writeFile(
      join(lifecycleTrustDir, 'release-owner-pin.json'),
      `${JSON.stringify({
        format: 'agent-teams.hosted-lifecycle-owner-release-pin/v2',
        artifact: lifecycleOwnerArtifact,
        launcher: {
          algorithm: 'ed25519',
          publicKey: lifecycleLauncherPublicKey,
          keyId: lifecycleLauncherKeyId,
        },
      })}\n`,
      { mode: 0o400 }
    ),
    writeFile(
      join(lifecycleLauncherDir, 'owner-admission-private-key.pem'),
      lifecycleLauncherKeys.privateKey.export({ format: 'pem', type: 'pkcs8' }),
      { mode: 0o400 }
    ),
  ]);

  await Promise.all([
    chmod(appDataDir, 0o770),
    chmod(storageDir, 0o770),
    chmod(join(appDataDir, 'logs'), 0o770),
    chmod(oidcAppDataDir, 0o770),
    chmod(oidcStorageDir, 0o770),
    chmod(join(oidcAppDataDir, 'logs'), 0o770),
    chmod(caddyDataDir, 0o770),
    chmod(fakeRuntimeStateDir, 0o770),
    chmod(lifecycleHighWaterDir, 0o700),
    chmod(lifecycleLauncherDir, 0o700),
    chmod(join(lifecycleLauncherDir, 'owner-admission-private-key.pem'), 0o400),
    chmod(lifecycleRunDir, 0o700),
    chmod(lifecycleTrustDir, 0o700),
    chmod(join(lifecycleTrustDir, 'trust-anchor'), 0o400),
    chmod(join(lifecycleTrustDir, 'release-owner-pin.json'), 0o400),
    chmod(runDir, 0o700),
  ]);
  await assertHostedV1MarkerOwnedRoot(root, markerPath, marker);
  return {
    appDataDir,
    bootstrap,
    caddyDataDir,
    claudeDir,
    fakeRuntimeStateDir,
    lifecycleHighWaterDir,
    lifecycleLauncherDir,
    lifecycleRunDir,
    lifecycleTrustAnchor,
    lifecycleTrustDir,
    marker,
    markerPath,
    oidcAppDataDir,
    runDir,
    root,
    workspaceDir,
  };
}
