/** Candidate-only split delivery staging. Never publishes or changes the product installer. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { readOpenCodeV2Contract } from '../../src/features/opencode-compatibility/core/domain/openCodeV2Contract';
import { readOpenCodeV2DeliveryMap } from '../../src/features/opencode-runtime-installer/core/domain/v2Delivery';
import { extractV2SupportArchive } from '../../src/features/opencode-runtime-installer/main/infrastructure/v2SupportArchive';
import { verifyExternalOpenCodeV2Base } from '../lib/opencode-v2-base-inventory.mts';

const execute = promisify(execFile);
export async function candidateFileSha256(file: string): Promise<string> {
  const before = await lstat(file);
  assert(before.isFile() && !before.isSymbolicLink(), 'Candidate component must be a regular file');
  const digest = createHash('sha256');
  for await (const bytes of createReadStream(file)) digest.update(bytes);
  const after = await lstat(file);
  assert(before.dev === after.dev && before.ino === after.ino && before.size === after.size &&
    before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs, 'Candidate bytes changed');
  return digest.digest('hex');
}

/** Restrict this disposable TEST lock to the built target; no stale release descriptors survive. */
export function candidateRuntimeLock(original: Record<string, unknown>, input: {
  version: string; sourceSha: string; platform: string; archiveSha256: string;
  contract: unknown; descriptor: unknown;
}) {
  assert(['win32-x64', 'win32-arm64'].includes(input.platform), 'Unknown candidate platform');
  assert(/^[a-f0-9]{40}$/.test(input.sourceSha) && /^[a-f0-9]{64}$/.test(input.archiveSha256));
  assert(readOpenCodeV2Contract(input.contract), 'Candidate qualification contract invalid');
  const assets = original.assets as Record<string, Record<string, unknown>>;
  assert(assets?.[input.platform], 'Candidate base platform missing');
  const lock = { ...original, version: input.version, sourceRef: input.sourceSha,
    releaseTag: `TEST-native-candidate-${input.sourceSha}`,
    assets: { [input.platform]: { ...assets[input.platform],
      file: `TEST-runtime-${input.platform}.zip`, sha256: input.archiveSha256 } },
    opencodeV2: input.contract, opencodeV2Delivery: { [input.platform]: input.descriptor } };
  const descriptor = readOpenCodeV2DeliveryMap(lock)?.[input.platform];
  assert(descriptor?.sourceCommit === input.sourceSha, 'Candidate support source identity mismatch');
  assert(descriptor.requiredBunVersion === '1.4.3', 'Candidate Windows Bun identity mismatch');
  return lock;
}

/** Verify the separate archive, then use the runtime's existing TEST fixture publisher. */
export async function stageNativeCandidateSupport(input: {
  executable: string; sdkRoot: string; archive: string; userData: string; testRoot: string;
  expectedSdkSha: string; env: NodeJS.ProcessEnv;
}) {
  const base = path.join(path.dirname(await realpath(input.executable)), 'resources/runtime');
  const lock: unknown = JSON.parse(await readFile(new URL('../../runtime.lock.json', import.meta.url), 'utf8'));
  const platform = `${process.platform}-${process.arch}`;
  const descriptor = readOpenCodeV2DeliveryMap(lock)?.[platform];
  assert(descriptor && descriptor.sourceCommit === input.expectedSdkSha, 'Candidate support lock identity mismatch');
  assert.deepEqual(JSON.parse(await readFile(path.join(base, 'opencode-v2-delivery.json'), 'utf8')), descriptor);
  assert(verifyExternalOpenCodeV2Base(base, lock, platform));
  assert.equal((await readFile(path.join(base, 'VERSION'), 'utf8')).trim(), descriptor.runtimeVersion);
  assert.equal(path.basename(input.archive), descriptor.archive.file);
  assert.equal((await lstat(input.archive)).size, descriptor.archive.bytes);
  assert.equal(await candidateFileSha256(input.archive), descriptor.archive.sha256);
  const support = path.join(input.testRoot, 'TEST-candidate-support');
  await mkdir(support, { mode: 0o700 });
  await extractV2SupportArchive(input.archive, support, descriptor);
  const sdk = await realpath(input.sdkRoot);
  const source = await execute('git', ['-C', sdk, 'rev-parse', 'HEAD'], { windowsHide: true, maxBuffer: 4096 });
  assert.equal(source.stdout.trim(), input.expectedSdkSha, 'Candidate fixture source changed');
  const cache = path.join(input.userData, 'data/runtimes/opencode-v2');
  assert.equal(await lstat(cache).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  }), false, 'Candidate support cache must be absent in the fresh TEST profile');
  const fixture = path.join(sdk, 'scripts/opencode-v2/stage-support-fixture.ts');
  await execute(path.join(base, 'bun/bun.exe'), ['--no-install', fixture, base, support, cache], {
    cwd: input.testRoot, env: input.env, windowsHide: true, timeout: 180_000, maxBuffer: 4096,
  });
  return { mode: 'verified_candidate_fixture' as const, sourceSha: descriptor.sourceCommit,
    platform, runtimeVersion: descriptor.runtimeVersion, archiveSha256: descriptor.archive.sha256,
    manifestSha256: descriptor.manifest.sha256, archiveBytes: descriptor.archive.bytes };
}

async function main() {
  const [sdkArgument, platform, sourceSha] = process.argv.slice(2);
  assert(sdkArgument && platform && sourceSha && process.argv.length === 5);
  const sdk = await realpath(sdkArgument);
  const original = JSON.parse(await readFile('runtime.lock.json', 'utf8')) as Record<string, unknown>;
  const descriptor: unknown = JSON.parse(await readFile(path.join(sdk, 'dist/opencode-v2-delivery.json'), 'utf8'));
  const metadata = JSON.parse(await readFile(path.join(sdk, 'package.json'), 'utf8')) as { version: string };
  const archive = path.join(sdk, `candidate/TEST-runtime-${platform}.zip`);
  const archiveSha256 = await candidateFileSha256(archive);
  const registry = await import(pathToFileURL(path.join(sdk, 'src/services/opencode/compatibility/OpenCodeV2Registry.ts')).href) as {
    openCodeV2ReleaseContract(): unknown;
  };
  const contract: unknown = process.env.CANDIDATE_OPENCODE_V2_CONTRACT
    ? JSON.parse(process.env.CANDIDATE_OPENCODE_V2_CONTRACT) : registry.openCodeV2ReleaseContract();
  const lock = candidateRuntimeLock(original, { version: metadata.version, sourceSha, platform,
    archiveSha256, descriptor, contract });
  assert(verifyExternalOpenCodeV2Base(path.join(sdk, 'candidate/runtime'), lock, platform));
  const selected = readOpenCodeV2DeliveryMap(lock)![platform]!;
  const supportArchive = path.join(sdk, 'dist', selected.archive.file);
  assert.equal((await lstat(supportArchive)).size, selected.archive.bytes);
  assert.equal(await candidateFileSha256(supportArchive), selected.archive.sha256);
  await writeFile('runtime.lock.json', JSON.stringify(lock, null, 2) + '\n');
  await writeFile('runtime-native-candidate-evidence.json', JSON.stringify({
    mode: 'candidate_not_public_release', appSha: process.env.GITHUB_SHA, sdkSha: sourceSha, platform,
    runtimeArchiveSha256: archiveSha256, support: selected,
  }, null, 2) + '\n');
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
