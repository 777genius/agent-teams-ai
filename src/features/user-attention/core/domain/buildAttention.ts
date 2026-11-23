import {
  belongsToConversation,
  conversationScopeKey,
  createDirectScope,
  isLeadConversationParticipant,
  isUserUnreadMessage,
  normalizeConversationParticipant,
} from '@features/team-direct-chats';

import type { ConversationScope } from '@features/team-direct-chats';
import type { InboxMessage } from '@shared/types/team';
import type { AttentionSnapshot, AttentionTaskCandidate } from '../../contracts';

export interface AttentionChat {
  teamName: string;
  logicalTeamName?: string;
  projectPath?: string;
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
export function conversationForAttentionMessage(
  message: InboxMessage,
  activeParticipants: ReadonlySet<string>,
  leadName?: string,
  groupName?: string
): {
  scope: ConversationScope;
  name: string;
} {
  if (message.groupChatId) {
    return {
      scope: { kind: 'group', groupChatId: message.groupChatId },
      name: groupName || `Group ${message.groupChatId}`,
    };
  }
  const sender = normalizeConversationParticipant(message.from);
  const lead = normalizeConversationParticipant(leadName);
  const leadNames = lead ? [lead] : [];
  const participant = lead && isLeadConversationParticipant(sender, leadNames) ? lead : sender;
  const scope = createDirectScope(participant);
  // Removed/unknown members have no available direct thread. Keep their
  // unread messages actionable through the canonical team-feed conversation.
  if (!participant || (!activeParticipants.has(participant) && participant !== lead) ||
      !belongsToConversation(message, scope, leadNames)) {
    return { scope: { kind: 'team-feed' }, name: 'Team messages' };
  }
  return { scope, name: participant === lead && leadName ? leadName : message.from };
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
    const activeParticipants = new Set((team.directParticipants ?? []).map(normalizeConversationParticipant));
    const chatMap = new Map<string, AttentionChat>();
    const seenMessages = new Set<string>();

    for (const message of team.messages) {
      const key = toMessageKey(message);
      if (seenMessages.has(key)) continue;
      seenMessages.add(key);
      const readSet = message.groupChatId ? reads.group : reads.direct;
      if (!isUserUnreadMessage(message, readSet, toMessageKey)) continue;

      const conversation = conversationForAttentionMessage(
        message, activeParticipants, team.leadName,
        message.groupChatId ? team.groupNames?.[message.groupChatId] : undefined
      );
      const scopeKey = conversationScopeKey(conversation.scope);
      const entry = chatMap.get(scopeKey);
      if (!entry) {
        chatMap.set(scopeKey, {
          teamName: team.teamName,
          logicalTeamName: team.logicalTeamName,
          projectPath: team.projectPath,
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
    const logicalName = team.logicalTeamName || team.teamName;
    const previous = countsByTeam.get(logicalName) ?? { tasks: 0, chats: 0 };
    countsByTeam.set(logicalName, {
      tasks: previous.tasks + seenTasks.size,
      chats: previous.chats + chatMap.size,
    });
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
