import {
  conversationScopeKey,
  createDirectScope,
  isAttentionUnread,
  normalizeConversationParticipant,
} from '@features/team-direct-chats';

import type { ConversationScope } from '@features/team-direct-chats';
import type { InboxMessage } from '@shared/types/team';
import type { AttentionSnapshot, AttentionTaskCandidate } from '../../contracts';

export interface AttentionChat {
  teamName: string;
  teamDisplayName: string;
  scope: ConversationScope;
  name: string;
  unreadCount: number;
  latestUnread: InboxMessage;
}

export interface AttentionModel {
  tasks: AttentionTaskCandidate[];
  chats: AttentionChat[];
  taskCount: number;
  chatCount: number;
  unreadMessageCount: number;
  countsByTeam: ReadonlyMap<string, { tasks: number; chats: number }>;
  complete: boolean;
}

export interface AttentionReads {
  direct: ReadonlySet<string>;
  group: ReadonlySet<string>;
}

function timeMs(timestamp: string | null | undefined): number {
  const value = Date.parse(timestamp ?? '');
  return Number.isFinite(value) ? value : 0;
}

/** A human-facing conversation has a single canonical home, never also team-feed. */
export function conversationForAttentionMessage(message: InboxMessage): {
  scope: ConversationScope;
  name: string;
} {
  if (message.groupChatId) {
    return {
      scope: { kind: 'group', groupChatId: message.groupChatId },
      name: 'Group chat',
    };
  }
  const sender = normalizeConversationParticipant(message.from);
  if (!sender || sender.includes('/')) {
    return { scope: { kind: 'team-feed' }, name: 'Team messages' };
  }
  return { scope: createDirectScope(sender), name: message.from };
}

export function buildAttentionModel(
  snapshot: AttentionSnapshot,
  getReads: (teamName: string) => AttentionReads,
  toMessageKey: (message: InboxMessage) => string
): AttentionModel {
  const tasks: AttentionTaskCandidate[] = [];
  const chats: AttentionChat[] = [];
  const countsByTeam = new Map<string, { tasks: number; chats: number }>();
  let unreadMessageCount = 0;

  for (const team of snapshot.teams) {
    const seenTasks = new Set<string>();
    for (const task of team.tasks) {
      if (seenTasks.has(task.taskId)) continue;
      seenTasks.add(task.taskId);
      tasks.push(task);
    }
    const reads = getReads(team.teamName);
    const chatMap = new Map<string, AttentionChat>();
    const seenMessages = new Set<string>();

    for (const message of team.messages) {
      const key = toMessageKey(message);
      if (seenMessages.has(key)) continue;
      seenMessages.add(key);
      const readSet = message.groupChatId ? reads.group : reads.direct;
      if (!isAttentionUnread(message, readSet, toMessageKey)) continue;

      const conversation = conversationForAttentionMessage(message);
      const scopeKey = conversationScopeKey(conversation.scope);
      const entry = chatMap.get(scopeKey);
      if (!entry) {
        chatMap.set(scopeKey, {
          teamName: team.teamName,
          teamDisplayName: team.teamDisplayName,
          scope: conversation.scope,
          name: conversation.name,
          latestUnread: message,
          unreadCount: 1,
        });
      } else {
        entry.unreadCount += 1;
        if (timeMs(message.timestamp) > timeMs(entry.latestUnread.timestamp)) {
          entry.latestUnread = message;
        }
      }
      unreadMessageCount += 1;
    }
    chats.push(...chatMap.values());
    countsByTeam.set(team.teamName, { tasks: seenTasks.size, chats: chatMap.size });
  }

  tasks.sort((a, b) =>
    timeMs(a.requestedAt) - timeMs(b.requestedAt) ||
    a.teamName.localeCompare(b.teamName) ||
    a.taskId.localeCompare(b.taskId)
  );
  chats.sort((a, b) =>
    timeMs(b.latestUnread.timestamp) - timeMs(a.latestUnread.timestamp) ||
    a.teamName.localeCompare(b.teamName)
  );

  return {
    tasks,
    chats,
    taskCount: tasks.length,
    chatCount: chats.length,
    unreadMessageCount,
    countsByTeam,
    complete: snapshot.complete,
  };
}
