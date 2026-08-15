import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, createReadStream, type Stats } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import { promisify } from 'node:util';

import {
  ACTUAL_OWNER_CONTRACT_BYTE_COUNT,
  ACTUAL_OWNER_CONTRACT_GIT_BLOB,
  ACTUAL_OWNER_CONTRACT_REPOSITORY_PATH,
  ACTUAL_OWNER_CONTRACT_SHA256,
  assertCanonicalAbsolutePath,
  assertFullGitRef,
  assertSha256,
  parseActualOwnerContractBundle,
  type ActualOwnerCliOptions,
} from './contracts';

const execFileAsync = promisify(execFile);
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_PLAYWRIGHT_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_EXECUTABLE_BYTES = 1024 * 1024 * 1024;

export interface ActualOwnerRepositoryEvidence {
  readonly head: string;
  readonly root: string;
  readonly status: 'clean';
}

export interface ActualOwnerArtifactEvidence {
  readonly ctimeNs: string;
  readonly device: string;
  readonly executable: string;
  readonly gid: string;
  readonly inode: string;
  readonly mode: number;
  readonly mtimeNs: string;
  readonly nlink: string;
  readonly sha256: string;
  readonly size: number;
  readonly sourceCommit: string;
  readonly uid: string;
}

export interface ActualOwnerExecutableEvidence {
  readonly ctimeNs: string;
  readonly device: string;
  readonly executable: string;
  readonly gid: string;
  readonly inode: string;
  readonly mode: number;
  readonly mtimeNs: string;
  readonly nlink: string;
  readonly sha256: string;
  readonly size: number;
  readonly sourceCommit: string;
  readonly uid: string;
}

export interface ActualOwnerSourceFileEvidence {
  readonly device: string;
  readonly inode: string;
  readonly gitBlob: string;
  readonly mode: number;
  readonly path: string;
  readonly repositoryPath: string;
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
  readonly productExecutable: ActualOwnerExecutableEvidence;
  readonly productContractSource: ActualOwnerSourceFileEvidence;
  readonly orchestratorAcceptanceSource: ActualOwnerSourceFileEvidence;
  readonly orchestratorLauncherSource: ActualOwnerSourceFileEvidence;
  readonly playwrightReleaseManifest: Readonly<{
    readonly byteCount: number;
    readonly sha256: string;
    readonly value: unknown;
  }>;
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

type StableFileStat = Stats;

function sameStableFile(before: StableFileStat, after: StableFileStat): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.mode === after.mode &&
    before.nlink === after.nlink &&
    before.uid === after.uid &&
    before.gid === after.gid &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  );
}

async function readStableDescriptor(
  path: string,
  label: string,
  validate: (stat: StableFileStat) => boolean
): Promise<Readonly<{ bytes: Buffer; stat: StableFileStat }>> {
  assertCanonicalAbsolutePath(path, label);
  if ((await realpath(path)) !== path)
    throw new Error(`hosted_actual_owner_${label}_not_canonical`);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!validate(before)) throw new Error(`hosted_actual_owner_${label}_invalid`);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (!sameStableFile(before, after) || bytes.byteLength !== before.size) {
      throw new Error(`hosted_actual_owner_${label}_rotated`);
    }
    return Object.freeze({ bytes, stat: before });
  } finally {
    await handle.close();
  }
}

function inside(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return (
    relation !== '' &&
    relation !== '..' &&
    !relation.startsWith(`..${sep}`) &&
    !isAbsolute(relation)
  );
}

export async function assertCleanExactRepository(
  root: string,
  expectedRef: string,
  label: string
): Promise<ActualOwnerRepositoryEvidence> {
  assertCanonicalAbsolutePath(root, `${label}_root`);
  assertFullGitRef(expectedRef, label);
  if ((await realpath(root)) !== root)
    throw new Error(`hosted_actual_owner_${label}_root_not_canonical`);
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

export async function assertTrackedSourceFile(
  repositoryRoot: string,
  path: string,
  label: string,
  executable: boolean,
  expectedRef: string
): Promise<ActualOwnerSourceFileEvidence> {
  assertCanonicalAbsolutePath(path, label);
  assertFullGitRef(expectedRef, label);
  if ((await realpath(path)) !== path || !inside(repositoryRoot, path)) {
    throw new Error(`hosted_actual_owner_${label}_outside_repository`);
  }
  const { bytes, stat } = await readStableDescriptor(
    path,
    label,
    (candidate) =>
      candidate.isFile() &&
      candidate.nlink === 1 &&
      (!executable || (candidate.mode & 0o111) !== 0) &&
      (candidate.mode & 0o022) === 0
  );
  if (stat.isSymbolicLink()) {
    throw new Error(`hosted_actual_owner_${label}_invalid`);
  }
  const repositoryPath = relative(repositoryRoot, path);
  await git(repositoryRoot, ['ls-files', '--error-unmatch', '--', repositoryPath]);
  const blob = await execFileAsync(
    '/usr/bin/git',
    ['-C', repositoryRoot, 'show', `${expectedRef}:${repositoryPath}`],
    {
      encoding: null,
      maxBuffer: 16 * 1024 * 1024,
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
    }
  );
  if (!Buffer.from(blob.stdout).equals(bytes)) {
    throw new Error(`hosted_actual_owner_${label}_git_blob_mismatch`);
  }
  const gitBlob = await git(repositoryRoot, ['rev-parse', `${expectedRef}:${repositoryPath}`]);
  if ((await git(repositoryRoot, ['rev-parse', 'HEAD'])) !== expectedRef) {
    throw new Error(`hosted_actual_owner_${label}_repository_rotated`);
  }
  return Object.freeze({
    device: String(stat.dev),
    inode: String(stat.ino),
    gitBlob,
    mode: stat.mode & 0o777,
    path,
    repositoryPath,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.byteLength,
    sourceCommit: expectedRef,
  });
}

function exactObject(
  value: unknown,
  keys: readonly string[],
  label: string
): Record<string, unknown> {
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
  expectedSize: number,
  contract?: Readonly<{
    sha256: string;
    byteCount: number;
    gitBlob: string;
    repositoryPath: string;
    playwrightReleaseManifest: Readonly<{ byteCount: number; sha256: string }>;
  }>
): Promise<string> {
  const { bytes } = await readStableDescriptor(
    path,
    'release_manifest',
    (stat) =>
      stat.isFile() &&
      stat.nlink === 1 &&
      stat.size >= 2 &&
      stat.size <= MAX_MANIFEST_BYTES &&
      (stat.mode & 0o022) === 0
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error('hosted_actual_owner_release_manifest_invalid', { cause: error });
  }
  const manifest = exactObject(
    parsed,
    contract
      ? [
          'schemaVersion',
          'release',
          'workflow',
          'assets',
          'actualOwnerContract',
          'playwrightReleaseManifest',
        ]
      : ['schemaVersion', 'release', 'workflow', 'assets'],
    'release_manifest'
  );
  if (manifest.schemaVersion !== 1) throw new Error('hosted_actual_owner_release_manifest_invalid');
  const release = exactObject(manifest.release, ['sourceCommit'], 'release');
  exactObject(manifest.workflow, ['name'], 'release_workflow');
  if (release.sourceCommit !== expectedRef)
    throw new Error('hosted_actual_owner_release_source_mismatch');
  if (!Array.isArray(manifest.assets) || manifest.assets.length !== 1) {
    throw new Error('hosted_actual_owner_release_manifest_invalid');
  }
  const asset = exactObject(manifest.assets[0], ['binarySha256', 'binarySize'], 'release_asset');
  if (asset.binarySha256 !== expectedSha256 || asset.binarySize !== expectedSize) {
    throw new Error('hosted_actual_owner_release_artifact_binding_mismatch');
  }
  if (contract) {
    const bound = exactObject(
      manifest.actualOwnerContract,
      ['repositoryPath', 'sha256', 'byteCount', 'gitBlob'],
      'release_actual_owner_contract'
    );
    if (
      bound.repositoryPath !== contract.repositoryPath ||
      bound.sha256 !== contract.sha256 ||
      bound.byteCount !== contract.byteCount ||
      bound.gitBlob !== contract.gitBlob
    ) {
      throw new Error('hosted_actual_owner_release_contract_binding_mismatch');
    }
    const playwright = exactObject(
      manifest.playwrightReleaseManifest,
      ['sha256', 'byteCount'],
      'release_playwright_manifest'
    );
    if (
      playwright.sha256 !== contract.playwrightReleaseManifest.sha256 ||
      playwright.byteCount !== contract.playwrightReleaseManifest.byteCount
    ) {
      throw new Error('hosted_actual_owner_release_playwright_binding_mismatch');
    }
  }
  return expectedRef;
}

export async function verifyProductExecutable(input: {
  readonly executable: string;
  readonly expectedSha256: string;
  readonly releaseManifest: string;
  readonly sourceRef: string;
  readonly contract: Readonly<{
    sha256: string;
    byteCount: number;
    gitBlob: string;
    repositoryPath: string;
    playwrightReleaseManifest: Readonly<{ byteCount: number; sha256: string }>;
  }>;
}): Promise<ActualOwnerExecutableEvidence> {
  assertCanonicalAbsolutePath(input.executable, 'product_executable');
  assertSha256(input.expectedSha256, 'product_executable');
  assertCanonicalAbsolutePath(input.releaseManifest, 'product_release_manifest');
  assertFullGitRef(input.sourceRef, 'product');
  if ((await realpath(input.executable)) !== input.executable) {
    throw new Error('hosted_actual_owner_product_executable_not_canonical');
  }
  const handle = await open(input.executable, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat({ bigint: true });
    if (
      !stat.isFile() ||
      stat.nlink !== 1n ||
      Number(stat.mode & 0o111n) === 0 ||
      Number(stat.mode & 0o022n) !== 0 ||
      (stat.uid !== 0n && stat.uid !== BigInt(process.getuid?.() ?? -1)) ||
      stat.size < 1n ||
      stat.size > BigInt(MAX_EXECUTABLE_BYTES)
    ) {
      throw new Error('hosted_actual_owner_product_executable_invalid');
    }
    const sha256 = await sha256FileHandle(handle);
    if (sha256 !== input.expectedSha256) {
      throw new Error('hosted_actual_owner_product_executable_digest_mismatch');
    }
    const after = await handle.stat({ bigint: true });
    if (
      after.dev !== stat.dev ||
      after.ino !== stat.ino ||
      after.mode !== stat.mode ||
      after.nlink !== stat.nlink ||
      after.uid !== stat.uid ||
      after.gid !== stat.gid ||
      after.size !== stat.size ||
      after.mtimeNs !== stat.mtimeNs ||
      after.ctimeNs !== stat.ctimeNs
    ) {
      throw new Error('hosted_actual_owner_product_executable_rotated');
    }
    const sourceCommit = await readReleaseSourceCommit(
      input.releaseManifest,
      input.sourceRef,
      input.expectedSha256,
      Number(stat.size),
      input.contract
    );
    return Object.freeze({
      ctimeNs: stat.ctimeNs.toString(),
      device: stat.dev.toString(),
      executable: input.executable,
      gid: stat.gid.toString(),
      inode: stat.ino.toString(),
      mode: Number(stat.mode & 0o777n),
      mtimeNs: stat.mtimeNs.toString(),
      nlink: stat.nlink.toString(),
      sha256,
      size: Number(stat.size),
      sourceCommit,
      uid: stat.uid.toString(),
    });
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
    const sha256 = await sha256FileHandle(handle);
    if (sha256 !== input.expectedSha256) {
      throw new Error('hosted_actual_owner_opencode_executable_digest_mismatch');
    }
    const after = await handle.stat({ bigint: true });
    if (
      after.dev !== stat.dev ||
      after.ino !== stat.ino ||
      after.mode !== stat.mode ||
      after.nlink !== stat.nlink ||
      after.uid !== stat.uid ||
      after.gid !== stat.gid ||
      after.size !== stat.size ||
      after.mtimeNs !== stat.mtimeNs ||
      after.ctimeNs !== stat.ctimeNs
    ) {
      throw new Error('hosted_actual_owner_opencode_executable_rotated');
    }
    const sourceCommit = await readReleaseSourceCommit(
      input.releaseManifest,
      input.sourceRef,
      input.expectedSha256,
      Number(stat.size)
    );
    return Object.freeze({
      ctimeNs: stat.ctimeNs.toString(),
      device: stat.dev.toString(),
      executable: input.executable,
      gid: stat.gid.toString(),
      inode: stat.ino.toString(),
      mode: Number(stat.mode & 0o777n),
      mtimeNs: stat.mtimeNs.toString(),
      nlink: stat.nlink.toString(),
      sha256,
      size: Number(stat.size),
      sourceCommit,
      uid: stat.uid.toString(),
    });
  } finally {
    await handle.close();
  }
}

export async function runActualOwnerPreflight(
  options: ActualOwnerCliOptions,
  productExecutable: { readonly executable: string; readonly expectedSha256: string }
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
  const [orchestratorLauncherSource, orchestratorAcceptanceSource, productContractSource] =
    await Promise.all([
      assertTrackedSourceFile(
        options.orchestratorRoot,
        options.orchestratorSourceLauncher,
        'orchestrator_source_launcher',
        true,
        options.orchestratorRef
      ),
      assertTrackedSourceFile(
        options.orchestratorRoot,
        options.orchestratorAcceptanceEntry,
        'orchestrator_acceptance_entry',
        false,
        options.orchestratorRef
      ),
      assertTrackedSourceFile(
        options.productRoot,
        `${options.productRoot}/${ACTUAL_OWNER_CONTRACT_REPOSITORY_PATH}`,
        'product_contract_bundle',
        false,
        options.productRef
      ),
    ]);
  const contractHandle = await open(
    productContractSource.path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
  );
  let contract;
  try {
    contract = parseActualOwnerContractBundle(await contractHandle.readFile());
  } finally {
    await contractHandle.close();
  }
  if (
    contract.sha256 !== productContractSource.sha256 ||
    contract.byteCount !== productContractSource.size ||
    contract.sha256 !== ACTUAL_OWNER_CONTRACT_SHA256 ||
    contract.byteCount !== ACTUAL_OWNER_CONTRACT_BYTE_COUNT ||
    productContractSource.gitBlob !== ACTUAL_OWNER_CONTRACT_GIT_BLOB
  ) {
    throw new Error('hosted_actual_owner_product_contract_source_mismatch');
  }
  const { bytes: playwrightManifestBytes } = await readStableDescriptor(
    options.playwrightReleaseManifest,
    'playwright_release_manifest',
    (stat) =>
      stat.isFile() &&
      stat.nlink === 1 &&
      stat.uid === process.getuid?.() &&
      stat.size >= 2 &&
      stat.size <= MAX_PLAYWRIGHT_MANIFEST_BYTES &&
      (stat.mode & 0o077) === 0
  );
  let playwrightManifestValue: unknown;
  try {
    playwrightManifestValue = JSON.parse(playwrightManifestBytes.toString('utf8'));
  } catch (error) {
    throw new Error('hosted_actual_owner_playwright_release_manifest_invalid', { cause: error });
  }
  const playwrightReleaseManifest = Object.freeze({
    byteCount: playwrightManifestBytes.byteLength,
    sha256: createHash('sha256').update(playwrightManifestBytes).digest('hex'),
    value: playwrightManifestValue,
  });
  const productExecutableEvidence = await verifyProductExecutable({
    ...productExecutable,
    releaseManifest: options.productReleaseManifest,
    sourceRef: options.productRef,
    contract: {
      sha256: contract.sha256,
      byteCount: contract.byteCount,
      gitBlob: productContractSource.gitBlob,
      repositoryPath: productContractSource.repositoryPath,
      playwrightReleaseManifest: {
        byteCount: playwrightReleaseManifest.byteCount,
        sha256: playwrightReleaseManifest.sha256,
      },
    },
  });
  const launcherName = options.orchestratorSourceLauncher.split('/').at(-1);
  if (launcherName !== 'cli-source') {
    throw new Error('hosted_actual_owner_orchestrator_built_launcher_forbidden');
  }
  const entryRelation = relative(options.orchestratorRoot, options.orchestratorAcceptanceEntry);
  if (entryRelation !== 'scripts/e2e/hosted-actual-owner-owner.ts') {
    throw new Error('hosted_actual_owner_orchestrator_acceptance_entry_scope_invalid');
  }
  return Object.freeze({
    artifact,
    orchestrator,
    product,
    orchestratorAcceptanceEntry: options.orchestratorAcceptanceEntry,
    orchestratorSourceLauncher: options.orchestratorSourceLauncher,
    productExecutable: productExecutableEvidence,
    productContractSource,
    orchestratorAcceptanceSource,
    orchestratorLauncherSource,
    playwrightReleaseManifest,
  });
}

export async function assertPrivateCanonicalManifest(path: string): Promise<unknown> {
  const { bytes } = await readStableDescriptor(
    path,
    'integration_manifest',
    (stat) =>
      stat.isFile() &&
      stat.nlink === 1 &&
      stat.uid === process.getuid?.() &&
      stat.size >= 2 &&
      stat.size <= MAX_MANIFEST_BYTES &&
      (stat.mode & 0o077) === 0
  );
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error('hosted_actual_owner_integration_manifest_invalid', { cause: error });
  }
}
