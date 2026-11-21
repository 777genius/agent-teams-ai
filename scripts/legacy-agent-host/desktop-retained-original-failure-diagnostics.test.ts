import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import fs, { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { captureRetainedOriginalFailureDiagnostics as capture, RETAINED_ORIGINAL_FAILURE_LIMITS as limits,
  type RetainedOriginalFailureDiagnostics } from './desktop-retained-original-failure-diagnostics.ts';

type Row = Record<string, unknown>;
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const encode = (value: unknown) => JSON.stringify(value);
const emptyReplica = { schemaVersion: 1, state: 'clean', updatedAt: '2026-11-20T22:00:00.000Z',
  snapshot: { statuses: [], reportIntents: [], outboxItems: [], metricEvents: [], filesToArchive: [] } };
async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-desktop-backend-')));
  const team = join(root, 'claude/teams/test-retained-original');
  await mkdir(team, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  const write = async (path: string, value: string | Buffer) => {
    const target = join(team, path);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, value, { mode: 0o600 });
  };
  return { root, team, write };
}
function file(result: RetainedOriginalFailureDiagnostics, path: string) {
  const found = result.files.find(entry => entry.path === path); assert.ok(found, path); return found;
}
function value(result: RetainedOriginalFailureDiagnostics, path: string): Row {
  return (file(result, path).payload as Row).value as Row;
}

test('failure snapshot retains exact TEST product bytes, paths, hashes and clean-empty WorkSync shape without writes', async t => {
  const f = await fixture(t);
  const config = encode({ name: 'test-retained-original', _backupIdentityId: 'TEST-incarnation',
    members: [{ name: 'team-lead', agentType: 'team-lead', sessionId: 'TEST-session' }] });
  const launch = encode({ version: 2, publicationRunId: 'TEST-run', leadSessionId: 'TEST-session', expectedMembers: [] });
  const replica = encode(emptyReplica);
  await f.write('config.json', config); await f.write('launch-state.json', launch);
  await f.write('.member-work-sync/sqlite-fallback-replica.json', replica);
  const result = await capture(f.root);
  assert.equal(result.status, 'captured'); assert.equal(result.teamName, 'test-retained-original');
  for (const [path, bytes] of [['config.json', config], ['launch-state.json', launch],
    ['.member-work-sync/sqlite-fallback-replica.json', replica]] as const) {
    const row = file(result, path);
    assert.equal(row.status, 'observed'); assert.equal(row.originalPath, join(f.team, path));
    assert.equal(row.sha256, hash(bytes)); assert.equal(row.bytesRead, Buffer.byteLength(bytes));
    assert.equal(row.identity?.kind, 'file'); assert.equal(row.identity?.nlink, '1');
    assert.equal(await readFile(join(f.team, path), 'utf8'), bytes);
  }
  assert.deepEqual(file(result, 'config.json').payload, { encoding: 'utf8', text: config });
  assert.deepEqual(value(result, '.member-work-sync/sqlite-fallback-replica.json'), emptyReplica);
  assert.equal(file(result, '.member-work-sync/report-token-secret.json').status, 'absent');
  assert.equal(file(result, 'launch-stopped.json').status, 'absent');
  assert.equal(result.directories.find(row => row.path === 'members')?.status, 'absent');
  assert.equal(result.totalReadBytes, Buffer.byteLength(config + launch + replica));
});

test('WorkSync secret and report tokens are never emitted, while mismatched identities and unknown field types remain visible', async t => {
  const f = await fixture(t), secret = 'TEST_SECRET_NEVER_EMITTED_' + 's'.repeat(40);
  const reportToken = 'TEST_REPORT_TOKEN_NEVER_EMITTED', unknown = 'TEST_UNKNOWN_PRIVATE_NEVER_EMITTED';
  await f.write('config.json', encode({ _backupIdentityId: 'TEST-original-marker' }));
  const token = { schemaVersion: 2, teamName: 'test-retained-original', incarnation: 'TEST-foreign-marker', secret };
  await f.write('.member-work-sync/report-token-secret.json', encode(token));
  const replica = { ...emptyReplica, incarnation: 'TEST-other-marker', snapshot: { ...emptyReplica.snapshot,
    statuses: [{ teamName: 'test-retained-original', memberName: 'team-lead', state: 'inactive',
      reportToken, reportTokenExpiresAt: '2026-11-20T22:02:00.000Z', unknownField: unknown }] } };
  await f.write('.member-work-sync/sqlite-fallback-replica.json', encode(replica));
  const journal = { schemaVersion: 1, teamName: 'test-retained-original', memberName: 'team-lead',
    source: 'reconciler', event: 'team_inactive', extraCredential: secret };
  await f.write('members/team-lead/.member-work-sync/journal.jsonl', encode(journal) + '\n');
  const result = await capture(f.root), serialized = encode(result);
  for (const privateValue of [secret, reportToken, unknown]) assert.equal(serialized.includes(privateValue), false);
  const tokenValue = value(result, '.member-work-sync/report-token-secret.json');
  assert.equal(tokenValue.incarnation, 'TEST-foreign-marker');
  assert.deepEqual(tokenValue.secret, { redacted: 'secret', type: 'string', length: secret.length, sha256: hash(secret) });
  assert.equal(file(result, '.member-work-sync/report-token-secret.json').sha256, hash(encode(token)));
  const status = ((value(result, '.member-work-sync/sqlite-fallback-replica.json').snapshot as Row).statuses as Row[])[0]!;
  assert.equal(status.reportTokenExpiresAt, '2026-11-20T22:02:00.000Z');
  assert.deepEqual(status.reportToken, { redacted: 'secret', type: 'string', length: reportToken.length, sha256: hash(reportToken) });
  assert.equal((status.unknownField as Row).redacted, 'unrecognized-field');
  assert.equal((file(result, 'members/team-lead/.member-work-sync/journal.jsonl').payload as Row).finalNewline, true);
});

test('malformed WorkSync JSON and UTF8 remain raw-hash-only evidence; partial journal lines are explicit', async t => {
  const f = await fixture(t), malformed = '{"secret":"TEST_PRIVATE_BROKEN_JSON"';
  await f.write('.member-work-sync/report-token-secret.json', malformed);
  await f.write('.member-work-sync/sqlite-fallback-replica.json', Buffer.from([0xff, 0xfe]));
  await f.write('members/team-lead/.member-work-sync/journal.jsonl', '{"event":"team_inactive"}');
  const result = await capture(f.root);
  assert.equal(file(result, '.member-work-sync/report-token-secret.json').payloadStatus, 'invalid-json');
  assert.equal(file(result, '.member-work-sync/report-token-secret.json').sha256, hash(malformed));
  assert.equal(file(result, '.member-work-sync/report-token-secret.json').payload, undefined);
  assert.equal(file(result, '.member-work-sync/sqlite-fallback-replica.json').payloadStatus, 'invalid-utf8');
  assert.equal((file(result, 'members/team-lead/.member-work-sync/journal.jsonl').payload as Row).finalNewline, false);
  assert.equal(encode(result).includes('TEST_PRIVATE_BROKEN_JSON'), false);
});

test('nonfinite JSON numbers retain an explicit diagnostic value instead of silently becoming null', async t => {
  const f = await fixture(t);
  const raw = '{"schemaVersion":1,"snapshot":{"statuses":[{"statusRevision":{"sequence":1e400}}]}}';
  await f.write('.member-work-sync/sqlite-fallback-replica.json', raw);
  const result = await capture(f.root);
  assert.equal(file(result, '.member-work-sync/sqlite-fallback-replica.json').sha256, hash(raw));
  const serialized = JSON.parse(encode(result)) as RetainedOriginalFailureDiagnostics;
  const status = ((value(serialized, '.member-work-sync/sqlite-fallback-replica.json').snapshot as Row).statuses as Row[])[0]!;
  assert.deepEqual((status.statusRevision as Row).sequence, { invalidNumber: 'Infinity' });
  assert.equal(encode(result).includes('"sequence":null'), false);
});

test('missing original team and non-TEST roots return unavailable without throwing', async t => {
  const f = await fixture(t);
  await rm(f.team, { recursive: true });
  const absent = await capture(f.root);
  assert.equal(absent.status, 'unavailable'); assert.equal(absent.directories[0]?.status, 'absent');
  assert.equal((await capture(join(f.root, '..'))).reason, 'not-original-test-root');
  assert.equal((await capture('relative')).reason, 'not-original-test-root');
});

test('symlinked ancestors, selected files and member directories never expose outside bytes', async t => {
  const f = await fixture(t), outside = join(f.root, 'outside'); await mkdir(outside);
  const privateBytes = 'TEST_OUTSIDE_CONTENT_NEVER_EMITTED';
  await writeFile(join(outside, 'config.json'), privateBytes);
  await symlink(join(outside, 'config.json'), join(f.team, 'config.json'), 'file');
  await mkdir(join(f.team, 'members')); await symlink(outside, join(f.team, 'members/other'), 'dir');
  const result = await capture(f.root);
  assert.equal(file(result, 'config.json').status, 'unsafe'); assert.equal(file(result, 'config.json').sha256, undefined);
  assert.equal(result.directories.some(row => row.path === 'members/other'), false);
  assert.equal(encode(result).includes(privateBytes), false);
  await rm(join(f.root, 'claude'), { recursive: true }); await symlink(outside, join(f.root, 'claude'), 'dir');
  assert.equal((await capture(f.root)).reason, 'unsafe-ancestor');
  assert.equal(await readFile(join(outside, 'config.json'), 'utf8'), privateBytes);
});

test('hardlinked selected files are metadata-only and never followed as original fixture bytes', async t => {
  const f = await fixture(t), original = join(f.root, 'outside.json');
  await writeFile(original, 'TEST_HARDLINK_PRIVATE'); await link(original, join(f.team, 'config.json'));
  const result = await capture(f.root);
  assert.equal(file(result, 'config.json').status, 'unsafe'); assert.equal(file(result, 'config.json').sha256, undefined);
  assert.equal(encode(result).includes('TEST_HARDLINK_PRIVATE'), false);
});

test('unreadable selected files preserve explicit refusal and never reject the capture promise', async t => {
  const f = await fixture(t); await f.write('config.json', '{}');
  const originalOpen = fs.open;
  t.mock.method(fs, 'open', (...args: Parameters<typeof fs.open>) => {
    if (String(args[0]) === join(f.team, 'config.json')) return Promise.reject(Object.assign(new Error('TEST_PRIVATE_ERROR'), { code: 'EACCES' }));
    return originalOpen(...args);
  });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const result = await capture(f.root);
  assert.equal(file(result, 'config.json').status, 'unreadable'); assert.equal(file(result, 'config.json').reason, 'EACCES');
  assert.equal(encode(result).includes('TEST_PRIVATE_ERROR'), false);
});

test('per-file and aggregate byte limits are explicit and never produce a truncated-file digest', async t => {
  const f = await fixture(t);
  await f.write('config.json', Buffer.alloc(limits.fileBytes + 1));
  let result = await capture(f.root);
  assert.equal(file(result, 'config.json').status, 'oversize'); assert.equal(file(result, 'config.json').sha256, undefined);
  assert.equal(result.totalReadBytes, 0);
  for (const path of ['config.json', 'members.meta.json', 'team.meta.json', 'launch-state.json', 'launch-summary.json'])
    await f.write(path, Buffer.alloc(limits.fileBytes));
  result = await capture(f.root);
  assert.ok(result.totalReadBytes <= limits.totalReadBytes); assert.ok(result.payloadBytes <= limits.payloadBytes);
  assert.ok(result.files.some(row => row.status === 'budget'));
  for (const row of result.files.filter(row => row.status === 'budget')) assert.equal(row.sha256, undefined);
});

test('directory inventory and recursive member walks stop at finite entry and depth bounds', async t => {
  const f = await fixture(t);
  await Promise.all(Array.from({ length: limits.entries + 1 }, (_, i) => f.write('extra-' + i, '')));
  const result = await capture(f.root);
  assert.equal(result.reason, 'entry-limit'); assert.equal(result.directories[0]?.truncated, true);
  assert.ok(result.directories.reduce((n, row) => n + (row.entries?.length ?? 0), 0) <= limits.entries);
  for (let i = 0; i <= limits.entries; i++) await rm(join(f.team, 'extra-' + i));
  await mkdir(join(f.team, 'members', ...Array.from({ length: limits.depth + 2 }, () => 'nested')), { recursive: true });
  const deep = await capture(f.root);
  assert.equal(deep.reason, 'directory-limit'); assert.ok(deep.directories.length <= limits.directories);
});

// Execute only the actual wrapper declaration, with controlled ports. No fixture,
// browser, process table or original UI attempt is imported or run by this test.
const uiSource = readFileSync(new URL('./desktop-retained-original-ui.ts', import.meta.url), 'utf8');
const wrapperStart = uiSource.indexOf('export async function runDesktopRetainedOriginalUi(');
const wrapperEnd = uiSource.indexOf('\n/** Existing visible choice,', wrapperStart);
assert.ok(wrapperStart >= 0 && wrapperEnd > wrapperStart, 'original wrapper declaration boundary');
const wrapperText = uiSource.slice(wrapperStart, wrapperEnd);
assert.ok(wrapperText.trimEnd().endsWith('\n}'));
const wrapperSource = stripTypeScriptTypes(wrapperText.replace(/^export\s+/u, ''), { mode: 'strip' });
const actualWrapper = (attempt: () => Promise<void>, diagnostic: (root: string) => unknown) =>
  new Function('runRetainedOriginalUiAttempt', 'captureRetainedOriginalFailureDiagnostics',
    wrapperSource + '; return runDesktopRetainedOriginalUi;')(attempt, diagnostic) as
    (cdp: unknown, options: { fixture: { root: string }; evidence: Row }) => Promise<void>;

test('actual original UI success does not collect a failure snapshot', async () => {
  let attempts = 0, captures = 0;
  await actualWrapper(async () => { attempts++; }, () => { captures++; })(null, { fixture: { root: 'TEST-root' }, evidence: {} });
  assert.equal(attempts, 1); assert.equal(captures, 0);
});

test('actual original UI failure captures once before outer cleanup and rethrows the same error without retry', async () => {
  const original = new Error('TEST-original'), events: string[] = [], evidence: Row = {}, receipt = { captured: true };
  const run = actualWrapper(async () => { events.push('attempt'); throw original; }, async root => {
    assert.equal(root, 'TEST-root'); events.push('capture-start'); await Promise.resolve();
    events.push('capture-finish'); return receipt;
  });
  await assert.rejects(async () => { try { await run(null, { fixture: { root: 'TEST-root' }, evidence }); }
    finally { events.push('outer-cleanup'); } }, error => error === original);
  assert.deepEqual(events, ['attempt', 'capture-start', 'capture-finish', 'outer-cleanup']);
  assert.equal(evidence.retainedOriginalFailureDiagnostics, receipt);
});

for (const kind of ['throw', 'reject'] as const) test('actual original UI preserves its error when diagnostic ' + kind + ' fails', async () => {
  const original = new Error('TEST-original'); let attempts = 0, captures = 0;
  const run = actualWrapper(async () => { attempts++; throw original; }, () => {
    captures++; const failure = new Error('TEST-diagnostic'); if (kind === 'throw') throw failure;
    return Promise.reject(failure);
  });
  await assert.rejects(run(null, { fixture: { root: 'TEST-root' }, evidence: {} }), error => error === original);
  assert.equal(attempts, 1); assert.equal(captures, 1);
});
