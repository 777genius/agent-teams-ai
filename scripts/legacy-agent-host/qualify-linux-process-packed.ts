import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { treeHash } from '../../packages/legacy-agent-host/tests/fixtures/native-host.ts';
import { candidateDigest } from './candidate-closure.ts';
import { captureCandidateElectron, readCapturedCandidateElectron } from './candidate-electron.ts';
import { qualifyLinuxProcessColdUi } from './qualify-linux-process-cold-ui.ts';
import { stageCandidate } from './stage-candidate.ts';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(import.meta.url);
const row = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
};
const text = (value: unknown): string => { assert.equal(typeof value, 'string'); return value as string; };
const hash = (value: unknown): string => { const result = text(value); assert.match(result, /^[a-f0-9]{64}$/); return result; };
const json = async (path: string) => row(JSON.parse(await readFile(path, 'utf8')));
async function pin(path: string, expected?: string) {
  const info = await lstat(path);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.size > 0);
  assert.equal(await realpath(path), path);
  const sha256 = await candidateDigest(path);
  if (expected !== undefined) assert.equal(sha256, hash(expected), path);
  return { path, sha256 };
}

/** TEST-only real builder output; reuses the proved cold UI scenario with its relocated Host. */
export async function qualifyLinuxProcessPacked(input: {
  output: string; coldReceipt: { path: string; sha256: string }; pnpmEntry: string;
  nativeCapture: { path: string; sha256: string };
}) {
  assert.equal(process.env.LEGACY_STAGE1_P7_GO, '1');
  assert.equal(process.env.LEGACY_PROCESS_COLD_UI_GO, '1');
  assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'x64');
  assert.equal(process.version, 'v24.21.0');
  assert.match(input.output, /^\/(?:[^/]+\/)*TEST-[^/]+$/);
  await mkdir(input.output, { mode: 0o700 });
  const output = await realpath(input.output); assert.equal(output, input.output);
  for (const name of ['home', 'tmp']) await mkdir(join(output, name), { mode: 0o700 });
  const coldReceipt = await pin(input.coldReceipt.path, input.coldReceipt.sha256);
  const cold = await json(coldReceipt.path);
  assert.equal(cold.status, 'PASS'); assert.equal(cold.sourceFreeze, 'PASS');
  assert.equal(cold.packagedClaim, false); assert.equal(cold.positiveStop, 'COMPLETED_ORIGINAL_REF_STOP');
  assert.equal(cold.sdkColdSurvivalClaim, false);
  const sdkRef = row(cold.sdkReceipt), sdkReceipt = await pin(text(sdkRef.path), hash(sdkRef.sha256));
  const sdk = await json(sdkReceipt.path);
  assert.equal(sdk.status, 'PASS'); assert.equal(sdk.sourceFreeze, 'PASS');
  assert.equal(sdk.platform, 'linux'); assert.equal(sdk.architecture, 'x64');
  assert.equal(row(sdk.native).status, 'NORMAL_SDK_PROCESS_STOP_OBSERVED');
  assert.ok(Array.isArray(sdk.pins) && Array.isArray(sdk.trees));
  const nativeCapture = await pin(input.nativeCapture.path, input.nativeCapture.sha256);
  const native = await json(nativeCapture.path);
  assert.equal(native.schemaVersion, 1); assert.equal(native.platform, 'linux-x64');
  assert.deepEqual(native.processCustody, sdk.selection);
  const codex = row(native.codex), helper = row(codex.codeModeHost), opencode = row(native.opencode);
  assert.equal(codex.protocolRevision, '0.162.0'); assert.equal(opencode.protocolRevision, '1.19.4');
  assert.equal(codex.sha256, '50ed828f357c655a3c82054d346cab8434f24901f14ec19b8267571bdd008b38');
  assert.equal(helper.sha256, '4c1984f440b743db476002c6364a31b2d8c437bebd628e9cb676d4742fcb1d8c');
  assert.equal(opencode.sha256, '538fcb1b6408c8d4608822acee19f7ff5b3a3eb3383c0633c4f06170857312a7');
  const electronRoot = dirname(await realpath(require.resolve('electron/package.json')));
  assert.equal((await json(join(electronRoot, 'package.json'))).version, '44.10.1');
  const electronDist = await realpath(join(electronRoot, 'dist'));
  const builderCli = await realpath(require.resolve('electron-builder/cli.js'));
  const files = await Promise.all([...new Set([
    ...sdk.pins.map(value => text(row(value).path)), import.meta.filename, coldReceipt.path, sdkReceipt.path,
    nativeCapture.path, text(codex.path), text(helper.path), text(opencode.path),
    builderCli, join(electronRoot, 'package.json'), join(electronDist, 'electron'),
    ...['package.json', 'pnpm-lock.yaml', 'legacy-host.lock.json', 'terminal-platform.lock.json', 'managed-git.lock.json',
      'electron.vite.config.ts', 'scripts/electron-builder/afterPack.cjs', 'resources/pricing.json',
      'resources/MANAGED_GIT_THIRD_PARTY.md'].map(path => join(repository, path)),
  ])].map(path => pin(path)));
  const trees = [...sdk.trees.map(value => {
    const item = row(value); return { path: text(item.path), suffix: text(item.suffix), sha256: hash(item.sha256) };
  }), ...await Promise.all(['dist-electron', 'out/renderer', 'resources/git', 'resources/terminal-platform',
    'mcp-server/dist', 'src/renderer/assets/participant-avatars'].map(async path => ({
    path: join(repository, path), suffix: '', sha256: await treeHash(join(repository, path), ''),
  })))];
  const verify = async () => {
    for (const original of files) await pin(original.path, original.sha256);
    for (const original of trees) assert.equal(await treeHash(original.path, original.suffix), original.sha256, original.path);
    for (const original of sdk.pins as unknown[]) {
      const item = row(original); await pin(text(item.path), hash(item.sha256));
    }
  };
  const receiptPath = join(output, 'packed-receipt.json');
  const proof: Record<string, unknown> = { schemaVersion: 1, status: 'INCOMPLETE', coldReceipt, sdkReceipt,
    nativeCapture, tuple: 'linux-x64', scope: 'Actual unsigned Electron directory: controlled cold Host, original-ref Stop/history',
    installerClaim: false, sdkColdSurvivalClaim: false, providerSessions: 0, frozenInputs: { files, trees } };
  let failure: unknown;
  let packedCapture: Awaited<ReturnType<typeof captureCandidateElectron>> | undefined;
  let packed: Awaited<ReturnType<typeof readCapturedCandidateElectron>> | undefined;
  await writeFile(receiptPath, JSON.stringify(proof), { mode: 0o600, flag: 'wx' });
  try {
    await verify();
    const staged = await stageCandidate({ output: join(output, 'candidate'), platform: 'linux-x64', nativeCapture });
    const config = await json(staged.builderConfig);
    config.npmRebuild = false; config.publish = null; config.electronDist = electronDist;
    await writeFile(staged.builderConfig, JSON.stringify(config, null, 2), { mode: 0o600 });
    files.push(await pin(staged.builderConfig)); proof.candidate = staged;
    await verify();
    const logPath = join(output, 'candidate-build.log'), log = openSync(logPath, 'wx', 0o600);
    try {
      execFileSync(process.execPath, [builderCli, '--config', staged.builderConfig, '--linux', 'dir', '--x64', '--publish', 'never'], {
        cwd: repository, stdio: ['ignore', log, log], env: {
          HOME: join(output, 'home'), TMPDIR: join(output, 'tmp'), PATH: dirname(process.execPath) + ':/usr/bin:/bin',
          NO_COLOR: '1', CI: 'true', CSC_IDENTITY_AUTO_DISCOVERY: 'false',
        },
      });
    } finally { closeSync(log); proof.buildLog = await pin(logPath); }
    await verify();
    const bundleRoot = await realpath(join(staged.output, 'packed/linux-unpacked'));
    packedCapture = await captureCandidateElectron({ bundleRoot, executableName: 'agent-teams-ai',
      candidateManifestSha256: staged.manifestSha256, output: join(output, 'packed-capture.json') });
    packed = await readCapturedCandidateElectron(packedCapture); proof.packedCapture = packedCapture;
    const originalNode = await realpath(process.execPath);
    assert.equal(packed.runtime.nodeSha256, files.find(value => value.path === originalNode)?.sha256);
    assert.equal(packed.runtime.processCustody.manifestSha256, row(sdk.selection).manifestSha256);
    for (const path of ['resources/app.asar.unpacked', 'resources/git', 'resources/terminal-platform']) {
      const sha256 = await treeHash(join(bundleRoot, path), '');
      if (path !== 'resources/app.asar.unpacked')
        assert.equal(sha256, trees.find(value => value.path === join(repository, path))?.sha256, path);
      trees.push({ path: join(bundleRoot, path), suffix: '', sha256 });
    }
    await verify();
    const ui = await qualifyLinuxProcessColdUi({ output: join(output, 'TEST-packed-cold-ui'),
      sdkReceipt: sdkReceipt.path, sdkReceiptSha256: sdkReceipt.sha256, pnpmEntry: input.pnpmEntry, packedCapture });
    assert.equal(ui.status, 'PASS'); assert.equal(ui.packagedClaim, true);
    proof.coldUi = await pin(join(output, 'TEST-packed-cold-ui/cold-ui-receipt.json'));
    proof.status = 'PASS';
  } catch (error) { failure = error; }
  finally {
    try {
      await verify();
      if (packedCapture) assert.deepEqual(await readCapturedCandidateElectron(packedCapture), packed);
      proof.sourceFreeze = 'PASS';
    } catch (error) { failure ??= error; proof.sourceFreeze = 'INCOMPLETE'; }
    if (failure) { proof.status = 'INCOMPLETE'; proof.failure = failure instanceof Error ? failure.message : String(failure); }
    await writeFile(receiptPath, JSON.stringify(proof, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ root: output, receipt: receiptPath, status: proof.status }));
  }
  if (failure) throw failure;
  return proof;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [output, coldPath, coldSha, pnpmEntry, nativePath, nativeSha, ...extra] = process.argv.slice(2);
  assert.ok(output && coldPath && coldSha && pnpmEntry && nativePath && nativeSha && extra.length === 0);
  await qualifyLinuxProcessPacked({ output, coldReceipt: { path: coldPath, sha256: coldSha }, pnpmEntry,
    nativeCapture: { path: nativePath, sha256: nativeSha } });
}
