/** Resolve immutable TEST inputs for the original retained-owner Desktop proof; no session is launched. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
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
async function captureDonorInputs() {
  const donorCommit = '4a0e06277fe216d9f82dbbede362668fe46622ee';
  const donorTree = '4bb456a5b35b6fca0e795bc8b19a13f5f1f6defd';
  const sourceCommit = 'e13edcd3d4ffbecc0272ae30195cc6b15b710ee7';
  const sourceTree = 'a5ed6ffc453a68a5454328bd79a9422ce1e4e3e9';
  const root = await realpath(process.env.OPENCODE_V1_V2_DONOR_REPO!);
  const sourceDirectory = await realpath(process.env.OPENCODE_V1_V2_DONOR_CUSTODY_SOURCE!);
  assert.equal(root, join(repo, '.runtime-download/TEST-donor-4a'));
  assert.equal(sourceDirectory, join(repo, '.runtime-download/TEST-donor-runtime-source'));
  const git = (directory: string, args: string[]) => execFileSync('/usr/bin/git',
    ['-C', directory, ...args], { encoding: 'utf8', timeout: 5000 }).trim();
  const verifySource = () => {
    for (const [directory, commit, tree] of [
      [root, donorCommit, donorTree], [sourceDirectory, sourceCommit, sourceTree],
    ]) {
      assert.equal(git(directory!, ['rev-parse', '--show-toplevel']), directory);
      assert.equal(git(directory!, ['rev-parse', 'HEAD']), commit);
      assert.equal(git(directory!, ['rev-parse', 'HEAD^{tree}']), tree);
      assert.equal(git(directory!, ['diff', '--name-only', 'HEAD']), '', 'donor inputs stay immutable');
      assert.equal(git(directory!, ['ls-files', '--others', '--exclude-standard']), '');
    }
    assertNativeV1Source(repo, sourceHead);
  };
  verifySource();
  const packageJson = await readJson(join(root, 'package.json'));
  const packageManager = 'pnpm@11.22.0+sha512.1ff870c4c6133dfd88fb2afc46dd13d47f09c9794b438c6fdb47ca98caf3bc16381ee0be93a091b8e3824cf01f889f46d7d9e20910fb0be1ab0fb5baa80dd621';
  assert.equal(packageJson.packageManager, packageManager);
  const lock = await readJson(join(root, 'runtime.lock.json'));
  assert.equal(lock.version, '0.0.160'); assert.equal(lock.cliVersion, '2.777.777');
  assert.equal(lock.sourceRepository, '777genius/agent_teams_orchestrator');
  assert.equal(lock.releaseRepository, '777genius/agent_teams_orchestrator_binaries');
  assert.equal(lock.releaseTag, 'runtime-v0.0.160');
  const asset = (lock.assets as Record<string, Record<string, unknown>>)['linux-x64']!;
  const archiveSha256 = '09b174841e74c95337f8b1be986f1501a71582ce190671c548bf4c70ab814e10';
  assert.equal(asset.file, 'agent-teams-runtime-linux-x64-v0.0.160.tar.gz');
  assert.equal(asset.archiveKind, 'tar.gz'); assert.equal(asset.binaryName, 'claude-multimodel');
  assert.equal(asset.sha256, archiveSha256);
  const delivery = (lock.opencodeV2Delivery as Record<string, Record<string, unknown>>)['linux-x64']!;
  assert.equal(delivery.sourceCommit, sourceCommit);
  const runtimeRoot = join(root, 'resources/runtime');
  assert.equal(await realpath(runtimeRoot), runtimeRoot);
  assert.equal((await readFile(join(runtimeRoot, 'COMMIT_SHA'), 'utf8')).trim(), sourceCommit);
  assert.equal((await readFile(join(runtimeRoot, 'VERSION'), 'utf8')).trim(), '0.0.160');
  const runtime = await pin(join(runtimeRoot, 'claude-multimodel'));
  assert.equal(runtime.path, join(runtimeRoot, 'claude-multimodel'));
  const files = await Promise.all([
    'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc', '.node-version',
    'runtime.lock.json', 'electron.vite.config.ts', 'scripts/stage-runtime.mjs',
    'scripts/lib/github-release-download-error.mjs', 'scripts/lib/runtime-archive-checksum.mjs',
    'scripts/lib/runtime-payload-cache.mjs', 'scripts/lib/opencode-v2-base-inventory.mts',
    'scripts/ci/enforce-pnpm-install.mjs', 'scripts/ci/install-dependencies-with-retry.mjs',
    'scripts/ensure-electron-install.cjs',
    'scripts/postinstall-electron.cjs', 'scripts/prepare-cpu-features-rebuild.cjs',
    'agent-teams-controller/package.json', 'agent-teams-controller/scripts/build.mjs',
    'mcp-server/package.json', 'resources/runtime/COMMIT_SHA', 'resources/runtime/VERSION',
  ].map(async (path) => {
    const measured = await pin(join(root, path));
    assert.equal(measured.path, join(root, path));
    return { path, sha256: measured.sha256 };
  }));
  const node = { ...await pin(process.execPath), version: process.version };
  assert.equal(node.version, 'v24.21.0');
  const electronManifest = await realpath(join(root, 'node_modules/electron/package.json'));
  const electronRoot = dirname(electronManifest);
  assert.ok(electronRoot.startsWith(join(root, 'node_modules') + '/'));
  const electronPackage = await readJson(electronManifest);
  assert.equal(electronPackage.name, 'electron'); assert.equal(electronPackage.version, '44.10.1');
  assert.equal((await readFile(join(electronRoot, 'path.txt'), 'utf8')).trim(), 'electron');
  assert.equal((await readFile(join(electronRoot, 'dist/version'), 'utf8')).trim().replace(/^v/, ''), '44.10.1');
  const electron = { ...await pin(join(electronRoot, 'dist/electron')), version: '44.10.1' };
  assert.equal(electron.path, join(electronRoot, 'dist/electron'));
  const source = await pin(join(sourceDirectory, 'native/opencode-custody/linux.c'));
  const buildScript = await pin(join(sourceDirectory, 'scripts/stage-opencode-custody.mts'));
  const validator = await pin(join(sourceDirectory, 'scripts/lib/opencode-custody-artifact.ts'));
  assert.equal(source.path, join(sourceDirectory, 'native/opencode-custody/linux.c'));
  assert.equal(buildScript.path, join(sourceDirectory, 'scripts/stage-opencode-custody.mts'));
  assert.equal(validator.path, join(sourceDirectory, 'scripts/lib/opencode-custody-artifact.ts'));
  const bun = await pin(process.env.OPENCODE_V2_EMBEDDED_BUN!);
  assert.equal(bun.sha256, process.env.OPENCODE_V2_EMBEDDED_BUN_SHA256);
  let nativeDirectory = join(runtimeRoot, 'native');
  let kind: 'PUBLISHED_RUNTIME_ASSET' | 'EXACT_RELEASE_SOURCE_BUILD' = 'PUBLISHED_RUNTIME_ASSET';
  let compiler: string | undefined;
  let absent = false, selected = runtimeRoot;
  const parts = ['native', 'opencode-custody', 'linux-x64', 'custodian'];
  for (const [index, part] of parts.entries()) {
    selected = join(selected, part);
    try {
      const metadata = await lstat(selected);
      assert.equal(metadata.isSymbolicLink(), false, 'packaged custody path cannot redirect');
      assert.ok(index === parts.length - 1 ? metadata.isFile() : metadata.isDirectory());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      absent = true; break;
    }
  }
  if (absent) {
    const sidecar = join(runtimeRoot, 'native/opencode-custody/linux-x64/custodian.json');
    try {
      await lstat(sidecar);
      assert.fail('incomplete packaged custody artifact cannot select a source-build fallback');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    // Only absent packaged custody selects the unchanged exact release-source build.
    kind = 'EXACT_RELEASE_SOURCE_BUILD';
    execFileSync(bun.path, ['--no-env-file', '--no-install', 'scripts/stage-opencode-custody.mts'],
      { cwd: sourceDirectory, env: { PATH: '/usr/bin:/bin' }, timeout: 60_000 });
    nativeDirectory = join(sourceDirectory, 'dist/native');
    compiler = execFileSync('/usr/bin/cc', ['--version'],
      { encoding: 'utf8', timeout: 5000 }).split('\n')[0];
    assert.ok(compiler && compiler.length <= 512);
  }
  // A present invalid artifact always refuses; validation errors never trigger fallback.
  const validated = JSON.parse(execFileSync(bun.path, ['--no-env-file', '--no-install', '-e',
    "import { verifyLinuxCustodyArtifact } from './scripts/lib/opencode-custody-artifact.js'; " +
    'console.log(JSON.stringify(verifyLinuxCustodyArtifact(' + JSON.stringify(nativeDirectory) +
    ",'linux-x64'," + JSON.stringify(source.path) + ')))'],
  { cwd: sourceDirectory, env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 5000 })) as Record<string, unknown>;
  const helper = await pin(join(nativeDirectory, 'opencode-custody/linux-x64/custodian'));
  assert.equal(helper.path, join(nativeDirectory, 'opencode-custody/linux-x64/custodian'));
  const manifestPin = await pin(helper.path + '.json');
  assert.equal(manifestPin.path, helper.path + '.json');
  assert.ok((await lstat(manifestPin.path)).size <= 16 * 1024);
  const manifest = await readJson(manifestPin.path);
  assert.equal(validated.schemaVersion, 1); assert.equal(validated.platform, 'linux'); assert.equal(validated.arch, 'x64');
  assert.equal(validated.sha256, helper.sha256); assert.equal(validated.sourceSha256, source.sha256);
  for (const field of ['schemaVersion', 'platform', 'arch', 'size', 'sha256', 'sourceSha256'])
    assert.equal(manifest[field], validated[field]);
  for (const measured of [runtime, node, electron, source, buildScript, validator, bun, helper, manifestPin])
    assert.deepEqual(await pin(measured.path), { path: measured.path, sha256: measured.sha256 });
  for (const file of files) assert.deepEqual(await pin(join(root, file.path)),
    { path: join(root, file.path), sha256: file.sha256 });
  verifySource();
  return { kind: 'TEST_DONOR_4A_RUNTIME_160_INPUTS', root, commit: donorCommit, tree: donorTree,
    packageManager, files, node, electron,
    runtime: { ...runtime, version: '0.0.160', cliVersion: '2.777.777', archiveSha256, sourceCommit },
    custody: { ...helper, kind, sourceDirectory, sourceCommit, sourceTree, manifest,
      manifestSha256: manifestPin.sha256, sourceSha256: source.sha256,
      buildScriptSha256: buildScript.sha256, validatorSha256: validator.sha256,
      ...(compiler === undefined ? {} : { compiler }), publishedRuntimeComplete: false } };
}

const packages = await realpath(process.env.OPENCODE_V1_V2_TEST_PACKAGES!);
const inputsReceipt = process.env.OPENCODE_V1_V2_INPUTS_RECEIPT!;
assert.ok(inputsReceipt && isAbsolute(inputsReceipt));
const sourceSelection = process.env.OPENCODE_V1_UI_SOURCE_SELECTION_GO === '1';
const v2SourceSelection = process.env.OPENCODE_V2_UI_SOURCE_SELECTION_GO === '1';
assert.ok(!(sourceSelection && v2SourceSelection), 'one original source-selection mode');
const evidence: Record<string, unknown> = { kind: v2SourceSelection ? 'TEST_DESKTOP_V2_SOURCE_INPUTS' :
  sourceSelection ? 'TEST_DESKTOP_V1_SOURCE_INPUTS' : 'TEST_RETAINED_V1_HOST_V2_INPUTS',
  sourceHead, status: 'HOLD', releaseQualified: false };
await writeFile(inputsReceipt, JSON.stringify(evidence), { mode: 0o600, flag: 'wx' });
let failure: { error: unknown } | undefined;
try {
  if (v2SourceSelection) {
    const { parse } = await import('yaml');
    const { loadNativeV1InstallSelector } = await import('../../packages/legacy-agent-host/tests/fixtures/native-opencode-install-selection.ts');
    const stage = async (directory: string, version: '2.0.21' | '2.3.0') => {
      const root = await realpath(join(directory, 'node_modules/@opencode/cli'));
      const native = await realpath(join(directory, 'node_modules/@opencode/cli-linux-x64'));
      assert.ok(root.startsWith(directory + '/') && native.startsWith(directory + '/'));
      const rootMetadata = await readJson(join(root, 'package.json'));
      const nativeMetadata = await readJson(join(native, 'package.json'));
      assert.equal(rootMetadata.name, '@opencode/cli'); assert.equal(rootMetadata.version, version);
      assert.equal(nativeMetadata.name, '@opencode/cli-linux-x64'); assert.equal(nativeMetadata.version, version);
      assert.deepEqual(rootMetadata.bin, { opencode: './bin/opencode.exe', opencode2: './bin/opencode.exe' });
      assert.equal((rootMetadata.optionalDependencies as Record<string, unknown>)?.['@opencode/cli-linux-x64'], version);
      // Published root stubs are unexecuted evidence. Only the separate native input is put on PATH.
      const rootLauncher = await pin(join(root, 'bin/opencode.exe'));
      const binary = await pin(join(native, 'bin/opencode'));
      assert.equal(rootLauncher.path, join(root, 'bin/opencode.exe'));
      assert.equal(binary.path, join(native, 'bin/opencode'));
      const packageLock = await pin(join(directory, 'pnpm-lock.yaml'));
      const locked = parse(await readFile(packageLock.path, 'utf8')) as {
        packages?: Record<string, { resolution?: { integrity?: string } }>;
      };
      const rootIntegrity = locked.packages?.['@opencode/cli@' + version]?.resolution?.integrity;
      const nativeIntegrity = locked.packages?.['@opencode/cli-linux-x64@' + version]?.resolution?.integrity;
      assert.match(nativeIntegrity ?? '', /^sha512-[A-Za-z0-9+/]+={0,2}$/);
      assert.equal(rootIntegrity, version === '2.0.21'
        ? 'sha512-hXFVQlNX+usWsYR5xYxDl1pYyG525V7p0kAGI0Q/mhrLg/2FpyJwuw0bMVJ+fc4PxHKHPC0tsIwAG/8i3lusKg=='
        : 'sha512-Q5RV8jLJ4O8bY2O8X2hkBOkgPf6+nDB9MEkz/Q/Cc4Ojd2SwUFFzEd1LzgNGKiXiS7g/9+/X4eqhrxY60fLMOQ==');
      return { version, ...binary, packageDirectory: directory, rootIntegrity, nativeIntegrity,
        rootManifest: await pin(join(root, 'package.json')), rootLauncher,
        nativeManifest: await pin(join(native, 'package.json')), packageLock };
    };
    const original = await stage(packages, '2.0.21');
    const nextDirectory = await realpath(process.env.OPENCODE_V2_UI_NEXT_PACKAGES!);
    assert.notEqual(nextDirectory, packages);
    const next = await stage(nextDirectory, '2.3.0');
    const corepackMetadata = await readJson(join(packages, 'node_modules/corepack/package.json'));
    assert.equal(corepackMetadata.name, 'corepack'); assert.equal(corepackMetadata.version, '0.36.0');
    const corepack = await pin(join(packages, 'node_modules/corepack/dist/pnpm.js'));
    const selector = await loadNativeV1InstallSelector(repo, sourceHead);
    const requests: { name: string; version: string | null; sha256: string }[] = [];
    const selected = await selector.select('v2', '2.1.4', [{ packageName: 'opencode-linux-x64' }],
      async (name, version = 'latest') => {
        assert.ok(['@opencode/cli', '@opencode/cli-linux-x64'].includes(name));
        assert.ok(requests.length < 8, 'finite original package-selector metadata reads');
        const url = 'https://registry.npmjs.org/' + encodeURIComponent(name) +
          (version === null ? '' : '/' + encodeURIComponent(version));
        const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw Object.assign(new Error('Original npm metadata lookup failed'), { status: response.status });
        assert.ok(response.body);
        let size = 0;
        const chunks: Uint8Array[] = [];
        for await (const bytes of response.body) {
          size += bytes.byteLength; assert.ok(size <= 16 * 1024 * 1024, 'bounded public metadata');
          chunks.push(bytes);
        }
        const bytes = Buffer.concat(chunks);
        requests.push({ name, version, sha256: createHash('sha256').update(bytes).digest('hex') });
        return JSON.parse(bytes.toString('utf8'));
      });
    assert.equal(selected.generation, 'v2');
    assert.equal(selected.packageName, '@opencode/cli-linux-x64');
    assert.equal(selected.metadata.version, '2.3.0', 'only the qualified CLI A2.0.21 to B2.3.0 transition');
    assert.equal(selected.metadata.dist?.integrity, next.nativeIntegrity);
    const tarball = new URL(selected.metadata.dist!.tarball!);
    assert.equal(tarball.protocol, 'https:'); assert.equal(tarball.hostname, 'registry.npmjs.org');
    await selector.assertUnchanged(); assertNativeV1Source(repo, sourceHead);
    const bun = await pin(process.env.OPENCODE_V2_EMBEDDED_BUN!);
    assert.equal(bun.sha256, process.env.OPENCODE_V2_EMBEDDED_BUN_SHA256);
    const directory = await realpath(process.env.OPENCODE_V2_EMBEDDED_GRAPH!);
    const manifest = await pin(join(directory, 'opencode-v2-engine-manifest.json'));
    assert.equal(manifest.sha256, process.env.OPENCODE_V2_EMBEDDED_MANIFEST_SHA256);
    evidence.v2 = original;
    evidence.next = { ...next, packageName: selected.packageName, integrity: next.nativeIntegrity,
      tarball: tarball.href, executableSha256: next.sha256,
      selectorSourceSha256: selector.sourceSha256, selectorBundleSha256: selector.bundleSha256, requests };
    evidence.engine = { version: '2.1.4', bun, directory, manifest, manifestSha256: manifest.sha256 };
    evidence.corepack = { version: '0.36.0', ...corepack };
    assert.ok(process.env.GITHUB_ENV);
    const values = { OPENCODE_V2_UI_SOURCE_INPUTS_RECEIPT: inputsReceipt,
      OPENCODE_V1_V2_COREPACK_ENTRY: corepack.path };
    for (const value of Object.values(values)) assert.ok(!/[\r\n\0]/.test(value));
    await appendFile(process.env.GITHUB_ENV!, Object.entries(values).map(([key, value]) => key + '=' + value + '\n').join(''));
  } else {
    for (const [name, version] of [['opencode-ai', '1.19.4'], ['opencode-linux-x64', '1.19.4'], ['corepack', '0.36.0']]) {
      const metadata = await readJson(join(packages, 'node_modules', name!, 'package.json'));
      assert.equal(metadata.name, name); assert.equal(metadata.version, version);
    }
    const binary = await pin(join(packages, 'node_modules/opencode-linux-x64/bin/opencode'));
    assert.equal(binary.sha256, '538fcb1b6408c8d4608822acee19f7ff5b3a3eb3383c0633c4f06170857312a7');
    const corepack = await pin(join(packages, 'node_modules/corepack/dist/pnpm.js'));
    if (sourceSelection) {
      const rootPackage = await realpath(join(packages, 'node_modules/opencode-ai'));
      const rootMetadata = await readJson(join(rootPackage, 'package.json'));
      assert.equal(rootMetadata.name, 'opencode-ai');
      assert.equal(rootMetadata.version, '1.19.4');
      const bins = rootMetadata.bin;
      assert.ok(bins && typeof bins === 'object' && !Array.isArray(bins), 'original published bin map');
      const rootBin = (bins as Record<string, unknown>).opencode;
      assert.ok(Object.keys(bins).length === 1 && Object.hasOwn(bins, 'opencode') &&
        rootBin === './bin/opencode.exe', 'exact original published opencode bin');
      // Unexecuted package-layout evidence; the platform executable remains the original A input.
      const rootLauncher = await pin(join(rootPackage, rootBin));
      assert.equal(rootLauncher.path, join(rootPackage, rootBin), 'original bin stays in its canonical package');
      const { parse } = await import('yaml');
      const { loadNativeV1InstallSelector } = await import('../../packages/legacy-agent-host/tests/fixtures/native-opencode-install-selection.ts');
      const lockPin = await pin(join(packages, 'pnpm-lock.yaml'));
      const locked = parse(await readFile(lockPin.path, 'utf8')) as {
        packages?: Record<string, { resolution?: { integrity?: string } }>;
      };
      const nativeIntegrity = locked.packages?.['opencode-linux-x64@1.19.4']?.resolution?.integrity;
      const rootIntegrity = locked.packages?.['opencode-ai@1.19.4']?.resolution?.integrity;
      assert.match(nativeIntegrity ?? '', /^sha512-[A-Za-z0-9+/]+={0,2}$/);
      assert.match(rootIntegrity ?? '', /^sha512-[A-Za-z0-9+/]+={0,2}$/);
      const selector = await loadNativeV1InstallSelector(repo, sourceHead);
      const requests: { name: string; version: string | null; sha256: string }[] = [];
      const selected = await selector.select('v1', null, [{ packageName: 'opencode-linux-x64' }], async (name, version = 'latest') => {
        assert.ok(['opencode-ai', 'opencode-linux-x64'].includes(name));
        assert.ok(requests.length < 8, 'finite original package-selector metadata reads');
        const url = 'https://registry.npmjs.org/' + encodeURIComponent(name) +
          (version === null ? '' : '/' + encodeURIComponent(version));
        const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw Object.assign(new Error('Original npm metadata lookup failed'), { status: response.status });
        assert.ok(response.body);
        let size = 0;
        const chunks: Uint8Array[] = [];
        for await (const bytes of response.body) {
          size += bytes.byteLength; assert.ok(size <= 16 * 1024 * 1024, 'bounded public metadata');
          chunks.push(bytes);
        }
        const bytes = Buffer.concat(chunks);
        requests.push({ name, version, sha256: createHash('sha256').update(bytes).digest('hex') });
        return JSON.parse(bytes.toString('utf8'));
      });
      assert.equal(selected.generation, 'v1');
      assert.equal(selected.packageName, 'opencode-linux-x64');
      assert.equal(selected.metadata.version, '1.19.5', 'only the qualified A1.19.4 to B1.19.5 transition');
      assert.match(selected.metadata.dist?.integrity ?? '', /^sha512-[A-Za-z0-9+/]+={0,2}$/);
      const tarball = new URL(selected.metadata.dist!.tarball!);
      assert.equal(tarball.protocol, 'https:'); assert.equal(tarball.hostname, 'registry.npmjs.org');
      await selector.assertUnchanged(); assertNativeV1Source(repo, sourceHead);
      evidence.v1 = { version: '1.19.4', ...binary, packageDirectory: packages,
        nativeIntegrity, rootIntegrity,
        rootManifest: await pin(join(packages, 'node_modules/opencode-ai/package.json')),
        rootLauncher,
        nativeManifest: await pin(join(packages, 'node_modules/opencode-linux-x64/package.json')) };
      evidence.packageLock = lockPin;
      evidence.corepack = { version: '0.36.0', ...corepack };
      evidence.next = { version: selected.metadata.version, packageName: selected.packageName,
        integrity: selected.metadata.dist!.integrity, tarball: tarball.href,
        executableSha256: '7df4e4136301f16589b0f30bf91a61380fca5f8ef22dd36570f5ebe1d4ec802c',
        selectorSourceSha256: selector.sourceSha256, selectorBundleSha256: selector.bundleSha256, requests };
      assert.ok(process.env.GITHUB_ENV);
      const values = { OPENCODE_V1_UI_SOURCE_INPUTS_RECEIPT: inputsReceipt,
        OPENCODE_V1_V2_RETAINED_BINARY: binary.path, OPENCODE_V1_V2_RETAINED_BINARY_SHA256: binary.sha256,
        OPENCODE_V1_V2_COREPACK_ENTRY: corepack.path };
      for (const value of Object.values(values)) assert.ok(!/[\r\n\0]/.test(value));
      await appendFile(process.env.GITHUB_ENV!, Object.entries(values).map(([key, value]) => key + '=' + value + '\n').join(''));
    } else {
      const retainedRoot = await realpath(process.env.OPENCODE_V1_V2_RETAINED_REPO!);
      assert.equal(retainedRoot, join(await realpath(repo), '.runtime-download/TEST-retained-release-158'));
      const appGit = (args: string[]) => execFileSync('git', args,
        { cwd: retainedRoot, encoding: 'utf8', timeout: 5000 }).trim();
      const verifyRetainedApp = () => {
        assert.equal(appGit(['rev-parse', '--show-toplevel']), retainedRoot);
        assert.equal(appGit(['rev-parse', 'HEAD']), '1d0f97f55de566036c970eab4f36b84620afdb3f');
        assert.equal(appGit(['rev-parse', 'HEAD^{tree}']), 'ec540290c86af9755c94e52ac795aeda8586a98f');
        assert.equal(appGit(['diff', '--name-only', 'HEAD']), '');
        assert.equal(appGit(['ls-files', '--others', '--exclude-standard']), '');
      };
      verifyRetainedApp();
      const lockPin = await pin(join(retainedRoot, 'runtime.lock.json'));
      const stagePin = await pin(join(retainedRoot, 'scripts/stage-runtime.mjs'));
      assert.equal(lockPin.path, join(retainedRoot, 'runtime.lock.json'));
      assert.equal(stagePin.path, join(retainedRoot, 'scripts/stage-runtime.mjs'));
      const appSource = { root: retainedRoot, commit: appGit(['rev-parse', 'HEAD']),
        tree: appGit(['rev-parse', 'HEAD^{tree}']), lockSha256: lockPin.sha256, stageScriptSha256: stagePin.sha256 };
      assert.equal(appSource.lockSha256, '1311acf34215a47950dd071a23669a69ed866d4825bcde5d21db41302a71d29d');
      assert.equal(appSource.stageScriptSha256, '7ee8a9036562728a66d5a1dcd3ce7c97abf75cabeb97092eb9b87171ed2e29be');
      const lock = await readJson(lockPin.path);
      assert.equal(lock.version, '0.0.158');
      assert.equal(lock.sourceRepository, '777genius/agent_teams_orchestrator');
      const asset = (lock.assets as Record<string, Record<string, unknown>>)['linux-x64']!;
      assert.equal(asset.sha256, '4c106fcebab79de525aa7c9bb7636aa91fa43e76b4d567a00f98b2e6650ab29d');
      const runtimeRoot = join(retainedRoot, 'resources/runtime');
      assert.equal(await realpath(runtimeRoot), runtimeRoot);
      for (const name of ['COMMIT_SHA', 'VERSION'])
        assert.equal(await realpath(join(runtimeRoot, name)), join(runtimeRoot, name));
      const release = await pin(join(runtimeRoot, 'claude-multimodel'));
      assert.equal(release.path, join(runtimeRoot, 'claude-multimodel'));
      assert.equal(release.sha256, 'b9b4c9f786238922cad49f46e5ac147b4e361b182bd250e5fbb47571571059cd');
      const commit = (await readFile(join(runtimeRoot, 'COMMIT_SHA'), 'utf8')).trim();
      assert.equal((await readFile(join(runtimeRoot, 'VERSION'), 'utf8')).trim(), '0.0.158');
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
      evidence.retainedRuntime = { version: lock.version, ...release, sourceCommit: commit,
        appSource, archiveSha256: asset.sha256 };
      evidence.sourceBuiltHelper = { sourceCommit: commit, sourceTree: git(['rev-parse', 'HEAD^{tree}']),
        source: await pin(join(helperSource, 'native/opencode-custody/linux.c')),
        buildScript: await pin(join(helperSource, 'scripts/stage-opencode-custody.mts')),
        validator: await pin(join(helperSource, 'scripts/lib/opencode-custody-artifact.ts')),
        publishedRuntimeComplete: false };
      evidence.corepack = { version: '0.36.0', ...corepack };
      evidence.packageLock = await pin(join(packages, 'pnpm-lock.yaml'));
      evidence.donor = await captureDonorInputs();
      verifyRetainedApp();
      assertNativeV1Source(repo, sourceHead);
      await appendFile(process.env.GITHUB_ENV!, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(''));
    }
  }
  evidence.status = 'READY';
} catch (error) {
  failure = { error };
  evidence.failure = error instanceof Error ? error.message : String(error);
} finally {
  try { await writeFile(inputsReceipt, JSON.stringify(evidence, null, 2), { mode: 0o600 }); }
  catch (error) { failure ??= { error }; }
}
if (failure) throw failure.error;
