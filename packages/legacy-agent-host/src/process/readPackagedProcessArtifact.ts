import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { isQualifiedDarwinBuild } from './qualifiedDarwinBuild.js';

/** Private selected build tuple. Never populated from public request payload, argv or ambient env. */
export interface PackagedProcessArtifactSelection {
  directory: string;
  manifestSha256: string;
}
const unavailable = (): never => { throw new Error('Registered process artifact unavailable'); };
function readManifest(selected: PackagedProcessArtifactSelection, platform: 'darwin' | 'linux') {
  if (
    process.platform !== platform ||
    !['arm64', 'x64'].includes(process.arch) ||
    !/^[a-f0-9]{64}$/.test(selected.manifestSha256) ||
    realpathSync(selected.directory) !== selected.directory ||
    !lstatSync(selected.directory).isDirectory()
  )
    return unavailable();
  const path = join(selected.directory, 'manifest.json'),
    before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 32 * 1024)
    return unavailable();
  const bytes = readFileSync(path),
    after = lstatSync(path);
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs ||
    createHash('sha256').update(bytes).digest('hex') !== selected.manifestSha256
  )
    return unavailable();
  const manifest: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!manifest || typeof manifest !== 'object') return unavailable();
  const row = manifest as Record<string, unknown>;
  if (
    row.schemaVersion !== 1 ||
    row.abi !== 'napi-8' ||
    row.platform !== platform ||
    row.architecture !== process.arch ||
    row.library !== 'registered-process.node' ||
    typeof row.binarySha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(row.binarySha256)
  )
    return unavailable();
  return { row, path: join(selected.directory, 'registered-process.node'), sha256: row.binarySha256 };
}
/** The existing Darwin contract and v1 manifests retain their exact shape. */
export function readPackagedProcessArtifact(selected: PackagedProcessArtifactSelection) {
  const artifact = readManifest(selected, 'darwin');
  if (!isQualifiedDarwinBuild(artifact.row.osBuild)) return unavailable();
  return { path: artifact.path, sha256: artifact.sha256, osBuild: artifact.row.osBuild };
}
export function readPackagedLinuxProcessArtifact(selected: PackagedProcessArtifactSelection): {
  path: string; sha256: string; kernelCapability: 'pidfs-inode64-v1' | 'pidfd-live-v1';
  libc: { family: 'glibc'; minimumVersion: string };
} {
  const artifact = readManifest(selected, 'linux');
  const libc = artifact.row.libc, kernelCapability = artifact.row.kernelCapability;
  if (process.arch !== 'x64' || (kernelCapability !== 'pidfs-inode64-v1' && kernelCapability !== 'pidfd-live-v1') ||
      !libc || typeof libc !== 'object' || !('family' in libc) || libc.family !== 'glibc' ||
      !('minimumVersion' in libc) || typeof libc.minimumVersion !== 'string' ||
      !/^\d{1,2}\.\d{1,3}(?:\.\d{1,3})?$/.test(libc.minimumVersion)) return unavailable();
  return { path: artifact.path, sha256: artifact.sha256,
    kernelCapability,
    libc: { family: 'glibc' as const, minimumVersion: libc.minimumVersion } };
}
