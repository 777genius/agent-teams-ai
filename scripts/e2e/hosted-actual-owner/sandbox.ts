import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

import { ACTUAL_OWNER_PURPOSE } from './contracts';

export const ACTUAL_OWNER_MARKER_FILE = '.agent-teams-actual-owner-e2e-owner.json';
const execFileAsync = promisify(execFile);

export interface ActualOwnerSandbox {
  readonly captureRoot: string;
  readonly markerPath: string;
  readonly root: string;
  readonly rootDevice: string;
  readonly rootInode: string;
  readonly runId: string;
  readonly runtimeRoot: string;
  readonly workspaceRoot: string;
}

export interface ActualOwnerCleanupEvidence {
  readonly attempted: boolean;
  readonly markerVerified: boolean;
  readonly removed: boolean;
  readonly root: string;
  readonly runId: string;
  readonly retainedReason: string | null;
}

interface MarkerDocument {
  readonly schemaVersion: 1;
  readonly purpose: typeof ACTUAL_OWNER_PURPOSE;
  readonly runId: string;
  readonly rootBasename: string;
  readonly rootDevice: string;
  readonly rootInode: string;
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === 'ENOENT'
  );
}

function parseMarker(value: unknown): MarkerDocument {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('hosted_actual_owner_marker_invalid');
  }
  const marker = value as Record<string, unknown>;
  const keys = Object.keys(marker).sort();
  const expected = [
    'purpose',
    'rootBasename',
    'rootDevice',
    'rootInode',
    'runId',
    'schemaVersion',
  ].sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index]) ||
    marker.schemaVersion !== 1 ||
    marker.purpose !== ACTUAL_OWNER_PURPOSE ||
    typeof marker.runId !== 'string' ||
    !/^[0-9a-f]{48}$/u.test(marker.runId) ||
    typeof marker.rootBasename !== 'string' ||
    !/^actual-owner-[0-9a-f]{48}-[A-Za-z0-9]{6}$/u.test(marker.rootBasename) ||
    typeof marker.rootDevice !== 'string' ||
    !/^\d+$/u.test(marker.rootDevice) ||
    typeof marker.rootInode !== 'string' ||
    !/^\d+$/u.test(marker.rootInode)
  ) {
    throw new Error('hosted_actual_owner_marker_invalid');
  }
  return marker as unknown as MarkerDocument;
}

async function assertPrivateCanonicalDirectory(path: string, label: string): Promise<void> {
  if (!isAbsolute(path) || resolve(path) !== path || (await realpath(path)) !== path) {
    throw new Error(`hosted_actual_owner_${label}_not_canonical`);
  }
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new Error(`hosted_actual_owner_${label}_not_private`);
  }
}

export async function createActualOwnerSandbox(parent: string): Promise<ActualOwnerSandbox> {
  await assertPrivateCanonicalDirectory(parent, 'sandbox_parent');
  const runId = randomBytes(24).toString('hex');
  const root = await mkdtemp(join(parent, `actual-owner-${runId}-`));
  await chmod(root, 0o700);
  const canonicalRoot = await realpath(root);
  const relation = relative(parent, canonicalRoot);
  if (
    canonicalRoot !== root ||
    !relation ||
    relation === '..' ||
    relation.startsWith(`..${sep}`) ||
    isAbsolute(relation)
  ) {
    throw new Error('hosted_actual_owner_sandbox_outside_parent');
  }
  const rootStat = await lstat(root, { bigint: true });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('hosted_actual_owner_sandbox_root_invalid');
  }
  const markerPath = join(root, ACTUAL_OWNER_MARKER_FILE);
  const marker: MarkerDocument = Object.freeze({
    schemaVersion: 1,
    purpose: ACTUAL_OWNER_PURPOSE,
    runId,
    rootBasename: basename(root),
    rootDevice: rootStat.dev.toString(),
    rootInode: rootStat.ino.toString(),
  });
  const markerHandle = await open(
    markerPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
    0o600
  );
  try {
    await markerHandle.writeFile(`${JSON.stringify(marker)}\n`, 'utf8');
    await markerHandle.sync();
  } finally {
    await markerHandle.close();
  }
  const runtimeRoot = join(root, 'runtime');
  const workspaceRoot = join(root, 'workspace', 'project');
  const captureRoot = join(root, 'capture');
  await Promise.all([
    mkdir(runtimeRoot, { recursive: true, mode: 0o700 }),
    mkdir(workspaceRoot, { recursive: true, mode: 0o700 }),
    mkdir(captureRoot, { recursive: true, mode: 0o700 }),
    mkdir(join(root, 'browser'), { recursive: true, mode: 0o700 }),
    mkdir(join(root, 'logs'), { recursive: true, mode: 0o700 }),
    mkdir(join(root, 'home'), { recursive: true, mode: 0o700 }),
    mkdir(join(root, 'tmp'), { recursive: true, mode: 0o700 }),
  ]);
  const sandbox = Object.freeze({
    captureRoot,
    markerPath,
    root,
    rootDevice: marker.rootDevice,
    rootInode: marker.rootInode,
    runId,
    runtimeRoot,
    workspaceRoot,
  });
  await assertActualOwnerMarkerOwnedRoot(sandbox);
  return sandbox;
}

export async function assertActualOwnerMarkerOwnedRoot(sandbox: ActualOwnerSandbox): Promise<void> {
  if (
    sandbox.markerPath !== join(sandbox.root, ACTUAL_OWNER_MARKER_FILE) ||
    !isAbsolute(sandbox.root) ||
    resolve(sandbox.root) !== sandbox.root ||
    (await realpath(sandbox.root)) !== sandbox.root
  ) {
    throw new Error('hosted_actual_owner_cleanup_scope_invalid');
  }
  const [rootStat, markerStat] = await Promise.all([
    lstat(sandbox.root, { bigint: true }),
    lstat(sandbox.markerPath, { bigint: true }),
  ]);
  if (
    !rootStat.isDirectory() ||
    rootStat.isSymbolicLink() ||
    rootStat.dev.toString() !== sandbox.rootDevice ||
    rootStat.ino.toString() !== sandbox.rootInode ||
    !markerStat.isFile() ||
    markerStat.isSymbolicLink() ||
    markerStat.nlink !== 1n ||
    Number(markerStat.mode & 0o777n) !== 0o600 ||
    markerStat.size < 2n ||
    markerStat.size > 1_024n
  ) {
    throw new Error('hosted_actual_owner_cleanup_scope_invalid');
  }
  let marker: MarkerDocument;
  try {
    marker = parseMarker(JSON.parse(await readFile(sandbox.markerPath, 'utf8')));
  } catch (error) {
    throw new Error('hosted_actual_owner_marker_invalid', { cause: error });
  }
  if (
    marker.runId !== sandbox.runId ||
    marker.rootBasename !== basename(sandbox.root) ||
    marker.rootDevice !== sandbox.rootDevice ||
    marker.rootInode !== sandbox.rootInode
  ) {
    throw new Error('hosted_actual_owner_marker_binding_mismatch');
  }
}

export async function initializeActualOwnerSandboxProject(
  sandbox: ActualOwnerSandbox
): Promise<void> {
  await assertActualOwnerMarkerOwnedRoot(sandbox);
  const projectMarker = Object.freeze({
    schemaVersion: 1,
    purpose: ACTUAL_OWNER_PURPOSE,
    runId: sandbox.runId,
    ownerMarkerPath: sandbox.markerPath,
  });
  await Promise.all([
    writeFile(
      join(sandbox.workspaceRoot, '.agent-teams-actual-owner-sandbox.json'),
      `${JSON.stringify(projectMarker)}\n`,
      { flag: 'wx', mode: 0o600 }
    ),
    writeFile(
      join(sandbox.workspaceRoot, 'README.md'),
      '# Marker-owned actual-owner E2E sandbox\n',
      { flag: 'wx', mode: 0o600 }
    ),
  ]);
  await execFileAsync('/usr/bin/git', ['init', '--quiet', '--initial-branch=main'], {
    cwd: sandbox.workspaceRoot,
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
  });
  await execFileAsync('/usr/bin/git', ['add', '--', 'README.md', '.agent-teams-actual-owner-sandbox.json'], {
    cwd: sandbox.workspaceRoot,
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
  });
  await execFileAsync(
    '/usr/bin/git',
    [
      '-c',
      'user.name=Actual Owner E2E',
      '-c',
      'user.email=actual-owner-e2e.invalid',
      'commit',
      '--quiet',
      '-m',
      'Create marker-owned actual-owner sandbox',
    ],
    {
      cwd: sandbox.workspaceRoot,
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
    }
  );
}

export async function cleanupActualOwnerSandbox(
  sandbox: ActualOwnerSandbox,
  removeRoot: (path: string) => Promise<void> = (path) => rm(path, { recursive: true })
): Promise<ActualOwnerCleanupEvidence> {
  try {
    await assertActualOwnerMarkerOwnedRoot(sandbox);
  } catch (error) {
    return Object.freeze({
      attempted: true,
      markerVerified: false,
      removed: false,
      root: sandbox.root,
      runId: sandbox.runId,
      retainedReason: error instanceof Error ? error.message : 'marker_verification_failed',
    });
  }
  try {
    const stagingRoot = await mkdtemp(
      join(dirname(sandbox.root), `.actual-owner-cleanup-${sandbox.runId}-`)
    );
    await chmod(stagingRoot, 0o700);
    const movedRoot = join(stagingRoot, basename(sandbox.root));
    await rename(sandbox.root, movedRoot);
    const movedStat = await lstat(movedRoot, { bigint: true });
    if (
      !movedStat.isDirectory() ||
      movedStat.isSymbolicLink() ||
      movedStat.dev.toString() !== sandbox.rootDevice ||
      movedStat.ino.toString() !== sandbox.rootInode
    ) {
      throw new Error('hosted_actual_owner_cleanup_inode_changed');
    }
    await removeRoot(movedRoot);
    const [current, movedCurrent] = await Promise.all([
      lstat(sandbox.root).catch((error: unknown) => {
        if (isMissing(error)) return null;
        throw error;
      }),
      lstat(movedRoot).catch((error: unknown) => {
        if (isMissing(error)) return null;
        throw error;
      }),
    ]);
    if (current !== null || movedCurrent !== null) {
      throw new Error('hosted_actual_owner_cleanup_incomplete');
    }
    await rmdir(stagingRoot);
    const stagingCurrent = await lstat(stagingRoot).catch((error: unknown) => {
      if (isMissing(error)) return null;
      throw error;
    });
    if (stagingCurrent !== null) throw new Error('hosted_actual_owner_cleanup_staging_retained');
    return Object.freeze({
      attempted: true,
      markerVerified: true,
      removed: true,
      root: sandbox.root,
      runId: sandbox.runId,
      retainedReason: null,
    });
  } catch (error) {
    return Object.freeze({
      attempted: true,
      markerVerified: true,
      removed: false,
      root: sandbox.root,
      runId: sandbox.runId,
      retainedReason: error instanceof Error ? error.message : 'cleanup_failed',
    });
  }
}

export function isPathWithinActualOwnerSandbox(path: string, sandbox: ActualOwnerSandbox): boolean {
  if (!isAbsolute(path) || resolve(path) !== path) return false;
  const relation = relative(sandbox.root, path);
  return relation !== '' && relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation);
}
