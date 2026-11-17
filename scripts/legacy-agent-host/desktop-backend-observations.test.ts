import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { TestContext } from 'node:test';
import { digest } from './desktop-backend-fixture.ts';
import { observeDesktopEmulatedRuntimeChildren } from './desktop-emulated-runtime-fixture.ts';
import { createDesktopProcessRootOracle } from './desktop-process-root-oracle.ts';
import {
  assertDesktopProofEnvironment,
  assertNoNativeHostChildren,
  assertOwnedCdpListener,
  groupMembers,
  isCapturedOriginalNodeZombie,
  processTable,
  safeGroupSnapshot,
  observeExitedAppGroup,
  observeOriginalAppReap,
  readRendererBackendConnections,
  readOwnedCdpListenerFailure,
  settledGroupMembers,
} from './desktop-backend-observations.ts';

test('offline Desktop admission refuses inherited native selections before preparing a fixture', (t) => {
  const original = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('LEGACY_DESKTOP_')));
  const controlledKeys = ['LEGACY_PROCESS_COLD_UI_GO', 'LEGACY_M19_PROVIDER_UI_GO', 'LEGACY_M19_ORIGINAL_HOST_CRASH_GO'];
  const controlledOriginal = Object.fromEntries(controlledKeys.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  for (const key of Object.keys(original)) delete process.env[key];
  for (const key of controlledKeys) delete process.env[key];
  t.after(() => {
    for (const key of Object.keys(process.env)) if (key.startsWith('LEGACY_DESKTOP_')) delete process.env[key];
    for (const key of controlledKeys) delete process.env[key];
    Object.assign(process.env, original);
    Object.assign(process.env, controlledOriginal);
  });
  Object.assign(process.env, { LEGACY_DESKTOP_BACKEND_GO: '1', LEGACY_DESKTOP_EMULATED_ONLY: '1',
    LEGACY_DESKTOP_TEST_DISPLAY: ':97', LEGACY_DESKTOP_TEST_XAUTHORITY: '/TEST/Xauthority' });
  for (const mode of ['team-ui', 'task-board-ui', 'task-board-cross-team-ui', 'skills-ui', 'emulated-management-ui', 'emulated-codex-login-ui', 'emulated-codex-runtime-ui', 'emulated-claude-runtime-ui', 'emulated-claude-lifecycle-ui', 'emulated-collaboration-ui', 'emulated-extensions-ui', 'emulated-import-ui', 'emulated-import-lifecycle-ui', 'emulated-retained-original-ui', 'emulated-opencode-runtime-ui', 'emulated-selection-ui', 'emulated-installer-ui', 'review-ui', 'review-readback-ui']) {
    process.env.LEGACY_DESKTOP_PROOF_MODE = mode;
    if (process.platform === 'darwin' || process.platform === 'linux' && process.arch === 'x64')
      assert.doesNotThrow(() => assertDesktopProofEnvironment(false));
    else assert.throws(() => assertDesktopProofEnvironment(false), /Linux Desktop portability/);
  }
  for (const mode of ['native-launch-ui', 'codex-login-ui', 'process-cold-ui', 'bridge-diagnostics', 'native-review-ui', 'native-review-readback-ui', 'native-readback-ui']) {
    process.env.LEGACY_DESKTOP_PROOF_MODE = mode;
    assert.throws(() => assertDesktopProofEnvironment(true), /only the original offline/);
  }
  process.env.LEGACY_DESKTOP_PROOF_MODE = 'team-ui';
  for (const key of ['LEGACY_DESKTOP_CLAUDE_PATH', 'LEGACY_DESKTOP_CODEX_PATH',
    'LEGACY_DESKTOP_OPENCODE_PATH', 'LEGACY_DESKTOP_OPENCODE_GENERATION',
    'LEGACY_DESKTOP_DIAGNOSTIC_HOST_ENTRY', 'LEGACY_DESKTOP_SCHEDULE_UI',
    'LEGACY_DESKTOP_READBACK_ROOT', 'LEGACY_DESKTOP_READBACK_RECEIPT_SHA256']) {
    process.env[key] = 'TEST-refused';
    assert.throws(() => assertDesktopProofEnvironment(true), new RegExp(`provider-emulation refuses ${key}`));
    delete process.env[key];
  }
  process.env.LEGACY_DESKTOP_PROOF_MODE = 'process-cold-ui';
  process.env.LEGACY_PROCESS_COLD_UI_GO = '1';
  process.env.LEGACY_DESKTOP_PROCESS_CAPTURE_PATH = '/TEST-process-inputs/capture.json';
  process.env.LEGACY_DESKTOP_PROCESS_CAPTURE_SHA256 = 'a'.repeat(64);
  if (process.platform === 'linux' && process.arch === 'x64') {
    assert.doesNotThrow(() => assertDesktopProofEnvironment(false));
    process.env.LEGACY_M19_PROVIDER_UI_GO = '1';
    assert.throws(() => assertDesktopProofEnvironment(false));
    delete process.env.LEGACY_M19_PROVIDER_UI_GO;
    process.env.LEGACY_DESKTOP_CLAUDE_PATH = '/TEST-no-vendor';
    assert.throws(() => assertDesktopProofEnvironment(false), /provider-emulation refuses LEGACY_DESKTOP_CLAUDE_PATH/);
    delete process.env.LEGACY_DESKTOP_CLAUDE_PATH;
  } else assert.throws(() => assertDesktopProofEnvironment(false));
  process.env.LEGACY_DESKTOP_PROCESS_CAPTURE_SHA256 = 'invalid';
  assert.throws(() => assertDesktopProofEnvironment(false), /only the original offline/);
  process.env.LEGACY_DESKTOP_PROCESS_CAPTURE_SHA256 = 'a'.repeat(64);
  process.env.LEGACY_DESKTOP_PROOF_MODE = 'team-ui';
  assert.throws(() => assertDesktopProofEnvironment(false), /provider-emulation refuses LEGACY_DESKTOP_PROCESS_CAPTURE_PATH/);
  delete process.env.LEGACY_DESKTOP_PROCESS_CAPTURE_PATH;
  delete process.env.LEGACY_DESKTOP_PROCESS_CAPTURE_SHA256;
  delete process.env.LEGACY_PROCESS_COLD_UI_GO;
  process.env.LEGACY_DESKTOP_PROOF_MODE = 'review-readback-ui';
  process.env.LEGACY_DESKTOP_READBACK_ROOT = '/TEST/TEST-desktop-backend-abc123';
  process.env.LEGACY_DESKTOP_READBACK_RECEIPT_SHA256 = 'a'.repeat(64);
  if (process.platform === 'darwin' || process.platform === 'linux' && process.arch === 'x64')
    assert.doesNotThrow(() => assertDesktopProofEnvironment(false));
  process.env.LEGACY_DESKTOP_READBACK_ATTEMPT_ID = 'abc123';
  assert.throws(() => assertDesktopProofEnvironment(true), /provider-emulation refuses LEGACY_DESKTOP_READBACK_ATTEMPT_ID/);
  delete process.env.LEGACY_DESKTOP_READBACK_ATTEMPT_ID;
  process.env.LEGACY_DESKTOP_PROOF_MODE = 'review-ui';
  assert.throws(() => assertDesktopProofEnvironment(true), /provider-emulation refuses LEGACY_DESKTOP_READBACK_ROOT/);
  process.env.LEGACY_DESKTOP_EMULATED_ONLY = 'false';
  assert.throws(() => assertDesktopProofEnvironment(true), /explicit provider-emulation admission/);
});

test('TEST management admission retains only the exact direct detached Host peer without signaling', (t) => {
  const fixture = { node: '/TEST/node', hostEntry: '/TEST/host.js' };
  const peer = { command: '/TEST/node /TEST/peer.ts serve --hostname 127.0.0.1 --port 12345', observedPeerPids: [] as number[] };
  let peerCommand = peer.command, peerGroup = 4200;
  let peerError: Error | undefined, loggerThrows = false;
  const calls: string[] = [], statements: string[] = [];
  t.mock.method(console, 'log', (value: unknown) => {
    if (loggerThrows) throw new Error('TEST diagnostic sink unavailable');
    assert.equal(typeof value, 'string'); statements.push(value as string);
  });
  t.mock.method(childProcess, 'execFileSync', (file: string, args: readonly string[]) => {
    calls.push(file === '/bin/ps' ? args[0] === '-ax' ? 'table' : 'argv:' + args[1] : 'listener');
    if (file === (process.platform === 'linux' ? '/usr/bin/lsof' : '/usr/sbin/lsof')) return process.platform === 'linux'
      ? 'p4100\nf61\ntIPv4\nD0xabcd\ni12345\nPTCP\nTST=LISTEN\nn127.0.0.1:9222\n' : '4100\n';
    assert.equal(file, '/bin/ps');
    if (args[0] === '-ax') return `4100 4000 4100\n4101 4100 4100\n4200 4101 ${peerGroup}\n`;
    assert.equal(args[0], '-p');
    if (args[1] === '4200' && peerError) throw peerError;
    return args[1] === '4101' ? `${fixture.node} ${fixture.hostEntry}` : args[1] === '4200' ? peerCommand : '/TEST/electron';
  });
  t.mock.method(process, 'kill', () => assert.fail('observation never signals or adopts a PID'));
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const readOrder = (childArgv: boolean) => assert.deepEqual(calls.splice(0),
    ['table', 'listener', 'table', 'table', 'argv:4100', 'argv:4101', ...(childArgv ? ['argv:4200'] : [])]);
  const facts = () => {
    assert.equal(statements.length, 1, 'only the original first refused child is recorded');
    const line = statements.shift()!, prefix = 'TEST_HOST_CHILD_ADMISSION_FAILURE ';
    assert.ok(line.startsWith(prefix)); assert.ok(Buffer.byteLength(line) <= 1024);
    assert.doesNotMatch(line, /\/TEST|--unselected|TEST-private/u);
    return JSON.parse(line.slice(prefix.length)) as Record<string, unknown>;
  };
  const census = { phase: 'after-team-read', atomic: false, pid: 4200, ppid: 4101 };
  assert.doesNotThrow(() => assertNoNativeHostChildren(4100, fixture, 'after-team-read', peer));
  readOrder(true); assert.deepEqual(statements, []);
  assert.deepEqual(peer.observedPeerPids, [4200]);
  assert.throws(() => assertNoNativeHostChildren(4100, fixture, 'after-team-read'), /never allocates/);
  readOrder(false); assert.deepEqual(statements, []);
  peerGroup = 4100;
  assert.throws(() => assertNoNativeHostChildren(4100, fixture, 'after-team-read', peer), /own POSIX process group/);
  // This child was already read by the Host-selection scan; admission must not read it again.
  readOrder(true);
  assert.deepEqual(facts(), { ...census, pgid: 4100, ownProcessGroup: false,
    argvRead: false, argvState: 'not-read', commandMatches: null });
  peerGroup = 4200; peerCommand += ' --unselected';
  assert.throws(() => assertNoNativeHostChildren(4100, fixture, 'after-team-read', peer), /pinned direct Node/);
  readOrder(true);
  assert.deepEqual(facts(), { ...census, pgid: 4200, ownProcessGroup: true,
    argvRead: true, argvState: 'nonempty', commandMatches: false });
  assert.deepEqual(peer.observedPeerPids, [4200]);
  peer.observedPeerPids.length = 0;
  peerGroup = 4300; peerCommand = peer.command;
  assert.throws(() => assertNoNativeHostChildren(4100, fixture, 'after-team-read', peer), /own POSIX process group/);
  readOrder(false);
  assert.deepEqual(facts(), { ...census, pgid: 4300, ownProcessGroup: false,
    argvRead: false, argvState: 'not-read', commandMatches: null });
  assert.deepEqual(peer.observedPeerPids, [], 'a refused child is never admitted');

  peerGroup = 4200;
  for (const absent of [false, true]) {
    peerCommand = '';
    peerError = absent ? Object.assign(new Error('TEST closed absent ps result'),
      { status: 1, stdout: '', stderr: '' }) : undefined;
    assert.throws(() => assertNoNativeHostChildren(4100, fixture, 'after-team-read', peer), /pinned direct Node/);
    readOrder(true);
    assert.deepEqual(facts(), { ...census, pgid: 4200, ownProcessGroup: true,
      argvRead: true, argvState: 'empty', commandMatches: false });
    assert.deepEqual(peer.observedPeerPids, []);
  }
  const originalFailure = new Error('TEST-private argv read failed');
  peerError = originalFailure;
  assert.throws(() => assertNoNativeHostChildren(4100, fixture, 'after-team-read', peer),
    error => error === originalFailure);
  readOrder(true); assert.deepEqual(statements, []); assert.deepEqual(peer.observedPeerPids, []);
  peerError = undefined; peerCommand = peer.command + ' --TEST-private';
  loggerThrows = true;
  assert.throws(() => assertNoNativeHostChildren(4100, fixture, 'after-team-read', peer), {
    code: 'ERR_ASSERTION',
    message: 'only the pinned direct Node management peer with its own POSIX process group may run under this Host',
  });
  readOrder(true); assert.deepEqual(statements, []); assert.deepEqual(peer.observedPeerPids, []);
  loggerThrows = false; peerCommand = peer.command;
  assert.doesNotThrow(() => assertNoNativeHostChildren(4100, fixture, 'after-team-read', peer));
  readOrder(true); assert.deepEqual(statements, []);
  assert.deepEqual(peer.observedPeerPids, [4200], 'only the original successful comparison admits the child');
});

test('Linux CDP diagnostics retain the original bounded descriptor read without accepting a second holder', { skip: process.platform !== 'linux' }, (t) => {
  const fields = (fd: number) => `f${fd}\ntIPv4\nD0xabcd\ni12345\nPTCP\nTST=LISTEN\nnPRIVATE_PATH_MUST_NOT_LEAK\n`;
  let output = 'p4100\n' + Array.from({ length: 17 }, (_, index) => fields(index + 1)).join('') + 'p4101\n' + fields(40);
  let reads = 0;
  let change: 'none' | 'replaced' | 'vanished' = 'none';
  const statReads = new Map<number, number>(), opened = new Map<number, string>();
  const procReads: string[] = [];
  let nextFd = 9000;
  let comparison: 'off' | 'exact' | 'other-argv' | 'builder' | 'other-builder' |
    'builder-duplicate-output' | 'builder-empty-output' | 'builder-no-expectation' |
    'missing-flags' | 'duplicate-flags' | 'reused-birth' | 'changed-socket' |
    'oversize-argv' | 'empty-argv' | 'incomplete-argv' | 'node-exec' | 'linux-child-exec' = 'off';
  let comparing = false;
  const links = new Map<number, number>();
  const fixture = { node: '/PRIVATE_FIXED/node', hostEntry: '/PRIVATE_FIXED/cli.js',
    mcpBuilderEntry: '/PRIVATE_FIXED/tsup-cli-default.js' };
  t.mock.method(fs, 'openSync', (path: string) => {
    assert.match(path, /^\/proc\/(4100|4101)\/(stat|cmdline|fdinfo\/61)$/u);
    const fd = nextFd++; opened.set(fd, path); return fd;
  });
  t.mock.method(fs, 'readSync', (fd: number, buffer: Buffer, offset: number, length: number, position: number) => {
    const path = opened.get(fd)!; procReads.push(path);
    assert.equal(position, 0); assert.equal(length, 4097, '4KiB plus one oversize sentinel byte');
    const pid = Number(path.split('/')[2]);
    let value: string;
    if (path.endsWith('/stat')) {
      const count = (statReads.get(pid) ?? 0) + 1; statReads.set(pid, count);
      if (pid === 4101 && count === 3 && change === 'vanished') throw new Error('PRIVATE_VANISHED');
      const stat = Array<string>(20).fill('0');
      stat[0] = 'S'; stat[1] = String(pid === 4100 ? 4000 : 4100); stat[2] = '4100';
      stat[19] = pid === 4101 && ((count === 3 && change === 'replaced') ||
        (comparing && comparison === 'reused-birth' && count >= 5)) ? '200' : '100';
      value = `${pid} (PRIVATE_COMM_MUST_NOT_LEAK) ${stat.join(' ')}\n`;
    } else if (path.includes('/fdinfo/')) {
      value = comparison === 'missing-flags' ? 'pos:\t0\n' :
        comparison === 'duplicate-flags' ? 'flags:\t02002\nflags:\t02002002\n' :
        `flags:\t${pid === 4100 ? '02002002' : '02002'}\n`;
    } else if (comparison !== 'off' && pid === 4101) {
      if (comparison === 'oversize-argv') value = 'PRIVATE_'.repeat(600);
      else if (comparison === 'empty-argv') value = '';
      else if (comparison === 'incomplete-argv') value = 'PRIVATE_INCOMPLETE';
      else if (comparison === 'node-exec' || comparison === 'linux-child-exec')
        value = '/PRIVATE_EXECUTABLE/' + comparison + '\0--\0' + fixture.node + '\0' + fixture.hostEntry + '\0';
      else if (comparison.includes('builder')) {
        const entry = comparison === 'other-builder' ? '/PRIVATE_OTHER/cli-default.js' : fixture.mcpBuilderEntry;
        const output = comparison === 'builder-empty-output' ? '' :
          comparison === 'builder-duplicate-output' ? '--out-dir' : '/PRIVATE_OUTPUT';
        value = fixture.node + '\0' + entry + '\0--out-dir\0' + output + '\0';
      } else value = fixture.node + '\0' + fixture.hostEntry + '\0' +
        (comparison === 'other-argv' ? '--PRIVATE_EXTRA\0' : '');
    } else value = '/PRIVATE_EXECUTABLE/electron\0' +
      (pid === 4101 ? '--type=zygote\0' : '') + '--PRIVATE_ARGUMENT_MUST_NOT_LEAK\0';
    return Buffer.from(value).copy(buffer, offset, 0, length);
  });
  t.mock.method(fs, 'closeSync', (fd: number) => { assert.ok(opened.delete(fd)); });
  t.mock.method(fs, 'readlinkSync', (path: string) => {
    assert.match(path, /^\/proc\/(4100|4101)\/(fd\/61|exe)$/u);
    procReads.push(path);
    const pid = Number(path.split('/')[2]);
    if (path.endsWith('/exe')) return pid === 4101
      ? comparison === 'node-exec' || comparison === 'linux-child-exec'
        ? '/PRIVATE_EXECUTABLE/' + comparison : fixture.node : '/PRIVATE_EXECUTABLE/electron';
    const count = (links.get(pid) ?? 0) + 1; links.set(pid, count);
    return comparing && pid === 4101 && comparison === 'changed-socket' && count >= 3
      ? 'socket:[99999]' : 'socket:[45678]';
  });
  t.mock.method(childProcess, 'execFileSync', (file: string, args: readonly string[]) => {
    if (file === '/bin/ps') return '4100 4000 4100\n4101 4100 4100\n';
    assert.equal(file, '/usr/bin/lsof');
    assert.ok(args.includes('-FpfDtinPT') && args.includes('-Ts') && args.includes('-a'));
    reads++;
    return output;
  });
  t.mock.method(process, 'kill', () => assert.fail('a descriptor census never signals'));
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  let original: unknown;
  try { assertOwnedCdpListener(4100); } catch (error) { original = error; }
  assert.ok(original instanceof assert.AssertionError);
  assert.match(original.message, /one CDP listener/u);
  assert.equal(reads, 1, 'failure projection does not perform a second racy census');
  const facts = readOwnedCdpListenerFailure(original);
  assert.ok(facts);
  assert.equal(facts.holderCount, 2, 'a second PID past the retained16rows still refuses, even with the same inode');
  assert.equal(facts.fileCount, 18); assert.equal(facts.files.length, 16); assert.equal(facts.truncated, true);
  assert.equal(JSON.stringify(facts).includes('PRIVATE_PATH_MUST_NOT_LEAK'), false);
  assert.equal(readOwnedCdpListenerFailure(new Error('unrelated')), undefined);
  output = 'p4100\n' + fields(1) + fields(2);
  assert.equal(assertOwnedCdpListener(4100), 4100, 'two descriptors of one original holder preserve the prior PID rule');
  assert.equal(readOwnedCdpListenerFailure(original), facts, 'a later successful read does not replace the original failure');
  output = 'p4100\n';
  assert.throws(() => assertOwnedCdpListener(4100), /Positive original lsof descriptor census/u);

  const unknownInode = 'f61\ntIPv4\nPTCP\nTST=LISTEN\nn127.0.0.1:9222\n';
  output = 'p4100\n' + unknownInode + 'p4101\n' + unknownInode;
  for (const variant of ['none', 'replaced', 'vanished'] as const) {
    change = variant; statReads.clear(); procReads.length = 0;
    let failure: unknown;
    try { assertOwnedCdpListener(4100); } catch (error) { failure = error; }
    assert.ok(failure instanceof assert.AssertionError);
    assert.match(failure.message, /one CDP listener/u);
    const retained = readOwnedCdpListenerFailure(failure)!;
    assert.equal(retained.holderCount, 2, 'even equal supplemental socket inodes never admit two holders');
    assert.equal(retained.files[0]!.inode, null, 'original lsof facts are never rewritten');
    assert.deepEqual(retained.files[0]!.afterCensus, {
      scope: 'after-original-census', atomic: false, birth: 'same', startTicks: '100',
      ppid: 4000, pgid: 4100, role: 'electron-main', socketInode: '45678',
    });
    assert.deepEqual(retained.files[1]!.afterCensus, variant === 'none' ? {
      scope: 'after-original-census', atomic: false, birth: 'same', startTicks: '100',
      ppid: 4100, pgid: 4100, role: 'electron-zygote', socketInode: '45678',
    } : {
      scope: 'after-original-census', atomic: false, birth: 'unknown', startTicks: null,
      ppid: null, pgid: null, role: 'unknown', socketInode: null,
    });
    assert.equal(JSON.stringify(retained).includes('PRIVATE_'), false, 'raw argv, comm, paths and errors stay private');
    assert.deepEqual(procReads.slice(0, 2), ['/proc/4100/stat', '/proc/4101/stat']);
    assert.equal(opened.size, 0, 'all diagnostic file descriptors close, including vanished birth');
  }
  for (const variant of ['exact', 'other-argv', 'builder', 'other-builder', 'builder-duplicate-output',
    'builder-empty-output', 'builder-no-expectation', 'missing-flags', 'duplicate-flags',
    'reused-birth', 'changed-socket', 'oversize-argv', 'empty-argv', 'incomplete-argv',
    'node-exec', 'linux-child-exec'] as const) {
    comparison = variant; comparing = false; change = 'none';
    statReads.clear(); links.clear(); procReads.length = 0;
    let failure: unknown;
    try { assertOwnedCdpListener(4100); } catch (error) { failure = error; }
    assert.ok(failure instanceof assert.AssertionError);
    const originalFacts = readOwnedCdpListenerFailure(failure)!;
    const originalBytes = JSON.stringify(originalFacts), censusReads: number = reads;
    comparing = true;
    const selection = variant === 'builder-no-expectation'
      ? { node: fixture.node, hostEntry: fixture.hostEntry } : fixture;
    const projected = readOwnedCdpListenerFailure(failure, selection)!;
    assert.equal(projected.holderCount, 2);
    const child = projected.fixtureCorrelation![1]!;
    const unknown = variant === 'reused-birth' || variant === 'changed-socket';
    const unreadableArgv = ['oversize-argv', 'empty-argv', 'incomplete-argv'].includes(variant);
    assert.deepEqual(child, {
      pid: 4101, fd: '61', scope: 'after-failed-census', atomic: false,
      birth: unknown ? 'unknown' : 'same', socket: unknown ? 'unknown' : 'same-as-supplemental',
      fixtureHostArgv: unknown || unreadableArgv ? null : ['exact', 'missing-flags', 'duplicate-flags'].includes(variant),
      fixtureNodeExecutable: unknown ? null : !['node-exec', 'linux-child-exec'].includes(variant),
      fixtureMcpBuilderEntry: unknown || unreadableArgv || variant === 'builder-no-expectation' ? null : variant === 'builder',
      closeOnExec: unknown || variant === 'missing-flags' || variant === 'duplicate-flags' ? null : false,
      commandLineState: unknown ? 'unknown' : variant === 'oversize-argv' ? 'unavailable-or-over-limit' :
        variant === 'empty-argv' ? 'empty' : variant === 'incomplete-argv' ? 'incomplete' : 'complete',
      executableKind: unknown ? 'unknown' : variant === 'node-exec' || variant === 'linux-child-exec' ? variant : 'node',
    });
    assert.equal(projected.fixtureCorrelation![0]!.fixtureHostArgv, false);
    assert.equal(projected.fixtureCorrelation![0]!.fixtureNodeExecutable, false);
    assert.equal(projected.fixtureCorrelation![0]!.commandLineState, 'complete');
    assert.equal(projected.fixtureCorrelation![0]!.executableKind, 'electron');
    assert.equal(projected.fixtureCorrelation![0]!.fixtureMcpBuilderEntry,
      variant === 'builder-no-expectation' ? null : false);
    if (variant === 'exact') assert.equal(projected.fixtureCorrelation![0]!.closeOnExec, true);
    const comparedReads = procReads.length;
    assert.equal(readOwnedCdpListenerFailure(failure, selection), projected, 'one correlation per original error');
    assert.equal(procReads.length, comparedReads);
    assert.equal(reads, censusReads, 'fixture comparison never repeats lsof or ps');
    assert.equal(readOwnedCdpListenerFailure(failure), originalFacts);
    assert.equal(JSON.stringify(originalFacts), originalBytes, 'original failed census stays byte-identical');
    assert.equal(JSON.stringify(projected).includes('PRIVATE_'), false);
    assert.ok(Buffer.byteLength('TEST_CDP_LISTENER_FAILURE ' + JSON.stringify(projected), 'utf8') <= 32 * 1024);
    assert.equal(opened.size, 0);
    assert.match(failure.message, /one CDP listener/u);
  }
});

test('Linux zero-group rows remain observable without becoming owned app groups; malformed census stays an error', (t) => {
  let output = '1 0 1\n2 0 0\n4100 4000 4100\n';
  t.mock.method(childProcess, 'execFileSync', (file: string, args: readonly string[]) => {
    assert.equal(file, '/bin/ps');
    assert.deepEqual(args, ['-ax', '-o', 'pid=,ppid=,pgid=']);
    return output;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  t.mock.method(process, 'kill', () => assert.fail('a census never signals'));
  assert.deepEqual(processTable(), [
    { pid: 1, ppid: 0, pgid: 1 }, { pid: 2, ppid: 0, pgid: 0 },
    { pid: 4100, ppid: 4000, pgid: 4100 },
  ]);
  assert.deepEqual(groupMembers(4100), [{ pid: 4100, ppid: 4000, pgid: 4100 }]);
  assert.throws(() => groupMembers(0), /Captured app group must be positive/);
  assert.throws(() => safeGroupSnapshot(0), /Captured app group must be positive/);
  for (const malformed of ['0 0 0', '2 0', '2 0 0 9', '2 nope 0', '2 -1 0', '9007199254740992 0 0']) {
    output = malformed + '\n';
    assert.throws(() => processTable(), /Malformed process table row|Invalid process table identity/);
  }
});

test('the same original-root oracle uses each existing caller deadline after a long provider phase, without renewing reads', t => {
  const capture = { version: 3 as const, platform: 'linux' as const,
    registrar: { backendId: 'TEST-backend', teamId: 'TEST-team', runId: 'TEST-run', memberId: 'TEST-member', generation: '1' },
    root: { pid: 4100, sessionId: 4100, pidfdId: '100', pidNamespaceId: '4026531836', bootId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' },
    target: { pid: 4101, sessionId: 4100, pidfdId: '101', pidNamespaceId: '4026531836', bootId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' } };
  const selection = { directory: '/TEST-original-artifact', manifestSha256: 'a'.repeat(64) };
  let clock = 1000, calls = 0, late = false;
  const budgets: number[] = [];
  t.mock.method(Date, 'now', () => clock);
  t.mock.method(childProcess, 'execFileSync', (file: string, args: string[], options: { timeout: number }) => {
    assert.equal(file, '/TEST-original-node'); assert.equal(args.length, 4);
    assert.equal(args[1], '--observe-linux-root');
    assert.deepEqual(JSON.parse(args[2]!), selection); assert.deepEqual(JSON.parse(args[3]!), capture);
    assert.ok(options.timeout > 0 && options.timeout <= 5000); budgets.push(options.timeout);
    calls++; if (late) clock += options.timeout + 1;
    return calls === 1 ? 'same-live\n' : 'absent\n';
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const oracle = createDesktopProcessRootOracle({ node: '/TEST-original-node', capture, selection,
    observe: () => assert.fail('Linux root observation uses only the bounded read-only actor') });
  assert.equal(oracle.observe(clock + 5000), 'same-live');
  clock += 180_001;
  const cleanupDeadline = clock + 30_000;
  assert.equal(oracle.observe(cleanupDeadline), 'absent', 'unrelated provider phases do not spend the cleanup read budget');
  assert.throws(() => oracle.observe(clock), /original-root oracle/u);
  assert.equal(calls, 2, 'an expired caller never starts another native read');
  for (let i = 0; i < 8; i++) { clock++; assert.equal(oracle.observe(cleanupDeadline), 'absent'); }
  clock = cleanupDeadline - 250; late = true;
  assert.throws(() => oracle.observe(cleanupDeadline), /original-root oracle/u);
  assert.equal(budgets.at(-1), 250, 'the final read receives only the original caller remainder');
  assert.equal(calls, 11);
  late = false;
  assert.throws(() => oracle.observe(clock + 5000), /original-root oracle/u);
  assert.equal(calls, 11, 'the13th call cannot reset the shared read cap with another deadline');
});

test('read-only discovery survives navigation during the actual IPC read, then reads the new context', async () => {
  let reads = 0;
  const cdp = {
    async evaluate(expression: string) {
      if (expression.startsWith('Boolean(')) return true;
      reads++;
      if (reads === 1) throw new Error('Execution context was destroyed.');
      return { state: 'ready', bindings: [{ handle: 'original-owner' }] };
    },
  };
  assert.deepEqual(await readRendererBackendConnections(cdp), {
    kind: 'pending',
    reason: 'context-replaced',
  });
  assert.deepEqual(await readRendererBackendConnections(cdp), {
    kind: 'read',
    value: { state: 'ready', bindings: [{ handle: 'original-owner' }] },
  });
  assert.equal(reads, 2);
});

test('unregistered initial discovery waits, but owner failures are never hidden as navigation', async () => {
  const cdp = (failure: string) => ({
    async evaluate(expression: string) {
      if (expression.startsWith('Boolean(')) return true;
      throw new Error(failure);
    },
  });
  assert.deepEqual(
    await readRendererBackendConnections(
      cdp("No handler registered for 'agentBackend:connections'")
    ),
    { kind: 'pending', reason: 'handler-not-ready' }
  );
  await assert.rejects(
    readRendererBackendConnections(cdp('Owner read forbidden')),
    /Owner read forbidden/
  );
});

test('initial discovery passes only its remaining captured budget to the IPC await', async (t) => {
  let clock = 1000;
  t.mock.method(performance, 'now', () => clock);
  const budgets: Array<number | undefined> = [];
  const cdp = {
    async evaluate(expression: string, timeoutMs?: number) {
      budgets.push(timeoutMs);
      if (expression.startsWith('Boolean(')) {
        clock += 10_000;
        return true;
      }
      assert.equal(timeoutMs, 50_000, 'bridge lookup time is charged to the original60s deadline');
      clock += 40_000;
      return { state: 'ready', bindings: [] };
    },
  };
  assert.deepEqual(await readRendererBackendConnections(cdp, 60_000), {
    kind: 'read',
    value: { state: 'ready', bindings: [] },
  });
  assert.deepEqual(budgets, [60_000, 50_000]);
});

test('exhausted initial observation never dispatches the backend IPC', async (t) => {
  let clock = 0,
    calls = 0;
  t.mock.method(performance, 'now', () => clock);
  const cdp = {
    async evaluate(_expression: string, timeoutMs?: number) {
      calls++;
      assert.equal(timeoutMs, 100);
      clock = 100;
      return true;
    },
  };
  await assert.rejects(
    readRendererBackendConnections(cdp, 100),
    /initial backend discovery observation deadline/
  );
  assert.equal(calls, 1);
});

test('other discovery callers retain the default CDP budget', async () => {
  const budgets: Array<number | undefined> = [];
  await readRendererBackendConnections({
    async evaluate(expression, timeoutMs) {
      budgets.push(timeoutMs);
      return expression.startsWith('Boolean(') ? true : { state: 'hold' };
    },
  });
  assert.deepEqual(budgets, [undefined, undefined]);
});

class CdpFixtureSocket extends EventEmitter {
  readonly sent: Array<{ id: number; method: string }> = [];
  send(value: string): void {
    this.sent.push(JSON.parse(value) as { id: number; method: string });
  }
  answer(id: number, value: unknown): void {
    this.emit('message', JSON.stringify({ id, result: { result: { value } } }));
  }
}
const { CdpClient } = createRequire(import.meta.url)('../e2e/comment-notification/cdp.mjs') as {
  CdpClient: new (socket: CdpFixtureSocket) => {
    evaluate(expression: string, timeoutMs?: number): Promise<unknown>;
  };
};

test('an explicit IPC observation budget lets the same read settle after30s within60s', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const socket = new CdpFixtureSocket(),
    client = new CdpClient(socket);
  const pending = client.evaluate('readOnlyConnections()', 60_000);
  // Observe rejection immediately as well, so old-code RED has no unhandled rejection.
  const outcome = pending.then(
    (value) => ({ ok: true as const, value }),
    () => ({ ok: false as const })
  );
  t.mock.timers.tick(30_001);
  assert.equal(socket.sent.length, 1, 'one original read; no resend or replacement');
  socket.answer(socket.sent[0]!.id, { state: 'ready' });
  assert.deepEqual(await outcome, { ok: true, value: { state: 'ready' } });
});

test('default CDP evaluations still reject at30s without a resend', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const socket = new CdpFixtureSocket(),
    client = new CdpClient(socket);
  let settled = false;
  const pending = client.evaluate('ordinaryObservation()');
  void pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  const rejection = assert.rejects(pending, /CDP command timed out: Runtime.evaluate/);
  t.mock.timers.tick(29_999);
  await Promise.resolve();
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  await rejection;
  assert.equal(socket.sent.length, 1);
});

test('macOS original Node zombie is the same unreaped harness child, never a changed live command', () => {
  const good = {
    expectedIdentity:
      'Sun Nov  8 01:17:47 2026     /captured/node /captured/pnpm.js dev:mcp --remoteDebuggingPort 9222',
    observedIdentity: 'Sun Nov  8 01:17:47 2026     (node)',
    state: 'Z',
    childPid: 4096,
    group: 4096,
    leader: { pid: 4096, ppid: 3990, pgid: 4096 },
    parentPid: 3990,
    platform: 'darwin' as const,
  };
  assert.equal(isCapturedOriginalNodeZombie(good), true);
  assert.equal(
    isCapturedOriginalNodeZombie({
      ...good,
      observedIdentity: 'Sun Nov  8 01:17:47 2026     <defunct>',
    }),
    true,
    'the original macOS defunct wrapper requires the same Z/parent/birth/custody proof'
  );
  const packed = {
    ...good,
    expectedIdentity:
      'Sun Nov  8 02:12:49 2026     /private/tmp/TEST-stage1-p7/app/Agent Teams AI.app/Contents/MacOS/Agent Teams AI --remote-debugging-port=9222',
    observedIdentity: 'Sun Nov  8 02:12:49 2026     (Agent Teams AI)',
  };
  assert.equal(isCapturedOriginalNodeZombie(packed), true, 'original packed app zombie must retain its exact capture');
  for (const variant of [
    { state: 'S' },
    { state: 'R+' },
    { parentPid: 1 },
    { group: 5000 },
    { leader: { pid: 4096, ppid: 1, pgid: 4096 } },
    { platform: 'linux' as const },
    { observedIdentity: 'Sun Nov  8 02:12:50 2026     (Agent Teams AI)' },
    { observedIdentity: 'Sun Nov  8 02:12:49 2026     (foreign)' },
    { expectedIdentity: 'Sun Nov  8 02:12:49 2026     /unrelated/Agent Teams AI --remote-debugging-port=9222' },
    { expectedIdentity: 'Sun Nov  8 02:12:49 2026     /app/Agent Teams AI.app/Contents/MacOS/Agent Teams AI --remote-debugging-port=9223' },
    { expectedIdentity: 'Sun Nov  8 02:12:49 2026     /app/Agent Teams AI.app/Contents/MacOS/Agent Teams AI --remote-debugging-port=9222 --other' },
  ]) {
    assert.equal(isCapturedOriginalNodeZombie({ ...packed, ...variant }), false, JSON.stringify(variant));
  }
  const invalid = [
    { state: 'S' }, // A live renamed process is never enough.
    { state: 'R+' },
    { observedIdentity: 'Sun Nov  8 01:17:48 2026     (node)' },
    { observedIdentity: 'Sun Nov  8 01:17:47 2026     /different/node' },
    { observedIdentity: 'Sun Nov  8 01:17:47 2026     (foreign)' },
    { childPid: 5000 },
    { group: 5000 },
    { leader: { pid: 4096, ppid: 1, pgid: 4096 } },
    { leader: { pid: 4096, ppid: 3990, pgid: 5000 } },
    { leader: undefined },
    { parentPid: 1 },
    { platform: 'linux' as const },
    { expectedIdentity: 'Sun Nov  8 01:17:47 2026     /unrelated/program' },
  ];
  for (const variant of invalid) {
    assert.equal(
      isCapturedOriginalNodeZombie({ ...good, ...variant }),
      false,
      JSON.stringify(variant)
    );
  }
});

const appReapInput = () => ({
  child: { pid: 4096, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null },
  group: 4096,
  hostPid: 4196,
  initialMembers: [{ pid: 4096, ppid: 3990, pgid: 4096 }],
  expectedIdentity: 'Tue Oct 27 22:59:52 2026     /captured/node /captured/pnpm.js dev:mcp',
  observedIdentity: 'Tue Oct 27 22:59:52 2026     <defunct>',
  deadline: 3000,
});

test('live stat can become original defunct before the guard; only original child reap and whole-group absence settle it', async (t) => {
  let now = 0,
    reaped = false;
  const input = appReapInput();
  t.mock.method(Date, 'now', () => now);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const queries: string[] = [];
  t.mock.method(childProcess, 'execFileSync', (file: string, args: readonly string[]) => {
    assert.equal(file, '/bin/ps');
    const query = args.join(' ');
    queries.push(query);
    if (query === '-p 4096 -o stat=') return 'S';
    if (query === '-p 4096 -o lstart=,command=') return input.observedIdentity;
    assert.equal(query, '-ax -o pid=,ppid=,pgid=');
    return reaped ? '9999 1 9999\n' : '4096 3990 4096\n';
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  t.mock.method(process, 'kill', () => {
    assert.fail('reaping observation never signals');
  });
  const deadline = Date.now() + 3000;
  const members = await settledGroupMembers(input.group, deadline);
  const observedIdentity = childProcess
    .execFileSync('/bin/ps', ['-p', '4096', '-o', 'lstart=,command='], { encoding: 'utf8' })
    .trim();
  const pending = observeOriginalAppReap({
    ...input,
    initialMembers: members,
    observedIdentity,
    deadline,
  });
  assert.equal(input.child.exitCode, null);
  now = 100;
  reaped = true;
  input.child.exitCode = 0;
  t.mock.timers.tick(100);
  const result = await pending;
  assert.equal(result.settled, true);
  assert.equal(result.reason, 'original-natural-exit-and-fresh-absence');
  assert.deepEqual(result.remaining, []);
  assert.equal(result.capturedHostAbsent, true);
  assert.equal(result.initial.appExitCode, null);
  assert.equal(result.initial.observedIdentity, input.observedIdentity);
  assert.deepEqual(queries.slice(0, 3), [
    '-ax -o pid=,ppid=,pgid=',
    '-p 4096 -o stat=',
    '-p 4096 -o lstart=,command=',
  ]);
});

test('changed command/start, wrong child/group and initial descendants never authorize a recovery observation', async () => {
  const variants = [
    { observedIdentity: 'Tue Oct 27 22:59:52 2026     /unrelated/command' },
    { observedIdentity: 'Tue Oct 27 23:00:52 2026     <defunct>' },
    { observedIdentity: '' },
    { child: { pid: 5000, exitCode: 0, signalCode: null } },
    { initialMembers: [{ pid: 5000, ppid: 3990, pgid: 4096 }] },
    {
      initialMembers: [
        { pid: 4096, ppid: 3990, pgid: 4096 },
        { pid: 5000, ppid: 4096, pgid: 4096 },
      ],
    },
  ];
  for (const variant of variants) {
    const result = await observeOriginalAppReap(
      { ...appReapInput(), deadline: Date.now() + 3000, ...variant },
      () => assert.fail('ineligible identity must not dispatch another observation')
    );
    assert.equal(result.settled, false);
    assert.equal(result.reason, 'ineligible-original-defunct-observation');
  }
});

test('an already observed original natural exit still requires fresh group and captured Host absence', async () => {
  for (const table of [
    [],
    [{ pid: 5000, ppid: 1, pgid: 4096 }],
    [{ pid: 4196, ppid: 1, pgid: 7777 }],
    [{ pid: 4096, ppid: 1, pgid: 4096 }],
  ]) {
    const input = appReapInput();
    input.deadline = Date.now() + 3000;
    input.child.exitCode = 0;
    let reads = 0;
    const result = await observeOriginalAppReap(input, () => {
      reads++;
      return table;
    });
    assert.equal(result.settled, table.length === 0);
    assert.equal(reads, 1);
  }
});

test('original crash/signal and process-table failures remain debt', async () => {
  for (const outcome of [
    { exitCode: 1, signalCode: null },
    { exitCode: null, signalCode: 'SIGTERM' as const },
  ]) {
    const input = appReapInput();
    input.deadline = Date.now() + 3000;
    Object.assign(input.child, outcome);
    const result = await observeOriginalAppReap(input, () =>
      assert.fail('non-natural exit cannot qualify')
    );
    assert.equal(result.settled, false);
    assert.equal(result.reason, 'original-child-exit-not-natural-zero');
  }
  const input = appReapInput();
  input.deadline = Date.now() + 3000;
  const result = await observeOriginalAppReap(input, () => {
    throw new Error('ps unavailable');
  });
  assert.equal(result.settled, false);
  assert.equal(result.reason, 'process-table-unavailable');
});

test('the original deadline is not renewed after initial settlement consumed it', async (t) => {
  t.mock.method(Date, 'now', () => 3000);
  const input = appReapInput();
  input.child.exitCode = 0;
  const result = await observeOriginalAppReap(input, () =>
    assert.fail('expired original deadline cannot re-read or qualify absence')
  );
  assert.equal(result.settled, false);
  assert.equal(result.reason, 'original-observation-deadline');
});

test('numeric group absence without this original child exit observation expires within the remaining original budget', async (t) => {
  let now = 2900;
  t.mock.method(Date, 'now', () => now);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = observeOriginalAppReap(appReapInput(), () => []);
  now = 3000;
  t.mock.timers.tick(100);
  const result = await pending;
  assert.equal(result.settled, false);
  assert.equal(result.reason, 'original-observation-deadline');
  assert.equal(result.appExitCode, null);
  assert.deepEqual(result.remaining, []);
});

test('a process-table read that crosses the original deadline cannot qualify natural exit', async (t) => {
  let now = 2999;
  t.mock.method(Date, 'now', () => now);
  const input = appReapInput();
  input.child.exitCode = 0;
  const result = await observeOriginalAppReap(input, () => {
    now = 3000;
    return [];
  });
  assert.equal(result.settled, false);
  assert.equal(result.reason, 'original-observation-deadline');
});

const exitedGroupInput = () => ({
  child: { pid: 4096, exitCode: 0 as number | null, signalCode: null as NodeJS.Signals | null },
  group: 4096,
  hostPid: 4196,
  initialMembers: [{ pid: 5000, ppid: 1, pgid: 4096 }],
  deadline: 3000,
});

test('an already reaped original child waits for actual descendant and original Host absence', async (t) => {
  let now = 2700;
  t.mock.method(Date, 'now', () => now);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(process, 'kill', () => assert.fail('absence observation never signals'));
  let table = [{ pid: 5000, ppid: 1, pgid: 4096 }];
  const pending = observeExitedAppGroup(exitedGroupInput(), () => table);
  table = [{ pid: 4196, ppid: 1, pgid: 7777 }];
  now = 2800;
  t.mock.timers.tick(100);
  await Promise.resolve();
  table = [];
  now = 2900;
  t.mock.timers.tick(100);
  const result = await pending;
  assert.equal(result.settled, true);
  assert.equal(result.reason, 'original-natural-exit-and-fresh-absence');
  assert.deepEqual(result.remaining, []);
  assert.equal(result.capturedHostAbsent, true);
  assert.deepEqual(result.initialMembers, exitedGroupInput().initialMembers);
  assert.equal(result.capturedDescendantsAbsent, true);
});

test('an orphan descendant, moved captured descendant or original Host cannot be cleared by an expired budget', async (t) => {
  let now = 2900;
  t.mock.method(Date, 'now', () => now);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const orphan = observeExitedAppGroup(exitedGroupInput(), () => exitedGroupInput().initialMembers);
  const moved = observeExitedAppGroup(exitedGroupInput(), () => [{ pid: 5000, ppid: 1, pgid: 5000 }]);
  const host = observeExitedAppGroup(exitedGroupInput(), () => [{ pid: 4196, ppid: 1, pgid: 7777 }]);
  now = 3000;
  t.mock.timers.tick(100);
  for (const result of await Promise.all([orphan, moved, host])) {
    assert.equal(result.settled, false);
    assert.equal(result.reason, 'original-observation-deadline');
  }
  assert.equal((await moved).capturedDescendantsAbsent, false);
});

test('absent leader observation rejects wrong child, live/crashed/signaled child and invalid captured identities', async () => {
  for (const variant of [
    { child: { pid: 5000, exitCode: 0, signalCode: null } },
    { child: { pid: 4096, exitCode: null, signalCode: null } },
    { child: { pid: 4096, exitCode: 1, signalCode: null } },
    { child: { pid: 4096, exitCode: null, signalCode: 'SIGTERM' as const } },
    { hostPid: 0 }, { hostPid: 4096 }, { group: -1 }, { deadline: NaN },
    { initialMembers: [{ pid: 4096, ppid: 3990, pgid: 4096 }] },
    { initialMembers: [{ pid: 5000, ppid: 1, pgid: 7777 }] },
  ]) {
    const result = await observeExitedAppGroup({ ...exitedGroupInput(), ...variant }, () =>
      assert.fail('ineligible captured child cannot observe again'));
    assert.equal(result.settled, false);
    assert.equal(result.reason, 'ineligible-original-natural-exit-observation');
  }
});

test('a reused leader PID and unavailable full process census retain debt without signaling', async (t) => {
  t.mock.method(Date, 'now', () => 2900);
  t.mock.method(process, 'kill', () => assert.fail('absence observation never signals'));
  const reused = await observeExitedAppGroup(exitedGroupInput(), () => [{ pid: 4096, ppid: 1, pgid: 7777 }]);
  assert.equal(reused.settled, false);
  assert.equal(reused.reason, 'captured-leader-pid-reappeared');
  const unavailable = await observeExitedAppGroup(exitedGroupInput(), () => { throw new Error('ps unavailable'); });
  assert.equal(unavailable.settled, false);
  assert.equal(unavailable.reason, 'process-table-unavailable');
});

test('absent leader observation never renews the original deadline or accepts a late census', async (t) => {
  let now = 3000;
  t.mock.method(Date, 'now', () => now);
  const expired = await observeExitedAppGroup(exitedGroupInput(), () => assert.fail('expired budget'));
  assert.equal(expired.settled, false);
  now = 2999;
  const late = await observeExitedAppGroup(exitedGroupInput(), () => { now = 3000; return []; });
  assert.equal(late.settled, false);
  assert.equal(late.reason, 'original-observation-deadline');
});

function emulatedObserverFixture(t: TestContext, mode: string,
  emptyPhase?: 'before-first-team-read' | 'after-team-read') {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'TEST-peer-observation Я 路径-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const executable = { path: join(root, 'TEST-peer.mjs'), sha256: digest('TEST never executed\n') };
  fs.writeFileSync(executable.path, 'TEST never executed\n');
  const peers = (['runtime', 'management'] as const).map(role => ({ root, role,
    environment: { HOME: root, CODEX_HOME: root, TEST_PEER_ROLE: role } }));
  const member = { provider: 'codex', protocolRevision: '0.162.0', teamId: 'TEST-team', memberId: 'TEST-member',
    principalId: 'TEST-user', sessionId: 'TEST-session', generation: 1, configRevision: 'TEST-1', model: 'TEST-model',
    accountBinding: 'TEST-account', cwd: root, executable, environment: peers[0]!.environment,
    limits: { queuedInputs: 1, inputBytes: 1024, outputBytes: 1024, outputEvents: 16, pendingInteractions: 1, timeoutMs: 1000 },
    nativeOptions: { approvalPolicy: 'on-request', sandbox: 'read-only' } };
  const profile = JSON.stringify({ schemaVersion: 1, principalId: 'TEST-user', teams: [],
    owner: { ownerId: 'TEST-owner', revision: 'TEST-1', storageRoot: root, profileId: 'TEST-profile', protocolVersion: 1,
      buildId: 'TEST-build', nodeSha256: executable.sha256, hostEntrySha256: executable.sha256 },
    runtime: { members: [member], providerTemplates: [member] }, management: [{ provider: 'codex', protocolRevision: '0.162.0',
      profileId: 'TEST-management', configRevision: 'TEST-1', accountBinding: 'TEST-account', cwd: root,
      executable, environment: peers[1]!.environment, timeoutMs: 1000 }] });
  const profilePath = join(root, 'profile.json'), descriptorPath = join(root, 'descriptor.json');
  fs.writeFileSync(profilePath, profile); fs.writeFileSync(descriptorPath, '{}');
  const fixture = { root, node: '/TEST/node', hostEntry: '/TEST/host.js', profilePath, descriptorPath,
    pins: { profileSha256: digest(profile), descriptorSha256: digest('{}') },
    emulatedRuntime: { provider: 'codex', sources: [executable], executable, peers,
      commandPrefix: `/TEST/node ${executable.path} `, observedPeerPids: [] as number[] } };
  const originalCommand = fixture.emulatedRuntime.commandPrefix + 'mcp list --json';
  const launch = { event: 'launch', provider: 'codex', role: 'management', pid: 4200, parentPid: 4101 };
  const journal = join(root, 'effects.ndjson'), row = JSON.stringify(launch) + '\n';
  const journalText = emptyPhase === undefined
    ? mode === 'later-row' || mode === 'missing' ? '' : mode === 'duplicate' ? row + row : row
    : mode === 'healthy-empty' ? '' : mode === 'retained-failure'
      ? JSON.stringify({ ...launch, event: 'failure' }) + '\n' : mode === 'malformed-json'
        ? '{"event":\n' : JSON.stringify({ ...launch, provider: mode === 'wrong-provider-claude' ? 'claude' : 'opencode' }) + '\n';
  fs.writeFileSync(journal, journalText);
  let now = 0, censusReads = 0, journalReads = 0, signalCalls = 0;
  t.mock.method(performance, 'now', () => now);
  const readFile = fsp.readFile;
  t.mock.method(fsp, 'readFile', async (...args: Parameters<typeof readFile>) => {
    const value = await readFile(...args);
    if (args[0] === journal) {
      journalReads++;
      if (mode === 'later-row' && journalReads === 1) fs.writeFileSync(journal, row);
      if (mode === 'late' || mode === 'missing' && journalReads === 2) now = 3000;
    }
    return value;
  });
  const openSync = fs.openSync;
  t.mock.method(fs, 'openSync', (...args: Parameters<typeof openSync>) => {
    if (String(args[0]).startsWith('/proc/')) throw Object.assign(new Error('TEST no real process read'), { code: 'ENOENT' });
    return openSync(...args);
  });
  const readFileSync = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (...args: Parameters<typeof readFileSync>) => {
    if (String(args[0]).startsWith('/proc/')) throw Object.assign(new Error('TEST no real process read'), { code: 'ENOENT' });
    return readFileSync(...args);
  });
  t.mock.method(childProcess, 'execFileSync', (file: string, args: readonly string[], options?: { timeout?: number; env?: NodeJS.ProcessEnv }) => {
    if (file.endsWith('/lsof')) return process.platform === 'linux'
      ? 'p4100\nf61\ntIPv4\nD0xabcd\ni12345\nPTCP\nTST=LISTEN\nn127.0.0.1:9222\n' : '4100\n';
    assert.equal(file, '/bin/ps');
    if (args.includes('pid=,ppid=,pgid=,lstart=,command=')) {
      censusReads++; assert.ok(options?.timeout && options.timeout <= 3000);
      assert.equal(options.env?.LC_ALL, process.platform === 'linux' ? 'C.UTF-8' : 'en_US.UTF-8');
      const host = '4100 4000 4100 Sun Nov 15 00:00:00 2026 /TEST/electron\n' +
        (emptyPhase === 'before-first-team-read' ? '' : '4101 4100 4100 Sun Nov 15 00:00:00 2026 /TEST/node /TEST/host.js\n');
      if (emptyPhase !== undefined || censusReads > 1 && mode === 'exit') return host;
      const birth = censusReads > 1 && mode === 'reuse' ? '00:00:01' : '00:00:00';
      const parent = censusReads > 1 && mode === 'reparent' ? 4999 : 4101;
      const argv = censusReads > 1 && mode === 'argv' ? originalCommand + ' --other' : originalCommand;
      return host + `4200 ${parent} 4200 Sun Nov 15 ${birth} 2026 ${argv}\n`;
    }
    if (args[0] === '-ax') return '4100 4000 4100\n' +
      (emptyPhase === 'before-first-team-read' ? '' : '4101 4100 4100\n') +
      (emptyPhase === undefined ? '4200 4101 4200\n' : '');
    assert.equal(args[0], '-p');
    return args[1] === '4101' ? '/TEST/node /TEST/host.js' : args[1] === '4200'
      ? mode === 'exit' ? '' : originalCommand : '/TEST/electron';
  });
  t.mock.method(process, 'kill', () => { signalCalls++; return assert.fail('observation never signals or adopts a PID'); });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return { fixture, journal, journalText, observe: () => observeDesktopEmulatedRuntimeChildren(4100,
    fixture as unknown as Parameters<typeof observeDesktopEmulatedRuntimeChildren>[1], emptyPhase ?? 'after-team-read'),
    reads: () => ({ censusReads, journalReads, signalCalls }) };
}

for (const mode of ['later-row', 'exit'])
test(`original peer observation accepts ${mode} only with its retained launch row`, async t => {
  const f = emulatedObserverFixture(t, mode);
  await f.observe();
  assert.deepEqual(f.fixture.emulatedRuntime.observedPeerPids, [4200]);
  assert.ok(f.reads().censusReads >= 2);
  if (mode === 'later-row') assert.equal(f.reads().journalReads, 2);
});

for (const mode of ['reuse', 'reparent', 'argv', 'duplicate', 'missing', 'late'])
test(`original peer observation refuses ${mode} without admitting the census PID`, async t => {
  const f = emulatedObserverFixture(t, mode);
  await assert.rejects(f.observe());
  assert.deepEqual(f.fixture.emulatedRuntime.observedPeerPids, []);
});

for (const phase of ['before-first-team-read', 'after-team-read'] as const)
for (const mode of ['healthy-empty', 'retained-failure', 'malformed-json', 'wrong-provider'])
test(`empty peer observation validates the original ${mode} journal ${phase}`, async t => {
  const f = emulatedObserverFixture(t, mode, phase);
  const observed = f.fixture.emulatedRuntime.observedPeerPids;
  observed.push(4300);
  if (mode === 'healthy-empty') await f.observe();
  else if (mode === 'retained-failure') await assert.rejects(f.observe(), {
    code: 'ERR_ASSERTION', actual: true, expected: false,
    message: /TEST protocol refusal cannot become a passing UI proof/u,
  });
  else if (mode === 'malformed-json') await assert.rejects(f.observe(), SyntaxError);
  else await assert.rejects(f.observe(), { code: 'ERR_ASSERTION', actual: 'opencode', expected: 'codex' });
  assert.equal(f.reads().censusReads, 1);
  assert.equal(f.reads().journalReads, 1, 'the original journal is read even without a current child');
  assert.equal(f.reads().signalCalls, 0, 'journal validation creates no signal authority');
  assert.equal(fs.readFileSync(f.journal, 'utf8'), f.journalText, 'observation appends no effect');
  assert.equal(f.fixture.emulatedRuntime.observedPeerPids, observed);
  assert.deepEqual(observed, [4300], 'empty or refused observations preserve the original PID inventory');
});

for (const [label, mode, phase] of [
  ['no-child-provider-mismatch', 'wrong-provider-claude', 'after-team-read'],
  ['zero-host-failure', 'retained-failure', 'before-first-team-read'],
  ['zero-host-clean', 'healthy-empty', 'before-first-team-read'],
] as const)
test(`empty peer census preserves ${label} through the original journal oracle`, async t => {
  const f = emulatedObserverFixture(t, mode, phase);
  const observed = f.fixture.emulatedRuntime.observedPeerPids;
  if (mode === 'wrong-provider-claude')
    await assert.rejects(f.observe(), { code: 'ERR_ASSERTION', actual: 'claude', expected: 'codex' });
  else if (mode === 'retained-failure') await assert.rejects(f.observe(), {
    code: 'ERR_ASSERTION', actual: true, expected: false,
    message: /TEST protocol refusal cannot become a passing UI proof/u,
  });
  else await f.observe();
  assert.equal(f.fixture.emulatedRuntime.observedPeerPids, observed);
  assert.deepEqual(observed, []);
  assert.deepEqual(f.reads(), { censusReads: 1, journalReads: 1, signalCalls: 0 });
  assert.equal(fs.readFileSync(f.journal, 'utf8'), f.journalText);
});

function capturedLinuxNodeTuple() {
  const birth = 'Mon Nov 16 06:10:25 2026';
  return { platform: 'linux' as NodeJS.Platform, expectedIdentity: birth + ' /TEST/node /TEST/pnpm.js dev:mcp',
    observedIdentity: birth + ' [MainThread] <defunct>', state: 'Z', childPid: 44001, group: 44001,
    leader: { pid: 44001, ppid: process.pid, pgid: 44001 }, parentPid: process.pid };
}

test('captured Linux original Node wrapper admits only its exact retained MainThread zombie tuple', t => {
  t.mock.method(process, 'kill', () => assert.fail('the identity predicate never signals'));
  assert.equal(isCapturedOriginalNodeZombie(capturedLinuxNodeTuple()), true);
});

test('Linux wrapper identity refuses changed custody, birth, invocation and other platform display forms', t => {
  let signals = 0; t.mock.method(process, 'kill', () => { signals++; return true; });
  const base = capturedLinuxNodeTuple();
  for (const change of [
    { state: 'S' }, { state: '' }, { childPid: undefined }, { childPid: 44002 },
    { group: 0 }, { group: -1 }, { group: Number.MAX_SAFE_INTEGER + 1 },
    { leader: undefined }, { leader: { ...base.leader, pid: 44002 } },
    { leader: { ...base.leader, ppid: base.parentPid + 1 } }, { leader: { ...base.leader, pgid: 44002 } },
    { observedIdentity: base.observedIdentity.replace('06:10:25', '06:10:26') },
    { expectedIdentity: base.expectedIdentity.replace('/node ', '/other ') },
    { expectedIdentity: base.expectedIdentity.replace('dev:mcp', 'dev:other') },
    { observedIdentity: base.observedIdentity.replace('[MainThread] <defunct>', '(node)') },
    { observedIdentity: base.observedIdentity.replace('[MainThread] <defunct>', '<defunct>') },
    { observedIdentity: base.observedIdentity + ' extra' },
    { platform: 'darwin' as const }, { platform: 'win32' as const }, { platform: 'freebsd' as const },
    { expectedIdentity: 'Mon Nov 16 06:10:25 2026 /TEST/Agent Teams AI.app/Contents/MacOS/Agent Teams AI --remote-debugging-port=9222',
      observedIdentity: 'Mon Nov 16 06:10:25 2026 (Agent Teams AI)' },
  ]) assert.equal(isCapturedOriginalNodeZombie({ ...base, ...change }), false, JSON.stringify(change));
  assert.equal(signals, 0);
});

type LinuxEpochMode = 'valid' | 'state' | 'birth' | 'child' | 'group' | 'parent' | 'leader' |
  'invocation' | 'display' | 'group-debt' | 'host-debt' | 'port-debt';

async function finiteLinuxOwnerEpoch(t: TestContext, mode: LinuxEpochMode) {
  const { finishDesktopOwnerRoutingEpoch } = await import('./desktop-owner-routing-epoch.ts');
  const { selectedCdpPort } = await import('./desktop-backend-observations.ts');
  const net = createRequire(import.meta.url)('node:net') as typeof import('node:net');
  const platform = Object.getOwnPropertyDescriptor(process, 'platform'); assert.ok(platform);
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
  t.after(() => { Object.defineProperty(process, 'platform', platform); t.mock.restoreAll(); syncBuiltinESMExports(); });
  const base = capturedLinuxNodeTuple(), group = mode === 'group' ? 0 : base.group;
  const app = { pid: mode === 'child' ? 44002 : base.childPid, exitCode: null, signalCode: null };
  const epoch: Record<string, unknown> = { cdpListener: 45001 }, hosts = [{ pid: 46001 }];
  const state = mode === 'state' ? 'S' : base.state;
  const observed = mode === 'birth' ? base.observedIdentity.replace('06:10:25', '06:10:26')
    : mode === 'display' ? base.observedIdentity.replace('[MainThread] <defunct>', '(node)') : base.observedIdentity;
  const expected = mode === 'invocation' ? base.expectedIdentity.replace('/node ', '/other ') : base.expectedIdentity;
  const counts = { tables: 0, states: 0, identities: 0, owned: 0, close: 0, disconnect: 0,
    signals: 0, sockets: 0, destroys: 0 };
  const delays: number[] = [], cleared: number[] = [], signals: { pid: number; signal: unknown }[] = [];
  const timers = new Map<object, number>(); let now = 0;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'setTimeout', (callback: () => void, delay: number) => {
    delays.push(delay); const token = { delay, serial: delays.length }; timers.set(token, delay);
    if (delay === 100) { now += counts.signals ? 30_000 : 3000; queueMicrotask(callback); }
    else assert.equal(delay, 3000, 'only the two original bounded close/disconnect timers');
    return token as unknown as NodeJS.Timeout;
  });
  t.mock.method(globalThis, 'clearTimeout', (token: NodeJS.Timeout) => {
    const delay = timers.get(token); assert.equal(delay, 3000); cleared.push(delay!); timers.delete(token);
  });
  const originalMembers = () => [
    { pid: 44001, ppid: mode === 'parent' ? process.pid + 1 : process.pid, pgid: 44001 },
    { pid: 44002, ppid: 44001, pgid: 44001 }, { pid: 44003, ppid: 44002, pgid: 44001 },
    { pid: 44004, ppid: 44003, pgid: 44001 },
  ];
  t.mock.method(childProcess, 'execFileSync', (file: string, args: readonly string[], options: unknown) => {
    assert.equal(file, '/bin/ps'); assert.deepEqual(options, { encoding: 'utf8', timeout: 3000 });
    if (args[0] === '-ax') {
      assert.deepEqual(args, ['-ax', '-o', 'pid=,ppid=,pgid=']); counts.tables++;
      let rows = counts.signals && mode !== 'group-debt' ? [] : originalMembers();
      if (mode === 'leader' && counts.tables === 6) rows = rows.filter(row => row.pid !== 44001);
      if (counts.signals && mode === 'host-debt') rows.push({ pid: 46001, ppid: 1, pgid: 99001 });
      return [{ pid: 99001, ppid: 1, pgid: 99001 }, ...rows].map(row => `${row.pid} ${row.ppid} ${row.pgid}`).join('\n');
    }
    assert.deepEqual(args.slice(0, 3), ['-p', String(group), '-o']);
    if (args[3] === 'stat=') { counts.states++; return state; }
    assert.equal(args[3], 'lstart=,command='); counts.identities++; return observed;
  });
  t.mock.method(process, 'kill', (pid: number, signal: unknown) => {
    counts.signals++; signals.push({ pid, signal }); assert.deepEqual({ pid, signal }, { pid: -44001, signal: 'SIGTERM' });
    assert.equal(counts.signals, 1, 'only the existing one guarded group signal'); return true;
  });
  t.mock.method(net, 'createConnection', (options: unknown) => {
    counts.sockets++; assert.deepEqual(options, { host: '127.0.0.1', port: selectedCdpPort });
    const socket = Object.assign(new EventEmitter(), {
      destroy(): EventEmitter { counts.destroys++; return socket; },
      setTimeout(delay: number): EventEmitter {
        assert.equal(delay, 1000); queueMicrotask(() => socket.emit(mode === 'port-debt' ? 'connect' : 'error', new Error('TEST absent')));
        return socket;
      },
    });
    return socket;
  });
  syncBuiltinESMExports();
  let error: unknown;
  try {
    await finishDesktopOwnerRoutingEpoch({ app: app as unknown as Parameters<typeof finishDesktopOwnerRoutingEpoch>[0]['app'],
      group, appIdentity: expected, hosts, epoch, assertOwned() { counts.owned++; }, cdp: {
        async evaluate(expression: string) { counts.close++; assert.equal(expression, 'window.electronAPI.windowControls.close()'); return undefined; },
        async close() { counts.disconnect++; },
      } as Parameters<typeof finishDesktopOwnerRoutingEpoch>[0]['cdp'] });
  } catch (caught) { error = caught; }
  return { error, epoch, counts, signals, delays, cleared, now, originalMembers: originalMembers() };
}

function assertOriginalEpochClose(f: Awaited<ReturnType<typeof finiteLinuxOwnerEpoch>>) {
  assert.deepEqual([f.counts.owned, f.counts.close, f.counts.disconnect], [1, 1, 1]);
  assert.deepEqual(f.cleared, [3000, 3000]);
  assert.deepEqual(f.epoch.failureQuit, { attempted: true,
    scope: 'Close only the verified TEST window before stopping its dev wrapper', reply: 'acknowledged', listenerAbsent: true });
  const cleanup = f.epoch.cleanup as Record<string, unknown>;
  assert.equal(cleanup.quitAttempted, true); assert.equal(cleanup.appExitCode, null); assert.equal(cleanup.appSignalCode, null);
}

test('actual owner epoch cleans the captured Linux zombie group only after original close and fresh identity guards', async t => {
  const f = await finiteLinuxOwnerEpoch(t, 'valid'); assertOriginalEpochClose(f);
  if (f.error) {
    assert.match(String(f.error), /original epoch invocation identity remains current/);
    assert.deepEqual([f.counts.tables, f.counts.states, f.counts.identities, f.counts.signals, f.counts.sockets], [6, 2, 1, 0, 0]);
    assert.deepEqual((f.epoch.cleanup as Record<string, unknown>).remaining, f.originalMembers);
  }
  assert.equal(f.error, undefined, 'the exact captured Linux tuple must reach the original guarded cleanup');
  assert.deepEqual(f.counts, { tables: 8, states: 2, identities: 1, owned: 1, close: 1, disconnect: 1,
    signals: 1, sockets: 1, destroys: 1 });
  assert.deepEqual(f.signals, [{ pid: -44001, signal: 'SIGTERM' }]); assert.deepEqual(f.delays, [3000, 3000, 100]);
  assert.equal(f.now, 3000); assert.deepEqual(f.epoch.originalZombieGuard, { group: 44001, state: 'Z', status: 'verified-original-zombie' });
  const cleanup = f.epoch.cleanup as Record<string, unknown>;
  assert.deepEqual(cleanup.remaining, []); assert.equal(cleanup.hostsAbsent, true); assert.equal(cleanup.signalAttempted, true);
  assert.equal((f.epoch.originalAppReap as Record<string, unknown>).settled, false);
  assert.equal((f.epoch.originalAppReap as Record<string, unknown>).reason, 'ineligible-original-defunct-observation');
});

for (const mode of ['state', 'birth', 'child', 'group', 'parent', 'leader', 'invocation', 'display'] as const)
test('actual Linux owner cleanup retains debt and zero signals for wrong ' + mode, async t => {
  const f = await finiteLinuxOwnerEpoch(t, mode); assertOriginalEpochClose(f);
  assert.match(String(f.error), mode === 'group' ? /Captured app group must be positive/ : /original epoch invocation identity remains current/);
  assert.equal(f.counts.signals, 0); assert.deepEqual(f.signals, []); assert.equal(f.counts.sockets, 0);
  const cleanup = f.epoch.cleanup as Record<string, unknown>;
  assert.equal(cleanup.signalAttempted, false); assert.equal(cleanup.hostsAbsent, null);
  assert.equal(typeof f.epoch.cleanupFailure, 'string');
});

for (const [mode, message] of [
  ['group-debt', /no next configuration while the captured epoch group remains/],
  ['host-debt', /every captured owner Host is absent before the next epoch/],
  ['port-debt', /true !== false/],
] as const)
test('actual Linux owner cleanup keeps final ' + mode + ' as failure after its one guarded signal', async t => {
  const f = await finiteLinuxOwnerEpoch(t, mode); assertOriginalEpochClose(f);
  assert.match(String(f.error), message); assert.deepEqual(f.signals, [{ pid: -44001, signal: 'SIGTERM' }]);
  assert.equal(f.counts.tables, 8); assert.equal(f.counts.states, 2); assert.equal(f.counts.identities, 1);
  assert.equal(f.counts.sockets, mode === 'port-debt' ? 1 : 0); assert.equal(f.counts.destroys, f.counts.sockets);
  assert.deepEqual(f.delays, mode === 'group-debt' ? [3000, 3000, 100, 100] : [3000, 3000, 100]);
  assert.equal(f.now, mode === 'group-debt' ? 33_000 : 3000);
  const cleanup = f.epoch.cleanup as Record<string, unknown>;
  assert.equal(cleanup.signalAttempted, true); assert.equal(cleanup.hostsAbsent, mode !== 'host-debt');
  assert.deepEqual(cleanup.remaining, mode === 'group-debt' ? f.originalMembers : []);
});


// Read the real pure projection. The packaged CLI main is never imported by these cases.
const {
  projectDesktopEmulatedReadinessFailure,
  projectDesktopProofReceiptSummary,
} = await import('./desktop-proof-evidence.ts');

function retainedDialogProjection(value: unknown) {
  const result = projectDesktopEmulatedReadinessFailure(value);
  assert.equal(result.status, 'available');
  assert.ok('retainedDialogs' in result);
  return result;
}

test('retained dialog readiness distinguishes saved Launch states and duplicate matches without a readiness verdict', () => {
  const result = retainedDialogProjection({ rendererFailureSnapshot: { dialogs: [
    { text: 'All selected providers are ready; model could not be verified; permission blocked',
      buttons: [{ text: 'Launch team', disabled: true }] },
    { text: 'Runtime environment unavailable; provider status is still loading',
      buttons: [{ text: 'Launch team', disabled: false }, { text: 'Launch team', disabled: true },
        { text: 'Launch team' }, { text: 'Launch team', disabled: 'false' },
        { text: ' Launch team ', disabled: false }, { text: 'Launch teamwork', disabled: false }] },
    { text: '', buttons: [] },
  ] } });
  assert.equal(result.storeRecorded, false);
  assert.deepEqual(result.provisioning.items, []);
  const sample = result.retainedDialogs;
  assert.equal(sample.source, 'retained-post-failure-partial-dialog-sample');
  assert.deepEqual([sample.atomicWithFailedWait, sample.completeDom, sample.actualTruncationKnown], [false, false, false]);
  assert.equal(sample.count, 3); assert.equal(sample.atCaptureLimit, true); assert.equal(sample.overflow, false);
  assert.deepEqual(sample.items[0].buttons.launchTeam, { matches: 1, enabled: 0, disabled: 1, unknown: 0 });
  assert.deepEqual(sample.items[1].buttons.launchTeam, { matches: 4, enabled: 1, disabled: 1, unknown: 2 });
  assert.deepEqual(sample.items[2].buttons.launchTeam, { matches: 0, enabled: 0, disabled: 0, unknown: 0 });
  assert.deepEqual(sample.items[0].text.terms, ['permission', 'model', 'provider', 'ready', 'blocked']);
  assert.equal(sample.items[0].text.selectedProvidersReady, true);
  assert.equal(sample.items[0].text.modelUnverified, true);
  assert.equal(sample.items[1].text.runtimeUnavailable, true);
  assert.equal(sample.items[1].text.providerStatusLoading, true);
  assert.equal('ready' in sample, false, 'saved facts do not resolve the original expired wait');
});

test('retained dialog projection bounds malformed samples independently and preserves the original final overflow fallback', () => {
  for (const value of [undefined, null, {}, { rendererFailureSnapshot: { unavailable: true } },
    { rendererFailureSnapshot: { dialogs: {} } }]) {
    const result = retainedDialogProjection(value);
    assert.equal(result.retainedDialogs.count, null);
    assert.equal(result.retainedDialogs.atCaptureLimit, null);
    assert.deepEqual(result.retainedDialogs.items, []);
  }
  const malformed = retainedDialogProjection({ rendererFailureSnapshot: { dialogs: [
    null, { buttons: {} }, { buttons: [null, {}, { text: 7 }, { text: 'Launch team', disabled: null }] },
  ] } }).retainedDialogs;
  assert.equal(malformed.items[0].recorded, false);
  assert.equal(malformed.items[1].buttons.recorded, false);
  assert.deepEqual(malformed.items[1].buttons.launchTeam, { matches: null, enabled: null, disabled: null, unknown: null });
  assert.equal(malformed.items[2].buttons.unknownEntries, 3);
  assert.deepEqual(malformed.items[2].buttons.launchTeam, { matches: 1, enabled: 0, disabled: 0, unknown: 1 });
  const atCap = Array.from({ length: 24 }, () => ({ text: 'Launch team', disabled: true }));
  const cap = retainedDialogProjection({ rendererFailureSnapshot: { dialogs: [{ text: 'm'.repeat(8000), buttons: atCap }] } });
  assert.equal(cap.retainedDialogs.items[0].buttons.atCaptureLimit, true);
  assert.equal(cap.retainedDialogs.items[0].buttons.overflow, false);
  assert.equal(cap.retainedDialogs.items[0].text.bounded, true);
  const buttons = [...atCap, {}];
  Object.defineProperty(buttons, '24', { get() { assert.fail('outside retained button traversal'); } });
  const dialogs = [{ text: 'm'.repeat(8001), buttons }, {}, {}, {}];
  Object.defineProperty(dialogs, '3', { get() { assert.fail('outside retained dialog traversal'); } });
  const overflow = retainedDialogProjection({ rendererFailureSnapshot: { dialogs } }).retainedDialogs;
  assert.equal(overflow.count, 4); assert.equal(overflow.items.length, 3);
  assert.equal(overflow.overflow, true); assert.equal(overflow.atCaptureLimit, false);
  assert.equal(overflow.items[0].buttons.count, 25);
  assert.equal(overflow.items[0].buttons.overflow, true);
  assert.equal(overflow.items[0].buttons.atCaptureLimit, false);
  assert.equal(overflow.items[0].buttons.launchTeam.matches, 24);
  assert.equal(overflow.items[0].text.bounded, false);
  assert.deepEqual(overflow.items[0].text.terms, []);
  const terms = 'authentication credential permission model probe runtime source profile owner grant context capture preparation provider ready loading unavailable unsupported missing mismatch changed expired stale busy blocked rejected refused failed invalid timeout timed out cancelled';
  const large = { rendererFailureSnapshot: { store: { provisioning: Array.from({ length: 8 }, () => ({
    error: terms, progress: { error: terms, message: terms },
  })) } } };
  assert.deepEqual(projectDesktopEmulatedReadinessFailure(large), { schemaVersion: 1, status: 'unavailable', reason: 'overflow' });
});

test('retained dialog projection avoids getters, aliases, mutations and private values with fixed opaque failure output', () => {
  const secret = 'TEST_PRIVATE_DIALOG_credential@example.invalid/token';
  const input = { rendererFailureSnapshot: { dialogs: [{ text: secret, id: secret, rect: { x: 999 },
    buttons: [{ text: 'Launch team', disabled: false, id: secret, rect: { x: 888 } }, { text: secret }] }] } };
  const original = JSON.stringify(input);
  Object.freeze(input.rendererFailureSnapshot.dialogs[0].buttons[0]);
  Object.freeze(input.rendererFailureSnapshot.dialogs[0].buttons);
  Object.freeze(input.rendererFailureSnapshot.dialogs[0]);
  Object.freeze(input.rendererFailureSnapshot.dialogs);
  Object.freeze(input.rendererFailureSnapshot);
  Object.freeze(input);
  const result = retainedDialogProjection(input);
  assert.doesNotMatch(JSON.stringify(result), /TEST_PRIVATE_DIALOG_|example\.invalid|token|999|888/);
  result.retainedDialogs.items[0].text.terms.push('TEST-output-only');
  assert.equal(JSON.stringify(input), original);
  let getterCalls = 0;
  const accessor = () => { getterCalls++; throw new Error(secret); };
  const button = Object.defineProperties({}, { text: { get: accessor }, disabled: { get: accessor } });
  const dialog = Object.defineProperties({ buttons: [button, Object.defineProperty({ text: 'Launch team' }, 'disabled', { get: accessor })] },
    { text: { get: accessor } });
  const retained = retainedDialogProjection({ rendererFailureSnapshot: { dialogs: [dialog] } });
  assert.equal(retained.retainedDialogs.items[0].buttons.unknownEntries, 1);
  assert.deepEqual(retained.retainedDialogs.items[0].buttons.launchTeam, { matches: 1, enabled: 0, disabled: 0, unknown: 1 });
  retainedDialogProjection(Object.defineProperty({}, 'rendererFailureSnapshot', { get: accessor }));
  retainedDialogProjection({ rendererFailureSnapshot: Object.defineProperty({}, 'dialogs', { get: accessor }) });
  retainedDialogProjection({ rendererFailureSnapshot: { dialogs: [Object.defineProperty({}, 'buttons', { get: accessor })] } });
  assert.equal(getterCalls, 0);
  const noOrdinaryGet = new Proxy({ rendererFailureSnapshot: { dialogs: [] } }, { get: accessor });
  assert.equal(retainedDialogProjection(noOrdinaryGet).retainedDialogs.count, 0);
  const opaque = new Proxy({}, { getOwnPropertyDescriptor: accessor });
  assert.deepEqual(projectDesktopEmulatedReadinessFailure(opaque),
    { schemaVersion: 1, status: 'unavailable', reason: 'projection-failed' });
  assert.equal(getterCalls, 1, 'only the explicit descriptor trap ran; no getter or coercion');
});

test('actual receipt summary routes all five non-PASS readiness modes and preserves PASS and unrelated summaries', () => {
  const evidence = { status: 'INCOMPLETE', rendererFailureSnapshot: { dialogs: [{ buttons: [{ text: 'Launch team', disabled: true }] }] } };
  for (const mode of ['emulated-import-ui', 'emulated-opencode-runtime-ui', 'emulated-claude-runtime-ui',
    'emulated-claude-lifecycle-ui', 'emulated-collaboration-ui']) {
    for (const status of ['INCOMPLETE', 'FAIL']) {
      const selected = { ...evidence, status };
      assert.deepEqual(projectDesktopProofReceiptSummary(selected, { receiptPath: '/TEST/receipt.json', mode, mixedMode: false }),
        { status, receipt: '/TEST/receipt.json', emulatedReadinessFailure: projectDesktopEmulatedReadinessFailure(selected) });
    }
    assert.deepEqual(projectDesktopProofReceiptSummary({ ...evidence, status: 'PASS' },
      { receiptPath: '/TEST/receipt.json', mode, mixedMode: false }), { status: 'PASS', receipt: '/TEST/receipt.json' });
  }
  for (const mode of ['team-ui', 'emulated-extensions-ui']) {
    assert.deepEqual(projectDesktopProofReceiptSummary(evidence, { receiptPath: '/TEST/receipt.json', mode, mixedMode: false }),
      { status: 'INCOMPLETE', receipt: '/TEST/receipt.json' });
  }
});

test('actual packaged final summary composes the same failure projection without executing its CLI main', () => {
  const source = fs.readFileSync(new URL('./desktop-packaged-relaunch-smoke.ts', import.meta.url), 'utf8');
  const start = '    console.log(JSON.stringify({ kind: evidence.kind, status: evidence.status, receipt: receiptPath, root: fixture.root,';
  const end = '\n  }\n  if (originalFailure) throw originalFailure;';
  assert.equal(source.split(start).length, 2);
  assert.equal(source.split(end).length, 2);
  const from = source.indexOf(start), until = source.indexOf(end, from);
  assert.ok(until > from);
  const fragment = source.slice(from, until);
  assert.ok(source.lastIndexOf('await writeFile(receiptPath,', from) < from);
  assert.ok(source.lastIndexOf('await writeFile(receiptPath,', from) >= 0);
  assert.match(source.slice(until), /if \(originalFailure\) throw originalFailure;[\s\S]*assert\.equal\(evidence\.status, 'PASS'/);
  const compose = new Function('evidence', 'receiptPath', 'fixture', 'projectDesktopEmulatedReadinessFailure', 'console', fragment);
  for (const status of ['PASS', 'INCOMPLETE', 'FAIL']) {
    const evidence = { kind: 'TEST_PACKAGED_RELAUNCH', status,
      rendererFailureSnapshot: { dialogs: [{ text: 'model unavailable', buttons: [{ text: 'Launch team', disabled: true }] }] } };
    const before = JSON.stringify(evidence), output: string[] = [];
    compose(evidence, '/TEST/receipt.json', { root: '/TEST/root' }, projectDesktopEmulatedReadinessFailure,
      { log(value: string) { output.push(value); } });
    assert.equal(output.length, 1);
    assert.deepEqual(JSON.parse(output[0]), { kind: evidence.kind, status, receipt: '/TEST/receipt.json', root: '/TEST/root',
      ...(status !== 'PASS' ? { emulatedReadinessFailure: projectDesktopEmulatedReadinessFailure(evidence) } : {}) });
    assert.equal(JSON.stringify(evidence), before);
  }
});
