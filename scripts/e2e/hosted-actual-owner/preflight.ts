import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import { promisify } from 'node:util';

import {
  assertCanonicalAbsolutePath,
  assertFullGitRef,
  assertSha256,
  type ActualOwnerCliOptions,
} from './contracts';

const execFileAsync = promisify(execFile);
const MAX_MANIFEST_BYTES = 1024 * 1024;

export interface ActualOwnerRepositoryEvidence {
  readonly head: string;
  readonly root: string;
  readonly status: 'clean';
}

export interface ActualOwnerArtifactEvidence {
  readonly device: string;
  readonly executable: string;
  readonly inode: string;
  readonly mode: number;
  readonly sha256: string;
  readonly size: number;
  readonly sourceCommit: string;
}

export interface ActualOwnerPreflightEvidence {
  readonly artifact: ActualOwnerArtifactEvidence;
  readonly orchestrator: ActualOwnerRepositoryEvidence;
  readonly product: ActualOwnerRepositoryEvidence;
  readonly orchestratorAcceptanceEntry: string;
  readonly orchestratorSourceLauncher: string;
}

async function git(root: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync('/usr/bin/git', ['-C', root, ...args], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
  });
  return result.stdout.trim();
}

async function sha256FileHandle(handle: FileHandle): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolveStream, rejectStream) => {
    const stream = createReadStream('/dev/null', { fd: handle.fd, autoClose: false });
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', rejectStream);
    stream.once('end', resolveStream);
  });
  return hash.digest('hex');
}

function inside(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation !== '' && relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation);
}

export async function assertCleanExactRepository(
  root: string,
  expectedRef: string,
  label: string
): Promise<ActualOwnerRepositoryEvidence> {
  assertCanonicalAbsolutePath(root, `${label}_root`);
  assertFullGitRef(expectedRef, label);
  if ((await realpath(root)) !== root) throw new Error(`hosted_actual_owner_${label}_root_not_canonical`);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`hosted_actual_owner_${label}_root_invalid`);
  }
  const [topLevel, head, status, objectType] = await Promise.all([
    git(root, ['rev-parse', '--show-toplevel']),
    git(root, ['rev-parse', 'HEAD']),
    git(root, ['status', '--porcelain=v1', '--untracked-files=all']),
    git(root, ['cat-file', '-t', expectedRef]),
  ]);
  if (topLevel !== root || head !== expectedRef || objectType !== 'commit') {
    throw new Error(`hosted_actual_owner_${label}_ref_mismatch`);
  }
  if (status !== '') throw new Error(`hosted_actual_owner_${label}_dirty`);
  return Object.freeze({ head, root, status: 'clean' });
}

async function assertTrackedSourceFile(
  repositoryRoot: string,
  path: string,
  label: string,
  executable: boolean
): Promise<void> {
  assertCanonicalAbsolutePath(path, label);
  if ((await realpath(path)) !== path || !inside(repositoryRoot, path)) {
    throw new Error(`hosted_actual_owner_${label}_outside_repository`);
  }
  const stat = await lstat(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    (executable && (stat.mode & 0o111) === 0) ||
    (stat.mode & 0o022) !== 0
  ) {
    throw new Error(`hosted_actual_owner_${label}_invalid`);
  }
  const repositoryPath = relative(repositoryRoot, path);
  await git(repositoryRoot, ['ls-files', '--error-unmatch', '--', repositoryPath]);
}

function exactObject(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`hosted_actual_owner_${label}_invalid`);
  }
  const result = value as Record<string, unknown>;
  const actual = Object.keys(result).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`hosted_actual_owner_${label}_invalid`);
  }
  return result;
}

async function readReleaseSourceCommit(
  path: string,
  expectedRef: string,
  expectedSha256: string,
  expectedSize: number
): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size < 2 ||
      stat.size > MAX_MANIFEST_BYTES ||
      (stat.mode & 0o022) !== 0
    ) {
      throw new Error('hosted_actual_owner_release_manifest_invalid');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await handle.readFile({ encoding: 'utf8' }));
    } catch (error) {
      throw new Error('hosted_actual_owner_release_manifest_invalid', { cause: error });
    }
    const manifest = exactObject(parsed, ['schemaVersion', 'release', 'workflow', 'assets'], 'release_manifest');
    if (manifest.schemaVersion !== 1) throw new Error('hosted_actual_owner_release_manifest_invalid');
    const release = manifest.release;
    if (typeof release !== 'object' || release === null || Array.isArray(release)) {
      throw new Error('hosted_actual_owner_release_manifest_invalid');
    }
    const sourceCommit = (release as Record<string, unknown>).sourceCommit;
    if (sourceCommit !== expectedRef) throw new Error('hosted_actual_owner_release_source_mismatch');
    if (!Array.isArray(manifest.assets)) throw new Error('hosted_actual_owner_release_manifest_invalid');
    const matchingAssets = manifest.assets.filter((value) => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
      const asset = value as Record<string, unknown>;
      return asset.binarySha256 === expectedSha256 && asset.binarySize === expectedSize;
    });
    if (matchingAssets.length !== 1) {
      throw new Error('hosted_actual_owner_release_artifact_binding_mismatch');
    }
    return expectedRef;
  } finally {
    await handle.close();
  }
}

export async function verifyActualOwnerArtifact(input: {
  readonly executable: string;
  readonly expectedSha256: string;
  readonly releaseManifest: string;
  readonly sourceRef: string;
}): Promise<ActualOwnerArtifactEvidence> {
  assertCanonicalAbsolutePath(input.executable, 'opencode_executable');
  assertCanonicalAbsolutePath(input.releaseManifest, 'opencode_release_manifest');
  assertSha256(input.expectedSha256, 'opencode_executable');
  assertFullGitRef(input.sourceRef, 'opencode');
  if ((await realpath(input.executable)) !== input.executable) {
    throw new Error('hosted_actual_owner_opencode_executable_not_canonical');
  }
  const handle = await open(input.executable, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat({ bigint: true });
    if (
      !stat.isFile() ||
      stat.nlink !== 1n ||
      Number(stat.mode & 0o111n) === 0 ||
      Number(stat.mode & 0o022n) !== 0 ||
      stat.size < 1n ||
      stat.size > BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      throw new Error('hosted_actual_owner_opencode_executable_invalid');
    }
    const [sha256, sourceCommit] = await Promise.all([
      sha256FileHandle(handle),
      readReleaseSourceCommit(
        input.releaseManifest,
        input.sourceRef,
        input.expectedSha256,
        Number(stat.size)
      ),
    ]);
    if (sha256 !== input.expectedSha256) {
      throw new Error('hosted_actual_owner_opencode_executable_digest_mismatch');
    }
    return Object.freeze({
      device: stat.dev.toString(),
      executable: input.executable,
      inode: stat.ino.toString(),
      mode: Number(stat.mode & 0o777n),
      sha256,
      size: Number(stat.size),
      sourceCommit,
    });
  } finally {
    await handle.close();
  }
}

export async function runActualOwnerPreflight(
  options: ActualOwnerCliOptions
): Promise<ActualOwnerPreflightEvidence> {
  const [product, orchestrator, artifact] = await Promise.all([
    assertCleanExactRepository(options.productRoot, options.productRef, 'product'),
    assertCleanExactRepository(options.orchestratorRoot, options.orchestratorRef, 'orchestrator'),
    verifyActualOwnerArtifact({
      executable: options.openCodeExecutable,
      expectedSha256: options.openCodeSha256,
      releaseManifest: options.openCodeReleaseManifest,
      sourceRef: options.openCodeSourceRef,
    }),
  ]);
  await Promise.all([
    assertTrackedSourceFile(
      options.orchestratorRoot,
      options.orchestratorSourceLauncher,
      'orchestrator_source_launcher',
      true
    ),
    assertTrackedSourceFile(
      options.orchestratorRoot,
      options.orchestratorAcceptanceEntry,
      'orchestrator_acceptance_entry',
      false
    ),
  ]);
  const launcherName = options.orchestratorSourceLauncher.split('/').at(-1);
  if (launcherName !== 'cli-source') {
    throw new Error('hosted_actual_owner_orchestrator_built_launcher_forbidden');
  }
  const entryRelation = relative(options.orchestratorRoot, options.orchestratorAcceptanceEntry);
  if (
    !/^scripts\/e2e\/hosted-actual-owner(?:\/|-owner\.)/u.test(entryRelation) ||
    !/\.(?:ts|tsx)$/u.test(entryRelation)
  ) {
    throw new Error('hosted_actual_owner_orchestrator_acceptance_entry_scope_invalid');
  }
  return Object.freeze({
    artifact,
    orchestrator,
    product,
    orchestratorAcceptanceEntry: options.orchestratorAcceptanceEntry,
    orchestratorSourceLauncher: options.orchestratorSourceLauncher,
  });
}

export async function assertPrivateCanonicalManifest(path: string): Promise<unknown> {
  assertCanonicalAbsolutePath(path, 'integration_manifest');
  if ((await realpath(path)) !== path) throw new Error('hosted_actual_owner_integration_manifest_not_canonical');
  const stat = await lstat(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size < 2 ||
    stat.size > MAX_MANIFEST_BYTES ||
    (stat.mode & 0o077) !== 0
  ) {
    throw new Error('hosted_actual_owner_integration_manifest_not_private');
  }
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new Error('hosted_actual_owner_integration_manifest_invalid', { cause: error });
  }
}
