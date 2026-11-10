import type { TransientHandoffCard } from '@claude-teams/agent-graph';
import type { InboxMessage, TaskRef } from '@shared/types';

function buildTaskRefs(teamName: string, card: TransientHandoffCard): TaskRef[] | undefined {
  if (!card.relatedTaskId) {
    return undefined;
  }
  return [
    {
      taskId: card.relatedTaskId,
      displayId: card.relatedTaskDisplayId ?? card.relatedTaskId.slice(0, 8),
      teamName,
    },
  ];
}

function buildSummary(card: TransientHandoffCard): string {
  const preview = card.preview?.trim();
  if (preview) {
    return preview;
  }
  if (card.kind === 'task_assign' && card.relatedTaskDisplayId) {
    return `Task ${card.relatedTaskDisplayId} assigned`;
  }
  if (card.kind === 'task_comment' && card.relatedTaskDisplayId) {
    return `${card.relatedTaskDisplayId} updated`;
  }
  return `${card.sourceLabel} -> ${card.destinationLabel}`;
}

function buildText(card: TransientHandoffCard): string {
  const preview = card.preview?.trim();
  switch (card.kind) {
    case 'task_assign': {
      const taskLabel = card.relatedTaskDisplayId ?? card.relatedTaskId ?? 'task';
      return `New task assigned to you: ${taskLabel}${preview ? ` - ${preview}` : ''}`;
    }
    case 'task_comment':
      return preview ?? `${card.sourceLabel} added a comment`;
    case 'review_request':
      return preview ?? `Review requested by ${card.sourceLabel}`;
    case 'review_response':
      return preview ?? `Review response from ${card.sourceLabel}`;
    case 'inbox_message':
    default:
      return preview ?? `${card.sourceLabel} -> ${card.destinationLabel}`;
  }
}

export function buildTransientHandoffMessage(
  teamName: string,
  card: TransientHandoffCard
): InboxMessage {
  const messageKind = card.kind === 'task_comment' ? 'task_comment_notification' : 'default';
  const taskRefs = buildTaskRefs(teamName, card);

  return {
    from: card.sourceLabel,
    to: card.destinationLabel,
    text: buildText(card),
    timestamp: new Date(card.updatedAt * 1000).toISOString(),
    read: true,
    summary: buildSummary(card),
    color: card.color,
    messageId: `graph-handoff:${card.key}`,
    source: 'inbox',
    messageKind,
    taskRefs,
  };
}
