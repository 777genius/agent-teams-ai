import assert from 'node:assert/strict';
import childProcess, { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, sep, toNamespacedPath } from 'node:path';
import { test } from 'node:test';
import { buildProcessNativeArtifact } from '../scripts/buildProcessNativeArtifact.ts';
import { buildLinuxProcessNativeArtifact } from '../scripts/buildLinuxProcessNativeArtifact.ts';
import { createQualifiedDarwinProcessApi } from '../dist/process/DarwinRegisteredProcess.js';
import { readPackagedProcessArtifact } from '../dist/process/readPackagedProcessArtifact.js';
import { validateProcessCapture } from '../dist/process/validateProcessRecords.js';
import { isQualifiedDarwinBuild } from '../dist/process/qualifiedDarwinBuild.js';
import type { TestContext } from 'node:test';
import type { QualifiedDarwinBuild } from '../dist/process/qualifiedDarwinBuild.js';

const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
function sandbox(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-process-build-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function darwin(t: TestContext, architecture = 'arm64') {
  for (const [key, value] of [['platform', 'darwin'], ['arch', architecture]] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(process, key)!;
    Object.defineProperty(process, key, { ...descriptor, value });
    t.after(() => Object.defineProperty(process, key, descriptor));
  }
}
function selected(t: TestContext, osBuild: string, architecture = process.arch) {
  const directory = sandbox(t);
  const path = join(directory, 'registered-process.node');
  writeFileSync(path, 'TEST bytes; never a native addon');
  const manifestPath = join(directory, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify({ schemaVersion: 1, abi: 'napi-8',
    platform: 'darwin', architecture, osBuild, library: 'registered-process.node',
    binarySha256: hash(path) }));
  return { directory, manifestSha256: hash(manifestPath) };
}

test('Linux builder refuses an existing or linked output leaf before any compiler dispatch',
  { skip: process.platform !== 'linux' || process.arch !== 'x64' }, t => {
    const root = sandbox(t), headersRoot = join(root, 'headers'); mkdirSync(headersRoot);
    const compiler = join(root, 'TEST-compiler'), inspector = join(root, 'TEST-inspector'), source = join(root, 'TEST-source.c');
    for (const path of [compiler, inspector, source]) writeFileSync(path, 'TEST pinned input; never execute');
    const headers = ['node_api.h', 'node_api_types.h', 'js_native_api.h', 'js_native_api_types.h'].map(file => {
      const path = join(headersRoot, file); writeFileSync(path, `TEST ${file}`); return { file, sha256: hash(path) };
    });
    const shared = join(root, 'shared'), existing = join(root, 'existing'), linked = join(root, 'linked');
    mkdirSync(shared); chmodSync(shared, 0o777); mkdirSync(existing, { mode: 0o700 }); symlinkSync(existing, linked);
    let compiled = 0;
    t.mock.method(childProcess, 'execFileSync', () => { compiled++; throw new Error('TEST compiler must not be reached'); });
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    const input = { compiler, compilerSha256: hash(compiler), inspector, inspectorSha256: hash(inspector),
      headersRoot, headers, source, sourceSha256: hash(source) };
    for (const outputDirectory of [shared, existing, linked])
      assert.throws(() => buildLinuxProcessNativeArtifact({ ...input, outputDirectory }), /new empty private artifact directory/u);
    assert.equal(compiled, 0);
  });

// Synthetic ABI boundary only: the exact TEST addon load is mocked; no native bytes execute.
function bridge(t: TestContext, osBuild: QualifiedDarwinBuild = '24G624') {
  const artifact = readPackagedProcessArtifact(selected(t, osBuild));
  const state = { current: String(osBuild), root: String(osBuild), target: String(osBuild),
    observations: 0, signals: 0, executablePath: '', executableBirth: '12345',
    executableReads: 0, executableVersion: 2, afterExecutableRead: () => {} };
  const identity = (pid: number, sessionId: number, build: string) => ({
    auditToken: [501, 501, 20, 501, 20, pid, 100, 2], sessionId,
    bootId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', osBuild: build,
  });
  const native = {
    osBuild: () => state.current,
    captureRoot: (pid: number) => identity(pid, pid, state.root),
    readRootExecutable: (_boot: string, token: readonly number[], sid: number) => {
      state.executableReads++;
      const value = { ...identity(token[5]!, sid, state.current),
        executablePath: state.executablePath, birth: state.executableBirth };
      value.auditToken[7] = state.executableVersion;
      state.afterExecutableRead();
      return value;
    },
    captureDescendant: (_boot: string, root: readonly number[], pid: number) =>
      identity(pid, root[5]!, state.target),
    observeOriginal: () => { state.observations++; return 'same-live'; },
    signalOriginal: () => { state.signals++; return 0; },
  };
  t.mock.method(process, 'dlopen', (module: object, path: string) => {
    // Windows dlopen uses the namespaced spelling of the same canonical TEST file.
    assert.equal(toNamespacedPath(realpathSync(path)), toNamespacedPath(artifact.path));
    Object.assign(module, { exports: native });
  });
  t.after(() => {
    delete createRequire(import.meta.url).cache[artifact.path];
  });
  return { artifact, state };
}

test('new native-qualified OS builds admit only the architecture with measured custody evidence', t => {
  assert.equal(isQualifiedDarwinBuild('24H232', 'arm64'), true);
  assert.equal(isQualifiedDarwinBuild('24G830', 'x64'), true);
  for (const [build, architecture] of [['24H232', 'x64'], ['24G830', 'arm64'],
    ['24H232', 'arm'], ['24G830', 'ia32'], ['24H233', 'arm64'], ['24G831', 'x64']])
    assert.equal(isQualifiedDarwinBuild(build, architecture), false);
  darwin(t, 'arm64');
  assert.equal(readPackagedProcessArtifact(selected(t, '24H232')).osBuild, '24H232');
  assert.throws(() => readPackagedProcessArtifact(selected(t, '24G830')), /unavailable/);
});

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

test('builder keeps unknown candidates out of product admission and refuses changed hosts', t => {
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
  assert.throws(() => buildProcessNativeArtifact({ ...input, outputDirectory: join(root, 'wrong-candidate') },
    { osBuild: '24G998', architecture: 'arm64' }), /Unsupported TEST candidate/);
  assert.throws(() => buildProcessNativeArtifact({ ...input, outputDirectory: join(root, 'wrong-arch') },
    { osBuild: build, architecture: 'x64' }), /Unsupported TEST candidate/);
  assert.equal(compiled, before);
  const candidateInput = { ...input, outputDirectory: join(root, 'candidate') };
  if (sep === '/') {
    const candidate = buildProcessNativeArtifact(candidateInput, { osBuild: build, architecture: 'arm64' });
    assert.equal(candidate.manifest.osBuild, build);
    assert.throws(() => readPackagedProcessArtifact(candidate), /unavailable/,
      'compilation alone never admits a prospective tuple to the product');
  } else {
    // Mocking the OS does not turn a real Windows filesystem path into a Darwin
    // TEST namespace. The candidate's POSIX-only path gate must still refuse it.
    assert.throws(() => buildProcessNativeArtifact(candidateInput, { osBuild: build, architecture: 'arm64' }),
      /Unsupported TEST candidate/);
    assert.equal(compiled, before);
  }
  build = '24G624'; changeAfterCompile = true;
  assert.throws(() => buildProcessNativeArtifact({ ...input, outputDirectory: join(root, 'changed') }), /build tuple changed/);
  assert.equal(existsSync(join(root, 'changed', 'manifest.json')), false);
});

test('native executable observations reuse the original captured child and reject changed bytes or birth', t => {
  darwin(t);
  const { artifact, state } = bridge(t);
  const binary = join(sandbox(t), 'TEST-bun');
  writeFileSync(binary, 'TEST selected executable bytes; never executed');
  const executable = { path: binary, sha256: hash(binary) };
  state.executablePath = binary;
  const api = createQualifiedDarwinProcessApi(artifact);
  const child = new ChildProcess(); Object.defineProperty(child, 'pid', { value: 1000 });
  assert.throws(() => api.readRootExecutable(child, executable), /unavailable/);
  assert.equal(state.executableReads, 0, 'a numeric PID does not grant executable observation');
  let current = true;
  api.captureRoot(child, () => current);
  const first = api.readRootExecutable(child, executable);
  assert.deepEqual(first, { executablePath: binary, executableSha256: executable.sha256,
    pid: 1000, startIdentity: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa:1000:2:12345' });
  assert.equal(state.executableReads, 2, 'kernel identity is rechecked after the file hash');
  assert.throws(() => api.captureRoot(child, () => true), /unavailable/, 'the same handle is never recaptured');
  const replacement = new ChildProcess(); Object.defineProperty(replacement, 'pid', { value: 1000 });
  assert.throws(() => api.readRootExecutable(replacement, executable), /unavailable/);
  state.executableVersion++;
  assert.throws(() => api.readRootExecutable(child, executable), /unavailable/);
  state.executableVersion--;
  state.afterExecutableRead = () => { state.executableBirth = '12346'; };
  assert.throws(() => api.readRootExecutable(child, executable), /unavailable/);
  state.afterExecutableRead = () => {};
  state.executableBirth = '12345';
  writeFileSync(binary, 'TEST changed executable bytes');
  assert.throws(() => api.readRootExecutable(child, executable), /unavailable/);
  current = false;
  const reads = state.executableReads;
  assert.throws(() => api.readRootExecutable(child, executable), /unavailable/);
  assert.equal(state.executableReads, reads);
  current = true; child.emit('exit', 0, null);
  assert.throws(() => api.readRootExecutable(child, executable), /unavailable/);
});

test('x64 selects only its own finite OS artifact; this synthetic boundary is not a native qualification', t => {
  darwin(t, 'x64');
  assert.equal(readPackagedProcessArtifact(selected(t, '24G624')).osBuild, '24G624');
  assert.throws(() => readPackagedProcessArtifact(selected(t, '24G624', 'arm64')), /unavailable/);
  assert.throws(() => readPackagedProcessArtifact(selected(t, '24G999')), /unavailable/);
  const { artifact } = bridge(t);
  assert.equal(typeof createQualifiedDarwinProcessApi(artifact).readRootExecutable, 'function');
});
