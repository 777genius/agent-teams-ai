/** TEST-only capture of the existing builder's unpacked Host resources. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, readlink, realpath, symlink, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { candidateDigest } from './candidate-closure.ts';
import type { CandidatePackage } from './candidate-closure.ts';
import type { StagedNode } from './stage-node.ts';
import type { PackagedNativeHostInputs } from '../../packages/legacy-agent-host/tests/opencode-v2-embedded-host.native.ts';

export interface PackagedOpenCodeV2Capture {
  resourcesRoot: string;
  manifestSha256: string;
  appAsar: string;
  appAsarSha256: string;
}

export interface PackagedOpenCodeV2Manifest {
  schemaVersion: 1;
  kind: 'TEST_PACKAGED_OPENCODE_V2_INPUTS';
  sourceHead: string;
  platform: string;
  hostSourceDigest: string;
  harnessSha256: string;
  node: StagedNode;
  nodeExecutable: string;
  hostPackage: string;
  hostEntry: string;
  hostEntrySha256: string;
  packages: CandidatePackage[];
  artifacts: { name: string; sha256: string }[];
  bun: { path: string; sha256: string; version: string };
  engine: { directory: string; manifestSha256: string; version: '2.1.4' };
  processCustody?: { directory: string; manifestSha256: string; binarySha256: string };
}

const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const inside = (root: string, target: string) => {
  const value = relative(root, target);
  return value !== '' && value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value);
};

/** No acquisition, repair, PATH lookup or source fallback occurs in the reader. */
export async function readPackagedOpenCodeV2(capture: PackagedOpenCodeV2Capture) {
  assert.ok(isAbsolute(capture.resourcesRoot) && hash(capture.manifestSha256));
  const root = await realpath(capture.resourcesRoot);
  assert.equal(root, capture.resourcesRoot);
  const rootInfo = await lstat(root);
  assert.ok(rootInfo.isDirectory() && !rootInfo.isSymbolicLink());
  async function selected(raw: string) {
    assert.ok(typeof raw === 'string' && raw.length > 0 && !isAbsolute(raw) &&
      !/[\\:\0]/.test(raw) && raw.split('/').every(part => part && part !== '.' && part !== '..'));
    const file = join(root, raw);
    assert.equal(await realpath(file), file, 'packaged inputs cannot escape through links');
    assert.ok(inside(root, file));
    return file;
  }
  async function verified(raw: string, expected: string, executable = false) {
    assert.ok(hash(expected));
    const file = await selected(raw), info = await lstat(file);
    assert.ok(info.isFile() && !info.isSymbolicLink());
    if (executable && process.platform !== 'win32') assert.ok(info.mode & 0o111);
    assert.equal(await candidateDigest(file), expected, 'packaged file digest changed');
    return file;
  }
  const bytes = await readFile(await selected('opencode-v2-candidate.json'));
  assert.ok(bytes.length <= 16 * 1024 * 1024);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), capture.manifestSha256);
  const manifest = JSON.parse(bytes.toString('utf8')) as PackagedOpenCodeV2Manifest;
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.kind, 'TEST_PACKAGED_OPENCODE_V2_INPUTS');
  assert.equal(manifest.platform, `${process.platform}-${process.arch}`);
  assert.ok(['linux-x64', 'darwin-arm64', 'darwin-x64', 'win32-x64', 'win32-arm64'].includes(manifest.platform));
  assert.match(manifest.sourceHead, /^[a-f0-9]{40}$/);
  assert.ok(hash(manifest.hostSourceDigest) && hash(manifest.harnessSha256));
  assert.equal(manifest.node.version, '24.21.0');
  assert.equal(manifest.node.platform, manifest.platform);
  assert.equal(manifest.node.schemaVersion, 1);
  assert.equal(manifest.node.executable, process.platform === 'win32' ? 'node.exe' : 'node');
  assert.equal(manifest.nodeExecutable, `node/v24.21.0/${manifest.platform}/${manifest.node.executable}`);
  assert.ok(hash(manifest.node.archiveSha256));
  assert.ok(Array.isArray(manifest.packages) && manifest.packages.length > 0 && manifest.packages.length <= 512);
  const keys = new Set(manifest.packages.map(row => row.path));
  assert.equal(keys.size, manifest.packages.length);
  let fileCount = 0;
  for (const pkg of manifest.packages) {
    assert.match(pkg.path, /^packages\/\d{4}$/);
    assert.ok(Array.isArray(pkg.files) && pkg.files.length > 0 && pkg.dependencies && typeof pkg.dependencies === 'object');
    fileCount += pkg.files.length;
    assert.ok(fileCount <= 100_000);
    const names = new Set<string>();
    for (const file of pkg.files) {
      assert.ok(!names.has(file.path)); names.add(file.path);
      assert.equal(typeof file.executable, 'boolean');
      assert.ok(!file.path.split('/').includes('node_modules'));
      await verified(`host/${pkg.path}/${file.path}`, file.sha256, file.executable);
    }
    for (const [name, key] of Object.entries(pkg.dependencies)) {
      assert.match(name, /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/iu);
      assert.match(key, /^\d{4}$/);
      assert.ok(keys.has(`packages/${key}`));
      const linked = await realpath(join(root, 'host', pkg.path, 'node_modules', name));
      assert.equal(linked, await selected(`host/packages/${key}`), 'packaged dependency must remain in its captured closure');
    }
    // Extra payload or dependency entries could change Node resolution without
    // changing a listed file. Observe the complete copied package, including links.
    const links = new Set(Object.keys(pkg.dependencies).map(name => `node_modules/${name}`));
    const directories = new Set<string>();
    for (const name of [...names, ...links]) {
      const parts = name.split('/');
      for (let end = 1; end < parts.length; end++) directories.add(parts.slice(0, end).join('/'));
    }
    async function census(prefix = ''): Promise<void> {
      for (const child of await readdir(join(root, 'host', pkg.path, prefix), { withFileTypes: true })) {
        const name = prefix ? `${prefix}/${child.name}` : child.name;
        if (child.isSymbolicLink()) assert.ok(links.has(name), 'unlisted packaged dependency link');
        else if (child.isDirectory()) {
          assert.ok(directories.has(name), 'unlisted packaged directory');
          await census(name);
        } else assert.ok(child.isFile() && names.has(name), 'unlisted packaged payload');
      }
    }
    await census();
  }
  assert.deepEqual((await readdir(await selected('host/packages'))).sort(),
    manifest.packages.map(row => row.path.slice('packages/'.length)).sort());
  const host = manifest.packages.find(pkg => pkg.name === '@agent-teams/legacy-agent-host');
  assert.ok(host && manifest.hostPackage === `host/${host.path}` && manifest.hostEntry === `${manifest.hostPackage}/dist/cli.js`);
  assert.equal(host.files.find(file => file.path === 'dist/cli.js')?.sha256, manifest.hostEntrySha256);
  assert.ok(Array.isArray(manifest.artifacts) && manifest.artifacts.length === 2);
  for (const name of ['@agent-teams/provider-implementations', '@agent-teams/provider-session-contracts'])
    assert.equal(manifest.artifacts.filter(item => item.name === name && hash(item.sha256)).length, 1);
  const node = await verified(manifest.nodeExecutable, manifest.node.binarySha256, true);
  const nodeManifest = await selected(`node/v24.21.0/${manifest.platform}/manifest.json`);
  assert.deepEqual(JSON.parse(await readFile(nodeManifest, 'utf8')), manifest.node);
  const entry = await verified(manifest.hostEntry, manifest.hostEntrySha256);
  assert.equal(manifest.bun.path, `native/opencode-v2/${process.platform === 'win32' ? 'bun.exe' : 'bun'}`);
  const bun = await verified(manifest.bun.path, manifest.bun.sha256, true);
  assert.equal(manifest.bun.version, process.platform === 'darwin' ? '1.4.4' : process.platform === 'win32' ? '1.4.3' : '1.3.11');
  assert.equal(manifest.engine.version, '2.1.4');
  assert.equal(manifest.engine.directory, 'native/opencode-v2/engine');
  const engine = await selected(manifest.engine.directory);
  await verified(`${manifest.engine.directory}/opencode-v2-engine-manifest.json`, manifest.engine.manifestSha256);
  const hostPackage = await selected(manifest.hostPackage);
  const graph = await import(pathToFileURL(join(hostPackage, 'dist/adapters/providers/OpenCodeV2EmbeddedGraph.js')).href) as {
    verifyOpenCodeV2EmbeddedGraph(selection: unknown): Promise<{ requiredBunVersion: string }>;
  };
  const verifiedGraph = await graph.verifyOpenCodeV2EmbeddedGraph({ directory: engine,
    manifestSha256: manifest.engine.manifestSha256, version: '2.1.4', platform: process.platform, arch: process.arch });
  assert.equal(verifiedGraph.requiredBunVersion, manifest.bun.version);
  let processCustody: { directory: string; manifestSha256: string } | undefined;
  if (process.platform === 'darwin') {
    assert.ok(manifest.processCustody);
    const native = manifest.processCustody;
    assert.equal(native.directory, 'process-custody');
    await verified(`${native.directory}/manifest.json`, native.manifestSha256);
    await verified(`${native.directory}/registered-process.node`, native.binarySha256);
    processCustody = { directory: await selected(native.directory), manifestSha256: native.manifestSha256 };
    const bridge = await import(pathToFileURL(join(hostPackage, 'dist/process/readPackagedProcessArtifact.js')).href) as {
      readPackagedProcessArtifact(selection: unknown): { sha256: string };
    };
    assert.equal(bridge.readPackagedProcessArtifact(processCustody).sha256, native.binarySha256);
  } else assert.equal(manifest.processCustody, undefined);
  assert.equal(capture.appAsar, join(dirname(root), 'app.asar'));
  assert.equal(await realpath(capture.appAsar), capture.appAsar);
  assert.ok((await lstat(capture.appAsar)).isFile() && hash(capture.appAsarSha256));
  assert.equal(await candidateDigest(capture.appAsar), capture.appAsarSha256);
  return { capture: { ...capture }, manifest, node, entry, hostPackage, bun, engine, processCustody };
}

/** The builder copies Windows directory links as absolute junctions. Restore
 * only the already attested relative Host links before signing or relocation. */
export async function preservePackagedOpenCodeV2DependencyLinks(
  resourcesRoot: string, expected: { manifestSha256: string; sourceHead: string }
): Promise<void> {
  const appAsar = join(dirname(resourcesRoot), 'app.asar');
  const capture = { resourcesRoot, manifestSha256: expected.manifestSha256,
    appAsar, appAsarSha256: await candidateDigest(appAsar) };
  const before = await readPackagedOpenCodeV2(capture);
  assert.equal(before.manifest.sourceHead, expected.sourceHead);
  for (const pkg of before.manifest.packages) {
    for (const [name, key] of Object.entries(pkg.dependencies)) {
      const link = join(resourcesRoot, 'host', pkg.path, 'node_modules', name);
      const target = join(resourcesRoot, 'host/packages', key);
      assert.equal(await realpath(dirname(link)), dirname(link));
      assert.equal(await realpath(target), target);
      assert.ok((await lstat(link)).isSymbolicLink());
      assert.equal(await realpath(link), target, 'only its original in-bundle dependency may be rewritten');
      if (isAbsolute(await readlink(link))) {
        // Build-owned candidate only; a failed replacement leaves packaging
        // incomplete. Do not convert foreign targets or repair missing inputs.
        assert.equal(await realpath(link), target);
        await unlink(link);
        await symlink(relative(dirname(link), target), link, 'dir');
      }
      assert.equal(isAbsolute(await readlink(link)), false);
      assert.equal(await realpath(link), target);
    }
  }
  const after = await readPackagedOpenCodeV2(capture);
  assert.deepEqual(after.manifest, before.manifest);
}

/** The pinned Windows x64 graph retains ffi-rs's unused ia32 optional payload.
 * Preserve its manifest bytes; only the original x64 loader branch can execute. */
export async function readPackagedOpenCodeV2UnusedWindowsFfi(
  resourcesRoot: string, expected: { manifestSha256: string; sourceHead: string }
): Promise<string> {
  assert.equal(process.platform, 'win32'); assert.equal(process.arch, 'x64');
  const appAsar = join(dirname(resourcesRoot), 'app.asar');
  const selected = await readPackagedOpenCodeV2({ resourcesRoot,
    manifestSha256: expected.manifestSha256, appAsar, appAsarSha256: await candidateDigest(appAsar) });
  assert.equal(selected.manifest.sourceHead, expected.sourceHead);
  const modules = join(selected.engine, 'local-cli/node_modules');
  const ffi = JSON.parse(await readFile(join(modules, 'ffi-rs/package.json'), 'utf8'));
  assert.equal(ffi.name, 'ffi-rs'); assert.equal(ffi.version, '1.3.7');
  for (const arch of ['ia32', 'x64']) {
    const name = `@yuuang/ffi-rs-win32-${arch}-msvc`;
    assert.equal(ffi.optionalDependencies?.[name], '1.3.7');
    const pkg = JSON.parse(await readFile(join(modules, name, 'package.json'), 'utf8'));
    assert.equal(pkg.name, name); assert.equal(pkg.version, '1.3.7');
    assert.equal(pkg.main, `ffi-rs.win32-${arch}-msvc.node`);
    assert.deepEqual(pkg.os, ['win32']);
    assert.deepEqual(pkg.cpu, arch === 'ia32' ? ['x64', 'ia32'] : ['x64']);
  }
  return join(modules, '@yuuang/ffi-rs-win32-x64-msvc/ffi-rs.win32-x64-msvc.node');
}

/** Only the actual relocated application and its bundled Node can run this scenario. */
export async function packagedOpenCodeV2Scenario(
  capture: PackagedOpenCodeV2Capture, sourceRoot: string, harnessPath: string
): Promise<PackagedNativeHostInputs> {
  const captured = await readPackagedOpenCodeV2(capture);
  const verify = async () => {
    const current = await readPackagedOpenCodeV2(capture);
    assert.deepEqual(current.manifest, captured.manifest);
    assert.ok(isAbsolute(sourceRoot) && isAbsolute(harnessPath));
    await assert.rejects(lstat(sourceRoot), { code: 'ENOENT' });
    await assert.rejects(lstat(join(dirname(capture.resourcesRoot), 'runtime')), { code: 'ENOENT' });
    assert.equal(await realpath(process.execPath), current.node, 'system Node cannot qualify the candidate');
    assert.equal(process.version, 'v24.21.0');
    assert.equal(await candidateDigest(harnessPath), current.manifest.harnessSha256);
  };
  await verify();
  return {
    sourceHead: captured.manifest.sourceHead,
    node: captured.node, entry: captured.entry, hostPackage: captured.hostPackage,
    bun: captured.bun, engine: captured.engine,
    manifestSha256: captured.manifest.engine.manifestSha256,
    hostSourceDigest: captured.manifest.hostSourceDigest,
    providerDigest: captured.manifest.artifacts.find(row => row.name === '@agent-teams/provider-implementations')!.sha256,
    ...(captured.processCustody ? { processCustody: captured.processCustody } : {}),
    evidence: { executionOrigin: 'packaged-extraResources',
      appAsarSha256: capture.appAsarSha256, candidateManifestSha256: capture.manifestSha256,
      harnessSha256: captured.manifest.harnessSha256,
      sourceCheckoutUnavailable: true, legacyRuntimeUnavailable: true,
      hostEntrySha256: captured.manifest.hostEntrySha256,
      nodeArchiveSha256: captured.manifest.node.archiveSha256,
      providerArtifacts: captured.manifest.artifacts,
      packages: captured.manifest.packages.length,
      files: captured.manifest.packages.reduce((sum, row) => sum + row.files.length, 0) },
    verify,
  };
}
