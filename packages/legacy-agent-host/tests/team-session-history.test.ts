import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readTeamSessionHistory } from '../dist/composition/readTeamSessionHistory.js';
import { deliveryFingerprint, runtimeDigest } from '../dist/runtime/identity.js';
import { prepareRuntimeInput } from '../dist/runtime/inputPreparation.js';
import { RuntimeOwnerError } from '../dist/runtime/contracts.js';
import type { TeamSessionHistoryReadOptions, TeamSessionHistorySummary } from '../dist/composition/readTeamSessionHistory.js';
import type { RuntimeBinding, RuntimeSessionRecord } from '../dist/runtime/contracts.js';
import type { RuntimeActivityEvent, RuntimeConversationMessage } from '../dist/runtime/activityContracts.js';

interface History { kind: 'team-session-history'; sessions: TeamSessionHistorySummary[] }
interface Page {
  kind: 'team-session-page'; sessionId: string; revision: string; nextCursor: string | null;
  log: { sessionId: string; generation: string; events: { eventId: string; sequence: number }[] } | null;
  messages: { messageId: string; observedAt: string | null; phase?: string; text: string; part: number; parts: number }[];
}
function fixture(teamId = 'TEST-history-team') {
  let allowed = true, grantRevision = 1;
  const teamBinding = { backendId: 'TEST-owner', teamId, teamName: teamId };
  const team = {
    definition: { binding: teamBinding, members: [{ memberId: 'lead', name: 'lead', role: 'lead' }] },
    owner: { withLaunchAuthority: (principal: string, _action: string, fn: (revision: number) => unknown) => {
      if (!allowed || principal !== 'human') throw new RuntimeOwnerError('forbidden');
      return fn(grantRevision);
    } },
  } as unknown as TeamSessionHistoryReadOptions['team'];
  const records = new Map<string, RuntimeSessionRecord>();
  const events = new Map<string, RuntimeActivityEvent[]>();
  const conversations = new Map<string, RuntimeConversationMessage[]>();
  const bindings: RuntimeBinding[] = [
    { ...teamBinding, runId: 'first', memberId: 'lead', generation: '1' },
    { ...teamBinding, runId: 'first', memberId: 'lead', generation: '2' },
    { ...teamBinding, runId: 'second', memberId: 'lead', generation: '1' },
  ];
  const starts = new Map<string, number | null>([['first', 1000], ['second', 2000]]);
  for (const binding of bindings) {
    const key = runtimeDigest(binding);
    const intent = { binding, deliveryId: key, inputId: 'input-' + key, messageId: key, content: 'TEST chat' };
    records.set(key, {
      schemaVersion: 1, binding, profileId: 'TEST-profile', config: null, openFingerprint: key,
      hostIncarnation: 'TEST-host', phase: 'closed', sealed: false, custody: 'released', nativeReady: true,
      inputs: [{ intent, fingerprint: deliveryFingerprint(intent), operationRef: 'operation-' + key, phase: 'terminal', terminal: 'succeeded' }],
      interactions: [], activitySequence: 96,
      conversation: { sequence: 96, digest: key, gaps: [] },
    });
    events.set(key, Array.from({ length: 96 }, (_, index) => ({
      sequence: index + 1, eventId: key + '-' + index, inputId: intent.inputId, operationRef: 'operation-' + key,
      data: { kind: 'text', messageRef: 'message-' + index, block: 0, text: 'x'.repeat(9000), phase: 'complete' },
    })));
    conversations.set(key, [{
      messageId: 'conversation-' + key, inputId: intent.inputId, operationRef: 'operation-' + key,
      messageRef: 'older-than-ring', firstSequence: 1, observedAt: '2026-01-01T00:00:00.000Z',
      blocks: [{ block: 0, sequence: 1, text: '🙂'.repeat(150000), phase: 'complete' }],
    }]);
  }
  const launches = new Map([...starts.keys()].map(runId => [
    runtimeDigest({ teamId, launchId: runId }),
    { team, launch: { read: () => ({ launchId: runId, startedAtMs: starts.get(runId) }) } },
  ])) as unknown as TeamSessionHistoryReadOptions['launches'];
  const options: TeamSessionHistoryReadOptions = {
    team, principalId: 'human', pageKey: 'TEST-private-page-key', launches,
    entries: bindings.map(binding => ({ binding, team, recordRequired: true })),
    assertCurrent: () => undefined,
    runtime: {
      readCapturedSession: (binding: RuntimeBinding) => ({ record: records.get(runtimeDigest(binding)), attached: false }),
      readActivitySnapshot: (binding: RuntimeBinding) => ({
        binding, cursor: { resource: runtimeDigest(binding), hostIncarnation: 'TEST-host', sequence: 96 },
        retainedFrom: 1, events: [], hasMore: false, state: null,
        latest: { text: [], tools: [], usage: [], interactions: [], subagents: [], compaction: null },
      }),
      readActivityFeed: (binding: RuntimeBinding, cursor: { sequence: number }) => {
        const available = events.get(runtimeDigest(binding))!.filter(event => event.sequence > cursor.sequence);
        const selected: RuntimeActivityEvent[] = [];
        let bytes = 0;
        for (const event of available) {
          const size = Buffer.byteLength(JSON.stringify(event));
          if (selected.length >= 64 || bytes + size > 128 * 1024) break;
          bytes += size; selected.push(event);
        }
        return { binding, cursor: { resource: runtimeDigest(binding), hostIncarnation: 'TEST-host', sequence: 96 },
          retainedFrom: 1, events: selected, hasMore: selected.length < available.length };
      },
      readConversation: (binding: RuntimeBinding) => ({
        binding, revision: runtimeDigest(binding), gaps: [], messages: conversations.get(runtimeDigest(binding)),
      }),
    } as TeamSessionHistoryReadOptions['runtime'],
  };
  const history = () => readTeamSessionHistory(options, { scope: 'sessions' }) as unknown as History;
  const page = (id: string, stream: 'activity' | 'conversation' | 'inputs', cursor?: string) =>
    readTeamSessionHistory(options, { scope: 'session', sessionId: id, stream, ...(cursor ? { cursor } : {}) }) as unknown as Page;
  return { options, history, page, records, bindings, starts, conversations,
    revoke: () => { allowed = false; }, regrant: () => { grantRevision++; } };
}
function drain(f: ReturnType<typeof fixture>, id: string, stream: 'activity' | 'conversation' | 'inputs') {
  const pages: Page[] = [], cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = f.page(id, stream, cursor);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 256 * 1024);
    pages.push(page);
    if (page.nextCursor) {
      assert.ok(!cursors.has(page.nextCursor)); cursors.add(page.nextCursor);
    }
    cursor = page.nextCursor ?? undefined;
    assert.ok(pages.length < 100);
  } while (cursor);
  return pages;
}
test('history keeps original launches, restored generations and real launch boundaries', () => {
  const f = fixture(), rows = f.history().sessions;
  assert.equal(rows.length, 2);
  assert.match(rows[0]!.id, /^host-session-[a-f0-9]{64}$/u);
  assert.deepEqual(rows.map(row => row.window), [{ start: 2000, end: null }, { start: 1000, end: 2000 }]);
  assert.equal(rows[1]!.generations, 2);
  const generations = new Set(drain(f, rows[1]!.id, 'activity').map(page => page.log!.generation));
  assert.deepEqual([...generations].sort(), ['1', '2']);
});
test('all retained facts above 256 KiB are available through bounded continuations', () => {
  const f = fixture(), pages = drain(f, f.history().sessions[0]!.id, 'activity');
  assert.ok(pages.length > 4);
  const facts = pages.flatMap(page => page.log!.events);
  assert.equal(facts.length, 96);
  assert.equal(new Set(facts.map(event => event.eventId)).size, 96);
  assert.deepEqual(facts.map(event => event.sequence), Array.from({ length: 96 }, (_, i) => i + 1));
});
test('conversation pages preserve older text and Unicode beyond the activity ring budget', () => {
  const f = fixture(), pages = drain(f, f.history().sessions[0]!.id, 'conversation');
  assert.ok(pages.length > 1);
  const parts = pages.flatMap(page => page.messages);
  assert.ok(parts.every(part => part.parts === parts.length));
  assert.deepEqual(parts.map(part => part.part), Array.from({ length: parts.length }, (_, i) => i));
  assert.equal(parts.map(part => part.text).join(''), '🙂'.repeat(150000));
});
test('missing or equal launch clocks keep history visible and refuse a guessed task window', () => {
  const f = fixture();
  f.starts.set('first', null);
  assert.ok(f.history().sessions.every(row => row.window === null && row.clock === 'unqualified'));
  f.starts.set('first', 2000);
  assert.ok(f.history().sessions.every(row => row.window === null && row.clock === 'unqualified'));
  assert.ok(f.page(f.history().sessions[0]!.id, 'activity').log!.events.length > 0);
});
test('revocation and changed grant invalidate existing history continuations', () => {
  const f = fixture(), id = f.history().sessions[0]!.id, cursor = f.page(id, 'activity').nextCursor!;
  f.regrant();
  assert.throws(() => f.page(id, 'activity', cursor), /hold/);
  f.revoke();
  assert.throws(() => f.page(id, 'activity', cursor), /forbidden/);
});
test('cursors cannot move across sessions, streams, Teams or cold owner incarnations', () => {
  const f = fixture(), rows = f.history().sessions, cursor = f.page(rows[0]!.id, 'activity').nextCursor!;
  assert.throws(() => f.page(rows[1]!.id, 'activity', cursor), /hold/);
  assert.throws(() => f.page(rows[0]!.id, 'conversation', cursor), /hold/);
  const foreign = fixture('TEST-other-team');
  assert.throws(() => foreign.page(foreign.history().sessions[0]!.id, 'activity', cursor), /hold/);
  f.options.pageKey = 'TEST-after-cold-restart';
  assert.throws(() => f.page(rows[0]!.id, 'activity', cursor), /hold/);
  assert.deepEqual(f.history().sessions.map(row => row.id), rows.map(row => row.id));
  assert.ok(f.page(rows[0]!.id, 'activity').nextCursor);
});
test('changed retained source rejects stale continuation instead of mixing pages', () => {
  const f = fixture(), id = f.history().sessions[0]!.id, cursor = f.page(id, 'activity').nextCursor!;
  const record = f.records.get(runtimeDigest(f.bindings[2]!))!;
  record.activitySequence = 97;
  assert.throws(() => f.page(id, 'activity', cursor), /hold/);
});

test('original inputs survive missing activity attribution without invented author or timestamps', () => {
  const f = fixture(), record = f.records.get(runtimeDigest(f.bindings[2]!))!;
  const input = record.inputs[0]!;
  input.intent.content = 'Human original prompt 🙂\n'.repeat(20000);
  input.fingerprint = deliveryFingerprint(input.intent);
  const prefix = 'TEST private prepared supplement must not leak';
  input.preparation = prepareRuntimeInput(record.binding, input, {
    epochIds: [runtimeDigest('TEST-context-epoch')], prefix,
    teamProof: runtimeDigest('TEST-context-proof'),
  }, Buffer.byteLength(prefix + input.intent.content));
  const id = f.history().sessions[0]!.id, pages = drain(f, id, 'inputs');
  assert.ok(pages.length > 1);
  const parts = pages.flatMap(page => page.messages);
  assert.equal(parts.map(part => part.text).join(''), input.intent.content);
  assert.ok(parts.every(part => part.observedAt === null && part.phase === 'terminal' &&
    /^host-input-[a-f0-9]{64}$/u.test(part.messageId)));
  assert.ok(!JSON.stringify(pages).includes('TEST private prepared supplement'));
  const cursor = f.page(id, 'inputs').nextCursor!;
  input.phase = 'unknown';
  assert.throws(() => f.page(id, 'inputs', cursor), /hold/);
  input.fingerprint = '0'.repeat(64);
  assert.throws(() => f.page(id, 'inputs'), /hold/);
});
