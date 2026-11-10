import assert from 'node:assert/strict';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { treeHash } from '../../packages/legacy-agent-host/tests/fixtures/native-host.ts';
import { readPackagedProcessArtifact } from '../../packages/legacy-agent-host/dist/process/readPackagedProcessArtifact.js';
import { fileDigest } from './desktop-backend-fixture.ts';
import { prepareProcessFixture, readProcessServices } from './desktop-native-process-fixture.ts';
import { qualifyNativeRegistrationThenStop } from './desktop-native-process-host.ts';
import { startProcessModel } from './desktop-native-process-model.ts';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const row = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
};
const text = (value: unknown): string => { assert.equal(typeof value, 'string'); return value as string; };
const hash = (value: unknown): string => { const result = text(value); assert.match(result, /^[a-f0-9]{64}$/); return result; };
const privatePath = (path: string) => assert.match(path, /^\/private\/tmp\/TEST-[^/]+\//);
async function pinned(value: unknown) {
  const pin = row(value), path = text(pin.path), sha256 = hash(pin.sha256);
  const info = await lstat(path);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size <= 512 * 1024 * 1024);
  assert.equal(await realpath(path), path); assert.equal(await fileDigest(path), sha256);
  return { path, sha256 };
}

/** Fresh normal SDK proof only; existing kernel/ancestry actors run in separate Node processes. */
export async function qualifyProcessNormalSdk(capturePath: string, captureSha256: string) {
  assert.equal(process.env.LEGACY_PROCESS_NORMAL_SDK_GO, '1');
  assert.equal(process.env.LEGACY_M19_ORIGINAL_HOST_CRASH_GO, undefined);
  assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64');
  assert.equal(process.version, 'v24.21.0');
  privatePath(capturePath);
  const captureInfo = await lstat(capturePath); assert.ok(captureInfo.size <= 32 * 1024);
  const capturePin = await pinned({ path: capturePath, sha256: captureSha256 });
  const capture = row(JSON.parse(await readFile(capturePath, 'utf8')));
  assert.equal(capture.schemaVersion, 1);
  const node = await pinned(capture.node), host = await pinned(capture.host);
  const claude = await pinned(capture.claude), corepack = row(capture.corepack);
  const entry = await pinned(corepack.entry), packagePin = await pinned(corepack.package);
  const library = await pinned(corepack.library);
  const hostSourceSha256 = hash(row(capture.host).sourceSha256);
  const hostDistSha256 = hash(row(capture.host).distSha256);
  assert.equal(node.path, await realpath(join(repository, 'resources/legacy-agent-host/node/v24.21.0/darwin-arm64/node')));
  assert.equal(node.path, await realpath(process.execPath));
  assert.equal(host.path, await realpath(join(repository, 'packages/legacy-agent-host/dist/cli.js')));
  const nodeManifest = row(JSON.parse(await readFile(join(dirname(node.path), 'manifest.json'), 'utf8')));
  assert.equal(nodeManifest.version, '24.21.0'); assert.equal(nodeManifest.platform, 'darwin-arm64');
  assert.equal(nodeManifest.binarySha256, node.sha256);
  assert.equal(nodeManifest.archiveSha256, 'bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057');
  assert.equal(claude.sha256, 'ea3ea3c08d2a9634a4651e687fcf900d410c489bce2b00f22bd7352b91ba704f');
  privatePath(entry.path);
  assert.equal(packagePin.path, await realpath(join(dirname(entry.path), '../package.json')));
  assert.equal(library.path, await realpath(join(dirname(entry.path), 'lib/corepack.cjs')));
  const packageJson = row(JSON.parse(await readFile(packagePin.path, 'utf8')));
  assert.equal(packageJson.name, 'corepack'); assert.equal(packageJson.version, '0.36.0');
  assert.equal(entry.path, join(dirname(packagePin.path), 'dist/pnpm.js'));
  const artifact = row(capture.processArtifact);
  const selection = { directory: text(artifact.directory), manifestSha256: hash(artifact.manifestSha256) };
  privatePath(selection.directory);
  const bridge = readPackagedProcessArtifact(selection);
  const manifest = await pinned({ path: join(selection.directory, 'manifest.json'), sha256: selection.manifestSha256 });
  const binary = await pinned({ path: bridge.path, sha256: bridge.sha256 });
  const manifestJson = row(JSON.parse(await readFile(manifest.path, 'utf8')));
  const source = await pinned({ path: join(selection.directory, 'registered-process-darwin.c'),
    sha256: manifestJson.sourceSha256 });
  assert.equal(source.sha256, '310161c5d404d45e4f149b15b88c3805bfeddc4cc4c424460cddee3e845a284b');
  assert.equal(await fileDigest(join(repository, 'packages/legacy-agent-host/native/registered-process-darwin.c')), source.sha256);
  const scripts = await Promise.all(['qualify-process-normal-sdk.ts', 'desktop-native-process-host.ts',
    'desktop-native-process-fixture.ts', 'desktop-native-process-model.ts', 'fixtures/process-foreground-service.ts']
    .map(async name => { const path = join(import.meta.dirname, name); return { path, sha256: await fileDigest(path) }; }));
  const pins = [capturePin, node, host, claude, entry, packagePin, library, manifest, binary, source, ...scripts];
  const validate = async () => {
    for (const pin of pins) await pinned(pin);
    assert.equal(await treeHash(join(repository, 'packages/legacy-agent-host/src'), '.ts'), hostSourceSha256);
    assert.equal(await treeHash(join(repository, 'packages/legacy-agent-host/dist'), '.js'), hostDistSha256);
  };
  await validate();
  let fixture: Awaited<ReturnType<typeof prepareProcessFixture>> | undefined;
  const model = await startProcessModel({
    bashCommand: () => { assert.ok(fixture); return fixture.bashCommand; },
    services: async () => { assert.ok(fixture); return readProcessServices(fixture.root); },
    serviceLifecycle: async role => {
      assert.ok(fixture);
      return (await readFile(join(fixture.root, `workspace/process-${role}-lifecycle.ndjson`), 'utf8'))
        .trim().split('\n').filter(Boolean).map(line => row(JSON.parse(line)));
    },
  });
  let failure: unknown;
  const sourceFreeze: { status: 'PASS' | 'INCOMPLETE'; failure?: string } = { status: 'INCOMPLETE' };
  try {
    fixture = await prepareProcessFixture(repository, { pnpmEntry: entry.path,
      nativeClaude: { ...claude, modelUrl: model.url }, processArtifact: selection });
    const serviceSource = scripts.find(pin => pin.path.endsWith('/fixtures/process-foreground-service.ts'))!;
    const seedPath = join(fixture.root, 'process-ui-seed.json');
    pins.push(
      { path: fixture.profilePath, sha256: fixture.pins.profileSha256 },
      { path: fixture.descriptorPath, sha256: fixture.pins.descriptorSha256 },
      { path: join(fixture.root, 'workspace/process-foreground-service.ts'), sha256: serviceSource.sha256 },
      { path: seedPath, sha256: await fileDigest(seedPath) }
    );
    await validate();
    await writeFile(join(fixture.root, 'normal-sdk-selected-inputs.json'),
      JSON.stringify({ capturePath, captureSha256, pins, hostSourceSha256, hostDistSha256 }, null, 2),
      { mode: 0o600, flag: 'wx' });
    await qualifyNativeRegistrationThenStop(fixture, model, { nativeClaude: true, normalStop: true });
  } catch (error) { failure = error; }
  finally {
    try { await validate(); sourceFreeze.status = 'PASS'; } catch (error) {
      sourceFreeze.failure = error instanceof Error ? error.message : String(error);
      failure ??= error;
    }
    if (fixture) await writeFile(join(fixture.root, 'normal-sdk-oracle.json'),
      JSON.stringify({ status: failure ? 'INCOMPLETE' : 'PASS', scope: 'Normal SDK process registration/Stop only',
        root: fixture.root, failure: failure instanceof Error ? failure.message : failure, sourceFreeze,
        original911Unchanged: true, harnessSignals: 0, observations: model.observations,
        notificationAcks: model.notificationAcks, rawTurns: model.rawTurns, failures: model.failures }, null, 2),
      { mode: 0o600, flag: 'wx' });
    await model.close();
  }
  if (failure) throw failure;
  assert.ok(fixture);
  return { root: fixture.root, status: 'PASS', scope: 'Normal SDK process registration/Stop only' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [capturePath, captureSha256, ...extra] = process.argv.slice(2);
  assert.ok(capturePath && captureSha256 && extra.length === 0,
    'Usage: node qualify-process-normal-sdk.ts PRIVATE_TEST_CAPTURE_JSON SHA256');
  console.log(JSON.stringify(await qualifyProcessNormalSdk(capturePath, captureSha256)));
}
