import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { CONTEXT_MARKER, REQUIRED_TOOLS, startOpenCodeModel } from '../../packages/legacy-agent-host/tests/fixtures/native-opencode-team/model.ts';
import { checkpoint, jsonDigest, originalHistoryMarker } from './desktop-resume-records.ts';
import { separateDesktopOpenCodeRuntimeChildren } from './desktop-native-stop-fixture.ts';
import { assertCapturedColdMetadataAbsent, assertColdOpenCodeRuntimeRecords } from './desktop-opencode-v2-cold-metadata.ts';

const messageId = '11111111-2222-4333-8444-555555555555';
const tools = ['shell', ...REQUIRED_TOOLS.map(name => 'agent-teams_' + name)]
  .map(name => ({ type: 'function', function: { name, parameters: { type: 'object' } } }));
const user = (turn: string) => ({ role: 'user', content: `${JSON.stringify({ messageId, text: turn })}\n` +
  'message_send tool to="user", including commandId and text\nDo not reuse the incoming messageId as a reply commandId' });
async function until(read: () => boolean) {
  const end = Date.now() + 3000;
  while (!read() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(read(), true);
}

test('V2 lifecycle retains the pre-Launch metadata birth identity and refuses replacement or extra children', () => {
  const host = { pid: 10, parentPid: 1, groupId: 10, birth: 'TEST-host-birth', command: '/TEST/node' };
  const metadata = { pid: 11, parentPid: 10, groupId: 11, birth: 'TEST-metadata-birth', command: '/TEST/bun' };
  const runtime = { ...metadata, pid: 12, groupId: 12, birth: 'TEST-runtime-birth' };
  const original = { host, children: [metadata] };
  assert.deepEqual(separateDesktopOpenCodeRuntimeChildren(original, { host, children: [metadata, runtime] }, 1), [runtime]);
  assert.deepEqual(separateDesktopOpenCodeRuntimeChildren(original, original, 0), []);
  assert.throws(() => separateDesktopOpenCodeRuntimeChildren(original,
    { host, children: [{ ...metadata, birth: 'TEST-reused-pid' }, runtime] }, 1));
  assert.throws(() => separateDesktopOpenCodeRuntimeChildren(original,
    { host: { ...host, birth: 'TEST-replaced-host' }, children: [metadata, runtime] }, 1));
  assert.throws(() => separateDesktopOpenCodeRuntimeChildren(original,
    { host, children: [metadata, runtime, { ...runtime, pid: 13 }] }, 1));
});

test('cold metadata reads accept only original completed PNG inputs and no extra Runtime', () => {
  const source = {
    mode: 'native-conversation-ui',
    conversationUiProof: {
      status: 'PASS',
      custody: 'released',
      nativeChildAbsentBeforeQuit: true,
      nativeInputs: 2,
    },
  };
  const session = {
    phase: 'closed',
    custody: 'released',
    inputs: [
      { phase: 'terminal', terminal: 'succeeded' },
      { phase: 'terminal', terminal: 'succeeded' },
    ],
  };
  assert.doesNotThrow(() => assertColdOpenCodeRuntimeRecords(source, {}, [session]));
  for (const changed of [
    { ...session, phase: 'allocated' },
    { ...session, custody: 'unknown' },
    { ...session, inputs: [] },
    { ...session, inputs: [{ phase: 'unknown' }, session.inputs[1]] },
  ])
    assert.throws(() => assertColdOpenCodeRuntimeRecords(source, {}, [changed]));
  assert.throws(() => assertColdOpenCodeRuntimeRecords(source, {}, [session, session]));
});

test('cold cleanup proves the captured detached metadata child absent before recording success', () => {
  const original = { metadataProcessCount: 1, captured: {
    host: { pid: 10, parentPid: 1, groupId: 10, birth: 'TEST-host-birth', command: '/TEST/node' },
    children: [{ pid: 11, parentPid: 10, groupId: 11, birth: 'TEST-metadata-birth', command: '/TEST/bun' }],
  } };
  const proof: Record<string, unknown> = structuredClone(original);
  const evidence = { coldOpenCodeMetadata: proof };
  assert.throws(() => assertCapturedColdMetadataAbsent(evidence, [{ pid: 11, ppid: 10, pgid: 11 }]));
  assert.equal(proof.metadataAbsentBeforeHarnessCleanup, undefined);
  assert.throws(() => assertCapturedColdMetadataAbsent(evidence, [{ pid: 11, ppid: 1, pgid: 11 }]));
  assert.equal(proof.metadataAbsentBeforeHarnessCleanup, undefined, 'orphaning is not physical termination');
  // A reused numeric PID is deliberately uncertain, never adopted or signalled.
  assert.throws(() => assertCapturedColdMetadataAbsent(evidence, [{ pid: 11, ppid: 99, pgid: 99 }]));
  assert.equal(proof.metadataAbsentBeforeHarnessCleanup, undefined);
  assertCapturedColdMetadataAbsent(evidence, [{ pid: 42, ppid: 1, pgid: 42 }]);
  assert.equal(proof.metadataAbsentBeforeHarnessCleanup, true);
  assert.deepEqual(proof.captured, original.captured);
  const absent: Record<string, unknown> = {};
  assertCapturedColdMetadataAbsent(absent, []);
  assert.deepEqual(absent, {});
});

test('cold metadata preserves only the exact pending-open UNKNOWN witnessed by original Quit', () => {
  const session = {
    phase: 'held',
    custody: 'unknown',
    diagnostic: 'open-unknown',
    sealed: true,
    nativeReady: false,
    inputs: [],
    interactions: [],
  };
  const proof = {
    status: 'PASS',
    scenario: 'pending-open',
    afterQuit: {
      session: structuredClone(session),
      runtimeOutcome: 'held-unknown',
      debtRetained: true,
      originalGroupAbsentBeforeHarnessCleanup: true,
      nativeChildrenAbsent: true,
    },
  };
  const source = { mode: 'native-quit-ui', nativeQuitUiProof: proof };
  assert.doesNotThrow(() => assertColdOpenCodeRuntimeRecords(source, {}, [session]));
  assert.throws(() =>
    assertColdOpenCodeRuntimeRecords(source, {}, [
      { ...session, phase: 'closed', custody: 'released' },
    ])
  );
  for (const changed of [
    { ...proof, scenario: 'active' },
    { ...proof, afterQuit: { ...proof.afterQuit, debtRetained: false } },
    { ...proof, afterQuit: { ...proof.afterQuit, nativeChildrenAbsent: false } },
    { ...proof, afterQuit: { ...proof.afterQuit, originalGroupAbsentBeforeHarnessCleanup: false } },
  ])
    assert.throws(() =>
      assertColdOpenCodeRuntimeRecords({ ...source, nativeQuitUiProof: changed }, {}, [session])
    );
  const foreign = { ...session, inputs: [{ phase: 'claimed' }] };
  assert.throws(() =>
    assertColdOpenCodeRuntimeRecords(
      {
        ...source,
        nativeQuitUiProof: {
          ...proof,
          afterQuit: { ...proof.afterQuit, session: foreign },
        },
      },
      {},
      [foreign]
    )
  );
});

test('V2 Quit oracle holds one actual HTTP request and records its original disconnect', async () => {
  const model = await startOpenCodeModel({ nativeGeneration: 'v2', memberName: 'alice',
    uiGeneratedMessageIds: true, holdInitialTurnResponse: true });
  const abort = new AbortController();
  const pending = fetch(model.url + '/v1/chat/completions', { method: 'POST', signal: abort.signal,
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'TEST-model', tools,
      messages: [{ role: 'system', content: CONTEXT_MARKER }, user('OPENCODE_TEAM_ONE')] }) }).catch(() => undefined);
  try {
    await until(() => model.heldInitialRequests?.length === 1);
    assert.equal(model.observations.length, 1);
    assert.equal(model.observations[0]!.visibleReplyContract, true);
    assert.equal(model.observations[0]!.incomingMessageId, messageId);
    assert.equal(model.heldInitialRequests![0]!.disconnected, false);
    abort.abort(); await pending;
    await until(() => model.heldInitialRequests![0]!.disconnected);
    assert.deepEqual(model.failures, []);
  } finally { abort.abort(); await pending; await model.close(); }
});

test('V2 Resume oracle measures original tool IDs from the incoming native request', async () => {
  const model = await startOpenCodeModel({ nativeGeneration: 'v2', memberName: 'alice',
    uiGeneratedMessageIds: true, captureHistoryMarkers: true });
  const ids = Array.from({ length: 7 }, (_, index) => `TEST_OPENCODE_TEAM_ONE_${index}`);
  try {
    const response = await fetch(model.url + '/v1/chat/completions', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'TEST-model', tools,
        messages: [{ role: 'system', content: CONTEXT_MARKER }, user('OPENCODE_TEAM_ONE'),
          { role: 'assistant', tool_calls: ids.map(id => ({ id, type: 'function', function: { name: 'shell', arguments: '{}' } })) },
          user('OPENCODE_TEAM_TWO')] }) });
    assert.equal(response.status, 200); await response.text();
    const observation = model.observations[0]!;
    assert.deepEqual(observation.priorNativeToolIds, ids);
    assert.equal(observation.incomingMessageId, messageId);
    assert.equal(observation.visibleReplyContract, true);
    assert.equal(originalHistoryMarker(ids, 'opencode'), jsonDigest(ids));
    assert.throws(() => originalHistoryMarker(ids.slice(1), 'opencode'));
    assert.deepEqual(model.failures, []);
  } finally { await model.close(); }
});

test('V2 checkpoint evidence reads only its exact captured SQLite session and rejects foreign identity', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-desktop-backend-')));
  try {
    const binding = { backendId: 'TEST-host', teamId: 'TEST-team', runId: 'TEST-run', memberId: 'alice-id', generation: '1' };
    const config = { sessionId: 'TEST-runtime-session' }, accountBinding = 'TEST-account';
    const nativeSessionId = 'ses_' + jsonDigest({ sessionId: config.sessionId, memberId: binding.memberId, accountBinding }).slice(0, 40);
    const data = join(root, 'providers/opencode-v2/data'), cwd = join(root, 'workspace');
    const directory = join(data, 'agent-teams-v2-' + jsonDigest({ teamId: binding.teamId,
      memberId: binding.memberId, sessionId: config.sessionId }).slice(0, 32));
    await mkdir(directory, { recursive: true }); await mkdir(cwd);
    await writeFile(join(root, 'host-profile.json'), JSON.stringify({ runtime: { members: [{
      provider: 'opencode', nativeGeneration: 'v2', protocolRevision: '2.1.4',
      teamId: binding.teamId, memberId: binding.memberId, accountBinding, cwd,
      environment: { XDG_DATA_HOME: data },
    }] } }));
    const databasePath = join(directory, 'opencode.sqlite');
    const database = new DatabaseSync(databasePath);
    database.exec('CREATE TABLE session_v2 (id TEXT, directory TEXT, version TEXT); CREATE TABLE event (id TEXT, aggregate_id TEXT, seq INTEGER, type TEXT, data TEXT)');
    database.prepare('INSERT INTO session_v2 VALUES (?, ?, ?)').run(nativeSessionId, cwd, '2.1.4');
    database.prepare('INSERT INTO event VALUES (?, ?, ?, ?, ?)').run('TEST-event', nativeSessionId, 1, 'session.message', JSON.stringify({ text: 'OPENCODE_TEAM_ONE' }));
    database.close();
    const checkpointId = 'TEST-checkpoint', reference = `cp1-${jsonDigest({ binding, checkpointId })}`;
    const historyDigest = jsonDigest({ baseline: null, operations: [] });
    const body = { reference, checkpointId, sourceSessionRef: 'TEST-session', sourceBinding: binding,
      sourceConfig: config, completedOperations: [], historyDigest,
      opaque: { version: 1, engine: 'opencode-v2', nativeSessionId, compatibility: 'a'.repeat(64) } };
    const payload = { ...body, digest: jsonDigest(body) };
    await mkdir(join(root, 'hoststore/runtime-checkpoints'), { recursive: true });
    await writeFile(join(root, 'hoststore/runtime-checkpoints', reference + '.json'), JSON.stringify(payload));
    const session = { binding, config, sessionRef: 'TEST-session', phase: 'closed', custody: 'released', inputs: [],
      checkpoints: [{ status: 'published', reference, payloadDigest: payload.digest, historyDigest }] };
    const before = await readFile(databasePath);
    const observed = await checkpoint(root, session, 'opencode');
    assert.equal(observed.nativeSession, nativeSessionId); assert.equal(observed.historyPath, databasePath);
    assert.ok(observed.history.includes(Buffer.from('OPENCODE_TEAM_ONE')));
    assert.deepEqual(await readFile(databasePath), before, 'evidence performs no database write');
    await assert.rejects(checkpoint(root, { ...session, custody: 'unknown' }, 'opencode'));
    const foreign = new DatabaseSync(databasePath);
    foreign.prepare('UPDATE session_v2 SET directory = ?').run(join(root, 'foreign'));
    foreign.close();
    await assert.rejects(checkpoint(root, session, 'opencode'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
