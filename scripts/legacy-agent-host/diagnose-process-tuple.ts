import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const file = (path: string) => {
  const stat = lstatSync(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && realpathSync(path) === path);
  return { path, sha256: hash(path), bytes: stat.size };
};
const run = (path: string, args: string[]) => execFileSync(path, args, {
  encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024,
}).trim();
const errorFact = (error: unknown) => {
  const value = error instanceof Error ? error : new Error(String(error));
  const extra = value as Error & { code?: unknown; status?: unknown; stderr?: unknown };
  return { name: value.name, message: value.message.slice(0, 4096), code: extra.code,
    status: extra.status, stderr: String(extra.stderr ?? '').slice(0, 8192) };
};

/** Unqualified TEST diagnostic only. Never imports production admission or emits its manifest. */
export async function diagnoseProcessTuple(outputParent: string, headersRoot: string, headersArchive: string) {
  assert.equal(process.env.LEGACY_PROCESS_TUPLE_DIAGNOSTIC_GO, '1');
  assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64');
  assert.equal(process.versions.node, '24.21.0');
  assert.equal(outputParent, '/private/tmp'); assert.equal(realpathSync(outputParent), outputParent);
  assert.match(headersRoot, /^\/private\/tmp\/TEST-[^/]+\//);
  assert.equal(realpathSync(headersRoot), headersRoot);
  assert.equal(basename(headersArchive), 'node-v24.21.0-headers.tar.gz');
  const directory = mkdtempSync(join(outputParent, 'TEST-process-tuple-'));
  const workspace = join(directory, 'workspace'); mkdirSync(workspace, { mode: 0o700 });
  const evidence: Record<string, unknown> = { schemaVersion: 1, qualification: false, signals: 0,
    scope: 'Unqualified current-tuple diagnostic on one newly owned finite Node child; no SDK, Host, production admission or signal API',
    directory, stage: 'input-census', status: 'INCOMPLETE' };
  const evidencePath = join(directory, 'diagnostic.json');
  let success = false;
  try {
    const lockPath = join(repository, 'legacy-host.lock.json');
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    assert.equal(lock.nodeVersion, '24.21.0');
    const nodeDirectory = join(repository, 'resources/legacy-agent-host/node/v24.21.0/darwin-arm64');
    const nodePath = join(nodeDirectory, 'node'), manifestPath = join(nodeDirectory, 'manifest.json');
    assert.equal(realpathSync(process.execPath), nodePath, 'only the existing staged Node artifact');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.equal(manifest.platform, 'darwin-arm64'); assert.equal(manifest.version, lock.nodeVersion);
    assert.equal(manifest.archiveSha256, lock.platforms['darwin-arm64'].sha256);
    assert.equal(manifest.executable, 'node'); assert.equal(hash(nodePath), manifest.binarySha256);
    const osBuild = run('/usr/sbin/sysctl', ['-n', 'kern.osversion']);
    const census: Record<string, unknown> = { status: 'observed-unqualified',
      os: { swVers: run('/usr/bin/sw_vers', []), architecture: process.arch, osBuild }, nodeManifest: manifest };
    evidence.inputs = census;
    const compiler = realpathSync(run('/usr/bin/xcrun', ['--find', 'clang']));
    const sdkRoot = realpathSync(run('/usr/bin/xcrun', ['--show-sdk-path']));
    const source = join(repository, 'packages/legacy-agent-host/native/registered-process-darwin.c');
    const headerNames = ['node_api.h', 'node_api_types.h', 'js_native_api.h', 'js_native_api_types.h', 'node_version.h'];
    const versionHeader = readFileSync(join(headersRoot, 'node_version.h'), 'utf8');
    for (const [name, value] of [['MAJOR', '24'], ['MINOR', '21'], ['PATCH', '0']])
      assert.match(versionHeader, new RegExp(`^#define NODE_${name}_VERSION\\s+${value}\\s*$`, 'm'));
    const inputs = [fileURLToPath(import.meta.url), lockPath, manifestPath, nodePath, compiler, join(sdkRoot, 'SDKSettings.json'), source,
      join(repository, 'packages/legacy-agent-host/scripts/buildProcessNativeArtifact.ts'),
      headersArchive, ...headerNames.map(name => join(headersRoot, name))].map(file);
    census.files = inputs;
    census.toolchain = { compiler, sdkRoot, version: run(compiler, ['--version']) };
    census.xcodeVersion = run('/usr/bin/xcodebuild', ['-version']);
    census.headersSource = 'https://nodejs.org/download/release/v24.21.0/node-v24.21.0-headers.tar.gz';
    const validateInputs = () => { for (const input of inputs) assert.deepEqual(file(input.path), input); };
    const library = join(directory, 'registered-process.node');
    // Exact compile flags from buildProcessNativeArtifact; no production manifest is generated.
    const flags = ['-bundle', '-undefined', 'dynamic_lookup', '-DNAPI_VERSION=8',
      '-DNODE_GYP_MODULE_NAME=registered_process', '-I', headersRoot, '-isysroot', sdkRoot,
      '-mmacosx-version-min=15.0', '-std=c11', '-Wall', '-Wextra', '-Werror', source, '-o', library];
    evidence.stage = 'compile'; evidence.compileFlags = flags;
    validateInputs(); run(compiler, flags); validateInputs();
    const output = file(library); evidence.output = output;
    evidence.stage = 'native-load';
    const native = createRequire(import.meta.url)(library) as {
      osBuild(): string;
      captureRoot(pid: number): { auditToken: number[]; sessionId: number; bootId: string; osBuild: string };
      observeOriginal(bootId: string, auditToken: number[], sessionId: number): unknown;
    };
    assert.deepEqual(file(library), output); assert.equal(native.osBuild(), osBuild);
    evidence.stage = 'owned-root-probe';
    const child = spawn(nodePath, ['-e', 'setTimeout(()=>process.exit(0),1500)'], {
      cwd: workspace, env: { HOME: workspace, TMPDIR: workspace, PATH: '/usr/bin:/bin' },
      detached: true, stdio: 'ignore',
    });
    let spawnError: unknown;
    const closed = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(resolve => {
      child.once('error', error => { spawnError = error; });
      child.once('close', (exitCode, signal) => resolve({ exitCode, signal }));
    });
    let captured: ReturnType<typeof native.captureRoot> | undefined;
    let live: unknown;
    try {
      // Original synchronous spawn admission, before the first yield; never adopt this PID later.
      assert.ok(child.pid && child.exitCode === null && child.signalCode === null);
      captured = native.captureRoot(child.pid);
      evidence.capture = captured;
      assert.ok(Array.isArray(captured.auditToken) && captured.auditToken.length === 8);
      assert.equal(captured.auditToken[5], child.pid); assert.equal(captured.sessionId, child.pid);
      assert.equal(captured.osBuild, osBuild); assert.match(captured.bootId, /^[a-f0-9-]{36}$/i);
      live = native.observeOriginal(captured.bootId, captured.auditToken, captured.sessionId);
      evidence.liveObservation = live; assert.equal(live, 'same-live');
    } catch (error) { evidence.captureFailure = errorFact(error); }
    finally {
      // Every capture failure still awaits this original finite child. No kill or cleanup fallback.
      evidence.originalHandleClosure = await closed;
      if (spawnError) evidence.spawnFailure = errorFact(spawnError);
    }
    assert.equal(child.exitCode, 0); assert.equal(child.signalCode, null);
    if (captured) evidence.afterNaturalExit = native.observeOriginal(captured.bootId, captured.auditToken, captured.sessionId);
    validateInputs(); assert.deepEqual(file(library), output);
    success = !evidence.captureFailure && live === 'same-live' && ['absent', 'stale'].includes(String(evidence.afterNaturalExit));
    evidence.status = success ? 'OBSERVED' : 'INCOMPLETE';
  } catch (error) { evidence.failure = errorFact(error); evidence.status = 'FAILED'; }
  finally { writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
  return { directory, evidencePath, qualification: false, signals: 0, success, status: evidence.status };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [parent, headers, archive, ...extra] = process.argv.slice(2);
  assert.ok(parent && headers && archive && !extra.length,
    'Usage: diagnose-process-tuple.ts /private/tmp HEADERS_ROOT HEADERS_ARCHIVE');
  const result = await diagnoseProcessTuple(parent, headers, archive);
  process.stdout.write(JSON.stringify(result) + '\n');
  if (!result.success) process.exitCode = 1;
}
