import { describe, expect, it } from 'vitest';

import {
  buildAttentionModel,
  conversationForAttentionMessage,
} from '../../../../src/features/user-attention/core/domain/buildAttention';
import {
  projectAttentionMessage,
  projectAttentionTasks,
} from '../../../../src/features/user-attention/core/domain/projectAttention';

import type { AttentionSnapshot } from '../../../../src/features/user-attention/contracts';
import type { InboxMessage, TeamTask } from '../../../../src/shared/types/team';

const message = (
  id: string,
  from: string,
  to: string,
  text: string,
  extra: Partial<InboxMessage> = {}
): InboxMessage => ({
  messageId: id,
  from,
  to,
  text,
  timestamp: '2026-11-23T12:00:00Z',
  read: false,
  ...extra,
});

describe('Attention Inbox pure domain', () => {
  it('selects awaiting human, not lead or dependency blockers; keeps more than 500 tasks', () => {
    const tasks: TeamTask[] = Array.from({ length: 520 }, (_, i) => ({
      id: `task-${i}`,
      subject: `Task ${i}`,
      status: 'in_progress',
      needsClarification: 'user',
      clarificationRequestedAt: '2026-11-23T11:00:00Z',
    }));
    tasks.push(
      { id: 'lead', subject: 'Lead', status: 'pending', needsClarification: 'lead' },
      { id: 'blocked', subject: 'Blocked', status: 'pending', blockedBy: ['lead'] },
      { id: 'deleted', subject: 'Deleted', status: 'deleted', needsClarification: 'user' },
    );
    const candidates = projectAttentionTasks(tasks, { teamName: 'team-1', displayName: 'Team 1' });
    expect(candidates).toHaveLength(520);
    expect(candidates[519].taskId).toBe('task-519');
    expect(candidates[0].requestedAt).toBe('2026-11-23T11:00:00Z');
  });

  it('keeps direct user messages and explicit group mentions, not agent chatter or group copies', () => {
    expect(projectAttentionMessage(message('dm', 'alice', 'user', 'Need your answer'))).not.toBeNull();
    expect(projectAttentionMessage(message('internal', 'alice', 'team-lead', 'Hello'))).toBeNull();
    expect(projectAttentionMessage(message('out', 'user', 'alice', 'Hello'))).toBeNull();
    expect(projectAttentionMessage(message('copy', 'alice', 'user', 'Hi', {
      groupChatId: 'g1', groupMessageId: 'copy',
    }))).toBeNull();
    expect(projectAttentionMessage(message('mention', 'alice', 'user', '@user choose A', {
      groupChatId: 'g1', groupMessageId: 'mention',
    }))).not.toBeNull();
  });

  it('does not double count team feed vs direct, and honors the existing read set', () => {
    const dm = message('dm1', 'alice', 'user', 'Please approve');
    const group = message('group1', 'alice', 'user', '@user please respond', {
      groupChatId: 'g1', groupMessageId: 'group1',
    });
    const snapshot: AttentionSnapshot = {
      contextId: 'local',
      complete: true,
      teams: [{
        teamName: 'one',
        teamDisplayName: 'One',
        tasks: [],
        messages: [dm, dm, group],
      }],
    };
    const unread = buildAttentionModel(snapshot, () => ({
      direct: new Set(),
      group: new Set(),
    }), (m) => m.messageId ?? '');
    expect(unread.unreadMessageCount).toBe(2);
    expect(unread.chatCount).toBe(2);
    expect(unread.chats.some((c) => c.scope.kind === 'team-feed')).toBe(false);

    const afterRead = buildAttentionModel(snapshot, () => ({
      direct: new Set(['dm1']),
      group: new Set(['group1']),
    }), (m) => m.messageId ?? '');
    expect(afterRead.unreadMessageCount).toBe(0);
    expect(afterRead.chatCount).toBe(0);
  });

  it('uses group scope for mentions and direct scope for human-addressed teammate messages', () => {
    expect(conversationForAttentionMessage(message('m', 'alice', 'user', 'Hi')).scope)
      .toEqual({ kind: 'direct', participant: 'alice' });
    expect(conversationForAttentionMessage(message('g', 'alice', 'user', '@user hi', {
      groupChatId: 'general', groupMessageId: 'g',
    })).scope).toEqual({ kind: 'group', groupChatId: 'general' });
  });

  it('includes stopped team entries, counts unique tasks and sorts chats by latest unread', () => {
    const snapshot: AttentionSnapshot = {
      contextId: 'local',
      complete: true,
      teams: [{
        teamName: 'stopped',
        teamDisplayName: 'Stopped',
        tasks: [{
          teamName: 'stopped', teamDisplayName: 'Stopped', taskId: 't1',
          subject: 'Choose strategy', requestedAt: null,
        }, {
          teamName: 'stopped', teamDisplayName: 'Stopped', taskId: 't1',
          subject: 'Choose strategy', requestedAt: null,
        }],
        messages: [message('new', 'alice', 'user', 'New', {
          timestamp: '2026-11-23T15:00:00Z',
        }), message('old', 'bob', 'user', 'Old', {
          timestamp: '2026-11-23T11:00:00Z',
        })],
      }],
    };
    const model = buildAttentionModel(snapshot, () => ({
      direct: new Set(), group: new Set(),
    }), (m) => m.messageId ?? '');
    expect(model.taskCount).toBe(1);
    expect(model.chatCount).toBe(2);
    expect(model.chats[0].name).toBe('alice');
    expect(model.countsByTeam.get('stopped')).toEqual({ tasks: 1, chats: 2 });
  });
});
