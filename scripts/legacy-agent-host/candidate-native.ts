import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, chmod, copyFile, lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { readPackagedProcessArtifact } from '../../packages/legacy-agent-host/dist/process/readPackagedProcessArtifact.js';
import { candidateDigest } from './candidate-closure.ts';

export interface CandidateNativeCapture {
  schemaVersion: 1;
  platform: string;
  codex: { path: string; sha256: string; protocolRevision: '0.162.0' };
  opencode: { path: string; sha256: string; protocolRevision: '1.18.35' | '1.19.4' };
  processCustody: { directory: string; manifestSha256: string };
}
export interface CandidateNativeArtifacts {
  captureSha256: string;
  codex: { path: string; sha256: string; protocolRevision: '0.162.0' };
  opencode: { path: string; sha256: string; protocolRevision: '1.18.35' | '1.19.4' };
  processCustody: {
    directory: string;
    manifestSha256: string;
    library: string;
    binarySha256: string;
  };
}
const hash = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

/** Build-time explicit inputs only. No CLI lookup, download, config discovery or native execution. */
export async function stageCandidateNativeArtifacts(
  resourceRoot: string,
  selected: { path: string; sha256: string },
  platform: string
): Promise<CandidateNativeArtifacts> {
  if (
    !isAbsolute(selected.path) ||
    !hash(selected.sha256) ||
    (await realpath(selected.path)) !== selected.path
  )
    throw new Error('Candidate native capture mismatch');
  const bytes = await readFile(selected.path);
  if (bytes.length > 32 * 1024) throw new Error('Candidate native capture exceeds bound');
  if (createHash('sha256').update(bytes).digest('hex') !== selected.sha256)
    throw new Error('Candidate native capture mismatch');
  const input = JSON.parse(bytes.toString('utf8')) as CandidateNativeCapture;
  if (
    input.schemaVersion !== 1 ||
    input.platform !== platform ||
    platform !== `${process.platform}-${process.arch}` ||
    input.codex?.protocolRevision !== '0.162.0' ||
    !['1.18.35', '1.19.4'].includes(input.opencode?.protocolRevision)
  )
    throw new Error('Candidate native tuple unavailable');
  const binary = async (name: 'codex' | 'opencode') => {
    const value = input[name];
    if (
      !isAbsolute(value.path) ||
      (await realpath(value.path)) !== value.path ||
      !hash(value.sha256)
    )
      throw new Error('Candidate native executable capture invalid');
    const stat = await lstat(value.path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      !(stat.mode & 0o111) ||
      (await candidateDigest(value.path)) !== value.sha256
    )
      throw new Error('Candidate native executable mismatch');
    await access(value.path, constants.X_OK);
    const path = `native/${name}/${name}`;
    await mkdir(join(resourceRoot, 'native', name), { recursive: true });
    await copyFile(value.path, join(resourceRoot, path), constants.COPYFILE_EXCL);
    await chmod(join(resourceRoot, path), 0o755);
    if ((await candidateDigest(join(resourceRoot, path))) !== value.sha256)
      throw new Error('Candidate native copy mismatch');
    return { path, sha256: value.sha256, protocolRevision: value.protocolRevision };
  };
  // The Host's existing selector owns the supported ABI/platform/OS-build policy.
  const bridge = readPackagedProcessArtifact(input.processCustody);
  if ((await candidateDigest(bridge.path)) !== bridge.sha256)
    throw new Error('Candidate M19 library mismatch');
  const directory = 'process-custody';
  await mkdir(join(resourceRoot, directory));
  for (const name of ['manifest.json', 'registered-process.node'])
    await copyFile(
      join(input.processCustody.directory, name),
      join(resourceRoot, directory, name),
      constants.COPYFILE_EXCL
    );
  const copied = readPackagedProcessArtifact({
    directory: join(resourceRoot, directory),
    manifestSha256: input.processCustody.manifestSha256,
  });
  if ((await candidateDigest(copied.path)) !== bridge.sha256)
    throw new Error('Candidate M19 copy mismatch');
  return {
    captureSha256: selected.sha256,
    codex: (await binary('codex')) as CandidateNativeArtifacts['codex'],
    opencode: (await binary('opencode')) as CandidateNativeArtifacts['opencode'],
    processCustody: {
      directory,
      manifestSha256: input.processCustody.manifestSha256,
      library: 'registered-process.node',
      binarySha256: bridge.sha256,
    },
  };
}
