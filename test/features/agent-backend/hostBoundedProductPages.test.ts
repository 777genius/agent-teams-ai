// @vitest-environment node
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFilesystemTeamOwner } from '@agent-teams/legacy-agent-host/team/filesystem';
import { afterEach, expect, it, vi } from 'vitest';

import { digest } from '../../../packages/legacy-agent-host/src/team/identity';
import { pageOwnerMessages } from '../../../packages/legacy-agent-host/src/team/pageOwnerMessages';
import { pageOwnerSnapshot } from '../../../packages/legacy-agent-host/src/team/pageOwnerSnapshot';
import { assembleHostMessageParts } from '../../../src/features/agent-backend/core/application/assembleHostMessageParts';
import { parseBackendOperation } from '../../../src/features/agent-backend/main/adapters/input/validateBackendOperation';
import { projectDeletedTasks } from '../../../src/features/agent-backend/main/adapters/output/projectDeletedTasks';
import { projectTeamMessagesPage } from '../../../src/features/agent-backend/main/adapters/output/projectTeamMessagesPage';
import { projectTeamSnapshot, projectTeamTask } from '../../../src/features/agent-backend/main/adapters/output/projectTeamSnapshot';
import { readHostScheduleState } from '../../../src/features/agent-backend/main/adapters/output/readHostScheduleState';
import { createHostTaskReads } from '../../../src/features/agent-backend/renderer/createHostTaskReads';
import { createHostTeamsApi, hostTeamSelectionKey } from '../../../src/features/agent-backend/renderer/createHostTeamsApi';
import { assembleTaskParts, readHostPagedSnapshot } from '../../../src/features/agent-backend/renderer/readHostPagedSnapshot';
import { TeamProductReadOrder } from '../../../src/features/agent-backend/renderer/TeamProductReadOrder';

import type { JsonValue } from '../../../packages/legacy-agent-host/src/contracts';
import type { BackendConnectionSnapshot } from '../../../src/features/agent-backend/contracts/connections';
import type { AgentBackendApi } from '../../../src/features/agent-backend/contracts/operations';
import type { BackendTeamSnapshot } from '../../../src/features/agent-backend/contracts/teamSnapshot';
import type { CapturedHostScheduleTarget } from '../../../src/features/agent-backend/main/application/captureHostScheduleTarget';
import type { TeamsAPI } from '../../../src/shared/types/api';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
const handle = { handleId: 'TEST-bounded-fields' };
const connection: BackendConnectionSnapshot['bindings'][number] = {
  handle, label: 'TEST fields', members: [],
};
const key = hostTeamSelectionKey(handle.handleId);
const teamName = 'test-team';
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const grant = {
  principalId: 'human', memberName: 'user', permissions: ['read', 'admin'] as ('read' | 'admin')[],
};
const snapshot = (tasks: JsonValue[] = [], messages: JsonValue[] = []) => ({
  teamName, revision: 'a'.repeat(64),
  feed: {
    streamId: '33333333-3333-4333-8333-333333333333',
    sequence: 0, cursor: '11111111-1111-4111-8111-111111111111',
  },
  members: [], tasks, messages,
  kanbanState: { teamName, tasks: {}, reviewers: [] },
});

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-bounded-product-fields-')));
  roots.push(root);
  const binding = { backendId: 'TEST-backend', teamId: 'TEST-team', teamName };
  const owner = createFilesystemTeamOwner({
    root, binding,
    members: [{
      memberId: 'alice', name: 'alice', role: 'lead',
      delivery: { ...binding, runId: 'TEST-run', memberId: 'alice', generation: 'TEST-generation' },
    }],
    grants: [{ ...grant, permissions: ['read', 'admin', 'task.write', 'message.write'] }],
  });
  return { owner, reader: owner.connect('human') };
}

it('keeps an accepted Unicode summary lossless through Owner snapshots and Desktop message history', async () => {
  const { reader } = fixture();
  const summary = '漢'.repeat(140_000);
  const parsed = parseBackendOperation({
    handle, commandId: 'TEST-large-summary', operation: 'message.send',
    payload: { to: 'alice', text: 'Original text', summary },
  });
  expect(parsed.operation).toBe('message.send');
  if (parsed.operation !== 'message.send') throw new Error('Wrong fixture command');
  const receipt = reader.execute({
    commandId: parsed.commandId, operation: 'message.send', payload: parsed.payload,
  });
  expect(receipt.phase).toBe('completed');
  const original = JSON.stringify(reader.lookup(receipt.commandId));
  const sizes: number[] = [];
  const backend: AgentBackendApi = {
    getConnections: vi.fn<AgentBackendApi['getConnections']>(async () => ({ state: 'ready', bindings: [connection] })),
    invoke: vi.fn<AgentBackendApi['invoke']>(async (request) => {
      if (request.operation === 'team.snapshot') {
        const raw = reader.readSnapshot(request.payload);
        sizes.push(bytes(raw));
        return { ok: true, value: projectTeamSnapshot(raw) };
      }
      if (request.operation === 'team.messages.page') {
        const raw = reader.readMessagesPage(request.payload);
        sizes.push(bytes(raw));
        return { ok: true, value: projectTeamMessagesPage(raw) };
      }
      throw new Error('Unexpected fixture operation');
    }),
  };
  const complete = await readHostPagedSnapshot(backend, connection, () => true, new TeamProductReadOrder());
  complete.assertCurrent();
  expect(complete.data.messages).toHaveLength(1);
  expect(complete.data.messages[0]).toMatchObject({ text: 'Original text', summary });
  const legacy = { getMessagesPage: vi.fn() } as unknown as TeamsAPI;
  const history = await createHostTeamsApi(legacy, backend).getMessagesPage(key, { limit: 100 });
  expect(history.messages).toHaveLength(1);
  expect(history.messages[0]).toMatchObject({ text: 'Original text', summary });
  expect(history.hasMore).toBe(false);
  expect(sizes.length).toBeGreaterThan(2);
  expect(sizes.every((size) => size <= 384 * 1024)).toBe(true);
  expect(legacy.getMessagesPage).not.toHaveBeenCalled();
  expect(JSON.stringify(reader.lookup(receipt.commandId))).toBe(original);
});

it('finishes 100 logical messages across bounded physical rows without consuming the older message', async () => {
  const message = (index: number, text: string) => ({
    messageId: 'TEST-message-' + index, from: 'alice', read: false, text,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
  });
  const messages = [
    message(0, 'older retained message'), message(1, '漢'.repeat(90_000)),
    ...Array.from({ length: 99 }, (_, index) => message(index + 2, 'short ' + index)),
  ];
  const options = { principalId: grant.principalId, grant, teamName, key: 'TEST-page-key', messages };
  const counts: number[] = [];
  const backend: AgentBackendApi = {
    getConnections: vi.fn<AgentBackendApi['getConnections']>(async () => ({ state: 'ready', bindings: [connection] })),
    invoke: vi.fn<AgentBackendApi['invoke']>(async (request) => {
      if (request.operation !== 'team.messages.page') throw new Error('Unexpected fixture operation');
      const raw = pageOwnerMessages({ ...options, ...request.payload }) as Record<string, JsonValue>;
      expect(bytes(raw)).toBeLessThanOrEqual(384 * 1024);
      counts.push((raw.messages as JsonValue[]).length);
      return { ok: true, value: projectTeamMessagesPage(raw) };
    }),
  };
  const teams = createHostTeamsApi({ getMessagesPage: vi.fn() } as unknown as TeamsAPI, backend);
  const first = await teams.getMessagesPage(key, { limit: 100 });
  expect(first.messages).toHaveLength(100);
  expect(first.messages.map((row) => row.messageId)).toEqual(messages.slice(1).map((row) => row.messageId));
  expect(first.messages[0]?.text).toBe(messages[1]!.text);
  expect(first.hasMore).toBe(true);
  expect(counts).toEqual([100, 1]);
  const last = await teams.getMessagesPage(key, { limit: 100, cursor: first.nextCursor });
  expect(last.messages).toEqual([messages[0]]);
  expect(last.hasMore).toBe(false);
  expect(counts.every((count) => count <= 100)).toBe(true);
});

it.each([43_000, 48_000])('restores a native accepted %i-character subject with all retained fields through the original MCP budget', async (length) => {
  const { reader } = fixture();
  const subject = '漢'.repeat(length), description = '界'.repeat(140_000);
  const prompt = '🙂'.repeat(40_000), comment = '評'.repeat(140_000);
  const created = reader.execute({
    commandId: 'TEST-large-task', operation: 'task.create',
    payload: { subject, description, prompt },
  });
  const taskId = created.effects.taskId;
  reader.execute({
    commandId: 'TEST-large-comment', operation: 'task.comment', payload: { taskId, text: comment },
  });
  const original = JSON.stringify(reader.getTask(taskId));
  const sizes: number[] = [];
  const invoke: AgentBackendApi['invoke'] = vi.fn<AgentBackendApi['invoke']>(async (request) => {
    if (request.operation !== 'team.snapshot') throw new Error('Unexpected fixture operation');
    const raw = reader.readQueries!.getTeam(request.payload.cursor);
    sizes.push(bytes(raw));
    return { ok: true, value: projectTeamSnapshot(raw) };
  });
  const complete = await readHostPagedSnapshot({ invoke }, connection, () => true, new TeamProductReadOrder());
  complete.assertCurrent();
  expect(complete.data.tasks).toHaveLength(1);
  expect(complete.data.tasks[0]).toMatchObject({ id: taskId, subject, description, prompt });
  expect(complete.data.tasks[0]?.comments?.[0]?.text).toBe(comment);
  expect(complete.data.taskParts).toBeUndefined();
  const target = {
    invoke: (request: Omit<Parameters<AgentBackendApi['invoke']>[0], 'handle'>) =>
      invoke({ ...request, handle } as Parameters<AgentBackendApi['invoke']>[0]),
  } as unknown as CapturedHostScheduleTarget;
  const scheduled = await readHostScheduleState(target);
  expect(scheduled.tasks[0]?.subject).toBe(subject);
  expect(sizes.length).toBeGreaterThan(2);
  expect(sizes.every((size) => size <= 128 * 1024)).toBe(true);
  expect(JSON.stringify(reader.getTask(taskId))).toBe(original);
});

it('forwards oversized retained subjects through the deleted-task projection and complete Trash reader', async () => {
  const subject = '漢'.repeat(48_000);
  const source = snapshot([{ id: 'TEST-deleted', subject, status: 'deleted' }]);
  const backend = {
    invoke: vi.fn<AgentBackendApi['invoke']>(async (request) => {
      if (request.operation !== 'tasks.list') throw new Error('Unexpected fixture operation');
      const raw = pageOwnerSnapshot({
        principalId: 'human', key: 'TEST-trash-key', snapshot: source, maxBytes: 128 * 1024,
        ...(request.payload.cursor ? { cursor: request.payload.cursor } : {}),
      }) as Record<string, JsonValue>;
      expect(bytes(raw)).toBeLessThanOrEqual(128 * 1024);
      return { ok: true, value: projectDeletedTasks({ ...raw, kind: 'deleted-tasks' }) };
    }),
  } as unknown as AgentBackendApi;
  const reads = createHostTaskReads(backend, async () => ({
    connection, snapshot: projectTeamSnapshot(snapshot()), canonicalTeamName: teamName,
    assertCurrent() {}, remapTasks: (tasks) => tasks,
  }));
  expect(await reads.getDeletedTasks(key)).toEqual([{ id: 'TEST-deleted', subject, status: 'deleted' }]);
  expect(await reads.getTask(key, 'TEST-deleted')).toEqual({ id: 'TEST-deleted', subject, status: 'deleted' });
});

it('retains legacy text-only fragments and rejects a new summary introduced after the original base', () => {
  const base = { messageId: 'TEST-message', from: 'alice', timestamp: '2026-01-01', read: false,
    text: 'first ', summary: 'original summary' };
  const { summary: _summary, ...continuation } = base;
  expect(assembleHostMessageParts({
    total: 2,
    values: new Map<number, BackendTeamSnapshot['messages'][number]>([
      [0, base],
      [1, { ...continuation, text: 'second' }],
    ]),
  })).toEqual({ ...base, text: 'first second' });
  expect(() => assembleHostMessageParts({
    total: 2,
    values: new Map<number, BackendTeamSnapshot['messages'][number]>([
      [0, continuation],
      [1, { ...base, text: 'second' }],
    ]),
  })).toThrow('summary');
});

it('rejects mixed subject parts and malformed markers before publishing a task', () => {
  const base = { id: 'TEST-task', subject: '', status: 'pending' as const };
  const groups = new Map([[0, {
    total: 3,
    values: new Map([[0, base], [1, { ...base, subject: 'part one' }], [2, { ...base, subject: 'part two' }]]),
    subjectParts: new Map([[1, { part: 0, total: 2 }], [2, { part: 1, total: 2 }]]),
  }]]);
  expect(assembleTaskParts(groups, 1)[0]?.subject).toBe('part onepart two');
  groups.get(0)!.subjectParts.set(2, { part: 0, total: 2 });
  expect(() => assembleTaskParts(groups, 1)).toThrow('subject');
  for (const subjectPart of [{ part: 0, total: 1 }, { part: 2, total: 2 }, { part: -1, total: 2 }]) {
    expect(() => projectTeamSnapshot({
      ...snapshot([base]), taskTotal: 1,
      taskParts: [{ index: 0, part: 1, total: 3, subjectPart }],
    })).toThrow('subject');
  }
});

it('rejects old codec cursors even under the same key, revision, principal and offset', () => {
  const source = snapshot([{ id: 'TEST-task', subject: '漢'.repeat(48_000), status: 'pending' }]);
  const options = { principalId: 'human', key: 'TEST-key', snapshot: source, maxBytes: 128 * 1024 };
  const first = pageOwnerSnapshot(options) as { nextCursor: string };
  const offset = Number(first.nextCursor.split('.')[0]);
  const old = offset + '.' + digest({
    key: options.key, principalId: options.principalId, teamName: source.teamName,
    revision: source.revision, maxBytes: options.maxBytes, offset,
  });
  expect(() => pageOwnerSnapshot({ ...options, cursor: old })).toThrow();
  const messages = [
    { messageId: 'TEST-old', from: 'alice', timestamp: '2026-01-01', read: false, text: 'old' },
    { messageId: 'TEST-new', from: 'alice', timestamp: '2026-01-02', read: false, text: 'new' },
  ];
  const messageOptions = { principalId: 'human', key: 'TEST-key', grant, teamName, messages, limit: 1 };
  const page = pageOwnerMessages(messageOptions) as { nextCursor: string; revision: string };
  const messageOffset = Number(page.nextCursor.split('.')[0]);
  const oldMessageCursor = messageOffset + '.' + digest({
    key: messageOptions.key, principalId: messageOptions.principalId, revision: page.revision,
    protocol: 'message-parts-v1', offset: messageOffset,
  });
  expect(() => pageOwnerMessages({ ...messageOptions, cursor: oldMessageCursor })).toThrow();
});

it.each([128 * 1024, 384 * 1024])('restores imported source messages and accepted workflow notes through %i-byte pages and Trash', async (maxBytes) => {
  const note = '評'.repeat(140_000), sourceText = '源'.repeat(140_000);
  expect(parseBackendOperation({ handle, commandId: 'TEST-note', operation: 'task.review',
    payload: { taskId: 'TEST-imported', action: 'request_changes', comment: note },
  })).toMatchObject({ payload: { comment: note } });
  const historyEvents: JsonValue[] = [
    { id: 'TEST-created', timestamp: '2026-11-20T11:00:00Z', type: 'task_created', status: 'pending' },
    { id: 'TEST-review', timestamp: '2026-11-21T11:00:00Z', type: 'review_changes_requested',
      actor: 'user', from: 'review', to: 'needsFix', note },
  ];
  const retained = {
    id: 'TEST-imported', subject: 'Original imported task', status: 'completed',
    sourceMessageId: 'TEST-original-message',
    sourceMessage: { from: 'user', timestamp: '2026-11-20T10:00:00Z', source: 'user_sent',
      text: sourceText, attachments: [{ id: 'TEST-file', filename: 'source.txt',
        mimeType: 'text/plain', size: 3, filePath: '/private/original/source.txt' }],
      fileReferenceIds: ['TEST-file'] },
    historyEvents,
  };
  const original = JSON.stringify(retained);
  const sizes: number[] = [];
  const backend: AgentBackendApi = {
    getConnections: vi.fn<AgentBackendApi['getConnections']>(async () => ({ state: 'ready', bindings: [connection] })),
    invoke: vi.fn<AgentBackendApi['invoke']>(async (request) => {
      if (request.operation !== 'team.snapshot' && request.operation !== 'tasks.list')
        throw new Error('Unexpected fixture operation');
      const deleted = request.operation === 'tasks.list';
      const raw = pageOwnerSnapshot({ principalId: 'human', key: 'TEST-imported-key', maxBytes,
        snapshot: snapshot([{ ...retained, status: deleted ? 'deleted' : retained.status }]),
        ...(request.payload.cursor ? { cursor: request.payload.cursor } : {}),
      });
      sizes.push(bytes(raw));
      return { ok: true, value: deleted
        ? projectDeletedTasks({ ...(raw as Record<string, JsonValue>), kind: 'deleted-tasks' })
        : projectTeamSnapshot(raw) };
    }),
  };
  const complete = await readHostPagedSnapshot(backend, connection, () => true, new TeamProductReadOrder());
  complete.assertCurrent();
  const expected = projectTeamTask(retained, teamName);
  expect(complete.data.tasks).toEqual([expected]);
  expect(complete.data.tasks[0]?.sourceMessage?.text).toBe(sourceText);
  expect(complete.data.tasks[0]?.sourceMessage?.fileReferenceIds).toEqual(['TEST-file']);
  expect(JSON.stringify(complete.data)).not.toContain('/private/original');
  const reads = createHostTaskReads(backend, async () => ({
    connection, snapshot: projectTeamSnapshot(snapshot()), canonicalTeamName: teamName,
    assertCurrent() {}, remapTasks: (tasks) => tasks,
  }));
  expect(await reads.getDeletedTasks(key)).toEqual([{ ...expected, status: 'deleted' }]);
  expect(sizes.length).toBeGreaterThan(2);
  expect(sizes.every((size) => size <= maxBytes)).toBe(true);
  expect(JSON.stringify(retained)).toBe(original);
});

it('keeps a complete subject when Main projects its final fragment with the same-page Kanban overlay', async () => {
  const subject = '漢'.repeat(48_000);
  const source = { ...snapshot([{ id: 'TEST-subject', subject, status: 'completed' }]),
    kanbanState: { teamName, reviewers: ['alice'], tasks: {
      'TEST-subject': { column: 'approved', reviewer: 'alice', movedAt: '2026-11-20T10:00:00Z' },
    } },
  };
  let overlaidSubject = false;
  const invoke: AgentBackendApi['invoke'] = vi.fn<AgentBackendApi['invoke']>(async (request) => {
    if (request.operation !== 'team.snapshot') throw new Error('Unexpected fixture operation');
    const page = projectTeamSnapshot(pageOwnerSnapshot({ principalId: 'human', key: 'TEST-overlay',
      snapshot: source, maxBytes: 128 * 1024,
      ...(request.payload.cursor ? { cursor: request.payload.cursor } : {}),
    }));
    overlaidSubject ||= page.tasks.some((task, index) => !!task.kanbanColumn && !!page.taskParts?.[index]?.subjectPart);
    return { ok: true, value: page };
  });
  const complete = await readHostPagedSnapshot({ invoke }, connection, () => true, new TeamProductReadOrder());
  expect(overlaidSubject).toBe(true);
  expect(complete.data.tasks[0]).toMatchObject({ subject, kanbanColumn: 'approved', reviewer: 'alice' });
});

it('rejects replaced source identity and metadata on nested text continuations', () => {
  const base = { id: 'TEST-source', subject: 'Source task', status: 'pending' as const,
    sourceMessageId: 'im1:TEST-source:' + 'a'.repeat(64),
    sourceMessage: { from: 'user', timestamp: '2026-11-20T10:00:00Z', source: 'user_sent', text: '' },
  };
  const continuation = { ...base, sourceMessage: { ...base.sourceMessage, text: 'Original text' } };
  const assemble = (next: typeof continuation) => assembleTaskParts(new Map([[0, {
    total: 2, values: new Map([[0, base], [1, next]]),
  }]]), 1);
  expect(assemble(continuation)[0]?.sourceMessage?.text).toBe('Original text');
  expect(() => assemble({ ...continuation, sourceMessageId: 'im1:TEST-other:' + 'b'.repeat(64) })).toThrow('source message');
  for (const changed of [{ from: 'alice' }, { source: 'inbox' }, { timestamp: '2026-11-22T10:00:00Z' }, { attachments: [] }])
    expect(() => assemble({ ...continuation, sourceMessage: { ...continuation.sourceMessage, ...changed } })).toThrow('source message');
});

it('rejects mixed workflow fragments, changed note identity and incomplete note sequences', () => {
  const base = { id: 'TEST-history', subject: 'History task', status: 'completed' as const };
  const event = { id: 'TEST-note', type: 'review_completed' as const, actor: 'alice',
    timestamp: '2026-11-20T10:00:00Z', from: 'review' as const, to: 'reviewed' as const,
    reviewRequestId: 'TEST-original-cycle', note: 'first' };
  const groups: Parameters<typeof assembleTaskParts>[0] = new Map([[0, {
    total: 3, values: new Map([[0, { ...base, historyEvents: [] }],
      [1, { ...base, historyEvents: [event] }], [2, { ...base, historyEvents: [{ ...event, note: 'second' }] }]]),
    historyParts: new Map([[1, { index: 0, part: 0, total: 2 }], [2, { index: 0, part: 1, total: 2 }]]),
  }]]);
  expect(assembleTaskParts(groups, 1)[0]?.historyEvents).toEqual([{ ...event, note: 'firstsecond' }]);
  for (const changed of [{ actor: 'user' }, { reviewRequestId: 'TEST-new-cycle' }]) {
    groups.get(0)!.values.set(2, { ...base, historyEvents: [{ ...event, ...changed, note: 'second' }] });
    expect(() => assembleTaskParts(groups, 1)).toThrow('fragment');
  }
  groups.get(0)!.values.delete(2);
  expect(() => assembleTaskParts(groups, 1)).toThrow('Incomplete');
  expect(() => projectTeamSnapshot({ ...snapshot([base]), taskTotal: 1,
    taskParts: [{ index: 0, part: 1, total: 3,
      historyPart: { index: 0, part: 0, total: 2 }, commentPart: { index: 0, part: 0, total: 2 } }],
  })).toThrow('fragment');
});
