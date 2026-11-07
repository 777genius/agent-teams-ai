// TEST-only negative E2E for publicly downloadable native Host receipts.
// Deliberately fail before process allocation; never open user configuration.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isCompleteNativeHostReceipt, REQUIRED_NATIVE_HOST_STEPS } from './opencode-v2-native-receipt-verify.mjs';
import { parseOwnedDurableLog, retainsOwnedDurablePrefix } from './opencode-v2-native-log-parse.mjs';

test('a failed native Host proof publishes only sanitized diagnostics and no raw paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'TEST-v2-host-failure-receipt-'));
  const path = join(root, 'receipt.json');
  const secret = 'TEST_PRIVATE_SECRET_' + randomBytes(12).toString('hex');
  try {
    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL('./opencode-v2-native-instructions.mjs', import.meta.url)),
    ], {
      env: { ...process.env, OPENCODE_V2_TEST_NPM_ROOT: '/' + secret,
        OPENCODE_V2_HOST_NATIVE_RECEIPT: path },
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1, 'unsupported native root must fail closed');
    const receipt = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(receipt.error, 'native_host_test_failed');
    assert.equal(receipt.qualified, false);
    assert.equal(receipt.productQualified, false);
    assert.equal(receipt.packagedElectronQualified, false);
    assert.equal(receipt.cleanup, true, 'no native process was allocated');
    assert.equal(receipt.pid, undefined);
    assert.equal(receipt.processStartTicks, undefined);
    assert.doesNotMatch(JSON.stringify(receipt) + result.stderr, /TEST_PRIVATE_SECRET_|\bat\s+file:\/\//);
    assert.match(result.stderr, /native_host_test_failed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function completeReceiptFixture() {
  return {
    kind: 'TEST_NATIVE_HOST_SPI_INSTRUCTIONS', version: '2.0.21',
    cleanup: true, qualified: false, productQualified: false,
    packagedElectronQualified: false, sourceHead: 'a'.repeat(40), binarySha256: 'f'.repeat(64),
    pid: 1101, processStartTicks: '123456', nativeCustodyReadbacks: 4,
    nativePermissionReadbacks: 4, steps: [...REQUIRED_NATIVE_HOST_STEPS],
    nativeLogReadback: { readOnly: true, synced: true, watermark: 0,
      eventCount: 0, modelTurnProven: false },
    restartLogReadback: { readOnly: true, synced: true, watermark: 0,
      eventCount: 0, modelTurnProven: false },
    restart: { priorPid: 1101, priorStartTicks: '123456', pid: 1102,
      startTicks: '123489', readOnly: true, actualBinarySha256: 'f'.repeat(64) },
  };
}

test('native receipt gate rejects forged digest, incomplete stages and cold restart uncertainty', () => {
  assert.equal(isCompleteNativeHostReceipt(completeReceiptFixture()), true);
  const mutations = [
    r => { r.steps.pop(); },
    r => { r.steps.splice(r.steps.indexOf('real_native_ordered_ask_readback_without_tool_execution'), 1); },
    r => { r.steps.splice(r.steps.indexOf('real_native_fresh_session_durable_log_cursor_read_only'), 1); },
    r => { delete r.nativeLogReadback; },
    r => { r.nativeLogReadback.synced = false; },
    r => { r.nativeLogReadback.readOnly = false; },
    r => { r.nativeLogReadback.modelTurnProven = true; },
    r => { r.nativeLogReadback.watermark = -1; },
    r => { r.nativeLogReadback.eventCount = 4097; },
    r => { r.steps.splice(r.steps.indexOf('native_cold_restart_durable_log_cursor_read_only'), 1); },
    r => { delete r.restartLogReadback; },
    r => { r.restartLogReadback.synced = false; },
    r => { r.restartLogReadback.readOnly = false; },
    r => { r.restartLogReadback.modelTurnProven = true; },
    r => { r.nativeLogReadback.watermark = 1; r.restartLogReadback.watermark = 0; },
    r => { r.nativeLogReadback.eventCount = 1; r.restartLogReadback.eventCount = 0; },
    r => { r.restartLogReadback.eventCount = 4097; },
    r => { r.steps[0] = 'npm_wrapper_hashed'; },
    r => { r.steps.reverse(); },
    r => { r.sourceHead = 'unverified'; },
    r => { r.sourceHead = 'A'.repeat(40); },
    r => { delete r.sourceHead; },
    r => { r.binarySha256 = 'unverified'; },
    r => { r.binarySha256 = 'F'.repeat(64); },
    r => { r.nativeCustodyReadbacks = 3; },
    r => { r.nativePermissionReadbacks = 3; },
    r => { r.pid = 0; },
    r => { r.processStartTicks = 'not-a-start'; },
    r => { r.restart.priorPid++; },
    r => { r.restart.priorStartTicks = '1'; },
    r => { r.restart.pid = r.pid; r.restart.startTicks = r.processStartTicks; },
    r => { r.restart.actualBinarySha256 = 'a'.repeat(64); },
    r => { r.restart.readOnly = false; },
    r => { r.cleanup = false; },
    r => { r.cleanupError = 'native_process_cleanup_unconfirmed'; },
    r => { r.qualified = true; },
    r => { r.error = 'native_host_test_failed'; },
  ];
  for (const mutate of mutations) {
    const candidate = completeReceiptFixture();
    mutate(candidate);
    assert.equal(isCompleteNativeHostReceipt(candidate), false);
  }
  assert.equal(isCompleteNativeHostReceipt(completeReceiptFixture(), 'a'.repeat(40)), true);
  assert.equal(isCompleteNativeHostReceipt(completeReceiptFixture(), 'b'.repeat(40)), false,
    'an otherwise valid native receipt cannot authorize another PR HEAD');
  assert.equal(isCompleteNativeHostReceipt(undefined), false);
});

test('receipt verifier CLI refuses lockfile-only artifacts with sanitized diagnostics', () => {
  const root = mkdtempSync(join(tmpdir(), 'TEST-v2-native-proof-'));
  const path = join(root, 'receipt.json');
  try {
    for (const [payload, exitCode] of [
      [completeReceiptFixture(), 0],
      [{ lockfileVersion: 3, packages: { 'node_modules/@opencode/cli': { version: '2.0.21' } } }, 1],
      [{ ...completeReceiptFixture(), cleanup: false }, 1],
    ]) {
      writeFileSync(path, JSON.stringify(payload));
      const result = spawnSync(process.execPath, [
        fileURLToPath(new URL('./opencode-v2-native-receipt-verify.mjs', import.meta.url)), path,
      ], { encoding: 'utf8',
        env: { ...process.env, OPENCODE_V2_TEST_SOURCE_HEAD: 'a'.repeat(40) } });
      assert.equal(result.status, exitCode);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, exitCode ? 'native_host_receipt_missing_or_incomplete\n' : '');
    }
    writeFileSync(path, JSON.stringify(completeReceiptFixture()));
    for (const sourceHead of ['', 'b'.repeat(40)]) {
      const result = spawnSync(process.execPath, [
        fileURLToPath(new URL('./opencode-v2-native-receipt-verify.mjs', import.meta.url)), path,
      ], { encoding: 'utf8',
        env: { ...process.env, OPENCODE_V2_TEST_SOURCE_HEAD: sourceHead } });
      assert.equal(result.status, 1, 'missing or different workflow HEAD must reject artifact');
      assert.equal(result.stderr, 'native_host_receipt_missing_or_incomplete\n');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('native durable SSE proof accepts a bounded, owned and ordered history prefix', () => {
  const id = 'ses_TEST123', dir = '/TEST/workspace';
  const frame = value => 'data: '+JSON.stringify(value)+'\n\n';
  const sync = seq => ({type:'log.synced',aggregateID:id,seq});
  const event = (seq, type = 'session.created') => ({
    id:'evt'+seq, type, durable:{aggregateID:id,seq},
    data:{sessionID:id},location:{directory:dir},
  });
  assert.deepEqual(parseOwnedDurableLog(frame(sync(0)),id,dir),
    {watermark:0,eventCount:0}, 'stock V2 fresh log is sync-only, never a model turn');
  assert.deepEqual(parseOwnedDurableLog(frame(event(0))+frame(sync(0)),id,dir),
    {watermark:0,eventCount:1}, 'nonempty native prefix may end at the exact sync watermark');
  assert.deepEqual(parseOwnedDurableLog(': heartbeat\n\n'+frame(event(0))+
    frame(event(2,'session.updated'))+frame(sync(3)),id,dir),
    {watermark:3,eventCount:2}, 'filtered native bus positions may have gaps');
  assert.deepEqual(parseOwnedDurableLog(frame(sync(0)).replaceAll('\n','\r\n'),id,dir),
    {watermark:0,eventCount:0});
});

test('native durable SSE proof enforces frame-count budget with a distinct error', () => {
  const id = 'ses_TEST123', dir = '/TEST/workspace';
  const sync = 'data: '+JSON.stringify({type:'log.synced',aggregateID:id,seq:0})+'\n\n';
  const keepAlive = ': keepalive\n\n';
  assert.deepEqual(parseOwnedDurableLog(keepAlive.repeat(4096)+sync,id,dir),
    {watermark:0,eventCount:0}, 'the 4098-frame upper boundary is accepted');
  assert.throws(() => parseOwnedDurableLog(keepAlive.repeat(4097)+sync,id,dir),
    /native_durable_log_limit_exceeded/, 'overflow cannot masquerade as wrong identity');
});

test('native durable SSE proof rejects foreign, incomplete and reordered events', () => {
  const id = 'ses_TEST123', dir = '/TEST/workspace';
  const frame = value => 'data: '+JSON.stringify(value)+'\n\n';
  const sync = (seq = 0, aggregateID = id) => ({type:'log.synced',aggregateID,seq});
  const event = (seq = 0, overrides = {}) => ({
    id:'evt'+seq,type:'session.created',durable:{aggregateID:id,seq},
    data:{sessionID:id},location:{directory:dir},...overrides,
  });
  const bad = [
    frame(sync()).trimEnd(), // truncated final SSE frame
    'data: {\n\n', // malformed JSON
    'data:\n\n'+frame(sync()), // empty data before sync is not a keep-alive
    'event: session.created\n\n'+frame(sync()), // only comment keep-alives may be skipped
    frame(sync())+'id: orphaned\n\n', // no hidden directives after sync
    'data: '+JSON.stringify(sync())+'\nretry: 0\n\n', // no unsupported mixed fields
    frame(sync())+'data: \n\n', // empty data after sync must not be ignored
    frame(sync(0,'ses_FOREIGN')),
    frame(sync(-1)),
    frame(event(0,{data:{sessionID:'ses_FOREIGN'}}))+frame(sync()),
    frame(event(0,{durable:{aggregateID:'ses_FOREIGN',seq:0}}))+frame(sync()),
    frame(event(0,{location:{directory:'/foreign'}}))+frame(sync()),
    frame(event(0,{id:'duplicate'}))+frame(event(0,{id:'duplicate'}))+frame(sync(1)),
    frame(event(0))+frame({...event(0),id:'evt_new',type:'session.updated'})+frame(sync(1)),
    frame(event(0))+frame(sync(0))+frame(event(1)),
    frame({...event(1),type:'session.updated'})+frame(sync(1)),
    frame({...event(0),type:'session.updated'})+frame(sync(1)),
    frame(event(0))+frame(sync(-1)),
    frame(event(0)), // no log.synced terminal
  ];
  for (const stream of bad)
    assert.throws(() => parseOwnedDurableLog(stream,id,dir),
      /native_durable_log_identity_or_cursor_mismatch/);
});


test('cold native log proof compares retained event content, not only counts and watermark', () => {
  const sessionId = 'ses_TEST123', directory = '/TEST/workspace';
  const frame = value => 'data: ' + JSON.stringify(value) + '\\n\\n';
  const event = (seq, id, content) => ({
    id, type: seq === 0 ? 'session.created' : 'session.updated',
    durable: { aggregateID: sessionId, seq },
    data: { sessionID: sessionId, content },
    location: { directory },
  });
  const sync = seq => ({ type: 'log.synced', aggregateID: sessionId, seq });
  const read = (events, watermark) => {
    const fingerprints = [];
    const body = events.map(frame).join('') + frame(sync(watermark));
    const cursor = parseOwnedDurableLog(body, sessionId, directory,
      value => fingerprints.push(createHash('sha256').update(JSON.stringify(value)).digest('hex')));
    return { ...cursor, fingerprints };
  };
  const original = read([event(0, 'evt-0', 'TEST-A')], 2);
  const unchanged = read([event(0, 'evt-0', 'TEST-A')], 2);
  const appended = read([event(0, 'evt-0', 'TEST-A'), event(3, 'evt-3', 'TEST-B')], 3);
  const replacedId = read([event(0, 'evt-foreign', 'TEST-A')], 2);
  const alteredContent = read([event(0, 'evt-0', 'TEST-CHANGED')], 2);
  const regressed = read([event(0, 'evt-0', 'TEST-A')], 1);
  assert.equal(retainsOwnedDurablePrefix(original, unchanged), true);
  assert.equal(retainsOwnedDurablePrefix(original, appended), true);
  assert.equal(retainsOwnedDurablePrefix(original, replacedId), false,
    'same watermark/count must not certify a different event');
  assert.equal(retainsOwnedDurablePrefix(original, alteredContent), false,
    'same event ID with changed payload must not certify the old durable prefix');
  assert.equal(retainsOwnedDurablePrefix(original, regressed), false);
  assert.equal(retainsOwnedDurablePrefix(original, { watermark: 2, eventCount: 1 }), false);
});
