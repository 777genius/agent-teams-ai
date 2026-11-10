import type { InboxMessage } from '@shared/types';

export interface PendingCrossTeamReply {
  teamName: string;
  sentAtMs: number;
  conversationId?: string;
}

export const CROSS_TEAM_PENDING_REPLY_TTL_MS = 10_000;

function parseQualifiedTeamName(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const dot = trimmed.indexOf('.');
  if (dot <= 0) return null;
  return trimmed.slice(0, dot);
}

export function computePendingCrossTeamReplies(
  messages: InboxMessage[] | null | undefined,
  nowMs = Date.now()
): PendingCrossTeamReply[] {
  if (!messages || messages.length === 0) return [];

  const latestSentByTeam = new Map<string, number>();
  const latestInboundByTeam = new Map<string, number>();
  const latestSentByConversation = new Map<
    string,
    { teamName: string; sentAtMs: number; conversationId: string }
  >();
  const latestInboundByConversation = new Map<string, number>();

  for (const message of messages) {
    const timestampMs = Date.parse(message.timestamp);
    if (!Number.isFinite(timestampMs)) continue;

    if (message.source === 'cross_team_sent') {
      const teamName = parseQualifiedTeamName(message.to);
      if (!teamName) continue;
      if (message.conversationId) {
        const existing = latestSentByConversation.get(message.conversationId);
        if (!existing || timestampMs > existing.sentAtMs) {
          latestSentByConversation.set(message.conversationId, {
            teamName,
            sentAtMs: timestampMs,
            conversationId: message.conversationId,
          });
        }
      } else {
        latestSentByTeam.set(teamName, Math.max(latestSentByTeam.get(teamName) ?? 0, timestampMs));
      }
      continue;
    }

    if (message.source === 'cross_team') {
      const teamName = parseQualifiedTeamName(message.from);
      if (!teamName) continue;
      if (message.conversationId) {
        latestInboundByConversation.set(
          message.conversationId,
          Math.max(latestInboundByConversation.get(message.conversationId) ?? 0, timestampMs)
        );
      } else {
        latestInboundByTeam.set(
          teamName,
          Math.max(latestInboundByTeam.get(teamName) ?? 0, timestampMs)
        );
      }
    }
  }

  const isWithinPendingWindow = (sentAtMs: number): boolean =>
    sentAtMs >= nowMs || nowMs - sentAtMs <= CROSS_TEAM_PENDING_REPLY_TTL_MS;

  const exactPending = Array.from(latestSentByConversation.values()).filter(
    ({ conversationId, sentAtMs }) =>
      sentAtMs > (latestInboundByConversation.get(conversationId) ?? 0) &&
      isWithinPendingWindow(sentAtMs)
  );
  const teamsCoveredExactly = new Set(exactPending.map((entry) => entry.teamName));
  const legacyPending = Array.from(latestSentByTeam.entries())
    .filter(([teamName]) => !teamsCoveredExactly.has(teamName))
    .filter(
      ([teamName, sentAtMs]) =>
        sentAtMs > (latestInboundByTeam.get(teamName) ?? 0) && isWithinPendingWindow(sentAtMs)
    )
    .map(([teamName, sentAtMs]) => ({ teamName, sentAtMs }))
    .sort((a, b) => b.sentAtMs - a.sentAtMs);

  return [...exactPending, ...legacyPending].sort((a, b) => b.sentAtMs - a.sentAtMs);
}
