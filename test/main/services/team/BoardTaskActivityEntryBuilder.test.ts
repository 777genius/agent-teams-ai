import { describe, expect, it } from 'vitest';

import { BoardTaskActivityEntryBuilder } from '../../../../src/main/services/team/taskLogs/activity/BoardTaskActivityEntryBuilder';

import type { TeamTask } from '../../../../src/shared/types/team';
import type { RawTaskActivityMessage } from '../../../../src/main/services/team/taskLogs/activity/BoardTaskActivityTranscriptReader';

function makeTask(task: Partial<TeamTask> & Pick<TeamTask, 'id' | 'subject' | 'status'>): TeamTask {
  return {
    displayId: task.displayId ?? task.id.slice(0, 8),
    createdAt: '2026-04-12T10:00:00.000Z',
    updatedAt: '2026-04-12T10:00:00.000Z',
    ...task,
  };
}

describe('BoardTaskActivityEntryBuilder', () => {
  it('builds same-task execution rows and external board actions', () => {
    const taskA = makeTask({
      id: '123e4567-e89b-12d3-a456-426614174000',
      displayId: 'abcd1234',
      subject: 'Task A',
      status: 'in_progress',
    });
    const taskB = makeTask({
      id: '123e4567-e89b-12d3-a456-426614174001',
      displayId: 'efgh5678',
      subject: 'Task B',
      status: 'pending',
    });

    const messages: RawTaskActivityMessage[] = [
      {
        filePath: '/tmp/a.jsonl',
        uuid: 'msg-1',
        timestamp: '2026-04-12T10:00:00.000Z',
        sessionId: 'session-1',
        agentId: 'agent-a',
        agentName: 'alice',
        isSidechain: true,
        sourceOrder: 1,
        boardTaskLinks: [
          {
            schemaVersion: 1,
            task: { ref: 'abcd1234', refKind: 'display', canonicalId: taskA.id },
            targetRole: 'subject',
            linkKind: 'execution',
            actorContext: { relation: 'same_task' },
          },
        ],
        boardTaskToolActions: [],
      },
      {
        filePath: '/tmp/b.jsonl',
        uuid: 'msg-2',
        timestamp: '2026-04-12T10:01:00.000Z',
        sessionId: 'session-1',
        agentId: 'agent-a',
        agentName: 'alice',
        isSidechain: true,
        sourceOrder: 2,
        boardTaskLinks: [
          {
            schemaVersion: 1,
            toolUseId: 'tool-2',
            task: { ref: 'abcd1234', refKind: 'display', canonicalId: taskA.id },
            targetRole: 'subject',
            linkKind: 'board_action',
            actorContext: {
              relation: 'other_active_task',
              activeTask: { ref: 'efgh5678', refKind: 'display', canonicalId: taskB.id },
              activePhase: 'work',
              activeExecutionSeq: 2,
            },
          },
        ],
        boardTaskToolActions: [
          {
            schemaVersion: 1,
            toolUseId: 'tool-2',
            canonicalToolName: 'task_add_comment',
            resultRefs: { commentId: 'comment-1' },
          },
        ],
      },
    ];

    const entries = new BoardTaskActivityEntryBuilder().buildForTask({
      teamName: 'demo',
      targetTask: taskA,
      tasks: [taskA, taskB],
      messages,
    });

    expect(entries).toHaveLength(2);
    expect(entries[0]?.linkKind).toBe('execution');
    expect(entries[1]?.actorContext.relation).toBe('other_active_task');
    expect(entries[1]?.action?.canonicalToolName).toBe('task_add_comment');
    expect(entries[1]?.action?.category).toBe('comment');
    expect(entries[1]?.action?.details?.commentId).toBe('comment-1');
  });

  it('marks display-id collisions as ambiguous instead of guessing', () => {
    const liveTask = makeTask({
      id: '123e4567-e89b-12d3-a456-426614174000',
      displayId: 'abcd1234',
      subject: 'Live task',
      status: 'in_progress',
    });
    const deletedTask = makeTask({
      id: '123e4567-e89b-12d3-a456-426614174099',
      displayId: 'abcd1234',
      subject: 'Deleted task',
      status: 'deleted',
    });

    const messages: RawTaskActivityMessage[] = [
      {
        filePath: '/tmp/a.jsonl',
        uuid: 'msg-1',
        timestamp: '2026-04-12T10:00:00.000Z',
        sessionId: 'session-1',
        isSidechain: true,
        sourceOrder: 1,
        boardTaskLinks: [
          {
            schemaVersion: 1,
            task: { ref: 'abcd1234', refKind: 'display' },
            targetRole: 'subject',
            linkKind: 'board_action',
            actorContext: { relation: 'idle' },
          },
        ],
        boardTaskToolActions: [],
      },
    ];

    const entries = new BoardTaskActivityEntryBuilder().buildForTask({
      teamName: 'demo',
      targetTask: liveTask,
      tasks: [liveTask, deletedTask],
      messages,
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]?.task.resolution).toBe('ambiguous');
  });

  it('preserves deleted peer tasks on relationship rows', () => {
    const taskA = makeTask({
      id: '123e4567-e89b-12d3-a456-426614174000',
      displayId: 'abcd1234',
      subject: 'Task A',
      status: 'in_progress',
    });
    const deletedPeer = makeTask({
      id: '123e4567-e89b-12d3-a456-426614174002',
      displayId: 'ijkl9012',
      subject: 'Task B',
      status: 'deleted',
    });

    const messages: RawTaskActivityMessage[] = [
      {
        filePath: '/tmp/relationships.jsonl',
        uuid: 'msg-3',
        timestamp: '2026-04-12T10:00:00.000Z',
        sessionId: 'session-1',
        agentName: 'lead',
        isSidechain: false,
        sourceOrder: 1,
        boardTaskLinks: [
          {
            schemaVersion: 1,
            toolUseId: 'tool-3',
            task: { ref: 'abcd1234', refKind: 'display', canonicalId: taskA.id },
            targetRole: 'subject',
            linkKind: 'board_action',
            actorContext: { relation: 'idle' },
          },
          {
            schemaVersion: 1,
            toolUseId: 'tool-3',
            task: { ref: 'ijkl9012', refKind: 'display', canonicalId: deletedPeer.id },
            targetRole: 'related',
            linkKind: 'board_action',
            actorContext: { relation: 'idle' },
          },
        ],
        boardTaskToolActions: [
          {
            schemaVersion: 1,
            toolUseId: 'tool-3',
            canonicalToolName: 'task_link',
            input: { relationship: 'related' },
          },
        ],
      },
    ];

    const entries = new BoardTaskActivityEntryBuilder().buildForTask({
      teamName: 'demo',
      targetTask: taskA,
      tasks: [taskA, deletedPeer],
      messages,
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]?.action?.peerTask?.resolution).toBe('deleted');
    expect(entries[0]?.action?.details?.relationship).toBe('related');
    expect(entries[0]?.action?.category).toBe('relationship');
    expect(entries[0]?.action?.relationshipPerspective).toBe('symmetric');
  });

  it('resolves display locators case-insensitively and canonical-like unknown refs safely', () => {
    const taskA = makeTask({
      id: '123e4567-e89b-12d3-a456-426614174000',
      displayId: 'abcd1234',
      subject: 'Task A',
      status: 'in_progress',
    });

    const messages: RawTaskActivityMessage[] = [
      {
        filePath: '/tmp/case.jsonl',
        uuid: 'msg-4',
        timestamp: '2026-04-12T10:00:00.000Z',
        sessionId: 'session-1',
        isSidechain: false,
        sourceOrder: 1,
        boardTaskLinks: [
          {
            schemaVersion: 1,
            task: { ref: 'ABCD1234', refKind: 'display' },
            targetRole: 'subject',
            linkKind: 'board_action',
            actorContext: { relation: 'idle' },
          },
          {
            schemaVersion: 1,
            task: { ref: taskA.id, refKind: 'unknown' },
            targetRole: 'subject',
            linkKind: 'execution',
            actorContext: { relation: 'same_task' },
          },
        ],
        boardTaskToolActions: [],
      },
    ];

    const entries = new BoardTaskActivityEntryBuilder().buildForTask({
      teamName: 'demo',
      targetTask: taskA,
      tasks: [taskA],
      messages,
    });

    expect(entries).toHaveLength(2);
    expect(entries[0]?.task.resolution).toBe('resolved');
    expect(entries[1]?.task.resolution).toBe('resolved');
  });

  it('marks main-session actor without explicit name as unknown instead of forcing lead', () => {
    const taskA = makeTask({
      id: '123e4567-e89b-12d3-a456-426614174000',
      displayId: 'abcd1234',
      subject: 'Task A',
      status: 'in_progress',
    });

    const messages: RawTaskActivityMessage[] = [
      {
        filePath: '/tmp/unknown-actor.jsonl',
        uuid: 'msg-5',
        timestamp: '2026-04-12T10:00:00.000Z',
        sessionId: 'session-1',
        isSidechain: false,
        sourceOrder: 1,
        boardTaskLinks: [
          {
            schemaVersion: 1,
            task: { ref: 'abcd1234', refKind: 'display', canonicalId: taskA.id },
            targetRole: 'subject',
            linkKind: 'board_action',
            actorContext: { relation: 'idle' },
          },
        ],
        boardTaskToolActions: [],
      },
    ];

    const entries = new BoardTaskActivityEntryBuilder().buildForTask({
      teamName: 'demo',
      targetTask: taskA,
      tasks: [taskA],
      messages,
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]?.actor.role).toBe('unknown');
  });

  it('never joins action payloads onto execution rows', () => {
    const taskA = makeTask({
      id: '123e4567-e89b-12d3-a456-426614174000',
      displayId: 'abcd1234',
      subject: 'Task A',
      status: 'in_progress',
    });

    const messages: RawTaskActivityMessage[] = [
      {
        filePath: '/tmp/execution-malformed.jsonl',
        uuid: 'msg-6',
        timestamp: '2026-04-12T10:00:00.000Z',
        sessionId: 'session-1',
        agentId: 'agent-a',
        agentName: 'alice',
        isSidechain: true,
        sourceOrder: 1,
        boardTaskLinks: [
          {
            schemaVersion: 1,
            toolUseId: 'tool-1',
            task: { ref: 'abcd1234', refKind: 'display', canonicalId: taskA.id },
            targetRole: 'subject',
            linkKind: 'execution',
            actorContext: { relation: 'same_task' },
          },
        ],
        boardTaskToolActions: [
          {
            schemaVersion: 1,
            toolUseId: 'tool-1',
            canonicalToolName: 'task_start',
          },
        ],
      },
    ];

    const entries = new BoardTaskActivityEntryBuilder().buildForTask({
      teamName: 'demo',
      targetTask: taskA,
      tasks: [taskA],
      messages,
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]?.linkKind).toBe('execution');
    expect(entries[0]?.action).toBeUndefined();
  });

  it('derives relationship perspective from target role', () => {
    const taskA = makeTask({
      id: '123e4567-e89b-12d3-a456-426614174010',
      displayId: 'taska010',
      subject: 'Task A',
      status: 'in_progress',
    });
    const taskB = makeTask({
      id: '123e4567-e89b-12d3-a456-426614174011',
      displayId: 'taskb011',
      subject: 'Task B',
      status: 'pending',
    });

    const messages: RawTaskActivityMessage[] = [
      {
        filePath: '/tmp/relationship-perspective.jsonl',
        uuid: 'msg-7',
        timestamp: '2026-04-12T10:00:00.000Z',
        sessionId: 'session-1',
        agentName: 'lead',
        isSidechain: false,
        sourceOrder: 1,
        boardTaskLinks: [
          {
            schemaVersion: 1,
            toolUseId: 'tool-7',
            task: { ref: 'taska010', refKind: 'display', canonicalId: taskA.id },
            targetRole: 'subject',
            linkKind: 'board_action',
            actorContext: { relation: 'idle' },
          },
          {
            schemaVersion: 1,
            toolUseId: 'tool-7',
            task: { ref: 'taskb011', refKind: 'display', canonicalId: taskB.id },
            targetRole: 'related',
            linkKind: 'board_action',
            actorContext: { relation: 'idle' },
          },
        ],
        boardTaskToolActions: [
          {
            schemaVersion: 1,
            toolUseId: 'tool-7',
            canonicalToolName: 'task_link',
            input: { relationship: 'blocked-by' },
          },
        ],
      },
    ];

    const builder = new BoardTaskActivityEntryBuilder();
    const entriesForTaskA = builder.buildForTask({
      teamName: 'demo',
      targetTask: taskA,
      tasks: [taskA, taskB],
      messages,
    });
    const entriesForTaskB = builder.buildForTask({
      teamName: 'demo',
      targetTask: taskB,
      tasks: [taskA, taskB],
      messages,
    });

    expect(entriesForTaskA).toHaveLength(1);
    expect(entriesForTaskA[0]?.action?.relationshipPerspective).toBe('incoming');
    expect(entriesForTaskA[0]?.action?.peerTask?.taskRef?.taskId).toBe(taskB.id);

    expect(entriesForTaskB).toHaveLength(1);
    expect(entriesForTaskB[0]?.action?.relationshipPerspective).toBe('outgoing');
    expect(entriesForTaskB[0]?.action?.peerTask?.taskRef?.taskId).toBe(taskA.id);
  });
});
