import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { chmod, copyFile, cp, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { treeHash } from '../../packages/legacy-agent-host/tests/fixtures/native-host.ts';
import { readPackagedLinuxProcessArtifact } from '../../packages/legacy-agent-host/dist/process/readPackagedProcessArtifact.js';
import { fileDigest } from './desktop-backend-fixture.ts';
import { desktopClaudeSha256 } from './desktop-claude-native-selection.ts';
import { prepareProcessFixture, readProcessServices } from './desktop-native-process-fixture.ts';
import { qualifyNativeRegistrationThenStop } from './desktop-native-process-host.ts';
import { startProcessModel } from './desktop-native-process-model.ts';
import { desktopProofSources } from './desktop-proof-sources.ts';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const row = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
};
const text = (value: unknown): string => { assert.equal(typeof value, 'string'); return value as string; };
const hash = (value: unknown): string => { const result = text(value); assert.match(result, /^[a-f0-9]{64}$/); return result; };
const privatePath = (path: string) => assert.match(path, /^\/(?:[^/]+\/)*TEST-[^/]+(?:\/[^\0\r\n]*)?$/);
async function pin(input: string) {
  const path = await realpath(input), info = await lstat(path);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size <= 512 * 1024 * 1024);
  return { path, sha256: await fileDigest(path) };
}

/** Genuine SDK/Bash/MCP test on a selected Linux tuple; does not claim a Desktop or packaged run. */
export async function qualifyLinuxProcessSdk(input: {
  output: string; selectionPath: string; selectionSha256: string; pnpmEntry: string;
}) {
  assert.equal(process.env.LEGACY_PROCESS_NORMAL_SDK_GO, '1');
  assert.equal(process.env.LEGACY_M19_ORIGINAL_HOST_CRASH_GO, undefined);
  assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'x64');
  assert.equal(process.version, 'v24.21.0');
  privatePath(input.output); privatePath(input.selectionPath); privatePath(input.pnpmEntry);
  await mkdir(input.output, { mode: 0o700 });
  const output = await realpath(input.output);
  assert.equal(output, input.output);
  const selectionPin = await pin(input.selectionPath);
  assert.equal(selectionPin.sha256, input.selectionSha256);
  assert.ok((await lstat(selectionPin.path)).size <= 32 * 1024);
  const selected = row(JSON.parse(await readFile(selectionPin.path, 'utf8')));
  const selection = { directory: text(selected.directory), manifestSha256: hash(selected.manifestSha256) };
  privatePath(selection.directory);
  const artifact = readPackagedLinuxProcessArtifact(selection);
  const manifest = row(JSON.parse(await readFile(join(selection.directory, 'manifest.json'), 'utf8')));
  const nativeSource = join(repository, 'packages/legacy-agent-host/native/registered-process-linux.c');
  assert.equal(await fileDigest(nativeSource), manifest.sourceSha256);
  const node = await pin(process.execPath);
  const host = await pin(join(repository, 'packages/legacy-agent-host/dist/cli.js'));
  const providerRoot = await realpath(join(repository, 'packages/legacy-agent-host/node_modules/@agent-teams/provider-implementations'));
  const sdkRoot = await realpath(resolve(providerRoot, '../../@anthropic-ai/claude-agent-sdk'));
  const sdkPackage = row(JSON.parse(await readFile(join(sdkRoot, 'package.json'), 'utf8')));
  assert.equal(sdkPackage.name, '@anthropic-ai/claude-agent-sdk'); assert.equal(sdkPackage.version, '0.3.305');
  const nativePackageRoot = await realpath(resolve(sdkRoot, '../claude-agent-sdk-linux-x64'));
  const nativePackage = row(JSON.parse(await readFile(join(nativePackageRoot, 'package.json'), 'utf8')));
  assert.equal(nativePackage.name, '@anthropic-ai/claude-agent-sdk-linux-x64');
  assert.equal(nativePackage.version, sdkPackage.version);
  const suppliedClaude = await pin(join(nativePackageRoot, 'claude'));
  assert.equal(suppliedClaude.sha256, desktopClaudeSha256());
  // pnpm may hardlink its immutable store; the private delivered executable has one link.
  const claudePath = join(output, 'claude');
  await copyFile(suppliedClaude.path, claudePath, constants.COPYFILE_EXCL);
  await chmod(claudePath, 0o700);
  const claude = await pin(claudePath);
  assert.equal(claude.sha256, suppliedClaude.sha256); assert.equal((await lstat(claude.path)).nlink, 1);
  const pnpm = await pin(input.pnpmEntry), corepackRoot = dirname(dirname(pnpm.path));
  const corepackPackage = row(JSON.parse(await readFile(join(corepackRoot, 'package.json'), 'utf8')));
  assert.equal(corepackPackage.name, 'corepack'); assert.equal(corepackPackage.version, '0.36.0');
  assert.equal(pnpm.path, join(corepackRoot, 'dist/pnpm.js'));
  const sources = [...new Set([...desktopProofSources.map(path => join(repository, path)),
    import.meta.filename, nativeSource, selectionPin.path, node.path, host.path, claude.path, suppliedClaude.path,
    join(repository, 'pnpm-lock.yaml'), join(repository, 'legacy-host.lock.json'),
    join(selection.directory, 'manifest.json'), artifact.path, pnpm.path,
    join(corepackRoot, 'package.json'), join(corepackRoot, 'dist/lib/corepack.cjs'),
    join(sdkRoot, 'package.json'), join(sdkRoot, 'sdk.mjs'), join(nativePackageRoot, 'package.json')])];
  const pins = await Promise.all(sources.map(pin));
  const trees = await Promise.all([
    [join(repository, 'packages/legacy-agent-host/src'), '.ts'],
    [join(repository, 'packages/legacy-agent-host/dist'), '.js'],
    [join(repository, 'agent-teams-controller/src'), '.js'],
    [join(repository, 'mcp-server/dist'), '.js'], [join(providerRoot, 'dist'), '.js'],
  ].map(async ([path, suffix]) => ({ path: path!, suffix: suffix!, sha256: await treeHash(path!, suffix!) })));
  const validate = async () => {
    for (const selected of pins) assert.deepEqual(await pin(selected.path), selected, selected.path);
    for (const selected of trees) assert.equal(await treeHash(selected.path, selected.suffix), selected.sha256, selected.path);
  };
  const proof: Record<string, unknown> = { schemaVersion: 1, status: 'INCOMPLETE',
    scope: 'Linux genuine Claude SDK background Bash services, MCP register, one exact Human Stop, normal owner close',
    nodeVersion: process.version, platform: process.platform, architecture: process.arch,
    selection, sdkVersion: sdkPackage.version, claude, suppliedClaude, pins, trees,
    harnessSignals: 0, desktopClaim: false, packagedClaim: false };
  const receipt = join(output, 'sdk-receipt.json');
  await writeFile(receipt, JSON.stringify(proof, null, 2), { flag: 'wx', mode: 0o600 });
  let fixture: Awaited<ReturnType<typeof prepareProcessFixture>> | undefined;
  let model: Awaited<ReturnType<typeof startProcessModel>> | undefined;
  let failure: unknown;
  try {
    await validate();
    model = await startProcessModel({
      bashCommand: () => { assert.ok(fixture); return fixture.bashCommand; },
      services: async () => { assert.ok(fixture); return readProcessServices(fixture.root); },
      serviceLifecycle: async role => {
        assert.ok(fixture);
        return (await readFile(join(fixture.root, `workspace/process-${role}-lifecycle.ndjson`), 'utf8'))
          .trim().split('\n').filter(Boolean).map(line => row(JSON.parse(line)));
      },
    });
    fixture = await prepareProcessFixture(repository, { pnpmEntry: pnpm.path,
      nativeClaude: { ...claude, modelUrl: model.url }, processArtifact: selection });
    proof.fixtureRoot = fixture.root;
    pins.push(await pin(fixture.profilePath), await pin(fixture.descriptorPath),
      await pin(join(fixture.root, 'process-ui-seed.json')),
      await pin(join(fixture.root, 'workspace/process-foreground-service.ts')));
    await validate();
    proof.native = await qualifyNativeRegistrationThenStop(fixture, model, { nativeClaude: true, normalStop: true });
  } catch (error) { failure = error; }
  finally {
    try { await model?.close(); } catch (error) { failure ??= error; }
    try { await validate(); proof.sourceFreeze = 'PASS'; } catch (error) {
      proof.sourceFreeze = 'INCOMPLETE'; failure ??= error;
    }
    if (model) { proof.model = model.observations; proof.modelFailures = model.failures; }
    if (fixture) {
      try {
        await cp(fixture.root, join(output, 'fixture'), { recursive: true, errorOnExist: true, force: false });
        proof.retainedFixture = join(output, 'fixture');
      } catch (error) { failure ??= error; }
    }
    proof.status = failure ? 'INCOMPLETE' : 'PASS';
    if (failure) proof.failure = failure instanceof Error ? failure.message : String(failure);
    await writeFile(receipt, JSON.stringify(proof, null, 2), { mode: 0o600 });
  }
  console.log(JSON.stringify({ status: proof.status, root: output, receipt,
    scope: proof.scope, sourceFreeze: proof.sourceFreeze, failure: proof.failure }));
  if (failure) throw failure;
  return proof;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [output, selectionPath, selectionSha256, pnpmEntry, ...extra] = process.argv.slice(2);
  assert.ok(output && selectionPath && selectionSha256 && pnpmEntry && extra.length === 0);
  await qualifyLinuxProcessSdk({ output, selectionPath, selectionSha256, pnpmEntry });
}
