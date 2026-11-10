import { getRelationId, getTeamNodeId } from './organizationIds';

import type { CrossTeamMessageCandidate, OrgRelationModel } from './models';

export interface CrossTeamRelationProjectionResult {
  relations: OrgRelationModel[];
  totalMessages: number;
  processedMessages: number;
  truncatedMessages: number;
}

function getTimestampMs(value: string | undefined): number {
  if (!value) {
    return 0;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getMessageDedupeKey(message: CrossTeamMessageCandidate): string {
  if (message.messageId?.trim()) {
    return `id:${message.messageId.trim()}`;
  }
  return [
    message.fromTeam,
    message.toTeam,
    message.conversationId ?? '',
    message.timestamp,
    message.summary ?? message.text ?? '',
  ]
    .map((part) => part.trim().toLowerCase())
    .join('|');
}

function getMessagePreview(message: CrossTeamMessageCandidate): string | undefined {
  const raw = message.summary?.trim() || message.text?.trim();
  if (!raw) {
    return undefined;
  }
  return raw.replace(/\s+/g, ' ').slice(0, 140);
}

export function projectCrossTeamRelations(params: {
  messages: readonly CrossTeamMessageCandidate[];
  visibleTeamNames: ReadonlySet<string>;
  maxMessages: number;
}): CrossTeamRelationProjectionResult {
  const deduped: CrossTeamMessageCandidate[] = [];
  const seen = new Set<string>();

  for (const message of params.messages) {
    if (!params.visibleTeamNames.has(message.fromTeam)) continue;
    if (!params.visibleTeamNames.has(message.toTeam)) continue;
    if (message.fromTeam === message.toTeam) continue;

    const key = getMessageDedupeKey(message);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(message);
  }

  deduped.sort((left, right) => getTimestampMs(right.timestamp) - getTimestampMs(left.timestamp));
  const selected = deduped.slice(0, params.maxMessages);
  const relationsByPair = new Map<string, OrgRelationModel>();

  for (const message of selected) {
    const sourceNodeId = getTeamNodeId(message.fromTeam);
    const targetNodeId = getTeamNodeId(message.toTeam);
    const key = `${sourceNodeId}->${targetNodeId}`;
    const previous = relationsByPair.get(key);
    const messageTime = getTimestampMs(message.timestamp);
    const previousTime = getTimestampMs(previous?.lastActivityAt);
    const preview = getMessagePreview(message);

    if (!previous) {
      relationsByPair.set(key, {
        id: getRelationId('communicates', sourceNodeId, targetNodeId),
        sourceNodeId,
        targetNodeId,
        kind: 'communicates',
        sourceKind: 'runtime',
        weight: 1,
        messageCount: 1,
        lastActivityAt: message.timestamp,
        latestMessagePreview: preview,
      });
      continue;
    }

    previous.weight += 1;
    previous.messageCount = (previous.messageCount ?? 0) + 1;
    if (messageTime >= previousTime) {
      previous.lastActivityAt = message.timestamp;
      previous.latestMessagePreview = preview ?? previous.latestMessagePreview;
    }
  }

  const relations = [...relationsByPair.values()].sort((left, right) => {
    const activityDelta =
      getTimestampMs(right.lastActivityAt) - getTimestampMs(left.lastActivityAt);
    if (activityDelta !== 0) return activityDelta;
    return right.weight - left.weight;
  });

  return {
    relations,
    totalMessages: deduped.length,
    processedMessages: selected.length,
    truncatedMessages: Math.max(0, deduped.length - selected.length),
  };
}
