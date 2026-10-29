import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { isQualifiedDarwinBuild } from './qualifiedDarwinBuild.js';

/** Private selected build tuple. Never populated from public request payload, argv or ambient env. */
export interface PackagedProcessArtifactSelection {
  directory: string;
  manifestSha256: string;
}
export function readPackagedProcessArtifact(selected: PackagedProcessArtifactSelection) {
  const unavailable = (): never => {
    throw new Error('Registered process artifact unavailable');
  };
  if (
    process.platform !== 'darwin' ||
    process.arch !== 'arm64' ||
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
    row.platform !== 'darwin' ||
    row.architecture !== 'arm64' ||
    !isQualifiedDarwinBuild(row.osBuild) ||
    row.library !== 'registered-process.node' ||
    typeof row.binarySha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(row.binarySha256)
  )
    return unavailable();
  return { path: join(selected.directory, 'registered-process.node'), sha256: row.binarySha256,
    osBuild: row.osBuild };
}
