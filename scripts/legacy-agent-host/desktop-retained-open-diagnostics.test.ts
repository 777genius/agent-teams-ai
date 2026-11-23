import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import {
  LEGACY_STOPPED_SOURCE_DIAGNOSTIC_BOUNDARIES,
  LEGACY_STOPPED_OWNER_FACT_NAMES,
} from '../../src/features/agent-backend/main/infrastructure/stopped-import/retainedLegacyOpenDiagnosticContract.ts';
import {
  projectRetainedDonorLaunchAuthority,
  projectRetainedOpenDiagnostics,
  readRetainedOpenDiagnostic,
  type RetainedOpenDiagnosticBinding,
  type RetainedOpenDiagnosticFiles,
} from './desktop-retained-open-diagnostics.ts';
import { bounded } from './desktop-proof-bounds.ts';
import { retainedOpenCodeLaunchExpression, RETAINED_OPENCODE_LAUNCH_TIMEOUT_MS } from './desktop-retained-opencode-launch.ts';

const binding: RetainedOpenDiagnosticBinding = {
  mainPid: 321, teamName: 'test-retained-opencode-v1', intentId: 'TEST-coexist-retained-original-once',
};
const operationHash = (value = binding) =>
  createHash('sha256').update(JSON.stringify(['open', value.teamName, value.intentId])).digest('hex');
const payload = (overrides: Record<string, unknown> = {}) => ({
  v: 1, mainPid: binding.mainPid, operationHash: operationHash(),
  phase: 'source-capture', category: 'unavailable', outcome: 'not-dispatched', ...overrides,
});
const envelope = (message: string, overrides: Record<string, unknown> = {}) => JSON.stringify({
  v: 1, t: '2026-11-18T10:00:00.000Z', level: 'diagnostic', process: 'main',
  namespace: 'RetainedLegacyOpen', appVersion: 'TEST-version', platform: 'linux', message, ...overrides,
}) + '\n';
const line = (overrides: Record<string, unknown> = {}) => envelope(JSON.stringify(payload(overrides)));
const observed = { status: 'observed', phase: 'source-capture', category: 'unavailable', outcome: 'not-dispatched' };
const ordinary = envelope('TEST-private-path-token-never-projected', { namespace: 'App', level: 'warn' });

test('retained open projection binds exact original Main and intent and emits only closed result fields', () => {
  const result = projectRetainedOpenDiagnostics({ main: ordinary + line(), rotated: ordinary }, binding);
  assert.deepEqual(result, observed);
  assert.deepEqual(Object.keys(result).sort(), ['category', 'outcome', 'phase', 'status']);
  assert.equal(JSON.stringify(result).includes('TEST-private'), false);
  assert.equal(JSON.stringify(result).includes(String(binding.mainPid)), false);
  assert.equal(JSON.stringify(result).includes(operationHash()), false);
});

test('retained open projection preserves the two distinct original call identities', () => {
  const second = { ...binding, intentId: 'TEST-coexist-retained-after-stop-once' };
  assert.notEqual(operationHash(second), operationHash());
  assert.deepEqual(projectRetainedOpenDiagnostics({ main: line({ operationHash: operationHash(second) }) }, second), observed);
  assert.deepEqual(projectRetainedOpenDiagnostics({ main: line() }, second),
    { status: 'diagnostic-unknown', reason: 'foreign-record' });
});

test('retained owner evidence survives the closed log projection with finite counts only', () => {
  const original = { phase: 'coordinator-admission', category: 'owner-active' };
  for (const count of [1, Number.MAX_SAFE_INTEGER, 'invalid']) {
    const ownerFacts = LEGACY_STOPPED_OWNER_FACT_NAMES.map(name => ({ name, count }));
    assert.deepEqual(projectRetainedOpenDiagnostics({ main: line({ ...original, ownerFacts }) }, binding),
      { status: 'observed', ...original, outcome: 'not-dispatched', ownerFacts });
  }
  assert.deepEqual(projectRetainedOpenDiagnostics({ main: line(original) }, binding),
    { status: 'observed', ...original, outcome: 'not-dispatched' });
});

test('retained owner evidence rejects malformed counters names duplicates and unrelated phases', () => {
  const original = { phase: 'coordinator-admission', category: 'owner-active' };
  const valid = { name: 'runtime.provisioning', count: 1 };
  const owners: unknown[] = [
    null, {}, [], [valid, valid], Array.from({ length: 35 }, () => valid),
    [{ ...valid, name: 'PRIVATE-team' }], [{ ...valid, extra: 'PRIVATE-token' }],
    ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1', 'PRIVATE-count', null, true]
      .map(count => [{ ...valid, count }]),
  ];
  for (const ownerFacts of owners)
    assert.deepEqual(projectRetainedOpenDiagnostics({ main: line({ ...original, ownerFacts }) }, binding),
      { status: 'diagnostic-unknown', reason: 'invalid-log' });
  for (const invalid of [{ phase: 'runtime-capture' }, { category: 'source-unreadable' }])
    assert.deepEqual(projectRetainedOpenDiagnostics({
      main: line({ ...original, ...invalid, ownerFacts: [valid] }),
    }, binding), { status: 'diagnostic-unknown', reason: 'invalid-log' });
});

test('retained owner evidence is read from the original durable log after cleanup', async (t) => {
  const ownerFacts = [{ name: 'lifecycle.pendingTimers', count: 2 },
    { name: 'background.initialization', count: 1 }];
  const original = { phase: 'coordinator-admission', category: 'owner-active', ownerFacts };
  const logs = await privateLogs(t, line(original));
  assert.deepEqual(await readRetainedOpenDiagnostic({ root: logs.root, binding }),
    { status: 'observed', ...original, outcome: 'not-dispatched' });
});

test('retained source boundary is finite and restricted to the original unreadable admission', () => {
  const original = { phase: 'coordinator-admission', category: 'source-unreadable' };
  for (const sourceBoundary of LEGACY_STOPPED_SOURCE_DIAGNOSTIC_BOUNDARIES) {
    assert.deepEqual(projectRetainedOpenDiagnostics({ main: line({ ...original, sourceBoundary }) }, binding),
      { status: 'observed', ...original, outcome: 'not-dispatched', sourceBoundary });
  }
  for (const value of [
    { ...original, sourceBoundary: 'TEST-private-path' },
    { ...original, sourceBoundary: null }, { ...original, sourceBoundary: 1 },
    { ...original, sourceBoundary: 'config-read', phase: 'runtime-capture' },
    { ...original, sourceBoundary: 'config-read', category: 'native-custody-unverified' },
    { ...original, sourceBoundary: 'config-read', rawError: 'TEST-private' },
  ]) {
    const result = projectRetainedOpenDiagnostics({ main: line(value) }, binding);
    assert.deepEqual(result, { status: 'diagnostic-unknown', reason: 'invalid-log' });
    assert.equal(JSON.stringify(result).includes('TEST-private'), false);
  }
});

test('retained open projection refuses foreign process hash envelope or platform instead of choosing a record', () => {
  for (const value of [
    line({ mainPid: 320 }), line({ operationHash: 'b'.repeat(64) }),
    envelope(JSON.stringify(payload()), { process: 'renderer' }),
    envelope(JSON.stringify(payload()), { platform: 'darwin' }),
    envelope(JSON.stringify(payload()), { level: 'error' }),
  ]) {
    assert.deepEqual(projectRetainedOpenDiagnostics({ main: value }, binding),
      { status: 'diagnostic-unknown', reason: 'foreign-record' });
    assert.equal(projectRetainedOpenDiagnostics({ main: value + line() }, binding).status, 'diagnostic-unknown');
  }
});

test('retained open projection refuses duplicates in one file or across rotation', () => {
  for (const input of [{ main: line() + line() }, { main: line(), rotated: line() }])
    assert.deepEqual(projectRetainedOpenDiagnostics(input, binding),
      { status: 'diagnostic-unknown', reason: 'duplicate-record' });
});

test('retained open payload is closed and cannot project raw error fields or future enum values', () => {
  const values = [
    payload({ phase: 'not-closed' }), payload({ category: 'TEST-private-token' }),
    payload({ outcome: 'published' }), payload({ mainPid: '321' }),
    payload({ operationHash: 'A'.repeat(64) }), payload({ v: 2 }),
    payload({ message: 'TEST-private-path' }), payload({ reason: 'TEST-secret' }),
    { v: 1, mainPid: 321, operationHash: operationHash(), category: 'unavailable', outcome: 'unknown' },
  ];
  for (const value of values) {
    const result = projectRetainedOpenDiagnostics({ main: envelope(JSON.stringify(value)) }, binding);
    assert.deepEqual(result, { status: 'diagnostic-unknown', reason: 'invalid-log' });
    assert.equal(JSON.stringify(result).includes('TEST-'), false);
  }
});

test('retained open projection refuses partial malformed and duplicate-key JSON without exposing bytes', () => {
  const duplicates = JSON.stringify(payload()).replace('{"v":1,', '{"v":1,"v":1,');
  for (const main of [
    line().trimEnd(), '\n', '{"TEST-private":\n', envelope('{"TEST-private":'),
    envelope(duplicates), line().replace('{"v":1,', '{"v":1,"v":1,'),
    envelope(JSON.stringify(payload()), { rawPath: 'TEST-private' }),
  ]) assert.deepEqual(projectRetainedOpenDiagnostics({ main }, binding),
    { status: 'diagnostic-unknown', reason: 'invalid-log' });
});

test('retained open log byte line and combined record limits never trim into a qualifying suffix', () => {
  const compact = envelope('', { namespace: 'App' });
  for (const input of [
    { main: 'x'.repeat(2 * 1024 * 1024 + 1) },
    { main: compact.repeat(4096), rotated: compact.repeat(4097) },
  ]) assert.deepEqual(projectRetainedOpenDiagnostics(input, binding),
    { status: 'diagnostic-unknown', reason: 'log-limit' });
  assert.deepEqual(projectRetainedOpenDiagnostics({
    main: envelope('x'.repeat(64 * 1024), { namespace: 'App' }) + line(),
  }, binding), { status: 'diagnostic-unknown', reason: 'invalid-log' });
});

test('retained open absent records and invalid bindings stay unknown with no getter or coercion calls', () => {
  let accessed = 0;
  const bad = Object.defineProperty({ ...binding }, 'intentId', { get() { accessed++; return binding.intentId; } });
  assert.deepEqual(projectRetainedOpenDiagnostics({ main: line() }, bad),
    { status: 'diagnostic-unknown', reason: 'not-correlated' });
  const coercion = { ...binding, intentId: { toString() { accessed++; return binding.intentId; } } };
  assert.deepEqual(projectRetainedOpenDiagnostics({ main: line() }, coercion as unknown as RetainedOpenDiagnosticBinding),
    { status: 'diagnostic-unknown', reason: 'not-correlated' });
  const logs = Object.defineProperty({}, 'main', { get() { accessed++; return line(); } });
  assert.deepEqual(projectRetainedOpenDiagnostics(logs as { main: string }, binding),
    { status: 'diagnostic-unknown', reason: 'invalid-log' });
  assert.equal(accessed, 0);
  assert.deepEqual(projectRetainedOpenDiagnostics({ main: ordinary }, binding),
    { status: 'diagnostic-unknown', reason: 'record-absent' });
});

async function privateLogs(t: TestContext, main: string = line()) {
  const root = await mkdtemp(join(tmpdir(), 'TEST-retained-open-diagnostic-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'userData', 'logs');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, 'app-errors.ndjson');
  await writeFile(file, main, { mode: 0o600, flag: 'wx' });
  return { root, directory, file };
}

test('retained open reader uses actual fresh private regular files and optional original rotation', {
  skip: process.platform !== 'linux',
}, async t => {
  const fixture = await privateLogs(t);
  assert.deepEqual(await readRetainedOpenDiagnostic({ root: fixture.root, binding }), observed);
  await writeFile(join(fixture.directory, 'app-errors.1.ndjson'), ordinary, { mode: 0o600, flag: 'wx' });
  assert.deepEqual(await readRetainedOpenDiagnostic({ root: fixture.root, binding }), observed);
  await writeFile(join(fixture.directory, 'app-errors.1.ndjson'), line(), { mode: 0o600 });
  assert.deepEqual(await readRetainedOpenDiagnostic({ root: fixture.root, binding }),
    { status: 'diagnostic-unknown', reason: 'duplicate-record' });
});

test('retained open reader refuses actual symlink and hardlink files without adopting their contents', {
  skip: process.platform !== 'linux',
}, async t => {
  for (const kind of ['symlink', 'hardlink'] as const) {
    const fixture = await privateLogs(t), target = join(fixture.root, 'TEST-other.ndjson');
    await writeFile(target, line(), { mode: 0o600, flag: 'wx' });
    await rm(fixture.file);
    if (kind === 'symlink') await symlink(target, fixture.file);
    else await link(target, fixture.file);
    assert.deepEqual(await readRetainedOpenDiagnostic({ root: fixture.root, binding }),
      { status: 'diagnostic-unknown', reason: 'unsafe-log' });
  }
});

test('retained open reader refuses an actual symlink directory and missing main log', {
  skip: process.platform !== 'linux',
}, async t => {
  const fixture = await privateLogs(t);
  await rm(fixture.file);
  assert.deepEqual(await readRetainedOpenDiagnostic({ root: fixture.root, binding }),
    { status: 'diagnostic-unknown', reason: 'missing-log' });
  const target = join(fixture.root, 'TEST-other-logs');
  await mkdir(target, { mode: 0o700 });
  await writeFile(join(target, 'app-errors.ndjson'), line(), { mode: 0o600, flag: 'wx' });
  await rm(fixture.directory, { recursive: true });
  await symlink(target, fixture.directory);
  assert.deepEqual(await readRetainedOpenDiagnostic({ root: fixture.root, binding }),
    { status: 'diagnostic-unknown', reason: 'unsafe-log' });
});

test('retained open reader rejects actual partial and oversized private files', {
  skip: process.platform !== 'linux',
}, async t => {
  const fixture = await privateLogs(t, line().trimEnd());
  assert.deepEqual(await readRetainedOpenDiagnostic({ root: fixture.root, binding }),
    { status: 'diagnostic-unknown', reason: 'invalid-log' });
  await writeFile(fixture.file, Buffer.alloc(2 * 1024 * 1024 + 1), { mode: 0o600 });
  assert.deepEqual(await readRetainedOpenDiagnostic({ root: fixture.root, binding }),
    { status: 'diagnostic-unknown', reason: 'log-limit' });
  await writeFile(fixture.file, Buffer.from([0xff]), { mode: 0o600 });
  assert.deepEqual(await readRetainedOpenDiagnostic({ root: fixture.root, binding }),
    { status: 'diagnostic-unknown', reason: 'unreadable-log' });
});

type Identity = Awaited<ReturnType<RetainedOpenDiagnosticFiles['named']>>;
type Fault = 'none' | 'open-replaced' | 'read-mutated' | 'short-read' | 'between-files' |
  'late-rotation' | 'parent-replaced' | 'read-error' | 'close-error';
function finiteFiles(fault: Fault = 'none') {
  const root = '/TEST-private', directories = [root, root + '/userData', root + '/userData/logs'];
  const main = directories[2] + '/app-errors.ndjson', rotated = directories[2] + '/app-errors.1.ndjson';
  const content = new Map<string, Buffer>([[main, Buffer.from(line())]]);
  if (fault === 'between-files') content.set(rotated, Buffer.from(ordinary));
  const calls: string[] = [];
  let changed = false, parentChanged = false, closes = 0, reads = 0;
  const identity = (path: string, opened = false): Identity => {
    const directory = directories.includes(path), bytes = content.get(path);
    if (!directory && !bytes) throw Object.assign(new Error('TEST private missing'), { code: 'ENOENT' });
    return {
      dev: 1n, ino: BigInt(directory ? directories.indexOf(path) + 1 : path === main ? 11 : 12) +
        (opened && fault === 'open-replaced' ? 100n : 0n) + (directory && parentChanged ? 100n : 0n),
      mode: directory ? 0o40700n : 0o100600n, nlink: directory ? 2n : 1n, uid: 1000n,
      size: BigInt(directory ? 64 : bytes!.length), mtimeNs: changed && (fault === 'read-mutated' || path === rotated) ? 2n : 1n,
      ctimeNs: 1n, isFile: () => !directory, isDirectory: () => directory, isSymbolicLink: () => false,
    };
  };
  const io: RetainedOpenDiagnosticFiles = {
    owner: () => 1000,
    canonical: async path => { calls.push('canonical'); return path; },
    named: async path => { calls.push('named'); return identity(path); },
    async open(path) {
      calls.push('open');
      return {
        stat: async () => identity(path, true),
        async read(buffer) {
          reads++; calls.push('read');
          if (fault === 'read-error') throw new Error('TEST-private-read-error');
          const bytes = content.get(path)!;
          bytes.copy(buffer);
          if (fault === 'read-mutated' || (fault === 'between-files' && path === main)) changed = true;
          if (fault === 'parent-replaced') parentChanged = true;
          if (fault === 'late-rotation') content.set(rotated, Buffer.from(ordinary));
          return fault === 'short-read' ? bytes.length - 1 : bytes.length;
        },
        async close() { closes++; calls.push('close'); if (fault === 'close-error') throw new Error('TEST-private-close-error'); },
      };
    },
  };
  return { root, io, calls, reads: () => reads, closes: () => closes };
}

test('retained open actual reader closes its bounded original handles and does not read without correlation', async () => {
  const fixture = finiteFiles();
  // The injected finite ports exercise the same reader, without any runtime/process substitution.
  assert.deepEqual(await readRetainedOpenDiagnostic({ root: fixture.root, binding }, fixture.io), observed);
  assert.equal(fixture.reads(), 1); assert.equal(fixture.closes(), 1);
  const unused = finiteFiles();
  assert.deepEqual(await readRetainedOpenDiagnostic({ root: unused.root, binding: undefined }, unused.io),
    { status: 'diagnostic-unknown', reason: 'not-correlated' });
  assert.deepEqual(unused.calls, []);
});

for (const fault of [
  'open-replaced', 'read-mutated', 'short-read', 'between-files', 'late-rotation', 'parent-replaced',
  'read-error', 'close-error',
] as const) test('retained open actual reader preserves uncertainty for ' + fault, async () => {
  const fixture = finiteFiles(fault);
  const result = await readRetainedOpenDiagnostic({ root: fixture.root, binding }, fixture.io);
  assert.equal(result.status, 'diagnostic-unknown');
  assert.equal(JSON.stringify(result).includes('TEST-private'), false);
  assert.equal(fixture.closes(), fault === 'between-files' ? 2 : 1);
  assert.ok(fixture.reads() <= (fault === 'between-files' ? 2 : 1));
  assert.equal(fixture.calls.filter(value => value === 'open').length, fixture.closes());
});

const caller = readFileSync(new URL('./desktop-retained-opencode-coexistence.native.ts', import.meta.url), 'utf8');
const finalStart = caller.indexOf('  finally {\n    if (app && legacySubmitted && !legacyStopped)');
const finalEnd = caller.indexOf('\n});', finalStart);
assert.ok(finalStart > 0 && finalEnd > finalStart, 'unique actual original cleanup boundary');
const finalBody = caller.slice(finalStart, finalEnd);

function finalCaller(options: { failure?: Error; cleanupError?: Error; diagnosticError?: boolean;
  consoleError?: boolean; saveError?: Error; correlated?: boolean; nativeDebt?: boolean } = {}) {
  const calls: string[] = [], cleanupErrors: unknown[] = [], proof: Record<string, unknown> = {};
  const primary = options.failure, lines: unknown[][] = [];
  const ports = {
    assert, app: {
      async call() { calls.push('stop'); return null; },
      async cleanup() { calls.push('app-cleanup'); return true; },
    },
    legacySubmitted: true, legacyStopped: false, legacyTeam: binding.teamName, literal: JSON.stringify,
    model: { async close() { calls.push('model-close'); if (options.cleanupError) throw options.cleanupError; } },
    natives: [{ pid: 42 }], originalLinuxProcessPresent(identity: unknown) {
      calls.push('native-absence'); assert.deepEqual(identity, { pid: 42 }); return options.nativeDebt === true;
    },
    fixture: { root: '/TEST-private' }, processBaseline: [],
    async testNamespaceLinuxProcesses() { calls.push('namespace'); return []; },
    cleanupErrors, proof, passed: !primary, failure: primary,
    retainedOpenAttempt: options.correlated === false ? undefined : binding,
    async readRetainedOpenDiagnostic(input: { root: string; binding: RetainedOpenDiagnosticBinding | undefined }) {
      calls.push('diagnostic');
      assert.equal(input.binding, options.correlated === false ? undefined : binding);
      if (options.diagnosticError) throw new Error('TEST-private-diagnostic-error');
      return input.binding ? observed : { status: 'diagnostic-unknown', reason: 'not-correlated' };
    },
    console: { error(...args: unknown[]) { calls.push('report'); lines.push(args); if (options.consoleError) throw new Error('TEST-private-sink'); } },
    async save() { calls.push('save'); if (options.saveError) throw options.saveError; },
  };
  const run = () => new Function(...Object.keys(ports),
    'return (async()=>{ let cleanup=false; try {} ' + finalBody + '\n})()')(...Object.values(ports)) as Promise<void>;
  return { run, calls, cleanupErrors, proof, lines };
}

test('actual retained final block observes only after all original cleanup and rethrows the same primary failure', async () => {
  const error = new Error('TEST-original-open-failure'), fixture = finalCaller({ failure: error });
  await assert.rejects(fixture.run(), value => value === error);
  assert.deepEqual(fixture.calls, ['stop', 'app-cleanup', 'model-close', 'native-absence', 'namespace', 'diagnostic', 'report', 'save']);
  assert.deepEqual(fixture.proof.retainedOpenDiagnostic, observed);
  assert.equal(fixture.proof.status, 'FAIL');
  assert.equal(JSON.stringify(fixture.lines).includes('operationHash'), false);
});

test('actual retained final block preserves primary plus cleanup AggregateError and original save precedence', async () => {
  const error = new Error('TEST-original'), cleanup = new Error('TEST-cleanup'), save = new Error('TEST-save');
  const combined = finalCaller({ failure: error, cleanupError: cleanup });
  await assert.rejects(combined.run(), value => value instanceof AggregateError &&
    value.message === 'coexistence and cleanup failed' && value.errors[0] === error && value.errors[1] === cleanup);
  assert.deepEqual(combined.cleanupErrors, [cleanup]);
  assert.equal(combined.proof.status, 'FAIL');
  const saved = finalCaller({ failure: error, cleanupError: cleanup, saveError: save });
  await assert.rejects(saved.run(), value => value === save);
  assert.deepEqual(saved.calls, ['stop', 'app-cleanup', 'model-close', 'native-absence', 'namespace', 'diagnostic', 'report', 'save']);
});

test('actual retained final block cannot let a closed diagnostic erase original native cleanup debt', async () => {
  const error = new Error('TEST-original'), fixture = finalCaller({ failure: error, nativeDebt: true });
  await assert.rejects(fixture.run(), value => value instanceof AggregateError &&
    value.errors[0] === error && value.errors[1] === fixture.cleanupErrors[0]);
  assert.equal(fixture.cleanupErrors.length, 1);
  assert.equal(fixture.proof.status, 'FAIL');
  assert.deepEqual(fixture.proof.retainedOpenDiagnostic, observed);
  assert.deepEqual(fixture.calls, ['stop', 'app-cleanup', 'model-close', 'native-absence', 'namespace', 'diagnostic', 'report', 'save']);
});

test('actual retained final block cannot replace original failures with reader or output exceptions', async () => {
  for (const option of [{ diagnosticError: true }, { consoleError: true }]) {
    const error = new Error('TEST-original'), fixture = finalCaller({ failure: error, ...option });
    await assert.rejects(fixture.run(), value => value === error);
    assert.deepEqual(fixture.cleanupErrors, []);
    assert.equal(fixture.calls.at(-1), 'save');
  }
});

test('actual retained final block does not diagnose success or borrow a binding for an unrelated later failure', async () => {
  const success = finalCaller();
  await success.run();
  assert.deepEqual(success.calls, ['stop', 'app-cleanup', 'model-close', 'native-absence', 'namespace', 'save']);
  assert.equal(success.proof.retainedOpenDiagnostic, undefined);
  const error = new Error('TEST-later-failure'), later = finalCaller({ failure: error, correlated: false });
  await assert.rejects(later.run(), value => value === error);
  assert.deepEqual(later.proof.retainedOpenDiagnostic, { status: 'diagnostic-unknown', reason: 'not-correlated' });
});

test('both actual retained callsites keep one original expression and clear binding only on successful await', async () => {
  for (const [intentId, name] of [
    ['TEST-coexist-retained-original-once', 'retainedLaunch'],
    ['TEST-coexist-retained-after-stop-once', 'relaunched'],
  ]) {
    const marker = "    retainedOpenAttempt = { mainPid: app.electron.pid, teamName: legacyTeam, intentId: '" + intentId + "' };";
    const start = caller.indexOf(marker), end = caller.indexOf('    assert.equal(typeof ' + name + '.runId', start);
    assert.ok(start > 0 && end > start && caller.indexOf(marker, start + 1) === -1);
    const body = caller.slice(start, end), error = new Error('TEST-original-call');
    for (const rejected of [false, true]) {
      const calls: [string, number][] = [];
      const app = { electron: { pid: 321 }, async call(expression: string, timeout: number) {
        calls.push([expression, timeout]); if (rejected) throw error; return { runId: 'TEST-run' };
      } };
      const run = new Function('app', 'legacyTeam', 'legacyProject', 'retainedOpenCodeLaunchExpression',
        'RETAINED_OPENCODE_LAUNCH_TIMEOUT_MS',
        'return (async()=>{let retainedOpenAttempt;try{' + body +
        '}catch(error){return {binding:retainedOpenAttempt,error}}return {binding:retainedOpenAttempt}})()');
      const result = await run(app, binding.teamName, '/TEST-project', retainedOpenCodeLaunchExpression,
        RETAINED_OPENCODE_LAUNCH_TIMEOUT_MS) as { binding?: RetainedOpenDiagnosticBinding; error?: unknown };
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0], [retainedOpenCodeLaunchExpression({ intentId: intentId!, request: {
        teamName: binding.teamName, cwd: '/TEST-project', providerId: 'opencode', model: 'test-legacy/TEST-model',
        skipPermissions: true, runtimeSelectionVersion: 1,
      } }), 240_000]);
      assert.deepEqual(result.binding, rejected ? { ...binding, intentId } : undefined);
      assert.equal(result.error, rejected ? error : undefined);
    }
  }
});

type Row = Record<string, unknown>;
const donorBlockerId = 'create-team-launch-authority-blocker';
function donorNotice() {
  const provider: Row = { providerId: 'opencode', supported: true, authenticated: false,
    verificationState: 'error', statusCheckOutcome: 'transient_error', statusCheckErrorCode: 'runtime_missing',
    modelVerificationState: 'verified', modelCatalogRefreshState: 'error',
    capabilities: { teamLaunch: false, oneShot: true },
    runtimeCapabilities: { modelCatalog: { dynamic: true, source: 'app-server' } },
    modelCatalog: { schemaVersion: 1, providerId: 'opencode', source: 'app-server', status: 'degraded',
      fetchedAt: '2026-11-23T02:17:03.299Z', staleAt: '2026-11-23T02:22:03.299Z',
      models: [{ id: 'SECRET-model', launchModel: 'SECRET-route' }], defaultModelId: 'SECRET-model',
      diagnostics: { configReadState: 'ready', appServerState: 'runtime-missing',
        code: 'SECRET-diagnostic-code', message: 'SECRET-diagnostic-message' } },
    authMethod: 'SECRET-auth', statusMessage: 'SECRET-status', detailMessage: 'SECRET-detail',
    backend: { endpointLabel: 'SECRET-endpoint', projectId: 'SECRET-project' }, catalogScope: 'SECRET-scope' };
  const blocker: Row = { providerId: 'opencode', providerStatus: provider, detail: 'SECRET-blocker-detail' };
  const props: Row = { id: donorBlockerId, action: 'SECRET-action', blockers: [blocker],
    onOpenProviderSettings() { throw new Error('callback must not execute'); } };
  const root: Row = { tag: 3, return: null, stateNode: {} };
  (root.stateNode as Row).current = root;
  const notice: Row = { memoizedProps: props, return: root };
  const node: Row = {};
  const host: Row = { stateNode: node, memoizedProps: { id: donorBlockerId }, return: notice, alternate: null };
  node.__reactFiber$TEST = host;
  const nodes: unknown[] = [node];
  const page = { querySelectorAll(selector: string) {
    assert.equal(selector, '[id="' + donorBlockerId + '"]'); return nodes;
  } } as unknown as Pick<Element, 'querySelectorAll'>;
  return { provider, blocker, props, root, notice, node, host, nodes, page };
}
// Exercise the serialized renderer function, not a separate test-side projection.
const browserProjection = new Function('return (' + projectRetainedDonorLaunchAuthority.toString() + ')')() as
  typeof projectRetainedDonorLaunchAuthority;
const firstProvider = (result: Row): Row => ((result.blockers as Row[])[0]!.providerStatus as Row);

test('donor-shaped rendered notice projects only closed status and catalog facts without private text', () => {
  const fixture = donorNotice(), result = browserProjection(fixture.page), provider = firstProvider(result);
  assert.equal(result.status, 'observed'); assert.equal(result.source, 'rendered-blocker-props');
  assert.equal((result.blockers as Row[])[0]!.providerLoading, null, 'missing prop never reads the store fallback');
  assert.equal(provider.supported, true); assert.equal(provider.authenticated, false);
  assert.equal(provider.statusCheckOutcome, 'transient_error'); assert.equal(provider.statusCheckErrorCode, 'runtime_missing');
  assert.equal(provider.modelVerificationState, 'verified'); assert.equal(provider.modelCatalogRefreshState, 'error');
  assert.deepEqual(provider.capabilities, { teamLaunch: false, oneShot: true });
  assert.deepEqual(provider.runtimeModelCatalog, { dynamic: true, source: 'app-server' });
  assert.deepEqual(provider.modelCatalog, { presence: 'present', schemaVersion: 1, providerId: 'opencode',
    source: 'app-server', status: 'degraded', fetchedAt: '2026-11-23T02:17:03.299Z', staleAt: '2026-11-23T02:22:03.299Z',
    modelCount: 1, diagnostics: { configReadState: 'ready', appServerState: 'runtime-missing' } });
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 2048);
});

test('donor projection selects the committed alternate and refuses ambiguous or unmounted fibers', () => {
  const old = donorNotice(), current = donorNotice();
  current.host.stateNode = old.node;
  old.host.alternate = current.host;
  old.root.stateNode = current.root.stateNode;
  current.provider.statusCheckErrorCode = 'partial_response';
  assert.equal(firstProvider(browserProjection(old.page)).statusCheckErrorCode, 'partial_response');
  old.root.stateNode = { current: old.root };
  assert.deepEqual(browserProjection(old.page), { status: 'diagnostic-unknown', reason: 'ambiguous-current-fiber' });
  old.host.alternate = null; old.root.stateNode = {};
  assert.deepEqual(browserProjection(old.page), { status: 'diagnostic-unknown', reason: 'current-fiber-unavailable' });
});

test('donor projection never invokes getters and treats absent or malformed authority as unknown', () => {
  const fixture = donorNotice(); let reads = 0;
  const getter = { get() { reads++; throw new Error('SECRET-getter'); }, configurable: true };
  for (const name of ['supported', 'capabilities', 'detailMessage', 'authMethod'])
    Object.defineProperty(fixture.provider, name, getter);
  Object.defineProperty(fixture.blocker, 'detail', getter);
  fixture.props.providerLoading = { opencode: true };
  fixture.provider.statusCheckOutcome = 'SECRET-invalid-outcome';
  fixture.provider.statusCheckErrorCode = 'SECRET-invalid-code';
  (fixture.provider.modelCatalog as Row).fetchedAt = 'SECRET'.repeat(10000);
  (fixture.provider.modelCatalog as Row).models = new Array(16385);
  const result = browserProjection(fixture.page), projected = firstProvider(result);
  assert.equal(reads, 0); assert.equal(projected.supported, null);
  assert.deepEqual(projected.capabilities, { teamLaunch: null, oneShot: null });
  assert.equal(projected.statusCheckOutcome, null); assert.equal(projected.statusCheckErrorCode, null);
  assert.equal((projected.modelCatalog as Row).fetchedAt, null);
  assert.equal((projected.modelCatalog as Row).modelCount, null);
  assert.equal((result.blockers as Row[])[0]!.providerLoading, true);
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
  Object.defineProperty(fixture.props, 'blockers', getter);
  assert.deepEqual(browserProjection(fixture.page), { status: 'diagnostic-unknown', reason: 'invalid-blockers' });
  assert.equal(reads, 0);
  for (const missing of [undefined, null, 'SECRET-status']) {
    const absent = donorNotice(); absent.blocker.providerStatus = missing;
    const status = firstProvider(browserProjection(absent.page));
    assert.equal(status.presence, missing === undefined ? 'missing' : missing === null ? 'null' : 'invalid');
    assert.equal(status.authenticated, null); assert.equal(JSON.stringify(status).includes('SECRET'), false);
  }
});

test('donor projection is bounded and refuses missing duplicate foreign or cyclic evidence', () => {
  for (const mutate of [
    (f: ReturnType<typeof donorNotice>) => { f.nodes.length = 0; },
    (f: ReturnType<typeof donorNotice>) => { f.nodes.push(f.node); },
    (f: ReturnType<typeof donorNotice>) => { delete f.node.__reactFiber$TEST; },
    (f: ReturnType<typeof donorNotice>) => { f.props.id = 'unrelated-notice'; },
    (f: ReturnType<typeof donorNotice>) => { f.props.blockers = [f.blocker, f.blocker]; },
    (f: ReturnType<typeof donorNotice>) => { f.props.blockers = new Array(4); },
    (f: ReturnType<typeof donorNotice>) => { f.provider.providerId = 'codex'; },
    (f: ReturnType<typeof donorNotice>) => { f.blocker.providerId = 'SECRET-provider'; },
    (f: ReturnType<typeof donorNotice>) => { f.notice.return = f.host; },
    (f: ReturnType<typeof donorNotice>) => {
      let parent: unknown = f.root;
      for (let depth = 0; depth < 64; depth++) parent = { return: parent };
      f.notice.return = parent;
    },
    (f: ReturnType<typeof donorNotice>) => {
      for (let index = 0; index < 128; index++) f.node['extra' + index] = null;
    },
  ]) {
    const fixture = donorNotice(); mutate(fixture);
    const result = browserProjection(fixture.page);
    assert.equal(result.status, 'diagnostic-unknown'); assert.equal(result.blockers, undefined);
    assert.equal(JSON.stringify(result).includes('SECRET'), false);
  }
});

const donorAppSource = readFileSync(new URL('./desktop-retained-opencode-app.ts', import.meta.url), 'utf8');
const captureStart = donorAppSource.indexOf('export async function captureRetainedDonorUiFailure(');
const captureEnd = donorAppSource.indexOf('\n/** The same native reader', captureStart);
assert.ok(captureStart > 0 && captureEnd > captureStart);
const captureSource = stripTypeScriptTypes(donorAppSource.slice(captureStart, captureEnd).replace(/^export /u, ''));
function actualDonorCapture(fixture = donorNotice()) {
  const events: string[] = [], budgets: [number, string][] = [], writes: unknown[][] = [];
  const page = { querySelector: () => null, querySelectorAll: (selector: string) =>
    selector === '[id="' + donorBlockerId + '"]' ? fixture.nodes : [] };
  const document = { readyState: 'complete', querySelectorAll(selector: string) {
    assert.equal(selector, '[data-testid="create-team-page"]'); return [page];
  } };
  const app = { original: { pid: 321, birth: '123' }, electron: { pid: 322, birth: '124' },
    assertCurrent() { events.push('owner'); },
    cdp: { async evaluate(expression: string) {
      events.push('evaluate');
      return new Function('document', 'HTMLElement', 'HTMLInputElement', 'return ' + expression)(document, class {}, class {});
    }, async send(method: string, params: unknown) {
      events.push('screenshot'); assert.equal(method, 'Page.captureScreenshot');
      assert.deepEqual(params, { format: 'png', fromSurface: true });
      return { data: Buffer.from('TEST-png').toString('base64') };
    } }, async cleanup() { events.push('cleanup'); return true; } };
  const ports = { assert, Buffer, join, createHash, projectRetainedDonorLaunchAuthority,
    async bounded<T>(promise: Promise<T>, ms: number, label: string) {
      budgets.push([ms, label]); return bounded(promise, ms, label);
    }, async writeFile(...args: unknown[]) { events.push('write'); writes.push(args); } };
  const bindCapture = new Function(...Object.keys(ports), captureSource + ';return captureRetainedDonorUiFailure;');
  const capture = bindCapture(...Object.values(ports)) as (app: unknown, root: string, epoch: Row) => Promise<Row>;
  return { app, capture, events, budgets, writes };
}

test('actual donor capture adds rendered props inside the one original bounded evaluation', async () => {
  const fixture = actualDonorCapture();
  const result = await fixture.capture(fixture.app, '/TEST-root', { kind: 'donor', sourceCommit: '4a0e06277fe216d9f82dbbede362668fe46622ee' });
  const form = result.form as Row;
  assert.equal(result.status, 'INCOMPLETE'); assert.equal(result.atomicWithFailure, false);
  assert.equal(result.observation, 'after-original-failure-before-cleanup');
  assert.equal(result.original, fixture.app.original); assert.equal(result.electron, fixture.app.electron);
  assert.equal(firstProvider(form.launchAuthority as Row).statusCheckErrorCode, 'runtime_missing');
  assert.deepEqual(fixture.budgets, [[4000, 'read retained donor failure form'], [5000, 'retained donor failure screenshot']]);
  assert.deepEqual(fixture.events, ['owner', 'evaluate', 'owner', 'owner', 'screenshot', 'owner', 'write']);
  assert.equal(fixture.writes.length, 1);
  assert.deepEqual(fixture.writes[0], ['/TEST-root/donor-history-failure.png', Buffer.from('TEST-png'), { mode: 0o600, flag: 'wx' }]);
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
});

const donorFailureStart = donorAppSource.indexOf('catch (error) {\n    failure = error;',
  donorAppSource.indexOf('export async function exerciseRetainedDonorHistory('));
const donorFailureEnd = donorAppSource.lastIndexOf('\n}');
assert.ok(donorFailureStart > 0 && donorFailureEnd > donorFailureStart);
const donorFailureBody = donorAppSource.slice(donorFailureStart, donorFailureEnd);
test('actual donor failure captures once before cleanup and preserves the same failure even if capture throws', async () => {
  for (const diagnosticThrows of [false, true]) {
    const fixture = actualDonorCapture(), original = new Error('TEST-original-Create-blocked');
    const proof: Row = {}, input = { cleanupErrors: [] as unknown[], baseline: [] };
    const ports = { assert, app: fixture.app, root: '/TEST-root', proof, input, epochs: [{ kind: 'donor' }],
      processes: [], inferenceAtDonorQuit: undefined,
      async attempt() { fixture.events.push('attempt'); throw original; },
      async captureRetainedDonorUiFailure(...args: Parameters<typeof fixture.capture>) {
        fixture.events.push('capture'); if (diagnosticThrows) throw new Error('TEST-capture');
        return fixture.capture(...args);
      }, originalLinuxProcessPresent() { throw new Error('unexpected process observation'); },
      async testNamespaceLinuxProcesses() { fixture.events.push('namespace'); return []; } };
    const run = new Function(...Object.keys(ports),
      'return (async()=>{let failure;try{await attempt();}' + donorFailureBody + '})()');
    await assert.rejects(run(...Object.values(ports)), error => error === original);
    assert.deepEqual(fixture.events.slice(0, 2), ['attempt', 'capture']);
    assert.deepEqual(fixture.events.slice(-2), ['cleanup', 'namespace']);
    assert.equal(fixture.events.filter(value => value === 'capture').length, 1);
    assert.equal(fixture.events.filter(value => value === 'evaluate').length, diagnosticThrows ? 0 : 1);
    assert.deepEqual(input.cleanupErrors, []); assert.equal(proof.inferenceAtDonorQuit, null);
  }
});
