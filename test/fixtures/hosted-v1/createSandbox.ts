import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const E2E_TEAM_NAME = 'sandbox-hosted-team';
export const E2E_TEAM_ID = `team_${'a'.repeat(32)}`;
export const E2E_WORKSPACE_ID = `workspace_${'c'.repeat(32)}`;
export const E2E_RUNTIME_WORKSPACE_ID = '-workspaces-sandbox';
export const E2E_BOOT_ID_PREFIX = 'boot_hosted-v1-e2e-';
const CREATED_AT = '2026-08-06T12:00:00.000Z';

export interface HostedV1Sandbox {
  readonly appDataDir: string;
  readonly bootstrap: string;
  readonly caddyDataDir: string;
  readonly claudeDir: string;
  readonly fakeRuntimeStateDir: string;
  readonly marker: string;
  readonly markerPath: string;
  readonly oidcAppDataDir: string;
  readonly runDir: string;
  readonly root: string;
  readonly workspaceDir: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
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

export async function createHostedV1Sandbox(root: string): Promise<HostedV1Sandbox> {
  await assertFreshHostedV1SandboxRoot(root);
  const marker = randomBytes(24).toString('hex');
  const markerPath = join(root, '.agent-teams-hosted-v1-e2e-owner.json');
  const claudeDir = join(root, 'claude');
  const appDataDir = join(root, 'app-data');
  const oidcAppDataDir = join(root, 'oidc-app-data');
  const caddyDataDir = join(root, 'caddy-data');
  const fakeRuntimeStateDir = join(root, 'fake-runtime');
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
    mkdir(runDir, { recursive: true }),
    mkdir(workspaceDir, { recursive: true }),
  ]);

  await writeFile(join(workspaceDir, 'README.md'), '# Marker-owned hosted v1 E2E workspace\n');
  await execFileAsync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: workspaceDir });
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
    writeFile(join(teamDir, 'config.json'), `${JSON.stringify({ name: E2E_TEAM_NAME })}\n`),
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
    workspaceId: E2E_WORKSPACE_ID,
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
          workspaceId: E2E_WORKSPACE_ID,
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

  await Promise.all([
    chmod(appDataDir, 0o770),
    chmod(storageDir, 0o770),
    chmod(join(appDataDir, 'logs'), 0o770),
    chmod(oidcAppDataDir, 0o770),
    chmod(oidcStorageDir, 0o770),
    chmod(join(oidcAppDataDir, 'logs'), 0o770),
    chmod(caddyDataDir, 0o770),
    chmod(fakeRuntimeStateDir, 0o770),
    chmod(runDir, 0o700),
  ]);
  await assertHostedV1MarkerOwnedRoot(root, markerPath, marker);
  return {
    appDataDir,
    bootstrap,
    caddyDataDir,
    claudeDir,
    fakeRuntimeStateDir,
    marker,
    markerPath,
    oidcAppDataDir,
    runDir,
    root,
    workspaceDir,
  };
}
