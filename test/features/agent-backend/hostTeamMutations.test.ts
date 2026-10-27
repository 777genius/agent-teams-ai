import { describe, expect, it, vi } from 'vitest';

import { safeSegment } from '../../../packages/legacy-agent-host/src/team/identity';
import { validateTeamCommand } from '../../../packages/legacy-agent-host/src/team/validateTeamCommand';
import { projectTeamSnapshot } from '../../../src/features/agent-backend/main/adapters/output/projectTeamSnapshot';
import {
  createHostTeamsApi,
  hostTeamSelectionKey,
} from '../../../src/features/agent-backend/renderer/createHostTeamsApi';
import { buildPreparedSendRequest } from '../../../src/renderer/components/team/messages/composerSendUtils';
import { createEncodedTaskReference } from '../../../src/renderer/utils/taskReferenceUtils';

import type { BackendConnectionSnapshot } from '../../../src/features/agent-backend/contracts/connections';
import type {
  AgentBackendApi,
  BackendOperationRequest,
} from '../../../src/features/agent-backend/contracts/operations';
import type { BackendTeamSnapshot } from '../../../src/features/agent-backend/contracts/teamSnapshot';
import type { TeamsAPI } from '../../../src/shared/types/api';

function fixture() {
  const key = hostTeamSelectionKey('TEST-A');
  const legacy = Object.fromEntries(
    [
      'getData',
      'createTask',
      'updateTaskFields',
      'updateTaskOwner',
      'updateTaskStatus',
      'softDeleteTask',
      'restoreTask',
      'addTaskComment',
      'sendMessage',
      'startTask',
      'getTask',
      'getMessagesPage',
      'startTaskByUser',
      'requestReview',
      'updateKanban',
      'updateKanbanColumnOrder',
      'addTaskRelationship',
      'removeTaskRelationship',
      'setTaskClarification',
    ].map((method) => [method, vi.fn()])
  ) as unknown as TeamsAPI;
  const invoke = vi.fn(async (request: BackendOperationRequest) => {
    if (request.operation === 'team.snapshot')
      return {
        ok: true as const,
        value: {
          teamName: 'actual-team',
          revision: 'a'.repeat(64),
          feed: {
            streamId: '33333333-3333-4333-8333-333333333333',
            sequence: 0,
            cursor: '11111111-1111-4111-8111-111111111111',
          },
          members: [],
          tasks: [],
          messages: [],
          kanbanState: { teamName: 'actual-team', reviewers: [], tasks: {} },
        },
      };
    return {
      ok: true as const,
      value: {
        commandId: request.commandId,
        operation: request.operation as 'task.create',
        phase: 'completed' as const,
        task: {
          id: 'TEST-task',
          subject: 'Actual created task',
          status: 'pending',
          descriptionTaskRefs: [{ taskId: 'TEST-task', displayId: '1', teamName: 'actual-team' }],
        },
        comment: {
          id: 'TEST-comment',
          text: 'Actual comment',
          author: 'user',
          createdAt: '2026-01-01',
          type: 'regular',
          taskRefs: [{ taskId: 'TEST-task', displayId: '1', teamName: 'actual-team' }],
        },
        ...(request.operation === 'task.start'
          ? { notifiedOwner: request.payload.notification === 'user' }
          : {}),
        messageId:
          request.operation === 'message.send'
            ? (request.payload.messageId ?? 'TEST-authoritative-message')
            : 'TEST-authoritative-message',
      },
    };
  });
  const backend = {
    invoke,
    getConnections: vi.fn().mockResolvedValue({
      state: 'ready',
      bindings: [{ handle: { handleId: 'TEST-A' }, label: 'Host', members: [] }],
    }),
  } satisfies AgentBackendApi;
  return { key, legacy, invoke, backend, teams: createHostTeamsApi(legacy, backend) };
}

describe('ordinary Host Team mutation adapters', () => {
  it('round trips same-owner Task, comment and prepared Composer refs by exact immutable resource identity', async () => {
    const f = fixture(),
      target = hostTeamSelectionKey('TEST-B');
    const resource = '22222222-2222-5222-8222-222222222222';
    const storedTeam = `host-ref:${resource}`;
    let bindings: BackendConnectionSnapshot['bindings'] = [
      {
        handle: { handleId: 'TEST-A' },
        label: 'A',
        members: [],
        ownerResourceRef: 'TEST-owner',
        teamResourceRef: '11111111-1111-5111-8111-111111111111',
      },
      {
        handle: { handleId: 'TEST-B' },
        label: 'B',
        members: [],
        ownerResourceRef: 'TEST-owner',
        teamResourceRef: resource,
      },
    ];
    const product: BackendTeamSnapshot = {
      teamName: 'actual-team',
      revision: 'a'.repeat(64),
      feed: {
        streamId: '33333333-3333-4333-8333-333333333333',
        sequence: 0,
        cursor: '11111111-1111-4111-8111-111111111111',
      },
      members: [],
      tasks: [],
      messages: [],
      kanbanState: { teamName: 'actual-team', reviewers: [], tasks: {} },
    };
    const backend: AgentBackendApi = {
      getConnections: vi.fn<AgentBackendApi['getConnections']>(async () => ({
        state: 'ready',
        bindings: structuredClone(bindings),
      })),
      invoke: vi.fn<AgentBackendApi['invoke']>(async (request) => {
        if (request.operation === 'team.snapshot')
          return { ok: true, value: projectTeamSnapshot(structuredClone(product)) };
        const base = { commandId: request.commandId, phase: 'completed' as const };
        if (request.operation === 'task.create') {
          const task = { id: 'TEST-new', status: 'pending' as const, ...request.payload };
          product.tasks.push(task);
          return { ok: true, value: { ...base, operation: request.operation, task } };
        }
        if (request.operation === 'task.comment') {
          const comment = {
            id: 'TEST-comment',
            author: 'user',
            createdAt: '2026-10-27',
            type: 'regular' as const,
            text: request.payload.text,
            taskRefs: request.payload.taskRefs,
          };
          product.tasks[0]!.comments = [comment];
          return { ok: true, value: { ...base, operation: request.operation, comment } };
        }
        if (request.operation === 'message.send') {
          product.messages.push({
            from: 'user',
            timestamp: '2026-10-27',
            read: false,
            to: request.payload.to,
            text: request.payload.text,
            summary: request.payload.summary,
            taskRefs: request.payload.taskRefs,
            messageId: request.commandId,
          });
          return {
            ok: true,
            value: { ...base, operation: request.operation, messageId: request.commandId },
          };
        }
        throw new Error('Unexpected TEST mutation');
      }),
    };
    const teams = createHostTeamsApi(f.legacy, backend);
    const reference = { taskId: 'TEST-B-task', displayId: '7', teamName: target };
    const text = createEncodedTaskReference('7', reference.taskId, target);
    const created = await teams.createTask(f.key, {
      subject: 'TEST foreign ref',
      description: text,
      descriptionTaskRefs: [reference],
      prompt: text,
      promptTaskRefs: [reference],
    });
    expect(product.tasks[0]!.descriptionTaskRefs).toEqual([{ ...reference, teamName: storedTeam }]);
    expect(product.tasks[0]!.promptTaskRefs).toEqual([{ ...reference, teamName: storedTeam }]);
    expect(created.descriptionTaskRefs).toEqual([reference]);
    expect(created.description).toBe(text);
    const comment = await teams.addTaskComment(f.key, created.id, { text, taskRefs: [reference] });
    expect(comment.taskRefs).toEqual([reference]);
    expect(comment.text).toBe(text);
    const prepared = buildPreparedSendRequest({
      attemptId: 'TEST-ref-message',
      teamName: f.key,
      selectedTeam: null,
      localRecipient: 'alice',
      crossTeamRecipient: null,
      text,
      summary: text,
      attachments: [],
      actionMode: 'ask',
      taskRefs: [reference],
    });
    if (prepared.kind !== 'local') throw new Error('Expected local Composer');
    await teams.sendMessage(f.key, prepared.request);
    const read = await teams.getTask(f.key, created.id);
    expect(read?.descriptionTaskRefs).toEqual([reference]);
    expect(read?.promptTaskRefs).toEqual([reference]);
    expect(read?.comments?.[0]?.taskRefs).toEqual([reference]);
    expect((await teams.getMessagesPage(f.key)).messages[0]).toMatchObject({
      text,
      summary: text,
      taskRefs: [reference],
    });
    for (const entry of Object.values(f.legacy))
      if (typeof entry === 'function') expect(entry).not.toHaveBeenCalled();

    bindings[1]!.ownerResourceRef = 'TEST-other-owner';
    vi.mocked(backend.invoke).mockClear();
    await expect(
      teams.createTask(f.key, { subject: 'TEST denied', descriptionTaskRefs: [reference] })
    ).rejects.toMatchObject({ code: 'unsupported', outcome: 'not-dispatched' });
    expect(backend.invoke).not.toHaveBeenCalled();

    bindings = [
      bindings[0]!,
      {
        ...bindings[1]!,
        handle: { handleId: 'TEST-replacement-B' },
        ownerResourceRef: 'TEST-owner',
        teamResourceRef: '99999999-9999-5999-8999-999999999999',
      },
    ];
    const afterPurge = await teams.getTask(f.key, created.id);
    expect(afterPurge?.descriptionTaskRefs?.[0]?.teamName).toBe(
      `${f.key}:unbound:${encodeURIComponent(storedTeam)}`
    );
    expect(afterPurge?.descriptionTaskRefs?.[0]?.teamName).not.toBe(
      hostTeamSelectionKey('TEST-replacement-B')
    );
    expect(afterPurge?.description).not.toContain(target);
    expect(f.legacy.getTask).not.toHaveBeenCalled();
  });

  it('admits only the finite reference metadata token while generic filesystem segments remain unchanged', () => {
    const teamName = 'host-ref:22222222-2222-5222-8222-222222222222';
    const command = {
      commandId: 'TEST-ref',
      operation: 'task.create' as const,
      payload: {
        subject: 'TEST metadata',
        descriptionTaskRefs: [{ taskId: 'TEST-task', displayId: '1', teamName }],
      },
    };
    expect(() => validateTeamCommand(command)).not.toThrow();
    expect(() => safeSegment(teamName)).toThrow();
    for (const bad of ['host-ref:../../arbitrary', 'host-ref:not-a-resource', '/TEST/path'])
      expect(() =>
        validateTeamCommand({
          ...command,
          payload: {
            ...command.payload,
            descriptionTaskRefs: [{ taskId: 'TEST-task', displayId: '1', teamName: bad }],
          },
        })
      ).toThrow();
  });
  it('routes the existing reorder, dependency and clarification controls to the captured owner', async () => {
    const f = fixture();
    await f.teams.updateKanbanColumnOrder(f.key, 'todo', ['TEST-b', 'TEST-a']);
    await f.teams.updateKanbanColumnOrder(f.key, 'todo', []);
    await f.teams.addTaskRelationship(f.key, 'TEST-a', 'TEST-b', 'blockedBy');
    await f.teams.removeTaskRelationship(f.key, 'TEST-a', 'TEST-b', 'related');
    await f.teams.setTaskClarification(f.key, 'TEST-a', 'lead');
    await f.teams.setTaskClarification(f.key, 'TEST-a', null);
    const commands = f.invoke.mock.calls
      .map(([request]) => request)
      .filter((request) => request.operation !== 'team.snapshot');
    expect(commands.map(({ operation, payload }) => ({ operation, payload }))).toEqual([
      {
        operation: 'task.board.order',
        payload: { columnId: 'todo', orderedTaskIds: ['TEST-b', 'TEST-a'] },
      },
      { operation: 'task.board.order', payload: { columnId: 'todo', orderedTaskIds: [] } },
      {
        operation: 'task.relationship',
        payload: { taskId: 'TEST-a', targetId: 'TEST-b', type: 'blockedBy', action: 'add' },
      },
      {
        operation: 'task.relationship',
        payload: { taskId: 'TEST-a', targetId: 'TEST-b', type: 'related', action: 'remove' },
      },
      { operation: 'task.clarification', payload: { taskId: 'TEST-a', value: 'lead' } },
      { operation: 'task.clarification', payload: { taskId: 'TEST-a', value: null } },
    ]);
    expect(new Set(commands.map((request) => request.commandId)).size).toBe(6);
    expect(commands.every((request) => request.handle.handleId === 'TEST-A')).toBe(true);
    for (const method of [
      'updateKanbanColumnOrder',
      'addTaskRelationship',
      'removeTaskRelationship',
      'setTaskClarification',
    ] as const)
      expect(f.legacy[method]).not.toHaveBeenCalled();
  });
  it('does not repeat uncertain board mutations or call legacy controls', async () => {
    const f = fixture();
    const original = f.backend.invoke;
    f.backend.invoke = vi.fn(async (request) =>
      request.operation === 'team.snapshot'
        ? original(request)
        : { ok: false, code: 'hold', outcome: 'unknown' }
    );
    const teams = createHostTeamsApi(f.legacy, f.backend);
    await expect(
      teams.addTaskRelationship(f.key, 'TEST-a', 'TEST-b', 'blocks')
    ).rejects.toMatchObject({ outcome: 'unknown', commandId: expect.any(String) });
    expect(
      vi
        .mocked(f.backend.invoke)
        .mock.calls.filter(([request]) => request.operation === 'task.relationship')
    ).toHaveLength(1);
    expect(f.legacy.addTaskRelationship).not.toHaveBeenCalled();
  });

  it('maps both ordinary start intents to the same captured owner and preserves actual notification proof', async () => {
    const f = fixture();
    expect(await f.teams.startTask(f.key, 'TEST-task')).toEqual({ notifiedOwner: false });
    expect(await f.teams.startTaskByUser(f.key, 'TEST-task')).toEqual({ notifiedOwner: true });
    const commands = f.invoke.mock.calls
      .map(([request]) => request)
      .filter((r) => r.operation === 'task.start');
    expect(commands.map((r) => ({ handle: r.handle, payload: r.payload }))).toEqual([
      { handle: { handleId: 'TEST-A' }, payload: { taskId: 'TEST-task', notification: 'legacy' } },
      { handle: { handleId: 'TEST-A' }, payload: { taskId: 'TEST-task', notification: 'user' } },
    ]);
    expect(new Set(commands.map((r) => r.commandId)).size).toBe(2);
    expect(f.legacy.startTask).not.toHaveBeenCalled();
    expect(f.legacy.startTaskByUser).not.toHaveBeenCalled();
    const original = f.backend.invoke;
    f.backend.invoke = vi.fn(async (request) =>
      request.operation === 'team.snapshot'
        ? original(request)
        : { ok: false, code: 'hold', outcome: 'unknown' }
    );
    await expect(
      createHostTeamsApi(f.legacy, f.backend).startTaskByUser(f.key, 'TEST-task')
    ).rejects.toMatchObject({ code: 'hold', outcome: 'unknown', commandId: expect.any(String) });
  });

  it('preserves actual prepared Composer identity, immutable modes/summary and original refs', async () => {
    const f = fixture();
    const prepared = buildPreparedSendRequest({
      attemptId: 'TEST-composer-intent',
      teamName: f.key,
      selectedTeam: null,
      localRecipient: 'alice',
      crossTeamRecipient: null,
      text: 'Read this',
      summary: 'Read-only request',
      attachments: [],
      actionMode: 'ask',
      taskRefs: [{ taskId: 'TEST-task', displayId: '1', teamName: f.key }],
    });
    if (prepared.kind !== 'local') throw new Error('Expected normal local composer request');
    const result = await f.teams.sendMessage(f.key, prepared.request);
    expect(result).toEqual({ deliveredToInbox: true, messageId: 'TEST-composer-intent' });
    const commands = f.invoke.mock.calls
      .map(([request]) => request)
      .filter((request) => request.operation === 'message.send');
    expect(commands).toEqual([
      {
        handle: { handleId: 'TEST-A' },
        commandId: 'TEST-composer-intent',
        operation: 'message.send',
        payload: {
          to: 'alice',
          text: 'Read this',
          messageId: 'TEST-composer-intent',
          summary: 'Read-only request',
          actionMode: 'ask',
          taskRefs: [{ taskId: 'TEST-task', displayId: '1', teamName: 'actual-team' }],
        },
      },
    ]);
    expect(f.legacy.sendMessage).not.toHaveBeenCalled();
  });
  it('rejects slash commands and meaningful unsupported send extras before reading or dispatching', async () => {
    const f = fixture();
    await expect(
      f.teams.sendMessage(f.key, { member: 'alice', text: '/compact now' })
    ).rejects.toMatchObject({ code: 'unsupported', outcome: 'not-dispatched' });
    await expect(
      f.teams.sendMessage(f.key, { member: 'alice', text: 'x', from: 'user' })
    ).rejects.toMatchObject({ code: 'unsupported' });
    await expect(
      f.teams.sendMessage(f.key, {
        member: 'alice',
        text: 'x',
        attachments: [{ id: 'attachment' } as never],
      })
    ).rejects.toMatchObject({ code: 'unsupported' });
    expect(f.invoke).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'accepts unowned CreateTaskDialog startImmediately=%s and preserves its stable command ID',
    async (startImmediately) => {
      const f = fixture();
      const request = {
        subject: 'Task',
        description: createEncodedTaskReference('1', 'TEST-task', f.key),
        command: { commandId: 'TEST-intent', idempotencyKey: 'TEST-intent' },
        startImmediately,
        related: [],
        promptTaskRefs: [],
        descriptionTaskRefs: [{ taskId: 'TEST-task', displayId: '1', teamName: f.key }],
      };
      const task = await f.teams.createTask(f.key, request);
      expect(task.descriptionTaskRefs?.[0].teamName).toBe(f.key);
      await f.teams.createTask(f.key, request);
      const mutations = f.invoke.mock.calls
        .map(([r]) => r)
        .filter((r) => r.operation === 'task.create');
      expect(mutations).toHaveLength(2);
      expect(mutations[0]).toEqual({
        handle: { handleId: 'TEST-A' },
        commandId: 'TEST-intent',
        operation: 'task.create',
        payload: {
          subject: 'Task',
          description: createEncodedTaskReference('1', 'TEST-task', 'actual-team'),
          descriptionTaskRefs: [{ taskId: 'TEST-task', displayId: '1', teamName: 'actual-team' }],
        },
      });
      expect(mutations[1]).toEqual(mutations[0]);
      expect(f.legacy.createTask).not.toHaveBeenCalled();
    }
  );
  it('routes assignment/fields/lifecycle/comments/text messages to the original handle with fresh per-intent IDs', async () => {
    const f = fixture();
    await f.teams.updateTaskFields(f.key, 'TEST-task', { description: '' });
    await f.teams.updateTaskOwner(f.key, 'TEST-task', 'alice');
    await f.teams.updateTaskStatus(f.key, 'TEST-task', 'in_progress');
    await f.teams.softDeleteTask(f.key, 'TEST-task');
    await f.teams.restoreTask(f.key, 'TEST-task');
    const comment = await f.teams.addTaskComment(f.key, 'TEST-task', {
      text: 'comment',
      attachments: [],
    });
    expect(comment.taskRefs?.[0].teamName).toBe(f.key);
    expect(
      await f.teams.sendMessage(f.key, { member: 'alice', text: 'message', attachments: [] })
    ).toEqual({ deliveredToInbox: true, messageId: 'TEST-authoritative-message' });
    const commands = f.invoke.mock.calls
      .map(([r]) => r)
      .filter((r) => r.operation !== 'team.snapshot');
    expect(commands.map((r) => r.operation)).toEqual([
      'task.update',
      'task.assign',
      'task.lifecycle',
      'task.lifecycle',
      'task.lifecycle',
      'task.comment',
      'message.send',
    ]);
    expect(new Set(commands.map((r) => r.commandId)).size).toBe(7);
    expect(commands.every((r) => r.handle.handleId === 'TEST-A')).toBe(true);
    expect(f.legacy.sendMessage).not.toHaveBeenCalled();
  });
  it('routes clear-assignee and the existing Create Task related/prompt/immediate choices to one captured owner', async () => {
    const f = fixture();
    const prompt = createEncodedTaskReference('1', 'TEST-task', f.key);
    const request = {
      subject: 'TEST richer task',
      owner: 'alice',
      related: ['TEST-task'],
      prompt,
      promptTaskRefs: [{ taskId: 'TEST-task', displayId: '1', teamName: f.key }],
      startImmediately: true,
      command: { commandId: 'TEST-rich-create', idempotencyKey: 'TEST-rich-create' },
    };
    await f.teams.createTask(f.key, request);
    await f.teams.createTask(f.key, request);
    await f.teams.updateTaskOwner(f.key, 'TEST-task', null);
    const commands = f.invoke.mock.calls
      .map(([request]) => request)
      .filter(
        (request) => request.operation === 'task.create' || request.operation === 'task.assign'
      );
    expect(commands[0]).toEqual({
      handle: { handleId: 'TEST-A' },
      commandId: 'TEST-rich-create',
      operation: 'task.create',
      payload: {
        subject: request.subject,
        owner: 'alice',
        related: ['TEST-task'],
        prompt: createEncodedTaskReference('1', 'TEST-task', 'actual-team'),
        promptTaskRefs: [{ taskId: 'TEST-task', displayId: '1', teamName: 'actual-team' }],
        startImmediately: true,
      },
    });
    expect(commands[1]).toEqual(commands[0]);
    expect(commands[2]).toMatchObject({
      handle: { handleId: 'TEST-A' },
      operation: 'task.assign',
      payload: { taskId: 'TEST-task', owner: null },
    });
    expect(f.legacy.createTask).not.toHaveBeenCalled();
    expect(f.legacy.updateTaskOwner).not.toHaveBeenCalled();
  });

  it('rejects cross-owner prompt refs before dispatch and keeps UNKNOWN on the original stable Create command', async () => {
    const f = fixture();
    await expect(
      f.teams.createTask(f.key, {
        subject: 'TEST foreign',
        promptTaskRefs: [{ taskId: 'TEST-task', displayId: '1', teamName: 'host-team:TEST-other' }],
      })
    ).rejects.toMatchObject({ code: 'unsupported', outcome: 'not-dispatched' });
    expect(f.invoke).not.toHaveBeenCalled();
    const actual = f.backend.invoke;
    f.backend.invoke = vi.fn(async (request) =>
      request.operation === 'team.snapshot'
        ? actual(request)
        : { ok: false, code: 'hold', outcome: 'unknown' }
    );
    await expect(
      createHostTeamsApi(f.legacy, f.backend).createTask(f.key, {
        subject: 'TEST uncertain',
        prompt: 'TEST instructions',
        command: { commandId: 'TEST-original-create', idempotencyKey: 'TEST-original-create' },
      })
    ).rejects.toMatchObject({ outcome: 'unknown', commandId: 'TEST-original-create' });
    expect(f.legacy.createTask).not.toHaveBeenCalled();
  });

  it('rejects meaningful unsupported options and distinct legacy idempotency keys before any read/send', async () => {
    const f = fixture();
    for (const request of [{ subject: 'x', command: { commandId: 'A', idempotencyKey: 'B' } }])
      await expect(f.teams.createTask(f.key, request)).rejects.toMatchObject({
        code: 'unsupported',
        outcome: 'not-dispatched',
      });
    await expect(
      f.teams.sendMessage(f.key, {
        member: 'alice',
        text: 'x',
        messageId: 'optimistic',
        actionMode: 'do',
        summary: 'x',
        conversationId: 'unsupported-thread',
      })
    ).rejects.toMatchObject({ code: 'unsupported' });
    expect(f.invoke).not.toHaveBeenCalled();
  });
  it('routes existing task review UI to the captured owner and preserves uncertainty without legacy writes', async () => {
    const f = fixture();
    const teams = createHostTeamsApi(f.legacy, f.backend);
    await teams.requestReview(f.key, 'TEST-task');
    await teams.updateKanban(f.key, 'TEST-task', { op: 'set_column', column: 'review' });
    await teams.updateKanban(f.key, 'TEST-task', { op: 'set_column', column: 'approved' });
    await teams.updateKanban(f.key, 'TEST-task', {
      op: 'request_changes',
      comment: 'Fix this',
      taskRefs: [{ taskId: 'TEST-task', displayId: '1', teamName: f.key }],
    });
    const writes = f.invoke.mock.calls
      .map(([request]) => request)
      .filter((request) => request.operation === 'task.review');
    expect(writes.map((request) => request.payload)).toEqual([
      { taskId: 'TEST-task', action: 'request' },
      { taskId: 'TEST-task', action: 'request' },
      { taskId: 'TEST-task', action: 'approve', notifyOwner: true, suppressTaskComment: true },
      {
        taskId: 'TEST-task',
        action: 'request_changes',
        comment: 'Fix this',
        taskRefs: [{ taskId: 'TEST-task', displayId: '1', teamName: 'actual-team' }],
      },
    ]);
    const original = f.backend.invoke;
    f.backend.invoke = vi.fn(async (request) =>
      request.operation === 'team.snapshot'
        ? original(request)
        : { ok: false, code: 'hold', outcome: 'unknown' }
    );
    await expect(teams.requestReview(f.key, 'TEST-task')).rejects.toMatchObject({
      outcome: 'unknown',
      commandId: expect.any(String),
    });
    expect(
      vi
        .mocked(f.backend.invoke)
        .mock.calls.filter(([request]) => request.operation === 'task.review')
    ).toHaveLength(1);
    expect(f.legacy.requestReview).not.toHaveBeenCalled();
    expect(f.legacy.updateKanban).not.toHaveBeenCalled();
  });
  it('preserves UNKNOWN and command identity on lost responses without a retry or legacy fallback', async () => {
    const f = fixture();
    const original = f.backend.invoke;
    f.backend.invoke = vi.fn(async (request) =>
      request.operation === 'team.snapshot'
        ? original(request)
        : { ok: false, code: 'hold', outcome: 'unknown' }
    );
    const teams = createHostTeamsApi(f.legacy, f.backend);
    await expect(
      teams.createTask(f.key, {
        subject: 'x',
        command: { commandId: 'TEST-once', idempotencyKey: 'TEST-once' },
      })
    ).rejects.toMatchObject({ code: 'hold', outcome: 'unknown', commandId: 'TEST-once' });
    expect(
      vi.mocked(f.backend.invoke).mock.calls.filter(([r]) => r.operation === 'task.create')
    ).toHaveLength(1);
    expect(f.legacy.createTask).not.toHaveBeenCalled();
  });
  it('seals a delayed target lookup before mutation when the renderer context changes', async () => {
    const f = fixture();
    let current = true;
    f.backend.getConnections.mockImplementation(async () => {
      current = false;
      return { state: 'ready', bindings: [] };
    });
    const teams = createHostTeamsApi(f.legacy, f.backend, () => () => current);
    await expect(teams.updateTaskStatus(f.key, '1', 'completed')).rejects.toThrow(
      'context changed'
    );
    expect(f.invoke).not.toHaveBeenCalled();
  });
});

it('routes existing kanban remove once, preserves UNKNOWN/refusal and never writes through legacy', async () => {
  const f = fixture();
  await f.teams.updateKanban(f.key, 'TEST-task', { op: 'remove' });
  const commands = f.invoke.mock.calls
    .map(([request]) => request)
    .filter((request) => request.operation !== 'team.snapshot');
  expect(commands).toHaveLength(1);
  expect(commands[0]).toMatchObject({
    operation: 'task.board.clear',
    payload: { taskId: 'TEST-task' },
  });
  await expect(
    f.teams.updateKanban(f.key, 'TEST-task', {
      op: 'remove',
      transition: 'status_reset',
    } as never)
  ).rejects.toMatchObject({ code: 'unsupported', outcome: 'not-dispatched' });
  expect(
    f.invoke.mock.calls.filter(([request]) => request.operation !== 'team.snapshot')
  ).toHaveLength(1);
  const original = f.backend.invoke;
  for (const outcome of ['unknown', 'not-dispatched'] as const) {
    f.backend.invoke = vi.fn(async (request) =>
      request.operation === 'team.snapshot'
        ? original(request)
        : { ok: false, code: 'hold', outcome }
    );
    const teams = createHostTeamsApi(f.legacy, f.backend);
    await expect(teams.updateKanban(f.key, 'TEST-task', { op: 'remove' })).rejects.toMatchObject({
      code: 'hold',
      outcome,
      commandId: expect.any(String),
    });
    expect(
      vi
        .mocked(f.backend.invoke)
        .mock.calls.filter(([request]) => request.operation !== 'team.snapshot')
    ).toHaveLength(1);
  }
  expect(f.legacy.updateKanban).not.toHaveBeenCalled();
  expect(f.legacy.updateTaskStatus).not.toHaveBeenCalled();
});

it('routes Disapprove as one explicit review command while generic remove retains its guarded contract', async () => {
  const f = fixture();
  await f.teams.updateKanban(f.key, 'TEST-task', { op: 'disapprove' });
  const commands = f.invoke.mock.calls
    .map(([request]) => request)
    .filter((request) => request.operation !== 'team.snapshot');
  expect(commands).toHaveLength(1);
  expect(commands[0]).toMatchObject({
    operation: 'task.review',
    payload: { taskId: 'TEST-task', action: 'disapprove' },
  });
  expect(f.legacy.updateKanban).not.toHaveBeenCalled();
  await expect(
    f.teams.updateKanban(f.key, 'TEST-task', { op: 'disapprove', from: 'user' } as never)
  ).rejects.toThrow();
  expect(
    f.invoke.mock.calls.filter(([request]) => request.operation !== 'team.snapshot')
  ).toHaveLength(1);
});
