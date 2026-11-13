import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { test, type TestContext } from 'node:test';

import { captureWindowsLauncher, capturedWindowsCommandLine, matchesCapturedWindowsLauncher,
  verifyCapturedWindowsLauncher } from '../dist/owned-process/capturedWindowsLauncher.js';

import type { NativeProcessProfile } from '../dist/composition/nativeProcessProfile.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const wrapper = 'C:\\TEST\\provider.cmd';
const script = 'C:\\TEST\\cli.cjs';
const interpreter = 'C:\\Captured\\node.exe';

function fixture(t: TestContext, content: string) {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const original = { lstatSync: fs.lstatSync, realpathSync: fs.realpathSync,
    readFileSync: fs.readFileSync, existsSync: fs.existsSync };
  const files = new Map([[wrapper, content], [script, 'TEST script'],
    [interpreter, 'TEST native Node'], ['C:\\Windows\\System32\\cmd.exe', 'TEST cmd image']]);
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
    return { dev: 1n, ino: 2n, size: BigInt(Buffer.byteLength(bytes)), mtimeNs: 3n, ctimeNs: 4n,
      isFile: () => true, isSymbolicLink: () => false } as fs.BigIntStats;
  }) as typeof fs.lstatSync);
  t.mock.method(fs, 'readFileSync', ((path, options) => {
    if (!selected(path)) return original.readFileSync(path, options);
    const value = read(String(path));
    return options === 'utf8' ? value : Buffer.from(value);
  }) as typeof fs.readFileSync);
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports();
    Object.defineProperty(process, 'platform', platform); });
  const profile: NativeProcessProfile = { cwd: 'C:\\TEST', environment: { PATH: 'C:\\Captured' },
    executable: { path: wrapper, sha256: hash(content) } };
  return { files, profile };
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
