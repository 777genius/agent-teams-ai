import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { candidateDigest } from './candidate-closure.ts';
import { packagedOpenCodeV2Scenario, readPackagedOpenCodeV2 } from './packaged-opencode-v2-inputs.ts';
import type { PackagedOpenCodeV2Manifest } from './packaged-opencode-v2-inputs.ts';
import type { TestContext } from 'node:test';

const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

/** Unrunnable TEST Node/Bun/CLI; only the real captured graph validator is imported. */
async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST packaged V2 capture ')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const resourcesRoot = join(root, 'App Bundle', 'resources', 'legacy-agent-host');
  const hostPackage = 'host/packages/0000';
  const platform = `${process.platform}-${process.arch}`;
  const executable = process.platform === 'win32' ? 'node.exe' : 'node';
  const bunName = process.platform === 'win32' ? 'bun.exe' : 'bun';
  const bunVersion = process.platform === 'darwin' ? '1.4.4' : process.platform === 'win32' ? '1.4.3' : '1.3.11';
  async function put(name: string, bytes: string | Buffer, executable = false) {
    const file = join(resourcesRoot, name);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, bytes); await chmod(file, executable ? 0o755 : 0o644);
    return { path: name, sha256: hash(bytes), executable };
  }
  const files = [];
  for (const [name, bytes] of [
    ['package.json', JSON.stringify({ name: '@agent-teams/legacy-agent-host', type: 'module' })],
    ['dist/cli.js', 'throw new Error("TEST-only unrunnable CLI");'],
    ...await Promise.all(['adapters/providers/OpenCodeV2EmbeddedGraph.js',
      'process/readPackagedProcessArtifact.js', 'process/qualifiedDarwinBuild.js'].map(async name =>
      [`dist/${name}`, await readFile(new URL(`../../packages/legacy-agent-host/dist/${name}`, import.meta.url))] as const)),
  ] as const) {
    const file = await put(`${hostPackage}/${name}`, bytes);
    files.push({ ...file, path: name });
  }
  const nodeExecutable = `node/v24.21.0/${platform}/${executable}`;
  const nodeFile = await put(nodeExecutable, 'TEST-node-never-executed', true);
  const node = { schemaVersion: 1 as const, platform, version: '24.21.0', executable,
    binarySha256: nodeFile.sha256, archiveSha256: 'a'.repeat(64), source: 'TEST-pinned-archive' };
  await put(`node/v24.21.0/${platform}/manifest.json`, JSON.stringify(node));
  const bun = await put(`native/opencode-v2/${bunName}`, 'TEST-bun-never-executed', true);
  const engineDirectory = 'native/opencode-v2/engine';
  const server = 'local-cli/node_modules/@opencode/server-v2.1.4';
  const effect = 'local-cli/node_modules/effect';
  const engineFiles = [];
  for (const [path, bytes] of [
    [`${server}/package.json`, JSON.stringify({ name: '@opencode/server', version: '2.1.4', dependencies: { effect: '4.0.1' } })],
    [`${server}/dist/process.js`, 'throw new Error("TEST-only graph, never executed");'],
    [`${effect}/package.json`, JSON.stringify({ name: 'effect', version: '4.0.1', exports: './dist/index.js' })],
    [`${effect}/dist/index.js`, 'export const TEST = true;'],
  ]) {
    const file = await put(`${engineDirectory}/${path}`, bytes!);
    engineFiles.push({ ...file, path, bytes: Buffer.byteLength(bytes!) });
  }
  const engine = await put(`${engineDirectory}/opencode-v2-engine-manifest.json`, JSON.stringify({
    schemaVersion: 1, platform: process.platform, arch: process.arch,
    requiredBunVersion: bunVersion, engineVersions: ['2.1.4'], files: engineFiles,
  }));
  let processCustody: PackagedOpenCodeV2Manifest['processCustody'];
  if (process.platform === 'darwin') {
    const bridge = await put('process-custody/registered-process.node', 'TEST-addon-never-loaded');
    const manifest = await put('process-custody/manifest.json', JSON.stringify({
      schemaVersion: 1, abi: 'napi-8', platform: 'darwin', architecture: process.arch,
      osBuild: '24G90', library: 'registered-process.node', binarySha256: bridge.sha256,
    }));
    processCustody = { directory: 'process-custody', manifestSha256: manifest.sha256, binarySha256: bridge.sha256 };
  }
  const harness = join(root, 'TEST-harness.mjs');
  await writeFile(harness, 'TEST-harness-never-executed');
  const appAsar = join(dirname(resourcesRoot), 'app.asar');
  await writeFile(appAsar, 'TEST-ASAR-never-executed');
  const manifest: PackagedOpenCodeV2Manifest = {
    schemaVersion: 1, kind: 'TEST_PACKAGED_OPENCODE_V2_INPUTS', platform,
    sourceHead: '1'.repeat(40), hostSourceDigest: 'b'.repeat(64), harnessSha256: await candidateDigest(harness),
    node, nodeExecutable, hostPackage, hostEntry: `${hostPackage}/dist/cli.js`,
    hostEntrySha256: files.find(file => file.path === 'dist/cli.js')!.sha256,
    packages: [{ name: '@agent-teams/legacy-agent-host', version: 'TEST', path: 'packages/0000',
      files, dependencies: {}, missingOptional: [] }],
    artifacts: ['@agent-teams/provider-implementations', '@agent-teams/provider-session-contracts']
      .map(name => ({ name, sha256: 'c'.repeat(64) })),
    bun: { path: bun.path, sha256: bun.sha256, version: bunVersion },
    engine: { directory: engineDirectory, manifestSha256: engine.sha256, version: '2.1.4' },
    ...(processCustody ? { processCustody } : {}),
  };
  const capture = { resourcesRoot, manifestSha256: '', appAsar, appAsarSha256: await candidateDigest(appAsar) };
  const save = async () => {
    await put('opencode-v2-candidate.json', JSON.stringify(manifest));
    capture.manifestSha256 = await candidateDigest(join(resourcesRoot, 'opencode-v2-candidate.json'));
  };
  await save();
  return { root, manifest, capture, save, put, harness };
}

test('packaged capture measures actual Host files, its real graph validator and paths containing spaces', async t => {
  const f = await fixture(t), selected = await readPackagedOpenCodeV2(f.capture);
  assert.equal(selected.entry, join(f.capture.resourcesRoot, f.manifest.hostEntry));
  assert.equal(selected.node, join(f.capture.resourcesRoot, f.manifest.nodeExecutable));
  assert.equal(selected.manifest.sourceHead, f.manifest.sourceHead);
});

test('packaged capture refuses changed Host bytes and unlisted resolution payloads', async t => {
  const f = await fixture(t);
  await f.put('host/packages/0000/dist/foreign.js', 'TEST-unlisted');
  await assert.rejects(readPackagedOpenCodeV2(f.capture), /unlisted packaged payload/);
  await rm(join(f.capture.resourcesRoot, 'host/packages/0000/dist/foreign.js'));
  await f.put(f.manifest.hostEntry, 'TEST-replaced');
  await assert.rejects(readPackagedOpenCodeV2(f.capture), /digest changed/);
});

test('packaged capture refuses an ambient dependency link and node path rebinding', async t => {
  const f = await fixture(t);
  await mkdir(join(f.capture.resourcesRoot, 'host/packages/0000/node_modules'));
  await symlink(f.root, join(f.capture.resourcesRoot, 'host/packages/0000/node_modules/foreign'), 'dir');
  await assert.rejects(readPackagedOpenCodeV2(f.capture), /unlisted packaged directory/);
  await rm(join(f.capture.resourcesRoot, 'host/packages/0000/node_modules'), { recursive: true });
  f.manifest.nodeExecutable = '../system-node'; await f.save();
  await assert.rejects(readPackagedOpenCodeV2(f.capture));
});

test('packaged capture binds ASAR and every graph file to the selected hashes', async t => {
  const f = await fixture(t);
  await writeFile(f.capture.appAsar, 'TEST-other-ASAR');
  await assert.rejects(readPackagedOpenCodeV2(f.capture));
  f.capture.appAsarSha256 = await candidateDigest(f.capture.appAsar);
  await f.put(`${f.manifest.engine.directory}/local-cli/foreign.js`, 'TEST-unlisted-graph');
  await assert.rejects(readPackagedOpenCodeV2(f.capture), /embedded graph unavailable/);
});

test('packaged scenario rejects an available source checkout and an ambient Node', async t => {
  const f = await fixture(t);
  await assert.rejects(packagedOpenCodeV2Scenario(f.capture, f.root, f.harness));
  await assert.rejects(packagedOpenCodeV2Scenario(f.capture, join(f.root, 'missing-source'), f.harness),
    /system Node cannot qualify the candidate/);
});

test('a failed external harness restores the disposable source, candidate and legacy payload independently',
  { skip: process.version !== 'v24.21.0', timeout: 30_000 }, async t => {
    const f = await fixture(t), repo = join(f.root, 'TEST-checkout');
    await mkdir(repo);
    // This tiny tracked TEST checkout contains only the runner's immutable inputs.
    // It never starts Host, Bun, a provider or an Electron application.
    for (const name of ['scripts/legacy-agent-host/run-packaged-opencode-v2.ts',
      'scripts/legacy-agent-host/packaged-opencode-v2-inputs.ts', 'scripts/legacy-agent-host/candidate-closure.ts',
      'packages/legacy-agent-host/tests/fixtures/native-host.ts',
      'packages/legacy-agent-host/tests/opencode-v1-version-source.ts', 'packages/legacy-agent-host/src/contracts.ts']) {
      await mkdir(dirname(join(repo, name)), { recursive: true });
      await copyFile(new URL(`../../${name}`, import.meta.url), join(repo, name));
    }
    await writeFile(join(repo, 'package.json'), '{"type":"module"}');
    const git = (args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', timeout: 5000, stdio: 'pipe' }).trim();
    git(['init']); git(['add', '.']);
    git(['-c', 'user.name=TEST', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'TEST restoration fixture']);
    f.manifest.sourceHead = git(['rev-parse', 'HEAD']);
    const selectedNode = join(f.capture.resourcesRoot, f.manifest.nodeExecutable);
    await copyFile(process.execPath, selectedNode); await chmod(selectedNode, 0o755);
    f.manifest.node.binarySha256 = await candidateDigest(selectedNode);
    await f.put(`node/v24.21.0/${f.manifest.platform}/manifest.json`, JSON.stringify(f.manifest.node));
    const harness = join(f.root, 'TEST-packaged-v2-host-failure.mjs');
    await writeFile(harness, `import assert from 'node:assert/strict';
import { lstat, writeFile } from 'node:fs/promises';
await assert.rejects(lstat(process.env.OPENCODE_V2_PACKAGED_SOURCE_ROOT), {code:'ENOENT'});
await writeFile(new URL('./TEST-observed-source-absence', import.meta.url), 'TEST');
throw new Error('TEST-injected-harness-failure');`);
    f.manifest.harnessSha256 = await candidateDigest(harness); await f.save();
    const originalBundle = join(repo, 'release/TEST-App');
    await mkdir(dirname(originalBundle));
    await rename(join(f.root, 'App Bundle'), originalBundle);
    // The fixture reader is platform-neutral; the runner uses the actual builder layout.
    if (process.platform === 'darwin') {
      await mkdir(join(originalBundle, 'Contents'));
      await rename(join(originalBundle, 'resources'), join(originalBundle, 'Contents/Resources'));
    }
    const resources = join(originalBundle, process.platform === 'darwin' ? 'Contents/Resources' : 'resources');
    await mkdir(join(resources, 'runtime'));
    await writeFile(join(resources, 'runtime/TEST-retained'), 'TEST-legacy-preserved');
    const receiptPath = join(f.root, 'TEST-restoration.json');
    const result = spawnSync(process.execPath, [join(repo, 'scripts/legacy-agent-host/run-packaged-opencode-v2.ts'),
      'release/TEST-App', f.manifest.platform], { cwd: f.root, encoding: 'utf8', timeout: 25_000,
      env: { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_WORKSPACE: repo, RUNNER_TEMP: f.root,
        OPENCODE_V2_TEST_SOURCE_HEAD: f.manifest.sourceHead, OPENCODE_V2_PACKAGED_HARNESS: harness,
        OPENCODE_V2_PACKAGED_MANIFEST_SHA256: f.capture.manifestSha256,
        OPENCODE_V2_PACKAGED_RECEIPT: receiptPath } });
    assert.equal(result.error, undefined); assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /TEST-injected-harness-failure/);
    assert.equal(await readFile(join(f.root, 'TEST-observed-source-absence'), 'utf8'), 'TEST');
    assert.equal(git(['rev-parse', 'HEAD']), f.manifest.sourceHead);
    assert.equal(await readFile(join(resources, 'runtime/TEST-retained'), 'utf8'), 'TEST-legacy-preserved');
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
    assert.equal(receipt.status, 'INCOMPLETE'); assert.equal(receipt.cleanup, false);
    assert.equal(receipt.sourceRestored, true); assert.equal(receipt.bundleRestored, true);
    assert.equal(receipt.legacyRuntimeRestored, true);
  });
