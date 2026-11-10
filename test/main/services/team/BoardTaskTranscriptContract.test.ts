import { describe, expect, it } from 'vitest';
import fixture from '../../../fixtures/team/board-task-activity-message-v1.json';

import {
  parseBoardTaskLinks,
  parseBoardTaskToolActions,
} from '../../../../src/main/services/team/taskLogs/contract/BoardTaskTranscriptContract';

describe('BoardTaskTranscriptContract', () => {
  it('salvages valid board-task links from mixed payloads', () => {
    const parsed = parseBoardTaskLinks([
      null,
      {
        schemaVersion: 1,
        task: { ref: 'abcd1234', refKind: 'display', canonicalId: 'task-a' },
        targetRole: 'subject',
        linkKind: 'lifecycle',
        actorContext: { relation: 'idle' },
      },
      {
        schemaVersion: 1,
        task: { ref: '', refKind: 'display' },
        targetRole: 'subject',
        linkKind: 'lifecycle',
        actorContext: { relation: 'idle' },
      },
    ]);

    expect(parsed).toEqual([
      {
        schemaVersion: 1,
        task: { ref: 'abcd1234', refKind: 'display', canonicalId: 'task-a' },
        targetRole: 'subject',
        linkKind: 'lifecycle',
        actorContext: { relation: 'idle' },
      },
    ]);
  });

  it('salvages valid task tool actions from mixed payloads', () => {
    const parsed = parseBoardTaskToolActions([
      {
        schemaVersion: 1,
        toolUseId: 'tool-1',
        canonicalToolName: 'task_add_comment',
        resultRefs: { commentId: 'comment-1' },
      },
      {
        schemaVersion: 1,
        canonicalToolName: 'task_add_comment',
      },
    ]);

    expect(parsed).toEqual([
      {
        schemaVersion: 1,
        toolUseId: 'tool-1',
        canonicalToolName: 'task_add_comment',
        resultRefs: { commentId: 'comment-1' },
      },
    ]);
  });

  it('parses the documented fixture example', () => {
    expect(parseBoardTaskLinks(fixture.boardTaskLinks)).toEqual([
      {
        schemaVersion: 1,
        toolUseId: 'tool-1',
        task: {
          ref: 'abcd1234',
          refKind: 'display',
          canonicalId: '123e4567-e89b-12d3-a456-426614174000',
        },
        targetRole: 'subject',
        linkKind: 'lifecycle',
        taskArgumentSlot: 'taskId',
        actorContext: { relation: 'idle' },
      },
    ]);

    expect(parseBoardTaskToolActions(fixture.boardTaskToolActions)).toEqual([
      {
        schemaVersion: 1,
        toolUseId: 'tool-1',
        canonicalToolName: 'task_add_comment',
        resultRefs: { commentId: 'comment-1' },
      },
    ]);
  });

  it('preserves semantic null owner and clarification values', () => {
    const parsed = parseBoardTaskToolActions([
      {
        schemaVersion: 1,
        toolUseId: 'tool-2',
        canonicalToolName: 'task_set_owner',
        input: { owner: null },
      },
      {
        schemaVersion: 1,
        toolUseId: 'tool-3',
        canonicalToolName: 'task_set_clarification',
        input: { clarification: 'clear' },
      },
    ]);

    expect(parsed).toEqual([
      {
        schemaVersion: 1,
        toolUseId: 'tool-2',
        canonicalToolName: 'task_set_owner',
        input: { owner: null },
      },
      {
        schemaVersion: 1,
        toolUseId: 'tool-3',
        canonicalToolName: 'task_set_clarification',
        input: { clarification: null },
      },
    ]);
  });

  it('accepts legacy version fields while preferring schemaVersion going forward', () => {
    const parsed = parseBoardTaskLinks([
      {
        version: 1,
        task: { ref: 'abcd1234', refKind: 'display' },
        targetRole: 'subject',
        linkKind: 'execution',
        actorContext: { relation: 'same_task' },
      },
    ]);

    expect(parsed).toEqual([
      {
        schemaVersion: 1,
        task: { ref: 'abcd1234', refKind: 'display' },
        targetRole: 'subject',
        linkKind: 'execution',
        actorContext: { relation: 'same_task' },
      },
    ]);
  });

  it('sanitizes impossible actor scope details unless relation is other_active_task', () => {
    const parsed = parseBoardTaskLinks([
      {
        schemaVersion: 1,
        task: { ref: 'abcd1234', refKind: 'display' },
        targetRole: 'subject',
        linkKind: 'execution',
        actorContext: {
          relation: 'same_task',
          activeTask: { ref: 'efgh5678', refKind: 'display' },
          activePhase: 'work',
          activeExecutionSeq: 2,
        },
      },
    ]);

    expect(parsed).toEqual([
      {
        schemaVersion: 1,
        task: { ref: 'abcd1234', refKind: 'display' },
        targetRole: 'subject',
        linkKind: 'execution',
        actorContext: { relation: 'same_task' },
      },
    ]);
  });

  it('preserves execution toolUseId while still dropping execution taskArgumentSlot', () => {
    const parsed = parseBoardTaskLinks([
      {
        schemaVersion: 1,
        toolUseId: 'tool-1',
        task: { ref: 'abcd1234', refKind: 'display' },
        targetRole: 'subject',
        linkKind: 'execution',
        taskArgumentSlot: 'taskId',
        actorContext: { relation: 'same_task' },
      },
    ]);

    expect(parsed).toEqual([
      {
        schemaVersion: 1,
        toolUseId: 'tool-1',
        task: { ref: 'abcd1234', refKind: 'display' },
        targetRole: 'subject',
        linkKind: 'execution',
        actorContext: { relation: 'same_task' },
      },
    ]);
  });
});
