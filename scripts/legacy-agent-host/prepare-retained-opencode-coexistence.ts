/** Resolve immutable TEST inputs for the original retained-owner Desktop proof; no session is launched. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { assertNativeV1Source } from '../../packages/legacy-agent-host/tests/opencode-v1-version-source.ts';

const repo = resolve(import.meta.dirname, '../..');
assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'x64');
assert.equal(process.version, 'v24.21.0');
const sourceHead = process.env.OPENCODE_V2_TEST_SOURCE_HEAD!;
assertNativeV1Source(repo, sourceHead);
const readJson = async (file: string) => JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
async function pin(file: string) {
  const path = await realpath(file), stat = await lstat(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= 256 * 1024 * 1024);
  return { path, sha256: createHash('sha256').update(await readFile(path)).digest('hex') };
}
const packages = await realpath(process.env.OPENCODE_V1_V2_TEST_PACKAGES!);
const inputsReceipt = process.env.OPENCODE_V1_V2_INPUTS_RECEIPT!;
assert.ok(inputsReceipt && isAbsolute(inputsReceipt));
const evidence: Record<string, unknown> = { kind: 'TEST_RETAINED_V1_HOST_V2_INPUTS',
  sourceHead, status: 'HOLD', releaseQualified: false };
await writeFile(inputsReceipt, JSON.stringify(evidence), { mode: 0o600, flag: 'wx' });
let failure: { error: unknown } | undefined;
try {
  for (const [name, version] of [['opencode-ai', '1.19.4'], ['opencode-linux-x64', '1.19.4'], ['corepack', '0.36.0']]) {
    const metadata = await readJson(join(packages, 'node_modules', name!, 'package.json'));
    assert.equal(metadata.name, name); assert.equal(metadata.version, version);
  }
  const binary = await pin(join(packages, 'node_modules/opencode-linux-x64/bin/opencode'));
  assert.equal(binary.sha256, '538fcb1b6408c8d4608822acee19f7ff5b3a3eb3383c0633c4f06170857312a7');
  const corepack = await pin(join(packages, 'node_modules/corepack/dist/pnpm.js'));
  const lock = await readJson(join(repo, 'runtime.lock.json'));
  assert.equal(lock.version, '0.0.158');
  assert.equal(lock.sourceRepository, '777genius/agent_teams_orchestrator');
  const release = await pin(join(repo, 'resources/runtime/claude-multimodel'));
  assert.equal(release.sha256, 'b9b4c9f786238922cad49f46e5ac147b4e361b182bd250e5fbb47571571059cd');
  const commit = (await readFile(join(repo, 'resources/runtime/COMMIT_SHA'), 'utf8')).trim();
  const delivery = (lock.opencodeV2Delivery as Record<string, Record<string, unknown>>)['linux-x64']!;
  assert.equal(commit, delivery.sourceCommit); assert.match(commit, /^[a-f0-9]{40}$/);
  const helperSource = await realpath(process.env.OPENCODE_V1_V2_RETAINED_CUSTODY_SOURCE!);
  const git = (args: string[]) => execFileSync('git', args,
    { cwd: helperSource, encoding: 'utf8', timeout: 5000 }).trim();
  assert.equal(git(['rev-parse', 'HEAD']), commit);
  assert.equal(git(['diff', '--name-only', 'HEAD']), '');
  assert.equal(git(['ls-files', '--others', '--exclude-standard']), '');
  const values = {
    OPENCODE_V1_V2_RETAINED_BINARY: binary.path,
    OPENCODE_V1_V2_RETAINED_BINARY_SHA256: binary.sha256,
    OPENCODE_V1_V2_RETAINED_RUNTIME: release.path,
    OPENCODE_V1_V2_RETAINED_RUNTIME_SHA256: release.sha256,
    OPENCODE_V1_V2_RETAINED_CUSTODY_SOURCE: helperSource,
    OPENCODE_V1_V2_COREPACK_ENTRY: corepack.path,
  };
  assert.ok(process.env.GITHUB_ENV);
  for (const value of Object.values(values)) assert.ok(!/[\r\n\0]/.test(value));
  evidence.v1 = { version: '1.19.4', ...binary };
  evidence.retainedRuntime = { version: lock.version, ...release, sourceCommit: commit };
  evidence.sourceBuiltHelper = { sourceCommit: commit, sourceTree: git(['rev-parse', 'HEAD^{tree}']),
    source: await pin(join(helperSource, 'native/opencode-custody/linux.c')),
    buildScript: await pin(join(helperSource, 'scripts/stage-opencode-custody.mts')),
    validator: await pin(join(helperSource, 'scripts/lib/opencode-custody-artifact.ts')),
    publishedRuntimeComplete: false };
  evidence.corepack = { version: '0.36.0', ...corepack };
  evidence.packageLock = await pin(join(packages, 'pnpm-lock.yaml'));
  assertNativeV1Source(repo, sourceHead);
  await appendFile(process.env.GITHUB_ENV!, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(''));
  evidence.status = 'READY';
} catch (error) {
  failure = { error };
  evidence.failure = error instanceof Error ? error.message : String(error);
} finally {
  try { await writeFile(inputsReceipt, JSON.stringify(evidence, null, 2), { mode: 0o600 }); }
  catch (error) { failure ??= { error }; }
}
if (failure) throw failure.error;
