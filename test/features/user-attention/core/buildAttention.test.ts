import { DEFAULT_TEAM_GROUP_CHAT_ID } from '@features/team-group-chats/contracts';
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

  it('does not count @user inside a hidden agent block as human attention', () => {
    const hidden = message('hidden-mention', 'alice', 'user',
      '<info_for_agent>@user internal</info_for_agent> Regular agent update', {
        groupChatId: 'general', groupMessageId: 'hidden-mention',
      });
    expect(projectAttentionMessage(hidden)).toBeNull();
    const visible = message('visible-mention', 'alice', 'user',
      '<info_for_agent>internal</info_for_agent> Please choose @user', {
        groupChatId: 'general', groupMessageId: 'visible-mention',
      });
    expect(projectAttentionMessage(visible)?.text).toBe('Please choose @user');
  });

  it('retains unread group mentions beyond the 240-character preview', () => {
    const original = message('late-mention', 'alice', 'user', `${'a'.repeat(290)} @user choose one`, {
      groupChatId: 'design', groupMessageId: 'late-mention',
    });
    const candidate = projectAttentionMessage(original);
    expect(candidate?.text.length).toBe(240);
    const snapshot: AttentionSnapshot = {
      contextId: 'local', complete: true,
      teams: [{ teamName: 'team', teamDisplayName: 'Team',
        tasks: [], messages: candidate ? [candidate] : [] }],
    };
    const result = buildAttentionModel(snapshot, () => ({
      direct: new Set(), group: new Set(),
    }), (item) => item.messageId ?? '');
    expect(result.chatCount).toBe(1);
    expect(result.chats[0]?.scope).toEqual({ kind: 'group', groupChatId: 'design' });
  });

  it('preserves the opaque Messenger read key before truncating the preview', () => {
    const candidate = projectAttentionMessage(message(' opaque-id ', 'alice', 'user', 'Read me'));
    expect(candidate?.messageId).toBe(' opaque-id ');
  });

  it('keeps direct attachment-only messages without exposing attachment paths', () => {
    const candidate = projectAttentionMessage(message('file-only', 'alice', 'user', '', {
      attachments: [{ id: 'file1', filename: 'picture.png', mimeType: 'image/png', size: 42,
        filePath: '/private/hidden/path' }],
    }));
    expect(candidate?.text).toBe('Attachment (1)');
    expect(candidate?.attachments).toBeUndefined();
    expect(JSON.stringify(candidate)).not.toContain('/private/hidden/path');
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
        directParticipants: ['alice'],
        tasks: [],
        messages: [dm, dm, group],
        groupNames: { g1: 'Architecture decisions' },
      }],
    };
    const unread = buildAttentionModel(snapshot, () => ({
      direct: new Set(),
      group: new Set(),
    }), (m) => m.messageId ?? '');
    expect(unread.unreadMessageCount).toBe(2);
    expect(unread.chatCount).toBe(2);
    expect(unread.chats.some((c) => c.scope.kind === 'team-feed')).toBe(false);
    expect(unread.chats.find((c) => c.scope.kind === 'group')?.name).toBe('Architecture decisions');

    const afterRead = buildAttentionModel(snapshot, () => ({
      direct: new Set(['dm1']),
      group: new Set(['group1']),
    }), (m) => m.messageId ?? '');
    expect(afterRead.unreadMessageCount).toBe(0);
    expect(afterRead.chatCount).toBe(0);
  });

  it('uses group scope for mentions and direct scope for human-addressed teammate messages', () => {
    expect(conversationForAttentionMessage(message('m', 'alice', 'user', 'Hi'), new Set(['alice'])).scope)
      .toEqual({ kind: 'direct', participant: 'alice' });
    expect(conversationForAttentionMessage(message('g', 'alice', 'user', '@user hi', {
      groupChatId: 'general', groupMessageId: 'g',
    }), new Set()).scope).toEqual({ kind: 'group', groupChatId: 'general' });
  });

  it('routes former and unknown participants to one available team-feed without dropping unread messages', () => {
    const snapshot: AttentionSnapshot = {
      contextId: 'local', complete: true,
      teams: [{
        teamName: 'team', teamDisplayName: 'Team',
        directParticipants: ['alice'], leadName: 'team-lead', tasks: [],
        messages: [
          message('former-1', 'former', 'user', 'An unanswered historical message'),
          message('former-2', 'other-removed', 'user', 'Another historical message'),
          message('active', 'alice', 'user', 'Current teammate'),
          message('lead-1', 'lead', 'user', 'Lead alias'),
          message('lead-2', 'team-lead', 'user', 'Lead canonical name'),
        ],
      }],
    };
    const model = buildAttentionModel(snapshot, () => ({
      direct: new Set(), group: new Set(),
    }), (m) => m.messageId ?? '');
    expect(model.unreadMessageCount).toBe(5);
    expect(model.chatCount).toBe(3);
    expect(model.chats.find((chat) => chat.scope.kind === 'team-feed')?.unreadCount).toBe(2);
    expect(model.chats.find((chat) => chat.scope.kind === 'direct' &&
      chat.scope.participant === 'team-lead')?.unreadCount).toBe(2);
    expect(conversationForAttentionMessage(
      message('unknown', 'former', 'user', 'History'), new Set()
    ).scope).toEqual({ kind: 'team-feed' });
    const afterRead = buildAttentionModel(snapshot, () => ({
      direct: new Set(['former-1', 'former-2']), group: new Set(),
    }), (m) => m.messageId ?? '');
    expect(afterRead.chatCount).toBe(2);
    expect(afterRead.unreadMessageCount).toBe(3);
  });

  it('opens standard-group mentions in the team feed but keeps their group read identity', () => {
    const standard = message('all-mention', 'alice', 'user', '@user choose', {
      groupChatId: DEFAULT_TEAM_GROUP_CHAT_ID, groupMessageId: 'all-mention',
    });
    const custom = message('custom-mention', 'alice', 'user', '@user another choice', {
      groupChatId: 'custom', groupMessageId: 'custom-mention',
    });
    const former = message('former-dm', 'former', 'user', 'Unanswered question');
    const snapshot: AttentionSnapshot = {
      contextId: 'local', complete: true,
      teams: [{
        teamName: 'one', teamDisplayName: 'One', directParticipants: ['alice'], tasks: [],
        messages: [standard, custom, former],
      }],
    };
    const build = (direct: string[], group: string[]) => buildAttentionModel(snapshot, () => ({
      direct: new Set(direct), group: new Set(group),
    }), (m) => m.messageId ?? '');

    const before = build([], []);
    expect(before.chatCount).toBe(2);
    expect(before.unreadMessageCount).toBe(3);
    expect(before.chats.find((chat) => chat.scope.kind === 'team-feed')?.unreadCount).toBe(2);
    expect(before.chats.find((chat) => chat.scope.kind === 'group')?.scope)
      .toEqual({ kind: 'group', groupChatId: 'custom' });
    expect(build(['all-mention'], []).unreadMessageCount).toBe(3);
    expect(build([], ['all-mention']).unreadMessageCount).toBe(2);
    expect(build(['former-dm'], ['all-mention']).chats.map((chat) => chat.scope))
      .toEqual([{ kind: 'group', groupChatId: 'custom' }]);
  });

  it('combines verified execution-alias counts under the logical team', () => {
    const snapshot: AttentionSnapshot = {
      contextId: 'local', complete: true,
      teams: [{
        teamName: 'native-a', logicalTeamName: 'logical', teamDisplayName: 'Logical',
        tasks: [{ teamName: 'native-a', logicalTeamName: 'logical',
          taskId: '1', subject: 'Task A', teamDisplayName: 'Logical', requestedAt: null }],
        messages: [],
      }, {
        teamName: 'native-b', logicalTeamName: 'logical', teamDisplayName: 'Logical',
        tasks: [{ teamName: 'native-b', logicalTeamName: 'logical',
          taskId: '1', subject: 'Task B', teamDisplayName: 'Logical', requestedAt: null }],
        messages: [],
      }],
    };
    const model = buildAttentionModel(snapshot, () => ({ direct: new Set(), group: new Set() }),
      (message) => message.messageId ?? '');
    expect(model.taskCount).toBe(2);
    expect(model.countsByTeam.get('logical')).toEqual({ tasks: 2, chats: 0 });
  });


  it('sorts longest waiting human decisions first, keeping unknown legacy times last', () => {
    const tasks = [
      { teamName: 'one', teamDisplayName: 'One', taskId: 'legacy',
        subject: 'Legacy', requestedAt: null },
      { teamName: 'one', teamDisplayName: 'One', taskId: 'older',
        subject: 'Older', requestedAt: '2026-11-22T10:00:00Z' },
      { teamName: 'one', teamDisplayName: 'One', taskId: 'newest',
        subject: 'Newest', requestedAt: '2026-11-24T10:00:00Z' },
    ];
    const snapshot: AttentionSnapshot = {
      contextId: 'local', complete: true,
      teams: [{ teamName: 'one', teamDisplayName: 'One', tasks, messages: [] }],
    };
    const model = buildAttentionModel(snapshot, () => ({
      direct: new Set(), group: new Set(),
    }), (item) => item.messageId ?? '');
    expect(model.tasks.map((task) => task.taskId)).toEqual(['older', 'newest', 'legacy']);
  });

  it('includes stopped team entries, counts unique tasks and sorts chats by latest unread', () => {
    const snapshot: AttentionSnapshot = {
      contextId: 'local',
      complete: true,
      teams: [{
        teamName: 'stopped',
        teamDisplayName: 'Stopped',
        directParticipants: ['alice', 'bob'],
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
