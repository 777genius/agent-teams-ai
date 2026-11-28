import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { createFilesystemTeamOwner } from '../dist/adapters/team/createFilesystemTeamOwner.js';
import { createTeamMcpTools } from '../dist/mcp/tools.js';
import { digest } from '../dist/team/identity.js';
import { processReceiptFingerprint, validateProcessReceipt } from '../dist/process/validateProcessRecords.js';
import type { ProcessCommandReceipt, TeamProcessRow } from '../dist/process/registeredProcessContracts.js';

type Tools = ReturnType<typeof createTeamMcpTools>;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
function result(response: Awaited<ReturnType<Tools['callAsync']>>) {
  const text = response.content.find(row => row.type === 'text');
  assert.ok(text?.type === 'text');
  assert.ok(Buffer.byteLength(text.text, 'utf8') <= 256 * 1024, 'actual MCP text fits its unchanged bound');
  assert.ok(response.structuredContent && 'result' in response.structuredContent);
  return response.structuredContent.result;
}
function completedAck(value: unknown, commandId: string) {
  assert.ok(record(value));
  assert.deepEqual(value, { commandId, operation: 'unregister', phase: 'completed',
    state: { phase: 'completed', native: 'not-requested' }, resultOmitted: true });
  assert.ok(Buffer.byteLength(JSON.stringify(value)) < 1024);
}
function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-mcp-process-unregister-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binding = { backendId: 'TEST-backend', teamId: 'TEST-team', teamName: 'TEST-unregister' };
  const delivery = { ...binding, runId: 'TEST-run', memberId: 'TEST-member', generation: '1' };
  const options: Parameters<typeof createFilesystemTeamOwner>[0] = {
    root, binding, members: [
      { memberId: 'TEST-lead', name: 'lead', role: 'lead' },
      { memberId: 'TEST-member', name: 'alice', role: 'member', delivery },
    ], grants: [
      { principalId: 'alice', memberName: 'alice', permissions: ['read', 'process.write'] },
      { principalId: 'other', memberName: 'lead', permissions: ['read', 'process.write'] },
      { principalId: 'admin', memberName: 'user', permissions: ['read', 'admin'] },
    ],
  };
  const owner = createFilesystemTeamOwner(options);
  const port = owner.processCommands('alice', { registrar: () => delivery });
  const tools = createTeamMcpTools({ ...owner.connect('alice'), process: port });
  const registryPath = join(root, 'teams', binding.teamName, 'processes.json');
  const receiptPath = (id: string) => join(root, 'teams', binding.teamName, '.host-owner/commands', digest(id) + '.json');
  const cold = () => {
    const reopened = createFilesystemTeamOwner({ ...options, members: [], grants: [] });
    return createTeamMcpTools({ ...reopened.connect('alice'), process: reopened.processCommands('alice') });
  };
  return { root, binding, owner, port, tools, registryPath, receiptPath, cold };
}
async function register(f: ReturnType<typeof fixture>, count: number, command: string) {
  for (let index = 0; index < count; index++) {
    const value = result(await f.tools.callAsync('process_register', { commandId: 'TEST-register-' + index,
      pid: 100000 + index, label: 'TEST process ' + index, port: 10000 + index,
      url: 'http://127.0.0.1', command }));
    assert.ok(record(value)); assert.equal(value.phase, 'completed');
  }
  return f.port.list();
}
async function completeCatalog(tools: Tools, expected: unknown[]) {
  const rows: unknown[] = [], cursors = new Set<string>();
  let cursor: string | undefined, revision: string | undefined, pages = 0;
  do {
    const page = result(await tools.callAsync('process_list', cursor === undefined ? {} : { cursor }));
    if (Array.isArray(page)) { assert.equal(pages, 0); rows.push(...page); cursor = undefined; }
    else {
      assert.ok(record(page)); assert.equal(page.kind, 'process-catalog-page');
      assert.equal(page.total, expected.length); assert.ok(Array.isArray(page.processes));
      assert.ok(page.processes.length > 0); assert.equal(typeof page.revision, 'string');
      if (revision !== undefined) assert.equal(page.revision, revision);
      revision = String(page.revision); rows.push(...page.processes);
      assert.ok(page.nextCursor === null || typeof page.nextCursor === 'string');
      cursor = page.nextCursor ?? undefined;
      if (cursor !== undefined) { assert.equal(cursors.has(cursor), false); cursors.add(cursor); }
    }
    assert.ok(++pages <= 128);
  } while (cursor !== undefined);
  assert.deepEqual(rows, expected, 'complete whole-row projection retains all optional metadata and order');
  return pages;
}

for (const [label, count, text] of [['ASCII', 100, 'x'], ['Unicode', 30, '漢']] as const) {
  test(`bounded unregister completes actual ${label} registry and exact replay without catalog receipt`, async t => {
    const f = fixture(t), before = await register(f, count, text.repeat(4096));
    assert.equal(before.length, count);
    await f.tools.callAsync('process_stop', { commandId: 'TEST-stop', id: before.at(-1)!.id });
    const commandId = 'TEST-unregister', args = { commandId, id: before[0]!.id };
    completedAck(result(await f.tools.callAsync('process_unregister', args)), commandId);
    const raw = f.port.lookup(commandId);
    assert.ok(raw); assert.equal(raw.phase, 'completed'); assert.equal(raw.result, undefined);
    assert.deepEqual(raw.selected?.map(row => row.id), [before[0]!.id]);
    const after = f.port.list(); assert.equal(after.length, count - 1);
    assert.ok(after.every(row => row.id !== before[0]!.id && row.command?.length === 4096 && row.canTerminate === false));
    assert.ok(after.at(-1)!.stoppedAt);
    const journal = readFileSync(f.receiptPath(commandId)), registry = readFileSync(f.registryPath);
    for (const tools of [f.tools, f.cold()]) {
      completedAck(result(await tools.callAsync('process_lookup', { commandId })), commandId);
      completedAck(result(await tools.callAsync('process_unregister', args)), commandId);
      await assert.rejects(tools.callAsync('process_unregister', { commandId, id: after[0]!.id }), /conflict/);
      assert.deepEqual(readFileSync(f.receiptPath(commandId)), journal);
      assert.deepEqual(readFileSync(f.registryPath), registry);
    }
    assert.ok(await completeCatalog(f.tools, after) > 1);
    assert.deepEqual(readFileSync(f.receiptPath(commandId)), journal);
    assert.deepEqual(readFileSync(f.registryPath), registry);
  });
}

test('large retained completed unregister is validated and projected without rewriting its legacy result', async t => {
  const f = fixture(t), rows = await register(f, 30, '漢'.repeat(4096));
  const commandId = 'TEST-legacy', args = { commandId, id: rows[0]!.id };
  const completed = f.port.metadata(commandId, 'unregister', { id: rows[0]!.id });
  const legacy = { ...completed, result: f.port.list() };
  validateProcessReceipt(legacy, digest);
  assert.ok(Buffer.byteLength(JSON.stringify(legacy)) > 256 * 1024);
  writeFileSync(f.receiptPath(commandId), JSON.stringify(legacy), { mode: 0o600 });
  const journal = readFileSync(f.receiptPath(commandId)), registry = readFileSync(f.registryPath);
  for (const tools of [f.tools, f.cold()]) {
    completedAck(result(await tools.callAsync('process_lookup', { commandId })), commandId);
    completedAck(result(await tools.callAsync('process_unregister', args)), commandId);
    assert.deepEqual(readFileSync(f.receiptPath(commandId)), journal);
    assert.deepEqual(readFileSync(f.registryPath), registry);
  }
  const malformed = { ...legacy, result: legacy.result.map((row, index) => index ? row : { ...row, command: '\0' }) };
  validateProcessReceipt(malformed, digest); // Header/fingerprint alone do not validate legacy public rows.
  writeFileSync(f.receiptPath(commandId), JSON.stringify(malformed), { mode: 0o600 });
  const corrupt = readFileSync(f.receiptPath(commandId));
  for (const tools of [f.tools, f.cold()]) {
    await assert.rejects(tools.callAsync('process_lookup', { commandId }), /hold/);
    await assert.rejects(tools.callAsync('process_unregister', args), /hold/);
  }
  assert.deepEqual(readFileSync(f.receiptPath(commandId)), corrupt);
  assert.deepEqual(readFileSync(f.registryPath), registry);
});

test('a historical prepared unregister stays prepared after its selected row disappeared', async t => {
  const f = fixture(t), rows = await register(f, 2, 'TEST command');
  const commandId = 'TEST-prepared', selector = { id: rows[0]!.id };
  const { result: _result, ...completed } = f.port.metadata(commandId, 'unregister', selector);
  const prepared: ProcessCommandReceipt = { ...completed, phase: 'prepared',
    state: { phase: 'prepared', native: 'not-requested' } };
  validateProcessReceipt(prepared, digest);
  writeFileSync(f.receiptPath(commandId), JSON.stringify(prepared), { mode: 0o600 });
  const journal = readFileSync(f.receiptPath(commandId)), registry = readFileSync(f.registryPath);
  for (const tools of [f.tools, f.cold()]) for (const method of ['process_lookup', 'process_unregister']) {
    const value = result(await tools.callAsync(method, { commandId, ...(method === 'process_unregister' ? selector : {}) }));
    assert.ok(record(value)); assert.equal(value.phase, 'prepared');
    assert.notEqual(value.resultOmitted, true);
  }
  assert.deepEqual(readFileSync(f.receiptPath(commandId)), journal);
  assert.deepEqual(readFileSync(f.registryPath), registry);
});

test('compact acknowledgements retain current principal, grant and Team authority', async t => {
  const f = fixture(t), rows = await register(f, 2, 'TEST command');
  const commandId = 'TEST-authority', selector = { id: rows[0]!.id };
  f.port.metadata(commandId, 'unregister', selector);
  const journal = readFileSync(f.receiptPath(commandId)), registry = readFileSync(f.registryPath);
  const other = createTeamMcpTools({ ...f.owner.connect('other'), process: f.owner.processCommands('other') });
  await assert.rejects(other.callAsync('process_lookup', { commandId }), /forbidden/);
  await assert.rejects(other.callAsync('process_unregister', { commandId, ...selector }), /forbidden/);
  const original = f.port.lookup(commandId); assert.ok(original);
  const foreign = { ...original, binding: { ...original.binding, teamId: 'TEST-other-team' } };
  foreign.fingerprint = processReceiptFingerprint(foreign, digest);
  validateProcessReceipt(foreign, digest);
  writeFileSync(f.receiptPath(commandId), JSON.stringify(foreign), { mode: 0o600 });
  await assert.rejects(f.tools.callAsync('process_lookup', { commandId }), /conflict|hold/);
  writeFileSync(f.receiptPath(commandId), journal);
  f.owner.connect('admin').revoke('alice');
  await assert.rejects(f.tools.callAsync('process_lookup', { commandId }), /forbidden/);
  await assert.rejects(f.tools.callAsync('process_unregister', { commandId, ...selector }), /forbidden/);
  assert.deepEqual(readFileSync(f.receiptPath(commandId)), journal);
  assert.deepEqual(readFileSync(f.registryPath), registry);
});

test('the exact compact completion limit is checked before canonical PID-history removal', async t => {
  const f = fixture(t), initial = await register(f, 1, 'TEST calibration');
  const { result: _result, ...base } = f.port.metadata('TEST-calibrate', 'unregister', { id: initial[0]!.id });
  const rows: TeamProcessRow[] = [];
  const selected = (values: TeamProcessRow[]) => values.map(row => ({ id: row.id,
    processRef: `p1:${row.id}:${digest({ binding: f.binding, row })}` }));
  const receipt = (commandId: string): ProcessCommandReceipt => {
    const value: ProcessCommandReceipt = { ...base, commandId, requestDigest: digest({ pid: 123456 }),
      selected: selected(rows), phase: 'completed', state: { phase: 'completed', native: 'not-requested' } };
    value.fingerprint = processReceiptFingerprint(value, digest);
    return value;
  };
  const prefix = 'TEST-boundary';
  for (let index = 0; index < 1024; index++) {
    rows.push({ id: 'TEST-history-' + String(index).padStart(4, '0') + '-'.repeat(16), pid: 123456,
      label: 'TEST valid stopped history', registeredAt: '2026-11-27T00:00:00.000Z', stoppedAt: '2026-11-27T00:01:00.000Z' });
    if (JSON.stringify(receipt(prefix)).length > 128 * 1024) { rows.pop(); break; }
  }
  const padding = 128 * 1024 + 1 - JSON.stringify(receipt(prefix)).length;
  assert.ok(padding > 0 && padding + prefix.length <= 256);
  const commandId = prefix + '-'.repeat(padding), completed = receipt(commandId);
  assert.equal(JSON.stringify(completed).length, 128 * 1024 + 1);
  const prepared: ProcessCommandReceipt = { ...completed, phase: 'prepared',
    state: { phase: 'prepared', native: 'not-requested' } };
  assert.ok(JSON.stringify(prepared).length <= 128 * 1024);
  validateProcessReceipt(prepared, digest);
  assert.throws(() => validateProcessReceipt(completed, digest), /hold/);
  writeFileSync(f.registryPath, JSON.stringify(rows), { mode: 0o600 });
  assert.equal(f.port.list().length, rows.length, 'actual canonical policy accepts the complete retained history');
  const registry = readFileSync(f.registryPath);
  assert.equal(existsSync(f.receiptPath(commandId)), false);
  await assert.rejects(f.tools.callAsync('process_unregister', { commandId, pid: 123456 }), /hold/);
  const after = readFileSync(f.registryPath), remaining: unknown = JSON.parse(after.toString('utf8'));
  assert.ok(Array.isArray(remaining));
  t.diagnostic(`TEST canonical rows ${rows.length}->${remaining.length}; prepared chars ${JSON.stringify(prepared).length}; completed chars ${JSON.stringify(completed).length}; native adapter absent`);
  assert.equal(after.equals(registry), true,
    'the two extra completion characters cannot cause removal before refusal');
  const retained = f.port.lookup(commandId);
  assert.ok(retained === null || retained.phase === 'prepared');
});
