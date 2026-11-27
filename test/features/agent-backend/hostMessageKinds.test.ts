// @vitest-environment node
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFilesystemTeamOwner } from '@agent-teams/legacy-agent-host/team/filesystem';
import { filterTeamMessages } from '@renderer/utils/teamMessageFiltering';
import { afterEach, describe, expect, it } from 'vitest';

import { projectTeamMessagesPage } from '../../../src/features/agent-backend/main/adapters/output/projectTeamMessagesPage';
import { projectTeamSnapshot } from '../../../src/features/agent-backend/main/adapters/output/projectTeamSnapshot';

import type { InboxMessageKind } from '@shared/types/team';

const teamName = 'test-message-kinds';
const revision = 'a'.repeat(64);
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

const readers = {
  snapshot(messages: unknown[]) {
    return projectTeamSnapshot({
      teamName,
      revision,
      feed: {
        streamId: '11111111-1111-4111-8111-111111111111',
        cursor: '22222222-2222-4222-8222-222222222222',
        sequence: 0,
      },
      members: [],
      tasks: [],
      messages,
      kanbanState: { teamName, reviewers: [], tasks: {} },
    }).messages;
  },
  page(messages: unknown[]) {
    return projectTeamMessagesPage({
      teamName,
      revision,
      messages,
      hasMore: false,
      nextCursor: null,
    }).messages;
  },
};
const message = {
  from: 'user',
  to: 'worker',
  text: 'TEST original message',
  timestamp: '2026-11-27T00:00:00.000Z',
  read: false,
  source: 'system_notification',
  messageId: 'TEST-message',
};
const kinds = {
  default: true,
  slash_command: true,
  slash_command_result: true,
  task_comment_notification: true,
  task_stall_remediation: true,
  member_work_sync_nudge: true,
  runtime_recovery_nudge: true,
  agent_error: true,
} satisfies Record<InboxMessageKind, true>;

describe.each(Object.entries(readers))('Host %s message semantics', (_name, read) => {
  it.each(Object.keys(kinds))('preserves the validated %s kind', (messageKind) => {
    expect(read([{ ...message, messageKind, privateReceipt: 'PRIVATE' }])).toEqual([
      { ...message, messageKind },
    ]);
  });

  it('retains an ordinary message without inventing a semantic kind', () => {
    expect(read([message])).toEqual([message]);
  });

  it.each([null, true, 1, {}, [], '', 'unknown', 'task_comment_notification\0'])(
    'rejects an invalid present kind: %j',
    (messageKind) => {
      expect(() => read([{ ...message, messageKind }])).toThrow('Invalid snapshot');
    }
  );
});

it('keeps the original clarification answer notice hidden after both Host reads', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-host-message-kinds-')));
  roots.push(root);
  const owner = createFilesystemTeamOwner({
    root,
    binding: { backendId: 'TEST-backend', teamId: 'TEST-team', teamName },
    members: [
      { memberId: 'TEST-lead', name: 'lead', role: 'lead' },
      { memberId: 'TEST-worker', name: 'worker', role: 'member' },
    ],
    grants: [
      {
        principalId: 'TEST-human',
        memberName: 'user',
        permissions: ['read', 'task.write', 'message.write', 'admin'],
      },
      {
        principalId: 'TEST-worker',
        memberName: 'worker',
        permissions: ['read', 'message.write'],
      },
    ],
  });
  const human = owner.connect('TEST-human');
  const taskId = human.execute({
    commandId: 'TEST-create',
    operation: 'task.create',
    payload: { subject: 'TEST decision', owner: 'worker', startImmediately: false },
  }).effects.taskId;
  human.execute({
    commandId: 'TEST-question',
    operation: 'task.clarification',
    payload: { taskId, value: 'user' },
  });
  const answer = human.execute({
    commandId: 'TEST-answer',
    operation: 'task.comment',
    payload: {
      taskId,
      text: 'TEST accepted answer',
      answerClarificationRequestId: String(human.getTask(taskId).clarificationRequestId),
    },
  });
  expect(answer.phase).toBe('completed');
  const visible = owner.connect('TEST-worker').execute({
    commandId: 'TEST-visible',
    operation: 'message.send',
    payload: { to: 'user', text: 'TEST ordinary teammate reply' },
  });
  expect(visible.phase).toBe('completed');

  const projected = [
    projectTeamSnapshot(human.readSnapshot()).messages,
    projectTeamMessagesPage(human.readMessagesPage()).messages,
  ];
  for (const messages of projected) {
    const notice = messages.find((entry) => entry.commentId === answer.effects.commentId);
    expect(notice).toMatchObject({ messageKind: 'task_comment_notification' });
    const filtered = filterTeamMessages(messages, {
      filter: { from: new Set(), to: new Set(), showNoise: true },
      searchQuery: '',
      includeAutomationEvents: true,
      includeMemberWorkSyncNudges: true,
    });
    expect(filtered.some((entry) => entry.commentId === answer.effects.commentId)).toBe(false);
    expect(filtered.some((entry) => entry.messageId === visible.effects.messageId)).toBe(true);
  }
});
