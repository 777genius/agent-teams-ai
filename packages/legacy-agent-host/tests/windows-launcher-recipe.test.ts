import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { test, type TestContext } from 'node:test';

import { captureWindowsLauncher, capturedWindowsCommandLine, matchesCapturedWindowsLauncher,
  quoteWindowsArg, verifyCapturedWindowsLauncher } from '../dist/owned-process/capturedWindowsLauncher.js';
import { buildWindowsShellFallbackCommand, quoteWindowsCmdArg } from '../dist/owned-process/windowsCliLauncher.js';
import { HostWindowsLaunch } from '../dist/owned-process/HostWindowsLaunch.js';
import { WindowsCapturedProcess } from '../dist/adapters/providers/WindowsCapturedProcess.js';

import type { NativeProcessProfile } from '../dist/composition/nativeProcessProfile.js';
import type { OwnedLaunchPort, PreparedOwnedProcess, TreeReceipt } from '../dist/owned-process/contract.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const wrapper = 'C:\\TEST\\provider.cmd';
const script = 'C:\\TEST\\cli.cjs';
const interpreter = 'C:\\Captured\\node.exe';

test('long Windows argument runs retain literal backslashes, quotes and the original time bound',
  { timeout: 2_000 }, () => {
    const slashes = '\\'.repeat(50_000), doubled = slashes + slashes;
    const started = performance.now();
    assert.equal(quoteWindowsArg(slashes), '"' + doubled + '"');
    assert.equal(quoteWindowsArg(slashes + 'x'), '"' + slashes + 'x"');
    assert.equal(quoteWindowsArg(slashes + '"'), '"' + doubled + '\\""');
    const native = captureWindowsLauncher({ cwd: 'C:\\TEST', environment: {},
      executable: { path: interpreter, sha256: hash('TEST native Node') } });
    assert.equal(capturedWindowsCommandLine(native, [slashes]), '"' + interpreter + '" "' + doubled + '"');
    assert.equal(quoteWindowsCmdArg(slashes), '"' + doubled + '"');
    assert.equal(quoteWindowsCmdArg(slashes + 'x'), '"' + slashes + 'x"');
    assert.equal(quoteWindowsCmdArg(slashes + '"'), '"' + doubled + '\\""');
    assert.equal(buildWindowsShellFallbackCommand(['TEST.exe', slashes]), 'TEST.exe ^"' + doubled + '^"');
    assert.equal(buildWindowsShellFallbackCommand(['TEST.exe', slashes + 'x']), 'TEST.exe ^"' + slashes + 'x^"');
    assert.equal(buildWindowsShellFallbackCommand(['TEST.exe', slashes + '"']), 'TEST.exe ^"' + doubled + '\\^"^"');
    assert.equal(buildWindowsShellFallbackCommand(['TEST.cmd', slashes], {
      reparsesArgs: true, usesPositionalArgs: false,
    }), 'TEST.cmd ^^^"' + doubled + '^^^"');
    assert.ok(performance.now() - started < 2_000, 'synchronous escaping cannot evade the original deadline');
  });

function fixture(t: TestContext, content: string) {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const original = { lstatSync: fs.lstatSync, realpathSync: fs.realpathSync,
    readFileSync: fs.readFileSync, existsSync: fs.existsSync };
  const files = new Map<string, string | Buffer>([[wrapper, content], [script, 'TEST script'],
    [interpreter, 'TEST native Node'], ['C:\\Windows\\System32\\cmd.exe', 'TEST cmd image']]);
  const reads = new Map<string, number>();
  const selected = (path: unknown) => typeof path === 'string' && /^[A-Z]:\\/.test(path);
  const read = (path: string) => {
    const value = files.get(path);
    if (value === undefined) throw Object.assign(new Error('TEST missing file'), { code: 'ENOENT' });
    return value;
  };
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  t.mock.method(fs, 'existsSync', (path: fs.PathLike) => selected(path)
    ? files.has(String(path)) : original.existsSync(path));
  t.mock.method(fs, 'realpathSync', ((path, options) => {
    if (!selected(path)) return Reflect.apply(original.realpathSync, fs, [path, options]);
    read(String(path)); return String(path);
  }) as typeof fs.realpathSync);
  t.mock.method(fs, 'lstatSync', ((path, options) => {
    if (!selected(path)) return original.lstatSync(path, options);
    const bytes = read(String(path));
    assert.equal(options?.bigint, true);
    return { dev: 1n, ino: 2n, nlink: 1n, size: BigInt(Buffer.byteLength(bytes)), mtimeNs: 3n, ctimeNs: 4n,
      isFile: () => true, isSymbolicLink: () => false } as fs.BigIntStats;
  }) as typeof fs.lstatSync);
  t.mock.method(fs, 'readFileSync', ((path, options) => {
    if (!selected(path)) return original.readFileSync(path, options);
    const value = read(String(path));
    reads.set(String(path), (reads.get(String(path)) ?? 0) + 1);
    const bytes = typeof value === 'string' ? Buffer.from(value) : value;
    return options === 'utf8' ? bytes.toString('utf8') : Buffer.from(bytes);
  }) as typeof fs.readFileSync);
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports();
    Object.defineProperty(process, 'platform', platform); });
  const profile: NativeProcessProfile = { cwd: 'C:\\TEST', environment: { PATH: 'C:\\Captured' },
    executable: { path: wrapper, sha256: hash(content) } };
  return { files, profile, reads };
}

test('known wrapper pins original, selected interpreter and script; later PATH never changes its argv', t => {
  const { files, profile } = fixture(t, '@echo off\r\n"%_prog%" "%~dp0cli.cjs" %*\r\n');
  const captured = captureWindowsLauncher(profile);
  assert.equal(captured.executable.path, interpreter);
  assert.deepEqual(captured.argsPrefix, [script]);
  assert.deepEqual(captured.files.map(file => file.path), [wrapper, interpreter, script]);
  profile.environment.PATH = 'C:\\Unselected';
  const commandLine = capturedWindowsCommandLine(captured, ['%PATH%', '!PATH!', 'x&echo TEST', '']);
  assert.equal(commandLine, '"C:\\Captured\\node.exe" "C:\\TEST\\cli.cjs" "%PATH%" "!PATH!" "x&echo TEST" ""');
  const spec = { executable: interpreter, commandLine, cwd: profile.cwd, environment: [] };
  assert.equal(matchesCapturedWindowsLauncher(captured, spec), true);
  assert.equal(matchesCapturedWindowsLauncher(captured, { ...spec,
    commandLine: '"C:\\Captured\\node.exe" "C:\\TEST\\different.cjs"' }), false);
  verifyCapturedWindowsLauncher(captured);
  for (const path of [wrapper, interpreter, script]) {
    const saved = files.get(path)!;
    files.set(path, saved + ' TEST replacement');
    assert.throws(() => verifyCapturedWindowsLauncher(captured), /launcher unavailable/);
    files.set(path, saved);
  }
});

test('captured fallback preserves the shared shell policy and pins its actual cmd image', t => {
  const { files, profile } = fixture(t, '@echo off\r\necho "%~1"\r\n');
  const captured = captureWindowsLauncher(profile);
  assert.equal(captured.executable.path, 'C:\\Windows\\System32\\cmd.exe');
  assert.deepEqual(captured.batch, { reparsesArgs: false, usesPositionalArgs: true });
  const spec = { executable: captured.executable.path,
    commandLine: capturedWindowsCommandLine(captured, ['TEST safe argument']),
    cwd: profile.cwd, environment: [] };
  assert.equal(matchesCapturedWindowsLauncher(captured, spec), true);
  assert.match(spec.commandLine, /^"C:\\Windows\\System32\\cmd\.exe" \/d \/s \/v:off \/c "/);
  files.set(wrapper, 'TEST later content with no positional substitution');
  assert.throws(() => capturedWindowsCommandLine(captured, ['& echo TEST']), /Unsafe Windows batch positional argument/);
  assert.throws(() => capturedWindowsCommandLine(captured, ['TEST\nline']), /control characters/);
  assert.throws(() => verifyCapturedWindowsLauncher(captured), /launcher unavailable/);
});

test('captured batch recipe rejects shell suffixes outside its encoded arguments', t => {
  const { profile } = fixture(t, '@echo off\r\necho TEST %*\r\n');
  const captured = captureWindowsLauncher(profile);
  const commandLine = capturedWindowsCommandLine(captured, ['TEST argument']);
  const spec = { executable: captured.executable.path, commandLine, cwd: profile.cwd, environment: [] };
  assert.equal(matchesCapturedWindowsLauncher(captured, spec), true);
  for (const suffix of [' & C:\\Foreign\\other.exe', ' | C:\\Foreign\\other.exe',
    ' > C:\\Foreign\\output.txt', '\nC:\\Foreign\\other.exe']) {
    assert.equal(matchesCapturedWindowsLauncher(captured, { ...spec,
      commandLine: commandLine.slice(0, -1) + suffix + '"' }), false, suffix);
  }
  assert.equal(matchesCapturedWindowsLauncher(captured, { ...spec,
    commandLine: capturedWindowsCommandLine(captured, []).slice(0, -1) + ' & C:\\Foreign\\other.exe"' }), false);
});

for (const mode of ['shell', 'passthrough', 'direct-wrapper'] as const) {
test(`captured ${mode} recipe preserves quoted arguments and rejects malformed suffixes`, t => {
  const content = mode === 'direct-wrapper' ? '@echo off\r\n"%_prog%" "%~dp0cli.cjs" %*\r\n'
    : `@echo off\r\necho TEST ${mode === 'passthrough' ? '%*' : ''}\r\n`;
  const { profile } = fixture(t, content);
  const captured = captureWindowsLauncher(profile);
  const argumentsToPreserve = ['', 'TEST plain text', 'C:\\TEST trailing\\', 'C:\\TEST\\', 'C:\\TEST\\\\',
    'TEST "quoted"', '\\"', '\\\\"', '%PATH%', '!PATH!', 'TEST ^ & | > < ( ) [ ] ; , * ? `', 'TEST Я'];
  for (const args of [[], ...argumentsToPreserve.map(arg => [arg]), argumentsToPreserve]) {
    const commandLine = capturedWindowsCommandLine(captured, args);
    const spec = { executable: captured.executable.path, commandLine, cwd: profile.cwd, environment: [] };
    assert.equal(matchesCapturedWindowsLauncher(captured, spec), true, JSON.stringify(args));
    if (args.length) {
      assert.equal(matchesCapturedWindowsLauncher(captured, { ...spec, commandLine: commandLine + ' ' }), false);
      assert.equal(matchesCapturedWindowsLauncher(captured, { ...spec, commandLine: commandLine.slice(0, -1) }), false);
    }
  }
});
}

test('known wrapper rejects ambiguous captured PATH and a changed original before selection', t => {
  const { files, profile } = fixture(t, '@echo off\r\n"%_prog%" "%~dp0cli.cjs" %*\r\n');
  profile.environment.Path = profile.environment.PATH!;
  assert.throws(() => captureWindowsLauncher(profile), /launcher unavailable/);
  delete profile.environment.Path;
  files.set(wrapper, files.get(wrapper)! + 'TEST changed');
  assert.throws(() => captureWindowsLauncher(profile), /launcher unavailable/);
});

test('direct native image selection preserves its independent command-line contract', () => {
  const profile: NativeProcessProfile = { cwd: 'C:\\TEST', environment: {},
    executable: { path: interpreter, sha256: hash('TEST native Node') } };
  const captured = captureWindowsLauncher(profile);
  assert.equal(matchesCapturedWindowsLauncher(captured, { executable: interpreter,
    commandLine: 'TEST-captured-argv0 --flag', cwd: profile.cwd, environment: [] }), true);
  assert.equal(matchesCapturedWindowsLauncher(captured, { executable: 'C:\\Foreign\\node.exe',
    commandLine: 'TEST-captured-argv0 --flag', cwd: profile.cwd, environment: [] }), false);
});

/** TEST files only. Original broker manifest/PE validation still runs; no native process is created. */
function stagedBroker(t: TestContext, nativeFiles: Map<string, string | Buffer>): NonNullable<NativeProcessProfile['windowsBroker']> {
  assert.ok(process.arch === 'x64' || process.arch === 'arm64');
  const broker = 'C:\\TEST\\owned-process-broker.exe', manifestPath = 'C:\\TEST\\manifest.json';
  const bytes = Buffer.alloc(128);
  bytes.write('MZ'); bytes.writeUInt32LE(64, 60); bytes.write('PE\0\0', 64);
  bytes.writeUInt16LE(process.arch === 'x64' ? 0x8664 : 0xaa64, 68);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const files = new Map([[broker, bytes], [manifestPath, Buffer.from(JSON.stringify({
    schema: 1, protocol: 1, platform: 'win32', arch: process.arch, file: 'owned-process-broker.exe', sha256,
  }))]]);
  for (const [file, value] of files) nativeFiles.set(file, value);
  const descriptors = new Map<number, Buffer>();
  let nextDescriptor = 71000;
  const original = { open: fs.openSync, close: fs.closeSync, fstat: fs.fstatSync, read: fs.readSync,
    basename: path.basename, dirname: path.dirname, join: path.join,
    windowsBasename: path.win32.basename, windowsDirname: path.win32.dirname, windowsJoin: path.win32.join };
  const selected = (value: unknown): value is string => typeof value === 'string' && /^[A-Z]:\\/.test(value);
  t.mock.method(path, 'basename', (value: string, suffix?: string) =>
    selected(value) ? original.windowsBasename(value, suffix) : original.basename(value, suffix));
  t.mock.method(path, 'dirname', (value: string) =>
    selected(value) ? original.windowsDirname(value) : original.dirname(value));
  t.mock.method(path, 'join', (...parts: string[]) =>
    selected(parts[0]) ? original.windowsJoin(...parts) : original.join(...parts));
  t.mock.method(fs, 'openSync', ((file, flags, mode) => {
    const value = files.get(String(file));
    if (!value) return original.open(file, flags, mode);
    assert.equal(flags, 'r');
    const fd = nextDescriptor++; descriptors.set(fd, value); return fd;
  }) as typeof fs.openSync);
  t.mock.method(fs, 'closeSync', (fd: number) => {
    if (!descriptors.delete(fd)) original.close(fd);
  });
  t.mock.method(fs, 'fstatSync', ((fd, options) => {
    const value = descriptors.get(fd);
    return value ? { isFile: () => true, size: value.length } : original.fstat(fd, options);
  }) as typeof fs.fstatSync);
  t.mock.method(fs, 'readSync', ((fd: number, buffer: Buffer, offset: number, length: number, position: number) => {
    const value = descriptors.get(fd);
    return value ? value.copy(buffer, offset, position, position + length)
      : Reflect.apply(original.read, fs, [fd, buffer, offset, length, position]);
  }) as typeof fs.readSync);
  syncBuiltinESMExports();
  t.after(() => assert.equal(descriptors.size, 0, 'Original staged broker readers close their handles'));
  return { path: broker, sha256, arch: process.arch, protocol: 1 };
}

function controlledPort(t: TestContext, beforePrepared: () => void = () => {}) {
  const counts = { allocated: 0, prepared: 0, resumed: 0, stopped: 0, released: 0 };
  const streams: PassThrough[] = [];
  let pending: PreparedOwnedProcess | undefined, receipt: TreeReceipt | undefined;
  const port: OwnedLaunchPort = {
    allocate(owner) {
      counts.allocated++;
      const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
      streams.push(stdin, stdout, stderr);
      pending = { owner, root: { pid: 421, birth: '0000000000001234' }, stdin, stdout, stderr,
        diagnostics: () => ({ writeCompleted: false }),
        observeRootExit: () => () => {}, observeTransportFailure: () => () => {},
        async resume(expectedOwner, installOwner) {
          assert.deepEqual(expectedOwner, owner); await installOwner(); counts.resumed++;
        },
        async stop(request) {
          assert.deepEqual(request.expectedOwner, owner); counts.stopped++;
          receipt = { owner, attemptId: request.attemptId, coverage: 'job-membership',
            rootExited: true, proofDigest: 'e'.repeat(64) };
          return { kind: 'confirmed', receipt };
        },
        async drain() { return { kind: 'complete' }; },
        async release(value, coverage) {
          assert.equal(value, receipt); assert.equal(coverage, 'job-membership'); counts.released++;
        },
        abandonControl() { assert.fail('The original controlled authority must remain retained'); },
      };
      return pending;
    },
    async prepare(value) {
      counts.prepared++; assert.equal(value, pending); beforePrepared();
      return { kind: 'prepared', process: pending! };
    },
  };
  t.after(() => { for (const stream of streams) stream.destroy(); });
  return { port, counts };
}

test('retained Windows port shares one immutable original selection only with its exact native profile', t => {
  const f = fixture(t, '@echo off\r\n"%_prog%" "%~dp0cli.cjs" %*\r\n');
  f.profile.windowsBroker = stagedBroker(t, f.files);
  const original = { ...f.profile, environment: { ...f.profile.environment, TEST_VALUE: 'original' },
    provider: 'codex' as const, nativeOptions: { sandbox: 'read-only' } };
  const candidate = structuredClone(original);
  let connections = 0;
  const port = new HostWindowsLaunch(() => { connections++; return undefined; }).port(original, () => true);
  const captured = port.originalLauncher(candidate);
  assert.deepEqual([wrapper, interpreter, script].map(file => f.reads.get(file)), [1, 1, 1]);
  assert.ok(Object.isFrozen(captured) && Object.isFrozen(captured.files) && Object.isFrozen(captured.argsPrefix));
  assert.ok(captured.files.every(file => Object.isFrozen(file)));
  assert.equal(Reflect.set(captured.executable, 'sha256', '0'.repeat(64)), false);
  original.environment.TEST_VALUE = 'changed after the port capture';
  const reordered = { cwd: candidate.cwd, environment: { TEST_VALUE: 'original', PATH: 'C:\\Captured' },
    executable: { ...candidate.executable }, windowsBroker: { ...candidate.windowsBroker! } };
  assert.equal(port.originalLauncher(reordered), captured);
  const retained = new WindowsCapturedProcess(reordered, () => true, () => {}, port);
  assert.equal(retained.isRunning(), false);
  assert.deepEqual([wrapper, interpreter, script].map(file => f.reads.get(file)), [1, 1, 1],
    'The original retained constructor does not repeat selection or native file reads');
  const foreign: NativeProcessProfile[] = [
    { ...reordered, cwd: 'C:\\Foreign' },
    { ...reordered, environment: { ...reordered.environment, PATH: 'C:\\Foreign' } },
    { ...reordered, environment: { ...reordered.environment, TEST_VALUE: 'foreign' } },
    { ...reordered, executable: { ...reordered.executable, path: 'C:\\Foreign\\provider.cmd' } },
    { ...reordered, executable: { ...reordered.executable, sha256: '0'.repeat(64) } },
    { ...reordered, windowsBroker: { ...reordered.windowsBroker, path: 'C:\\Foreign\\owned-process-broker.exe' } },
    { ...reordered, windowsBroker: { ...reordered.windowsBroker, sha256: '0'.repeat(64) } },
    { ...reordered, windowsBroker: { ...reordered.windowsBroker, arch: process.arch === 'x64' ? 'arm64' : 'x64' } },
    { ...reordered, windowsBroker: { ...reordered.windowsBroker, capability: 'service-scopes-v1' } },
  ];
  const missingBroker: NativeProcessProfile = { ...reordered }; delete missingBroker.windowsBroker;
  foreign.push(missingBroker);
  const wrongProtocol = structuredClone(reordered);
  Object.defineProperty(wrongProtocol.windowsBroker, 'protocol', { value: 2 });
  foreign.push(wrongProtocol);
  for (const profile of foreign)
    assert.throws(() => new WindowsCapturedProcess(profile, () => true, () => {}, port),
      /Original Main custody unavailable/);
  assert.deepEqual([wrapper, interpreter, script].map(file => f.reads.get(file)), [1, 1, 1]);
  assert.equal(port.originalLauncher(reordered), captured);
  assert.equal(connections, 0, 'Selection association never invokes the original Main transport');
});

for (const boundary of ['launch', 'prepare', 'install-owner'] as const) {
  for (const changed of [wrapper, interpreter, script]) {
    test('retained Windows ' + boundary + ' refuses changed original ' + changed, async t => {
      const f = fixture(t, '@echo off\r\n"%_prog%" "%~dp0cli.cjs" %*\r\n');
      f.profile.windowsBroker = stagedBroker(t, f.files);
      const original = new HostWindowsLaunch(() => assert.fail('No Main wire in the controlled fixture'))
        .port(f.profile, () => true);
      const mutate = () => f.files.set(changed, f.files.get(changed)! + ' TEST replacement');
      const native = controlledPort(t, boundary === 'install-owner' ? mutate : undefined);
      let targetChecks = 0;
      const process = new WindowsCapturedProcess(f.profile, () => true, () => { targetChecks++; },
        { ...original, ...native.port });
      assert.deepEqual([wrapper, interpreter, script].map(file => f.reads.get(file)), [1, 1, 1]);
      const request = { command: wrapper, args: ['TEST argument'], cwd: f.profile.cwd };
      if (boundary === 'launch') {
        mutate();
        assert.throws(() => process.launch(request), /Captured Windows launcher unavailable/);
        assert.equal(native.counts.allocated, 0);
      } else {
        const child = process.launch(request);
        if (boundary === 'prepare') mutate();
        await assert.rejects(child.ready, /Captured Windows launcher unavailable/);
        assert.equal(native.counts.allocated, 1);
        assert.equal(native.counts.prepared, boundary === 'prepare' ? 0 : 1);
      }
      assert.equal(native.counts.resumed, 0, 'No changed image crosses the original pre-resume gate');
      assert.equal(targetChecks, boundary === 'launch' ? 1 : boundary === 'prepare' ? 2 : 3);
      assert.equal(await process.confirmStopped(), true);
      assert.equal(native.counts.stopped, boundary === 'launch' ? 0 : 1);
      assert.equal(native.counts.released, native.counts.stopped);
    });
  }
}

test('ordinary Windows ports still capture their own original recipe without a retained facet', async t => {
  const f = fixture(t, '@echo off\r\n"%_prog%" "%~dp0cli.cjs" %*\r\n');
  f.profile.windowsBroker = stagedBroker(t, f.files);
  const native = controlledPort(t);
  const process = new WindowsCapturedProcess(f.profile, () => true, () => {}, native.port);
  assert.deepEqual([wrapper, interpreter, script].map(file => f.reads.get(file)), [1, 1, 1]);
  const child = process.launch({ command: wrapper, args: ['TEST argument'], cwd: f.profile.cwd });
  await child.ready;
  assert.equal(native.counts.allocated, 1); assert.equal(native.counts.prepared, 1);
  assert.equal(native.counts.resumed, 1);
  assert.deepEqual([wrapper, interpreter, script].map(file => f.reads.get(file)), [4, 4, 4],
    'Selection plus all three original fresh file checks remain active');
  assert.equal(await process.confirmStopped(), true);
  assert.equal(native.counts.stopped, 1); assert.equal(native.counts.released, 1);
});
