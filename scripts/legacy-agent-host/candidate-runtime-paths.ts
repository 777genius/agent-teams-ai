import { constants } from 'node:fs';
import { access, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { candidateDigest } from './candidate-closure.ts';
import { readPackagedProcessArtifact } from '../../packages/legacy-agent-host/dist/process/readPackagedProcessArtifact.js';
import type { CandidateNativeArtifacts } from './candidate-native.ts';
import type { CandidatePackage } from './candidate-closure.ts';

export interface CandidateRuntimePaths {
  resourcesRoot: string;
  manifestSha256: string;
  nodeExecutable: string;
  nodeVersion: string;
  nodeSha256: string;
  hostEntry: string;
  hostEntrySha256: string;
  claudeSdkRoot: string;
  claudeExecutable: string;
  claudeSdkVersion: string;
  codexExecutable: string;
  codexProtocolRevision: string;
  openCodeExecutable: string;
  openCodeProtocolRevision: string;
  processCustody: { directory: string; manifestSha256: string };
  providerArtifacts: { name: string; sha256: string }[];
}
const hash = (raw: unknown): raw is string => typeof raw === 'string' && /^[a-f0-9]{64}$/.test(raw);
/** TEST/build harness adapter. Private owner/storage/profile/env remain supplied by the existing descriptor factory. */
export async function readCandidateRuntimePaths(
  resourcesRoot: string,
  expectedManifestSha256: string
): Promise<CandidateRuntimePaths> {
  const root = await realpath(resourcesRoot);
  if (!isAbsolute(resourcesRoot) || !hash(expectedManifestSha256))
    throw new Error('Invalid candidate capture');
  async function path(raw: unknown): Promise<string> {
    if (typeof raw !== 'string' || !raw || isAbsolute(raw) || raw.includes('\0'))
      throw new Error('Invalid candidate relative path');
    const selected = await realpath(join(root, raw));
    const within = relative(root, selected);
    if (!within || within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within))
      throw new Error('Candidate path escapes resources');
    return selected;
  }
  const bytes = await readFile(await path('candidate.json'));
  if (
    bytes.length > 16 * 1024 * 1024 ||
    createHash('sha256').update(bytes).digest('hex') !== expectedManifestSha256
  )
    throw new Error('Candidate manifest mismatch');
  const manifest = JSON.parse(bytes.toString('utf8')) as {
    schemaVersion: unknown;
    platform: unknown;
    node: { version: string; binarySha256: string };
    nodeExecutable: string;
    hostEntry: string;
    hostEntrySha256: string;
    packages: CandidatePackage[];
    nativeArtifacts: CandidateNativeArtifacts;
    artifacts: { name: string; sha256: string }[];
  };
  if (
    manifest.schemaVersion !== 2 ||
    manifest.platform !== `${process.platform}-${process.arch}` ||
    !/^24\.(?:2[1-9]|[3-9]\d|\d{3,})\.\d+$/.test(manifest.node?.version) ||
    !hash(manifest.node?.binarySha256) ||
    !hash(manifest.hostEntrySha256) ||
    !Array.isArray(manifest.packages) ||
    manifest.packages.length > 512
  )
    throw new Error('Invalid candidate manifest');
  async function verified(raw: unknown, digest: unknown, executable = false) {
    const selected = await path(raw),
      file = await stat(selected);
    if (
      !hash(digest) ||
      !file.isFile() ||
      (await candidateDigest(selected)) !== digest ||
      (executable && (file.mode & 0o111) === 0)
    )
      throw new Error('Candidate file mismatch');
    if (executable) await access(selected, constants.X_OK);
    return selected;
  }
  for (const pkg of manifest.packages) {
    if (!Array.isArray(pkg.files) || !pkg.dependencies || typeof pkg.dependencies !== 'object')
      throw new Error('Invalid candidate package');
    for (const file of pkg.files)
      await verified(`host/${pkg.path}/${file.path}`, file.sha256, file.executable);
    for (const [name, key] of Object.entries(pkg.dependencies)) {
      const actual = await path(`host/${pkg.path}/node_modules/${name}`);
      if (actual !== (await path(`host/packages/${key}`)))
        throw new Error('Candidate dependency rebound');
    }
  }
  const sdk = manifest.packages.find((pkg) => pkg.name === '@anthropic-ai/claude-agent-sdk');
  const native = manifest.packages.find(
    (pkg) => pkg.name === `@anthropic-ai/claude-agent-sdk-${manifest.platform}`
  );
  const executable = native?.files.find((file) => file.path === 'claude' && file.executable);
  if (!sdk || !native || native.version !== sdk.version || !executable)
    throw new Error('Candidate Claude closure unavailable');
  if (
    !Array.isArray(manifest.artifacts) ||
    manifest.artifacts.length !== 2 ||
    ['@agent-teams/provider-implementations', '@agent-teams/provider-session-contracts'].some(
      (name) =>
        manifest.artifacts.filter((item) => item.name === name && hash(item.sha256)).length !== 1
    )
  )
    throw new Error('Candidate provider artifact census unavailable');
  const natives = manifest.nativeArtifacts;
  if (natives?.codex?.path !== 'native/codex/codex' ||
      natives.codex.codeModeHost?.path !== 'native/codex/codex-code-mode-host' ||
      !hash(natives.codex.codeModeHost.sha256))
    throw new Error('Candidate Codex code-mode census unavailable');
  if (
    !natives ||
    !hash(natives.captureSha256) ||
    natives.codex?.protocolRevision !== '0.162.0' ||
    !['1.18.35', '1.19.4'].includes(natives.opencode?.protocolRevision) ||
    natives.processCustody?.library !== 'registered-process.node'
  )
    throw new Error('Candidate native census unavailable');
  for (const [directory, expected] of [
    [natives.codex.path.slice(0, natives.codex.path.lastIndexOf('/')), ['codex', 'codex-code-mode-host']],
    [natives.opencode.path.slice(0, natives.opencode.path.lastIndexOf('/')), ['opencode']],
    [natives.processCustody.directory, ['manifest.json', 'registered-process.node']],
  ] as const) {
    const entries = await readdir(await path(directory), { withFileTypes: true });
    if (
      entries.some((entry) => !entry.isFile()) ||
      entries
        .map((entry) => entry.name)
        .sort()
        .join('\0') !== [...expected].sort().join('\0')
    )
      throw new Error('Candidate native directory census mismatch');
  }
  await verified(natives.codex.codeModeHost.path, natives.codex.codeModeHost.sha256, true);
  const processCustody = {
    directory: await path(natives.processCustody.directory),
    manifestSha256: natives.processCustody.manifestSha256,
  };
  const bridge = readPackagedProcessArtifact(processCustody);
  await verified(
    `${natives.processCustody.directory}/manifest.json`,
    processCustody.manifestSha256
  );
  await verified(
    `${natives.processCustody.directory}/${natives.processCustody.library}`,
    natives.processCustody.binarySha256
  );
  if (bridge.sha256 !== natives.processCustody.binarySha256)
    throw new Error('Candidate M19 census mismatch');
  return {
    codexExecutable: await verified(natives.codex.path, natives.codex.sha256, true),
    codexProtocolRevision: natives.codex.protocolRevision,
    openCodeExecutable: await verified(natives.opencode.path, natives.opencode.sha256, true),
    openCodeProtocolRevision: natives.opencode.protocolRevision,
    processCustody,
    providerArtifacts: manifest.artifacts,
    resourcesRoot: root,
    manifestSha256: expectedManifestSha256,
    nodeExecutable: await verified(manifest.nodeExecutable, manifest.node.binarySha256, true),
    nodeVersion: `v${manifest.node.version}`,
    nodeSha256: manifest.node.binarySha256,
    hostEntry: await verified(manifest.hostEntry, manifest.hostEntrySha256),
    hostEntrySha256: manifest.hostEntrySha256,
    claudeSdkRoot: await path(`host/${sdk.path}`),
    claudeExecutable: await verified(`host/${native.path}/claude`, executable.sha256, true),
    claudeSdkVersion: sdk.version,
  };
}
