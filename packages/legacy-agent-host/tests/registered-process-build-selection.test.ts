import assert from 'node:assert/strict';
import childProcess, { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildProcessNativeArtifact } from '../scripts/buildProcessNativeArtifact.ts';
import { createQualifiedDarwinProcessApi } from '../dist/process/DarwinRegisteredProcess.js';
import { readPackagedProcessArtifact } from '../dist/process/readPackagedProcessArtifact.js';
import { validateProcessCapture } from '../dist/process/validateProcessRecords.js';
import type { TestContext } from 'node:test';
import type { QualifiedDarwinBuild } from '../dist/process/qualifiedDarwinBuild.js';

const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
function sandbox(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-process-build-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function darwin(t: TestContext) {
  for (const [key, value] of [['platform', 'darwin'], ['arch', 'arm64']] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(process, key)!;
    Object.defineProperty(process, key, { ...descriptor, value });
    t.after(() => Object.defineProperty(process, key, descriptor));
  }
}
function selected(t: TestContext, osBuild: string) {
  const directory = sandbox(t);
  const path = join(directory, 'registered-process.node');
  writeFileSync(path, 'TEST bytes; never a native addon');
  const manifestPath = join(directory, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify({ schemaVersion: 1, abi: 'napi-8',
    platform: 'darwin', architecture: 'arm64', osBuild, library: 'registered-process.node',
    binarySha256: hash(path) }));
  return { directory, manifestSha256: hash(manifestPath) };
}

// Synthetic ABI boundary only: the exact TEST addon load is mocked; no native bytes execute.
function bridge(t: TestContext, osBuild: QualifiedDarwinBuild = '24G624') {
  const artifact = readPackagedProcessArtifact(selected(t, osBuild));
  const state = { current: String(osBuild), root: String(osBuild), target: String(osBuild),
    observations: 0, signals: 0 };
  const identity = (pid: number, sessionId: number, build: string) => ({
    auditToken: [501, 501, 20, 501, 20, pid, 100, 2], sessionId,
    bootId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', osBuild: build,
  });
  const native = {
    osBuild: () => state.current,
    captureRoot: (pid: number) => identity(pid, pid, state.root),
    captureDescendant: (_boot: string, root: readonly number[], pid: number) =>
      identity(pid, root[5]!, state.target),
    observeOriginal: () => { state.observations++; return 'same-live'; },
    signalOriginal: () => { state.signals++; return 0; },
  };
  t.mock.method(process, 'dlopen', (module: object, path: string) => {
    assert.equal(path, artifact.path);
    Object.assign(module, { exports: native });
  });
  t.after(() => {
    delete createRequire(import.meta.url).cache[artifact.path];
  });
  return { artifact, state };
}

test('manifest selects one exact known build; unknown tuples and a mismatched loaded build fail closed', t => {
  darwin(t);
  for (const build of ['24G90', '24G624'])
    assert.equal(readPackagedProcessArtifact(selected(t, build)).osBuild, build);
  for (const build of ['24G999', '', '24G90\0'])
    assert.throws(() => readPackagedProcessArtifact(selected(t, build)), /unavailable/);
  const { artifact, state } = bridge(t, '24G90'); state.current = '24G624';
  assert.throws(() => createQualifiedDarwinProcessApi(artifact), /custody unavailable/);
  assert.equal(state.observations, 0); assert.equal(state.signals, 0);
});

test('saved historical records remain readable; control requires root, target, selected and actual builds to match', t => {
  darwin(t);
  const { artifact, state } = bridge(t);
  const api = createQualifiedDarwinProcessApi(artifact);
  const child = new ChildProcess(); Object.defineProperty(child, 'pid', { value: 1000 });
  const root = api.captureRoot(child, () => true);
  const registrar = { backendId: 'TEST-backend', teamId: 'TEST-team', runId: 'TEST-run',
    memberId: 'TEST-member', generation: '1' };
  const capture = root.capture(1001, registrar);
  validateProcessCapture(capture);
  assert.equal(api.observe(capture), 'same-live');
  const previous = structuredClone(capture);
  previous.root.osBuild = '24G90'; previous.target.osBuild = '24G90';
  const bytes = JSON.stringify(previous); validateProcessCapture(previous);
  assert.equal(JSON.stringify(previous), bytes, 'historical evidence is not rewritten');
  for (const original of [previous,
    { ...capture, root: { ...capture.root, osBuild: '24G90' } },
    { ...capture, target: { ...capture.target, osBuild: '24G90' } },
    { ...capture, target: { ...capture.target, osBuild: '24G999' } },
  ]) {
    const before = state.observations;
    assert.equal(api.observe(original), 'unknown');
    assert.throws(() => api.signal(original), /custody unavailable/);
    assert.equal(state.observations, before); assert.equal(state.signals, 0);
  }
  assert.throws(() => validateProcessCapture({ ...capture,
    target: { ...capture.target, osBuild: '24G90' } }), /hold/);
  assert.throws(() => validateProcessCapture({ ...capture,
    root: { ...capture.root, osBuild: '24G999' } }), /hold/);
  state.root = '24G90'; assert.throws(() => api.captureRoot(child, () => true));
  state.root = '24G624'; state.target = '24G90';
  assert.throws(() => root.capture(1001, registrar));
  state.target = '24G624'; state.current = '24G90';
  assert.equal(api.observe(capture), 'unknown'); assert.throws(() => api.signal(capture));
  assert.throws(() => root.capture(1001, registrar)); assert.equal(state.signals, 0);
});

test('builder emits its actual finite host tuple and never publishes a manifest for unknown or changed hosts', t => {
  darwin(t);
  const root = sandbox(t), headersRoot = join(root, 'headers'), sdkRoot = join(root, 'sdk');
  mkdirSync(headersRoot); mkdirSync(sdkRoot);
  const compiler = join(root, 'TEST-clang'), source = join(root, 'TEST-source.c');
  writeFileSync(compiler, 'TEST compiler input'); writeFileSync(source, 'TEST C input');
  writeFileSync(join(sdkRoot, 'SDKSettings.json'), '{}');
  const headers = ['node_api.h', 'node_api_types.h', 'js_native_api.h', 'js_native_api_types.h']
    .map(file => { const path = join(headersRoot, file); writeFileSync(path, `TEST ${file}`);
      return { file, sha256: hash(path) }; });
  let build = '24G624', compiled = 0, changeAfterCompile = false;
  t.mock.method(childProcess, 'execFileSync', ((path: string, args: string[]) => {
    if (path === '/usr/sbin/sysctl') return build;
    assert.equal(path, compiler); compiled++;
    writeFileSync(args[args.indexOf('-o') + 1]!, 'TEST output; never executable');
    if (changeAfterCompile) build = '24G90';
    return Buffer.alloc(0);
  }) as typeof childProcess.execFileSync);
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const input = { compiler, compilerSha256: hash(compiler), sdkRoot,
    sdkSettingsSha256: hash(join(sdkRoot, 'SDKSettings.json')), headersRoot, headers,
    source, sourceSha256: hash(source), outputDirectory: join(root, 'output-624') };
  const result = buildProcessNativeArtifact(input);
  assert.equal(result.manifest.osBuild, '24G624');
  assert.equal(result.manifestSha256, hash(join(input.outputDirectory, 'manifest.json')));
  build = '24G90';
  assert.equal(buildProcessNativeArtifact({ ...input, outputDirectory: join(root, 'output-90') })
    .manifest.osBuild, '24G90');
  build = '24G999'; const before = compiled;
  assert.throws(() => buildProcessNativeArtifact({ ...input, outputDirectory: join(root, 'unknown') }), /Unsupported build tuple/);
  assert.equal(compiled, before); assert.equal(existsSync(join(root, 'unknown')), false);
  build = '24G624'; changeAfterCompile = true;
  assert.throws(() => buildProcessNativeArtifact({ ...input, outputDirectory: join(root, 'changed') }), /build tuple changed/);
  assert.equal(existsSync(join(root, 'changed', 'manifest.json')), false);
});
