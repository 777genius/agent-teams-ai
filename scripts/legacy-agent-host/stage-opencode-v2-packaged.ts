/** Stage one unsigned TEST candidate through the existing legacy-agent-host extraResources entry. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, copyFile, cp, lstat, mkdir, readFile, realpath, rm, writeFile, appendFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stageNode } from './stage-node.ts';
import { candidateDigest, stageCandidateClosure } from './candidate-closure.ts';
import { assertNativeV1Source } from '../../packages/legacy-agent-host/tests/opencode-v1-version-source.ts';
import { treeHash } from '../../packages/legacy-agent-host/tests/fixtures/native-host.ts';
import { verifyOpenCodeV2EmbeddedGraph } from '../../packages/legacy-agent-host/dist/adapters/providers/OpenCodeV2EmbeddedGraph.js';
import { readPackagedProcessArtifact } from '../../packages/legacy-agent-host/dist/process/readPackagedProcessArtifact.js';
import type { PackagedOpenCodeV2Manifest } from './packaged-opencode-v2-inputs.ts';

const repo = resolve(import.meta.dirname, '../..');
assert.equal(process.version, 'v24.21.0');
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'candidate staging is confined to the disposable CI checkout');
assert.equal(await realpath(process.env.GITHUB_WORKSPACE!), repo);
const sourceHead = process.env.OPENCODE_V2_TEST_SOURCE_HEAD!;
assertNativeV1Source(repo, sourceHead);
const platform = `${process.platform}-${process.arch}`;
assert.equal(platform, process.env.OPENCODE_V2_TEST_PLATFORM);
assert.ok(['linux-x64', 'darwin-arm64', 'darwin-x64', 'win32-x64', 'win32-arm64'].includes(platform));
assert.equal(process.env.OPENCODE_V2_EMBEDDED_PRODUCT_ADMITTED, '1', 'packaged proof uses admitted native custody without candidate overrides');
const resourceRoot = await realpath(join(repo, 'resources/legacy-agent-host'));
const hostRoot = join(resourceRoot, 'host');
await assert.rejects(lstat(hostRoot), { code: 'ENOENT' });
const packages = await stageCandidateClosure(repo, hostRoot);
const host = packages.find(row => row.name === '@agent-teams/legacy-agent-host');
assert.ok(host && host.files.some(file => file.path === 'dist/cli.js'));
const node = await stageNode(platform, resourceRoot, join(repo, '.legacy-host-download'));
const native = join(resourceRoot, 'native/opencode-v2');
await mkdir(native, { recursive: true });
const bunPath = await realpath(process.env.OPENCODE_V2_EMBEDDED_BUN!);
const bunSha256 = process.env.OPENCODE_V2_EMBEDDED_BUN_SHA256!;
assert.equal(await candidateDigest(bunPath), bunSha256);
const bunName = process.platform === 'win32' ? 'bun.exe' : 'bun';
await copyFile(bunPath, join(native, bunName));
await chmod(join(native, bunName), 0o755);
assert.equal(await candidateDigest(join(native, bunName)), bunSha256);
const graphPath = await realpath(process.env.OPENCODE_V2_EMBEDDED_GRAPH!);
const manifestSha256 = process.env.OPENCODE_V2_EMBEDDED_MANIFEST_SHA256!;
await cp(graphPath, join(native, 'engine'), { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
const graph = await verifyOpenCodeV2EmbeddedGraph({ directory: join(native, 'engine'), manifestSha256,
  version: '2.1.4', platform: process.platform, arch: process.arch });
let processCustody: PackagedOpenCodeV2Manifest['processCustody'];
if (process.platform === 'darwin') {
  const selected = { directory: await realpath(process.env.OPENCODE_V2_EMBEDDED_PROCESS_CUSTODY_DIRECTORY!),
    manifestSha256: process.env.OPENCODE_V2_EMBEDDED_PROCESS_CUSTODY_MANIFEST_SHA256! };
  const bridge = readPackagedProcessArtifact(selected);
  await mkdir(join(resourceRoot, 'process-custody'));
  for (const file of ['manifest.json', 'registered-process.node'])
    await copyFile(join(selected.directory, file), join(resourceRoot, 'process-custody', file));
  assert.equal(readPackagedProcessArtifact({ directory: join(resourceRoot, 'process-custody'),
    manifestSha256: selected.manifestSha256 }).sha256, bridge.sha256);
  processCustody = { directory: 'process-custody', manifestSha256: selected.manifestSha256, binarySha256: bridge.sha256 };
}
// Retain the existing candidate's exact installed-versus-selected-archive census.
const installed = JSON.parse(await readFile(join(repo, 'packages/legacy-agent-host/package.json'), 'utf8'));
const artifacts: PackagedOpenCodeV2Manifest['artifacts'] = [];
for (const name of ['@agent-teams/provider-implementations', '@agent-teams/provider-session-contracts']) {
  const reference: unknown = installed.dependencies[name];
  assert.ok(typeof reference === 'string' && reference.startsWith('file:') && reference.endsWith('.tgz'));
  const archive = await realpath(resolve(repo, 'packages/legacy-agent-host', reference.slice(5)));
  const selected = packages.find(row => row.name === name);
  assert.ok(selected);
  const members = execFileSync('tar', ['-tf', archive], { encoding: 'utf8', timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024 }).trim().split(/\r?\n/);
  assert.ok(members.every(member => member.startsWith('package/') && !member.split('/').includes('..')));
  const unpacked = join(await realpath(process.env.RUNNER_TEMP!), `TEST-provider-census-${randomUUID()}`);
  await mkdir(unpacked);
  try {
    execFileSync('tar', ['-xf', archive, '-C', unpacked], { timeout: 30_000, stdio: 'pipe' });
    const paths = members.filter(member => !member.endsWith('/')).map(member => member.slice(8)).sort();
    assert.deepEqual(paths, selected.files.map(file => file.path).sort());
    for (const file of selected.files)
      assert.equal(await candidateDigest(join(unpacked, 'package', file.path)), file.sha256);
    artifacts.push({ name, sha256: await candidateDigest(archive) });
  } finally { await rm(unpacked, { recursive: true, force: true }); }
}
// The TEST runner is outside the application; all product modules and native bytes
// selected by that runner remain in the builder's actual extraResources payload.
const harness = join(await realpath(process.env.RUNNER_TEMP!), `TEST-packaged-v2-host-${randomUUID()}.mjs`);
const require = createRequire(import.meta.url);
const tsxRequire = createRequire(require.resolve('tsx/package.json'));
const esbuild = await import(pathToFileURL(tsxRequire.resolve('esbuild')).href) as {
  build(options: Record<string, unknown>): Promise<unknown>;
};
await esbuild.build({ stdin: {
  contents: `import { runOpenCodeV2EmbeddedHostNative } from './packages/legacy-agent-host/tests/opencode-v2-embedded-host.native.ts';
import { packagedOpenCodeV2Scenario } from './scripts/legacy-agent-host/packaged-opencode-v2-inputs.ts';
const selected = JSON.parse(process.env.OPENCODE_V2_PACKAGED_CAPTURE);
const cancellation = new AbortController();
process.stdin.once('end', () => cancellation.abort(new Error('TEST packaged deadline')));
process.stdin.resume();
const scenario = await packagedOpenCodeV2Scenario(selected, process.env.OPENCODE_V2_PACKAGED_SOURCE_ROOT, import.meta.filename);
try { await runOpenCodeV2EmbeddedHostNative(scenario, cancellation.signal); }
finally { process.stdin.pause(); }`,
  resolveDir: repo, sourcefile: 'TEST-packaged-v2-host-entry.ts', loader: 'ts',
}, bundle: true, platform: 'node', format: 'esm', target: 'node24', outfile: harness,
  sourcemap: false, logLevel: 'warning' });
const manifest: PackagedOpenCodeV2Manifest = {
  schemaVersion: 1, kind: 'TEST_PACKAGED_OPENCODE_V2_INPUTS', sourceHead, platform,
  hostSourceDigest: await treeHash(join(repo, 'packages/legacy-agent-host/src'), '.ts'),
  harnessSha256: await candidateDigest(harness), node,
  nodeExecutable: `node/v${node.version}/${platform}/${node.executable}`,
  hostPackage: `host/${host.path}`, hostEntry: `host/${host.path}/dist/cli.js`,
  hostEntrySha256: host.files.find(file => file.path === 'dist/cli.js')!.sha256,
  packages, artifacts,
  bun: { path: `native/opencode-v2/${bunName}`, sha256: bunSha256, version: graph.requiredBunVersion },
  engine: { directory: 'native/opencode-v2/engine', manifestSha256, version: '2.1.4' },
  ...(processCustody ? { processCustody } : {}),
};
const capturePath = join(resourceRoot, 'opencode-v2-candidate.json');
await writeFile(capturePath, JSON.stringify(manifest) + '\n', { flag: 'wx', mode: 0o600 });
assertNativeV1Source(repo, sourceHead);
assert.ok(process.env.GITHUB_ENV && isAbsolute(process.env.GITHUB_ENV));
assert.ok(!/[\r\n\0]/.test(harness));
await appendFile(process.env.GITHUB_ENV,
  `OPENCODE_V2_PACKAGED_MANIFEST_SHA256=${await candidateDigest(capturePath)}\nOPENCODE_V2_PACKAGED_HARNESS=${harness}\n`);
process.stdout.write(JSON.stringify({ kind: manifest.kind, status: 'STAGED', sourceHead, platform,
  manifestSha256: await candidateDigest(capturePath), packages: packages.length,
  files: packages.reduce((sum, row) => sum + row.files.length, 0), artifacts }) + '\n');
