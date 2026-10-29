import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, openSync } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildProcessNativeArtifact } from '../../packages/legacy-agent-host/scripts/buildProcessNativeArtifact.ts';
import { treeHash } from '../../packages/legacy-agent-host/tests/fixtures/native-host.ts';
import { captureCandidateElectron, readCapturedCandidateElectron } from './candidate-electron.ts';
import { desktopProofSources } from './desktop-proof-sources.ts';
import { captureDesktopCodexNativeInputs } from './desktop-source-freeze.ts';
import { stageCandidate } from './stage-candidate.ts';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(import.meta.url);
const digest = async (path: string) => createHash('sha256').update(await readFile(path)).digest('hex');
const row = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
};
const privatePath = (path: string) => assert.match(path, /^\/private\/tmp\/TEST-[^/]+\//);
const json = async (path: string) => row(JSON.parse(await readFile(path, 'utf8')));
async function pin(path: string) {
  const info = await lstat(path);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size <= 512 * 1024 * 1024);
  assert.equal(await realpath(path), path);
  return { path, sha256: await digest(path) };
}
const jsonRows = (text: string) => text.split('\n').flatMap(line => {
  try { return line.startsWith('{') ? [row(JSON.parse(line))] : []; } catch { return []; }
});

/** One manually selected TEST tuple: existing kernel/SDK proofs, then existing packed Launch/Stop. */
export async function runProcessQualification(inputsDirectory: string) {
  assert.equal(process.env.LEGACY_STAGE1_P7_GO, '1');
  assert.equal(process.env.LEGACY_M19_ORIGINAL_HOST_CRASH_GO, undefined);
  assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64');
  assert.equal(process.version, 'v24.21.0');
  privatePath(inputsDirectory + '/'); assert.equal(await realpath(inputsDirectory), inputsDirectory);
  const root = await realpath(await mkdtemp('/private/tmp/TEST-stage1-p7-'));
  for (const name of ['home', 'tmp']) await mkdir(join(root, name), { mode: 0o700 });
  const receiptPath = join(root, 'p7-receipt.json');
  const stages: Record<string, unknown>[] = [];
  const proof: Record<string, unknown> = { schemaVersion: 1, status: 'INCOMPLETE', root, stages,
    scope: 'Fresh current-tuple kernel ancestry, normal SDK registration/Stop and unsigned packed original Launch/Stop/close',
    original911Unchanged: true, supportedTupleClaims: [], publication: false };
  await writeFile(receiptPath, JSON.stringify(proof), { flag: 'wx', mode: 0o600 });
  const retain = () => writeFile(receiptPath, JSON.stringify(proof, null, 2), { mode: 0o600 });
  let frozen: { files: { path: string; sha256: string }[];
    trees: { path: string; suffix: string; sha256: string }[] } | undefined;
  let verifyPacked: (() => Promise<void>) | undefined;
  let failure: unknown;
  const run = async (name: string, executable: string, args: string[], env: NodeJS.ProcessEnv,
    timeout?: number) => {
    const log = join(root, name + '.log');
    const stage: Record<string, unknown> = { name, executable, args, log, status: 'attempted' };
    stages.push(stage); await retain();
    const fd = openSync(log, 'wx', 0o600);
    try {
      // Native proofs have their existing internal bounds; never add an outer signal fallback.
      execFileSync(executable, args, { cwd: repository, env, stdio: ['ignore', fd, fd],
        ...(timeout === undefined ? {} : { timeout }) });
      stage.status = 'completed';
    } catch (error) {
      const result = error as Error & { status?: number; signal?: string };
      stage.status = 'INCOMPLETE'; stage.failure = result.message;
      stage.exitCode = result.status; stage.signal = result.signal;
      throw error;
    } finally { closeSync(fd); await retain(); }
    const info = await lstat(log); assert.ok(info.size <= 16 * 1024 * 1024);
    return readFile(log, 'utf8');
  };
  const verifyFrozen = async () => {
    assert.ok(frozen);
    for (const original of frozen.files) assert.deepEqual(await pin(original.path), original);
    for (const original of frozen.trees)
      assert.equal(await treeHash(original.path, original.suffix), original.sha256, original.path);
    await verifyPacked?.();
  };
  try {
    const node = await pin(await realpath(join(repository, 'resources/legacy-agent-host/node/v24.21.0/darwin-arm64/node')));
    assert.equal(await realpath(process.execPath), node.path);
    const nodeManifestPath = join(dirname(node.path), 'manifest.json');
    const nodeManifest = await json(nodeManifestPath);
    assert.equal(nodeManifest.version, '24.21.0'); assert.equal(nodeManifest.platform, 'darwin-arm64');
    assert.equal(nodeManifest.archiveSha256, 'bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057');
    assert.equal(nodeManifest.binarySha256, node.sha256);
    const osBuild = execFileSync('/usr/sbin/sysctl', ['-n', 'kern.osversion'], { encoding: 'utf8' }).trim();
    assert.equal(osBuild, '24G624', 'this prospective Draft qualification selects only the observed current tuple');
    proof.tuple = { platform: process.platform, architecture: process.arch, osBuild, nodeVersion: process.version };
    proof.gitSha = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    if (process.env.GITHUB_SHA) assert.equal(proof.gitSha, process.env.GITHUB_SHA);
    const hostPath = await realpath(join(repository, 'packages/legacy-agent-host/dist/cli.js'));
    const host = { ...await pin(hostPath),
      sourceSha256: await treeHash(join(repository, 'packages/legacy-agent-host/src'), '.ts'),
      distSha256: await treeHash(join(repository, 'packages/legacy-agent-host/dist'), '.js') };
    const providerRoot = await realpath(join(repository, 'packages/legacy-agent-host/node_modules/@agent-teams/provider-implementations'));
    const sdkRoot = await realpath(resolve(providerRoot, '../../@anthropic-ai/claude-agent-sdk'));
    const sdkPackage = await json(join(sdkRoot, 'package.json'));
    assert.equal(sdkPackage.name, '@anthropic-ai/claude-agent-sdk'); assert.equal(sdkPackage.version, '0.3.305');
    const claude = await pin(await realpath(resolve(sdkRoot, '../claude-agent-sdk-darwin-arm64/claude')));
    const codex = await pin(await realpath(join(inputsDirectory, 'codex/codex-aarch64-apple-darwin')));
    const codeModeHost = (await captureDesktopCodexNativeInputs(codex.path))[1]!;
    const codeModeHostArchive = await pin(join(inputsDirectory, 'codex-code-mode-host-aarch64-apple-darwin.tar.gz'));
    assert.equal(codeModeHostArchive.sha256, '9455c17fa9ba6e89f8ec24ebfd3419825e2c651c56f8bd8df7141411e6decdc2');
    proof.codexNativeInputs = { executable: codex, codeModeHost, archive: codeModeHostArchive };
    const opencode = await pin(await realpath(join(inputsDirectory, 'opencode/opencode')));
    for (const [actual, expected] of [[claude.sha256, 'ea3ea3c08d2a9634a4651e687fcf900d410c489bce2b00f22bd7352b91ba704f'],
      [codex.sha256, '8238273076041e55beded03ba1d51e034f997b7d100b0642d36daf036620fe57'],
      [opencode.sha256, '417af53923f3d529759ab85ce3e8dd09116f742efcd332de591d2da6ebae696b']]) assert.equal(actual, expected);
    const corepackRoot = await realpath(join(inputsDirectory, 'corepack/node_modules/corepack'));
    const corepack = { entry: await pin(join(corepackRoot, 'dist/pnpm.js')),
      package: await pin(join(corepackRoot, 'package.json')), library: await pin(join(corepackRoot, 'dist/lib/corepack.cjs')) };
    const corepackPackage = await json(corepack.package.path);
    assert.equal(corepackPackage.name, 'corepack'); assert.equal(corepackPackage.version, '0.36.0');
    const terminalLockPath = join(repository, 'terminal-platform.lock.json');
    const terminalLock = await json(terminalLockPath);
    const terminalAsset = row(row(terminalLock.assets)['darwin-arm64']);
    assert.equal(terminalLock.version, '0.3.3');
    assert.equal(terminalAsset.file, 'terminal-platform-runtime-darwin-arm64-v0.3.3.tar.gz');
    assert.equal(terminalAsset.sha256, 'b78da8494e2ee9b46b9bd2e002b7b6d27a2431fbac5f8bcd52d7940c408702cd');
    const terminalArchive = join(inputsDirectory, String(terminalAsset.file));
    assert.equal(await digest(terminalArchive), terminalAsset.sha256);
    const terminalRoot = join(repository, 'resources/terminal-platform');
    const terminalBinary = await pin(join(terminalRoot, 'terminal-daemon'));
    assert.ok((await readFile(join(terminalRoot, 'VERSION'), 'utf8')).includes('0.3.3'));
    proof.terminalPlatform = { archive: await pin(terminalArchive), binary: terminalBinary };
    const headersArchive = join(inputsDirectory, 'node-v24.21.0-headers.tar.gz');
    assert.equal(await digest(headersArchive), '57c6bee2e30bbbee5bd51d6cc343eb992e174b56a2a1d0eab7a7510771c20ea2');
    const headersRoot = await realpath(join(inputsDirectory, 'node-v24.21.0/include/node'));
    const headerNames = ['node_api.h', 'node_api_types.h', 'js_native_api.h', 'js_native_api_types.h', 'node_version.h'];
    const versionHeader = await readFile(join(headersRoot, 'node_version.h'), 'utf8');
    for (const [name, value] of [['MAJOR', '24'], ['MINOR', '21'], ['PATCH', '0']])
      assert.match(versionHeader, new RegExp(`^#define NODE_${name}_VERSION\\s+${value}\\s*$`, 'm'));
    const compilerPath = await realpath(execFileSync('/usr/bin/xcrun', ['--find', 'clang'], { encoding: 'utf8' }).trim());
    const sdk = await realpath(execFileSync('/usr/bin/xcrun', ['--show-sdk-path'], { encoding: 'utf8' }).trim());
    const compiler = await pin(compilerPath), sdkSettings = await pin(join(sdk, 'SDKSettings.json'));
    const source = await pin(join(repository, 'packages/legacy-agent-host/native/registered-process-darwin.c'));
    assert.equal(source.sha256, '310161c5d404d45e4f149b15b88c3805bfeddc4cc4c424460cddee3e845a284b');
    const headers = await Promise.all(headerNames.map(async file => ({ file, sha256: await digest(join(headersRoot, file)) })));
    proof.toolchain = { compiler, sdkSettings, headersRoot, headers, source,
      xcode: execFileSync('/usr/bin/xcodebuild', ['-version'], { encoding: 'utf8' }).trim(),
      clang: execFileSync(compiler.path, ['--version'], { encoding: 'utf8' }).trim() };
    const artifact = buildProcessNativeArtifact({ compiler: compiler.path, compilerSha256: compiler.sha256,
      sdkRoot: sdk, sdkSettingsSha256: sdkSettings.sha256, headersRoot, headers,
      source: source.path, sourceSha256: source.sha256, outputDirectory: join(root, 'process-artifact') });
    const copiedSource = join(artifact.directory, 'registered-process-darwin.c');
    await copyFile(source.path, copiedSource, constants.COPYFILE_EXCL); assert.equal(await digest(copiedSource), source.sha256);
    const selection = { directory: artifact.directory, manifestSha256: artifact.manifestSha256 };
    proof.processArtifact = artifact;
    const env = { HOME: join(root, 'home'), TMPDIR: join(root, 'tmp'),
      PATH: dirname(node.path) + ':/usr/bin:/bin', NO_COLOR: '1' };
    const actorSource = join(repository, 'packages/legacy-agent-host/tests/fixtures/registered-process-actor.c');
    const actor = join(root, 'registered-process-actor');
    await run('compile-ancestry-actor', compiler.path, ['-std=c11', '-Wall', '-Wextra', '-Werror',
      '-isysroot', sdk, '-mmacosx-version-min=15.0', actorSource, '-o', actor], env, 60_000);
    const normalCapture = join(root, 'normal-sdk-capture.json');
    await writeFile(normalCapture, JSON.stringify({ schemaVersion: 1, node, host, claude, corepack, processArtifact: selection }),
      { flag: 'wx', mode: 0o600 });
    const nativeCapture = join(root, 'candidate-native-capture.json');
    await writeFile(nativeCapture, JSON.stringify({ schemaVersion: 1, platform: 'darwin-arm64',
      codex: { ...codex, protocolRevision: '0.162.0', codeModeHost }, opencode: { ...opencode, protocolRevision: '1.19.4' },
      processCustody: selection }), { flag: 'wx', mode: 0o600 });
    const electronRoot = dirname(await realpath(require.resolve('electron/package.json')));
    const electronDist = await realpath(join(electronRoot, 'dist'));
    const builderCli = await realpath(require.resolve('electron-builder/cli.js'));
    const fixedPaths = [...new Set([...desktopProofSources.map(path => join(repository, path)), import.meta.filename,
      join(repository, '.github/workflows/ci.yml'), join(repository, 'package.json'), join(repository, 'pnpm-lock.yaml'),
      join(repository, 'legacy-host.lock.json'), join(repository, 'electron.vite.config.ts'), node.path, nodeManifestPath,
      terminalLockPath, terminalArchive, join(repository, 'scripts/stage-terminal-platform-runtime.mjs'),
      compiler.path, sdkSettings.path, source.path, actorSource, actor, headersArchive, ...headerNames.map(name => join(headersRoot, name)),
      normalCapture, nativeCapture, join(artifact.directory, 'manifest.json'), join(artifact.directory, 'registered-process.node'), copiedSource,
      claude.path, codex.path, codeModeHost.path, codeModeHostArchive.path, opencode.path, corepack.entry.path, corepack.package.path, corepack.library.path,
      join(electronRoot, 'package.json'), join(electronDist, 'Electron.app/Contents/MacOS/Electron'), builderCli])];
    const treeInputs = [[join(repository, 'packages/legacy-agent-host/src'), '.ts'],
      [join(repository, 'packages/legacy-agent-host/dist'), '.js'], [join(repository, 'agent-teams-controller/src'), '.js'],
      [join(repository, 'mcp-server/dist'), ''], [join(repository, 'dist-electron'), ''], [join(repository, 'out/renderer'), ''],
      [terminalRoot, ''],
      [providerRoot, ''], [sdkRoot, ''], [dirname(claude.path), '']] as const;
    frozen = { files: await Promise.all(fixedPaths.map(pin)),
      trees: await Promise.all(treeInputs.map(async ([path, suffix]) => ({ path, suffix, sha256: await treeHash(path, suffix) }))) };
    proof.frozenInputs = frozen; await retain(); await verifyFrozen();
    const kernelLog = await run('kernel-live-ancestry', node.path,
      ['packages/legacy-agent-host/tests/registered-process-live-ancestry.native.ts', join(artifact.directory, 'registered-process.node'),
        artifact.manifest.binarySha256, actor, await digest(actor)], { ...env, LEGACY_REGISTERED_PROCESS_NATIVE_GO: '1' });
    const kernelRoots = jsonRows(kernelLog).filter(value => typeof value.root === 'string'); assert.equal(kernelRoots.length, 1);
    const kernelRoot = String(kernelRoots[0]!.root); privatePath(kernelRoot + '/');
    const kernel = jsonRows(await readFile(join(kernelRoot, 'proof.ndjson'), 'utf8'));
    assert.equal(kernel.filter(value => value.phase === 'kernel-contract-assertions-completed').length, 1);
    assert.equal(kernel.at(-1)?.phase, 'original-finite-cleanup-finished'); assert.equal(kernel.at(-1)?.originalTargetsAbsent, true);
    proof.kernel = { root: kernelRoot, status: 'PASS' }; await verifyFrozen();
    const normalLog = await run('normal-sdk', node.path,
      ['scripts/legacy-agent-host/qualify-process-normal-sdk.ts', normalCapture, await digest(normalCapture)],
      { ...env, LEGACY_PROCESS_NORMAL_SDK_GO: '1' });
    const normalResults = jsonRows(normalLog).filter(value => value.status === 'PASS' && typeof value.root === 'string');
    assert.equal(normalResults.length, 1); const normalRoot = String(normalResults[0]!.root); privatePath(normalRoot + '/');
    const normalOracle = await json(join(normalRoot, 'normal-sdk-oracle.json'));
    assert.equal(normalOracle.status, 'PASS'); assert.equal(row(normalOracle.sourceFreeze).status, 'PASS');
    proof.normalSdk = { root: normalRoot, status: 'PASS' }; await verifyFrozen();
    const staged = await stageCandidate({ output: join(root, 'candidate'), platform: 'darwin-arm64',
      nativeCapture: { path: nativeCapture, sha256: await digest(nativeCapture) } });
    const config = await json(staged.builderConfig);
    config.npmRebuild = false; config.forceCodeSigning = false; config.publish = null; config.electronDist = electronDist;
    config.mac = { ...row(config.mac), identity: null, forceCodeSigning: false, notarize: false, hardenedRuntime: false };
    await writeFile(staged.builderConfig, JSON.stringify(config, null, 2), { mode: 0o600 });
    const builderConfigPin = await pin(staged.builderConfig); frozen.files.push(builderConfigPin);
    proof.candidate = { ...staged, builderConfigPin };
    await verifyFrozen();
    await run('unsigned-candidate-build', node.path, [builderCli, '--config', staged.builderConfig,
      '--mac', 'dir', '--arm64', '--publish', 'never'], { ...env, CI: 'true', CSC_IDENTITY_AUTO_DISCOVERY: 'false' });
    assert.deepEqual(await pin(staged.builderConfig), builderConfigPin); await verifyFrozen();
    const appDirectory = join(staged.output, 'packed/mac-arm64');
    const apps = (await readdir(appDirectory, { withFileTypes: true })).filter(value => value.isDirectory() && value.name.endsWith('.app'));
    assert.equal(apps.length, 1); const bundleRoot = await realpath(join(appDirectory, apps[0]!.name));
    const executableName = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', join(bundleRoot, 'Contents/Info.plist')],
      { encoding: 'utf8' }).trim();
    const packedCapture = await captureCandidateElectron({ bundleRoot, executableName,
      candidateManifestSha256: staged.manifestSha256, output: join(root, 'packed-capture.json') });
    const packed = await readCapturedCandidateElectron(packedCapture);
    verifyPacked = async () => { assert.deepEqual(await readCapturedCandidateElectron(packedCapture), packed); };
    assert.equal(packed.runtime.nodeSha256, node.sha256); assert.equal(packed.runtime.hostEntrySha256, host.sha256);
    assert.equal(packed.runtime.processCustody.manifestSha256, selection.manifestSha256);
    assert.equal(await digest(join(packed.runtime.processCustody.directory, 'registered-process.node')), artifact.manifest.binarySha256);
    const packedRenderer = join(bundleRoot, 'Contents/Resources/app.asar.unpacked/out/renderer');
    const packedRendererSha256 = await treeHash(packedRenderer, '');
    frozen.trees.push({ path: packedRenderer, suffix: '', sha256: packedRendererSha256 });
    proof.packedRenderer = { path: packedRenderer, sha256: packedRendererSha256 };
    const packedTerminal = join(bundleRoot, 'Contents/Resources/terminal-platform');
    const packedTerminalSha256 = await treeHash(packedTerminal, '');
    frozen.trees.push({ path: packedTerminal, suffix: '', sha256: packedTerminalSha256 });
    proof.packedTerminal = { path: packedTerminal, sha256: packedTerminalSha256 };
    assert.equal(await digest(join(packedTerminal, 'terminal-daemon')), terminalBinary.sha256);
    proof.packedCapture = packedCapture;
    await retain(); await verifyFrozen();
    const packedLog = await run('packed-native-launch-ui', packedCapture.nodeExecutable,
      ['scripts/legacy-agent-host/desktop-backend-smoke.ts'], { ...env, LEGACY_DESKTOP_BACKEND_GO: '1',
        LEGACY_DESKTOP_PROOF_MODE: 'native-launch-ui', LEGACY_DESKTOP_PACKED_CAPTURE_PATH: packedCapture.path,
        LEGACY_DESKTOP_PACKED_CAPTURE_SHA256: packedCapture.sha256, LEGACY_DESKTOP_NODE_SHA256: packedCapture.nodeSha256,
        LEGACY_DESKTOP_HOST_ENTRY_SHA256: packedCapture.hostEntrySha256, LEGACY_DESKTOP_PNPM_PATH: corepack.entry.path,
        LEGACY_DESKTOP_PNPM_SHA256: corepack.entry.sha256, LEGACY_DESKTOP_COREPACK_PACKAGE_SHA256: corepack.package.sha256,
        LEGACY_DESKTOP_COREPACK_LIBRARY_SHA256: corepack.library.sha256 });
    const packedResults = jsonRows(packedLog).filter(value => value.status === 'PASS' && typeof value.receipt === 'string');
    assert.equal(packedResults.length, 1); const packedReceiptPath = String(packedResults[0]!.receipt); privatePath(packedReceiptPath);
    const packedReceipt = await json(packedReceiptPath);
    assert.equal(packedReceipt.status, 'PASS'); assert.equal(packedReceipt.mode, 'native-launch-ui');
    assert.equal(packedReceipt.packedCandidateVerifiedAfterCleanup, true);
    assert.deepEqual(await readCapturedCandidateElectron(packedCapture), packed);
    assert.equal(await treeHash(packedRenderer, ''), packedRendererSha256);
    proof.packed = { receipt: packedReceiptPath, sha256: await digest(packedReceiptPath), status: 'PASS' };
    await verifyFrozen(); proof.status = 'PASS';
  } catch (error) { failure = error; proof.failure = error instanceof Error ? error.message : String(error); }
  finally {
    if (frozen) try { await verifyFrozen(); proof.sourceFreeze = { status: 'PASS' }; } catch (error) {
      proof.status = 'INCOMPLETE'; proof.sourceFreeze = { status: 'INCOMPLETE', failure: String(error) }; failure ??= error;
    }
    await retain(); console.log(JSON.stringify({ root, receipt: receiptPath, status: proof.status }));
  }
  if (failure) throw failure;
  return { root, receipt: receiptPath, status: proof.status };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [inputsDirectory, ...extra] = process.argv.slice(2);
  assert.ok(inputsDirectory && extra.length === 0, 'Usage: node run-process-qualification.ts PRIVATE_TEST_INPUTS_DIRECTORY');
  await runProcessQualification(inputsDirectory);
}
