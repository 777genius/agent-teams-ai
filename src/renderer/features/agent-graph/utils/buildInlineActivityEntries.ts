import { stripCrossTeamPrefix } from '@shared/constants/crossTeam';
import { getIdleGraphLabel } from '@shared/utils/idleNotificationSemantics';
import { isInboxNoiseMessage } from '@shared/utils/inboxNoise';
import { isLeadMember } from '@shared/utils/leadDetection';

import type { GraphActivityItem } from '@claude-teams/agent-graph';
import type {
  AttachmentMeta,
  InboxMessage,
  ResolvedTeamMember,
  TaskAttachmentMeta,
  TaskComment,
  TaskRef,
  TeamTaskWithKanban,
} from '@shared/types/team';

export interface InlineActivityEntry {
  ownerNodeId: string;
  graphItem: GraphActivityItem;
  message: InboxMessage;
}

export interface ActivityEntrySourceData {
  members: ResolvedTeamMember[];
  tasks: readonly TeamTaskWithKanban[];
  messages: readonly InboxMessage[];
}

export interface BuildInlineActivityEntriesArgs {
  data: ActivityEntrySourceData;
  teamName: string;
  leadId: string;
  leadName: string;
  ownerNodeIds: ReadonlySet<string>;
}

export function getGraphLeadMemberName(
  data: Pick<ActivityEntrySourceData, 'members'>,
  teamName: string
): string {
  return data.members.find((member) => isLeadMember(member))?.name ?? `${teamName}-lead`;
}

export function buildInlineActivityEntries({
  data,
  teamName,
  leadId,
  leadName,
  ownerNodeIds,
}: BuildInlineActivityEntriesArgs): Map<string, InlineActivityEntry[]> {
  const entriesByOwnerNodeId = new Map<string, InlineActivityEntry[]>();

  const appendEntry = (entry: InlineActivityEntry): void => {
    const targetOwnerNodeId = ownerNodeIds.has(entry.ownerNodeId) ? entry.ownerNodeId : leadId;
    const ownerEntries = entriesByOwnerNodeId.get(targetOwnerNodeId);
    if (ownerEntries) {
      ownerEntries.push(entry);
    } else {
      entriesByOwnerNodeId.set(targetOwnerNodeId, [entry]);
    }
  };

  for (const ownerNodeId of ownerNodeIds) {
    entriesByOwnerNodeId.set(ownerNodeId, []);
  }

  const orderedMessages = [...data.messages].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  for (const message of orderedMessages) {
    if (message.summary?.startsWith('Comment on ')) {
      continue;
    }

    const idleLabel = getIdleGraphLabel(message.text ?? '');
    if (idleLabel === 'idle') {
      continue;
    }
    if (!idleLabel && isInboxNoiseMessage(message.text ?? '')) {
      continue;
    }

    const ownerNodeId = resolveMessageOwnerNodeId({
      message,
      teamName,
      leadId,
      leadName,
      ownerNodeIds,
    });
    if (!ownerNodeId) {
      continue;
    }

    const crossTeamPreview =
      message.source === 'cross_team' || message.source === 'cross_team_sent'
        ? (message.summary ?? stripCrossTeamPrefix(message.text ?? '')).replace(
            /^\[cross-team\]\s*/i,
            ''
          )
        : undefined;
    const previewSource =
      message.source === 'cross_team' || message.source === 'cross_team_sent'
        ? crossTeamPreview
        : (message.summary ?? message.text);
    const graphItem: GraphActivityItem = {
      id: `activity:msg:${teamName}:${getActivityMessageKey(message)}`,
      kind: 'inbox_message',
      timestamp: message.timestamp,
      title: buildActivityMessageTitle(message, leadName),
      preview: idleLabel ?? buildActivityPreview(previewSource),
      authorLabel: buildParticipantLabel(message.from, leadName),
    };

    appendEntry({
      ownerNodeId,
      graphItem,
      message,
    });
  }

  const orderedComments = [...collectTaskComments(data.tasks)].sort((a, b) =>
    a.comment.createdAt.localeCompare(b.comment.createdAt)
  );
  for (const item of orderedComments) {
    const ownerNodeId = resolveCommentOwnerNodeId({
      taskOwner: item.task.owner,
      author: item.comment.author,
      teamName,
      leadId,
      leadName,
      ownerNodeIds,
    });
    if (!ownerNodeId) {
      continue;
    }

    const taskLabel = item.task.displayId ?? `#${item.task.id.slice(0, 6)}`;
    const preview = buildActivityPreview(item.comment.text);
    const graphItem: GraphActivityItem = {
      id: `activity:comment:${teamName}:${item.task.id}:${item.comment.id}`,
      kind: 'task_comment',
      timestamp: item.comment.createdAt,
      title: `${taskLabel} ${item.task.subject}`.trim(),
      preview,
      taskId: item.task.id,
      taskDisplayId: item.task.displayId ?? undefined,
      authorLabel: item.comment.author,
    };

    appendEntry({
      ownerNodeId,
      graphItem,
      message: buildCommentActivityMessage({
        teamName,
        leadName,
        task: item.task,
        comment: item.comment,
      }),
    });
  }

  for (const [ownerNodeId, entries] of entriesByOwnerNodeId) {
    entriesByOwnerNodeId.set(
      ownerNodeId,
      entries.sort((a, b) => b.graphItem.timestamp.localeCompare(a.graphItem.timestamp))
    );
  }

  return entriesByOwnerNodeId;
}

function collectTaskComments(
  tasks: readonly TeamTaskWithKanban[]
): { task: TeamTaskWithKanban; comment: TaskComment }[] {
  const items: { task: TeamTaskWithKanban; comment: TaskComment }[] = [];
  for (const task of tasks) {
    for (const comment of task.comments ?? []) {
      items.push({ task, comment });
    }
  }
  return items;
}

function resolveMessageOwnerNodeId(args: {
  message: InboxMessage;
  teamName: string;
  leadId: string;
  leadName: string;
  ownerNodeIds: ReadonlySet<string>;
}): string | null {
  const { message, teamName, leadId, leadName, ownerNodeIds } = args;
  if (message.source === 'cross_team' || message.source === 'cross_team_sent') {
    return leadId;
  }

  const fromId = resolveParticipantId(message.from ?? '', teamName, leadId, leadName);
  const toId = message.to ? resolveParticipantId(message.to, teamName, leadId, leadName) : leadId;

  if (toId !== leadId && ownerNodeIds.has(toId)) {
    return toId;
  }
  if (fromId !== leadId && ownerNodeIds.has(fromId)) {
    return fromId;
  }
  return ownerNodeIds.has(leadId) ? leadId : null;
}

function resolveCommentOwnerNodeId(args: {
  taskOwner: string | undefined;
  author: string;
  teamName: string;
  leadId: string;
  leadName: string;
  ownerNodeIds: ReadonlySet<string>;
}): string | null {
  const { taskOwner, author, teamName, leadId, leadName, ownerNodeIds } = args;
  if (taskOwner) {
    const ownerId = resolveParticipantId(taskOwner, teamName, leadId, leadName);
    if (ownerNodeIds.has(ownerId)) {
      return ownerId;
    }
  }

  const authorId = resolveParticipantId(author, teamName, leadId, leadName);
  if (ownerNodeIds.has(authorId)) {
    return authorId;
  }
  return ownerNodeIds.has(leadId) ? leadId : null;
}

function buildActivityMessageTitle(message: InboxMessage, leadName: string): string {
  if (message.source === 'cross_team' || message.source === 'cross_team_sent') {
    const externalTeam = extractExternalTeamName(message.from ?? '') ?? 'external';
    return message.source === 'cross_team_sent'
      ? `${leadName} -> ${externalTeam}`
      : `${externalTeam} -> ${leadName}`;
  }

  const fromLabel = buildParticipantLabel(message.from, leadName);
  const toLabel = buildParticipantLabel(message.to ?? leadName, leadName);
  return `${fromLabel} -> ${toLabel}`;
}

function buildCommentActivityMessage(args: {
  teamName: string;
  leadName: string;
  task: TeamTaskWithKanban;
  comment: TaskComment;
}): InboxMessage {
  const { teamName, leadName, task, comment } = args;
  const taskDisplayId = task.displayId ?? `#${task.id.slice(0, 6)}`;
  const summaryPreview = buildActivityPreview(comment.text, 90) ?? task.subject;
  const summary = `${taskDisplayId} ${summaryPreview}`.trim();
  const recipient = task.owner && task.owner !== comment.author ? task.owner : leadName;

  return {
    from: comment.author,
    to: recipient,
    text: comment.text,
    timestamp: comment.createdAt,
    read: true,
    summary,
    messageId: `graph-activity-comment:${teamName}:${task.id}:${comment.id}`,
    messageKind: 'task_comment_notification',
    source: 'inbox',
    taskRefs: buildTaskRefs(teamName, task),
    attachments: mapCommentAttachments(comment.attachments),
  };
}

function buildTaskRefs(teamName: string, task: TeamTaskWithKanban): TaskRef[] | undefined {
  const displayId = task.displayId ?? `#${task.id.slice(0, 6)}`;
  return [
    {
      taskId: task.id,
      displayId,
      teamName,
    },
  ];
}

function mapCommentAttachments(
  attachments: TaskAttachmentMeta[] | undefined
): AttachmentMeta[] | undefined {
  if (!attachments || attachments.length === 0) {
    return undefined;
  }
  return attachments.map((attachment) => ({
    id: attachment.id,
    filename: attachment.filename,
    mimeType: attachment.mimeType,
    size: attachment.size,
    filePath: attachment.filePath ?? undefined,
  }));
}

function buildActivityPreview(text: string | undefined, max = 180): string | undefined {
  const normalized = normalizeActivityText(text);
  if (!normalized) {
    return undefined;
  }
  return normalized.length > max
    ? `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}…`
    : normalized;
}

function normalizeActivityText(text: string | undefined): string | undefined {
  let normalized = text?.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return normalized;
  }
  normalized = normalized.replace(/#[a-f0-9]{6,}\s*/gi, '').trim();
  normalized = normalized.replace(/\|/g, ' - ');
  return normalized;
}

function getActivityMessageKey(message: InboxMessage): string {
  if (message.messageId && message.messageId.trim().length > 0) {
    return message.messageId;
  }
  return [
    message.timestamp,
    message.from ?? '',
    message.to ?? '',
    message.summary ?? '',
    message.text ?? '',
  ].join('\u0000');
}

function resolveParticipantId(
  name: string,
  teamName: string,
  leadId: string,
  leadName?: string
): string {
  const normalized = name.trim().toLowerCase();
  if (normalized === 'user' || normalized === 'team-lead') {
    return leadId;
  }
  if (normalized === leadName?.trim().toLowerCase()) {
    return leadId;
  }
  return `member:${teamName}:${name}`;
}

function buildParticipantLabel(name: string | undefined, leadName: string): string {
  if (!name) {
    return leadName;
  }
  const normalized = name.trim().toLowerCase();
  if (
    normalized === 'user' ||
    normalized === 'team-lead' ||
    normalized === leadName.trim().toLowerCase()
  ) {
    return leadName;
  }

  const dotIndex = name.indexOf('.');
  if (dotIndex > 0 && dotIndex < name.length - 1) {
    return name.slice(dotIndex + 1);
  }

  return name;
}

function extractExternalTeamName(from: string): string | null {
  const dotIndex = from.indexOf('.');
  if (dotIndex <= 0) {
    return null;
  }
  return from.slice(0, dotIndex);
}
