import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants, readFileSync } from 'node:fs';
import { link, lstat, mkdir, mkdtemp, open, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { readRetainedOpenDiagnostic } from './desktop-retained-product-record-diagnostics.ts';
import type { RetainedOpenDiagnosticFiles } from './desktop-retained-open-diagnostics.ts';

const binding = { mainPid: 321, teamName: 'test-retained-opencode-v1', intentId: 'TEST-coexist-retained-original-once' };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const observed = { status: 'observed', phase: 'coordinator-admission', category: 'source-unreadable',
  outcome: 'not-dispatched', sourceBoundary: 'product-records' };
const line = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  v: 1, t: '2026-11-20T18:00:00.000Z', level: 'diagnostic', process: 'main',
  namespace: 'RetainedLegacyOpen', appVersion: 'TEST', platform: 'linux',
  message: JSON.stringify({ v: 1, mainPid: binding.mainPid,
    operationHash: hash(JSON.stringify(['open', binding.teamName, binding.intentId])),
    phase: observed.phase, category: observed.category, outcome: observed.outcome,
    sourceBoundary: observed.sourceBoundary, ...overrides }),
}) + '\n';
const linux = { skip: process.platform !== 'linux' };
const record = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
};
const summary = (value: unknown) => record(record(value).productRecordShapes);

async function fixture(t: TestContext, log = line()) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-retained-record-shape-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const team = join(root, 'claude', 'teams', binding.teamName), logs = join(root, 'userData', 'logs');
  await mkdir(team, { recursive: true, mode: 0o700 });
  await mkdir(logs, { recursive: true, mode: 0o700 });
  await writeFile(join(logs, 'app-errors.ndjson'), log, { mode: 0o600 });
  for (const [name, value] of Object.entries({
    'config.json': { name: 'TEST_PRIVATE_TEAM', members: [{ name: 'TEST_PRIVATE_MEMBER', sessionHistory: [] }] },
    'team.meta.json': { version: 1, cwd: '/TEST_PRIVATE_PATH', prompt: 'TEST_PRIVATE_MESSAGE',
      launchIdentity: { providerId: 'TEST_PRIVATE_PROVIDER', TEST_PRIVATE_KEY: 'TEST_PRIVATE_SECRET' } },
    'members.meta.json': { version: 1, members: [{ name: 'TEST_PRIVATE_MEMBER', isActive: false }] },
  })) await writeFile(join(team, name), JSON.stringify(value), { mode: 0o600 });
  const calls: { operation: string; path: string }[] = [];
  const io: RetainedOpenDiagnosticFiles = {
    owner: () => process.getuid?.(),
    async canonical(path) { calls.push({ operation: 'canonical', path }); return realpath(path); },
    async named(path) { calls.push({ operation: 'named', path }); return lstat(path, { bigint: true }); },
    async open(path) {
      calls.push({ operation: 'open', path });
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      return {
        stat: () => handle.stat({ bigint: true }),
        async read(buffer) { calls.push({ operation: 'read', path }); return (await handle.read(buffer, 0, buffer.length, 0)).bytesRead; },
        async close() { calls.push({ operation: 'close', path }); await handle.close(); },
      };
    },
  };
  return { root, team, io, calls, input: { root, binding } };
}

test('retained failure reads only three fixed product files and projects structural data without values', linux, async t => {
  t.diagnostic(JSON.stringify({ node: process.version, execArgv: process.execArgv, nodeOptionsPresent: process.env.NODE_OPTIONS !== undefined }));
  const f = await fixture(t), result = await readRetainedOpenDiagnostic(f.input, f.io);
  const value = summary(result), text = JSON.stringify(value);
  assert.equal(value.status, 'observed');
  assert.equal(value.observation, 'after-original-cleanup');
  assert.equal(value.failureSnapshot, false);
  assert.equal(value.truncated, false);
  assert.deepEqual((value.records as unknown[]).map(item => record(item).file), ['config.json', 'team.meta.json', 'members.meta.json']);
  assert.match(text, /"key":"sessionHistory"/);
  assert.match(text, /"type":"array","length":0/);
  assert.match(text, /"key":"isActive","shape":\{"type":"boolean"\}/);
  assert.equal(text.includes('TEST_PRIVATE'), false);
  assert.equal(text.includes(f.root), false);
  assert.equal(text.includes(hash('TEST_PRIVATE_KEY')), true);
  assert.equal(text.includes('"keyLength":16'), true);
  assert.equal(Buffer.byteLength(JSON.stringify(result)) <= 64 * 1024, true);
  assert.deepEqual(f.calls.filter(v => v.operation === 'read').map(v => v.path), [
    join(f.root, 'userData', 'logs', 'app-errors.ndjson'),
    ...['config.json', 'team.meta.json', 'members.meta.json'].map(name => join(f.team, name)),
  ]);
  assert.equal(f.calls.filter(v => v.operation === 'open').length, f.calls.filter(v => v.operation === 'close').length);
});

test('other refusal boundaries or uncorrelated logs do not inspect any product path', linux, async t => {
  for (const overrides of [{ sourceBoundary: 'saved-settings' }, { sourceBoundary: undefined, category: 'held' }]) {
    const f = await fixture(t, line(overrides));
    const result = await readRetainedOpenDiagnostic(f.input, f.io);
    assert.equal('productRecordShapes' in result, false);
    assert.equal(f.calls.some(v => v.path.includes('/claude')), false);
  }
  const f = await fixture(t);
  assert.deepEqual(await readRetainedOpenDiagnostic({ root: f.root, binding: undefined }, f.io),
    { status: 'diagnostic-unknown', reason: 'not-correlated' });
  assert.equal(f.calls.length, 0);
});

test('large arrays, deep nesting and many keys remain bounded and explicitly truncated', linux, async t => {
  const f = await fixture(t);
  let deep: unknown = { prompt: 'TEST_PRIVATE_DEEP' };
  for (let i = 0; i < 20; i++) deep = { launchIdentity: deep };
  await writeFile(join(f.team, 'config.json'), JSON.stringify({ members: Array.from({ length: 1000 }, () => deep) }));
  await writeFile(join(f.team, 'team.meta.json'), JSON.stringify(Object.fromEntries(
    Array.from({ length: 200 }, (_, i) => [`TEST_PRIVATE_KEY_${i}`, 'TEST_PRIVATE_VALUE'])
  )));
  const result = await readRetainedOpenDiagnostic(f.input, f.io), value = summary(result);
  assert.equal(value.status, 'observed'); assert.equal(value.truncated, true);
  const text = JSON.stringify(result);
  assert.equal(text.includes('TEST_PRIVATE'), false);
  assert.equal(Buffer.byteLength(text) <= 64 * 1024, true);
  assert.ok(Number(value.nodes) <= 512);
});

test('missing product record is reported without inventing an empty record or skipping the other files', linux, async t => {
  const f = await fixture(t); await rm(join(f.team, 'config.json'));
  const value = summary(await readRetainedOpenDiagnostic(f.input, f.io));
  const rows = value.records as unknown[];
  assert.deepEqual(rows[0], { file: 'config.json', status: 'missing' });
  assert.equal(record(rows[1]).status, 'observed'); assert.equal(record(rows[2]).status, 'observed');
});

for (const kind of ['symlink', 'hardlink', 'directory'] as const) test(`unsafe ${kind} record is never read`, linux, async t => {
  const f = await fixture(t), path = join(f.team, 'config.json'), foreign = join(f.root, 'TEST_PRIVATE_FOREIGN');
  await writeFile(foreign, '{"secret":"TEST_PRIVATE_SECRET"}'); await rm(path);
  if (kind === 'symlink') await symlink(foreign, path);
  else if (kind === 'hardlink') await link(foreign, path);
  else await mkdir(path);
  const value = summary(await readRetainedOpenDiagnostic(f.input, f.io));
  assert.equal(value.status, 'diagnostic-unknown'); assert.equal(value.reason, 'unsafe-records');
  assert.equal(f.calls.some(v => v.operation === 'open' && v.path === path), false);
  assert.equal(JSON.stringify(value).includes('TEST_PRIVATE'), false);
});

test('oversized or malformed bytes yield only a bounded fixed diagnostic reason', linux, async t => {
  for (const [bytes, reason] of [[Buffer.alloc(1024 * 1024 + 1), 'record-limit'],
    [Buffer.from('{"TEST_PRIVATE_SECRET":'), 'invalid-records'], [Buffer.from([0xff]), 'invalid-records']] as const) {
    const f = await fixture(t), path = join(f.team, 'config.json'); await writeFile(path, bytes);
    const value = summary(await readRetainedOpenDiagnostic(f.input, f.io));
    assert.equal(value.status, 'diagnostic-unknown'); assert.equal(value.reason, reason);
    assert.equal(JSON.stringify(value).includes('TEST_PRIVATE'), false);
    if (reason === 'record-limit') assert.equal(f.calls.some(v => v.operation === 'open' && v.path === path), false);
  }
});

for (const fault of ['read-error', 'changed-after-read', 'close-error'] as const)
  test(`record ${fault} stays diagnostic and closes the original descriptor`, linux, async t => {
    const f = await fixture(t), originalOpen = f.io.open;
    f.io.open = async path => {
      const handle = await originalOpen(path);
      if (path !== join(f.team, 'config.json')) return handle;
      return { stat: handle.stat, async read(buffer) {
        if (fault === 'read-error') throw new Error('TEST_PRIVATE_READ_ERROR');
        const bytes = await handle.read(buffer);
        if (fault === 'changed-after-read') await writeFile(path, '{"TEST_PRIVATE_CHANGED":true}');
        return bytes;
      }, async close() { await handle.close(); if (fault === 'close-error') throw new Error('TEST_PRIVATE_CLOSE_ERROR'); } };
    };
    const result = await readRetainedOpenDiagnostic(f.input, f.io), value = summary(result);
    assert.equal(value.status, 'diagnostic-unknown');
    assert.equal(value.reason, fault === 'changed-after-read' ? 'changed-records' : 'unreadable-records');
    assert.equal(JSON.stringify(result).includes('TEST_PRIVATE'), false);
    assert.equal(f.calls.filter(v => v.operation === 'open').length, f.calls.filter(v => v.operation === 'close').length);
    assert.equal(record(result).category, 'source-unreadable');
  });

test('native caller uses the failure-only wrapper without extending its original final block', () => {
  const caller = readFileSync(new URL('./desktop-retained-opencode-coexistence.native.ts', import.meta.url), 'utf8');
  assert.equal(caller.includes("from './desktop-retained-product-record-diagnostics.ts'"), true);
  assert.equal(caller.split('await readRetainedOpenDiagnostic(').length - 1, 1);
  const block = caller.slice(caller.indexOf('  finally {\n    if (app && legacySubmitted && !legacyStopped)'));
  assert.ok(block.indexOf('readRetainedOpenDiagnostic') > block.indexOf('cleanup = cleanupErrors.length === 0'));
  assert.ok(block.indexOf('readRetainedOpenDiagnostic') > block.indexOf("if (failure) {"));
});
