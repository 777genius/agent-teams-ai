import { isImageMimeType } from '@renderer/utils/attachmentUtils';

import type { TeamTaskWithKanban } from '@shared/types';

const MOSAIC_HEIGHT_BY_IMAGE_COUNT = [0, 104, 96, 104] as const;
const COMMENT_IMAGE_INDICATOR_HEIGHT = 22;

type KanbanAttachmentTask = Pick<
  TeamTaskWithKanban,
  'attachments' | 'comments' | 'sourceMessage' | 'sourceMessageId'
>;

export interface KanbanCardImageAttachment {
  key: string;
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  filePath?: string | null;
  source: 'task' | 'source-message';
  messageId?: string;
}

export interface KanbanAttachmentPresentation {
  images: KanbanCardImageAttachment[];
  commentImageCount: number;
}

function attachmentIdentityKeys(attachment: {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  filePath?: string | null;
}): string[] {
  const keys = [
    `id:${attachment.id}`,
    `meta:${attachment.mimeType}:${attachment.size}:${attachment.filename.trim().toLowerCase()}`,
  ];
  const filePath = attachment.filePath?.trim();
  if (filePath) keys.push(`path:${filePath}`);
  return keys;
}

export function buildKanbanAttachmentPresentation(
  task: KanbanAttachmentTask
): KanbanAttachmentPresentation {
  const images: KanbanCardImageAttachment[] = [];
  const taskImageIdentities = new Set<string>();

  for (const attachment of task.attachments ?? []) {
    if (!isImageMimeType(attachment.mimeType)) continue;
    const image: KanbanCardImageAttachment = {
      ...attachment,
      key: `task:${attachment.id}`,
      source: 'task',
    };
    images.push(image);
    attachmentIdentityKeys(image).forEach((identity) => taskImageIdentities.add(identity));
  }

  if (task.sourceMessageId) {
    for (const attachment of task.sourceMessage?.attachments ?? []) {
      if (!isImageMimeType(attachment.mimeType)) continue;
      const image: KanbanCardImageAttachment = {
        ...attachment,
        key: `source:${task.sourceMessageId}:${attachment.id}`,
        source: 'source-message',
        messageId: task.sourceMessageId,
      };
      if (attachmentIdentityKeys(image).some((identity) => taskImageIdentities.has(identity))) {
        continue;
      }
      images.push(image);
    }
  }

  const commentImageCount = (task.comments ?? []).reduce(
    (count, comment) =>
      count +
      (comment.attachments?.filter((attachment) => isImageMimeType(attachment.mimeType)).length ??
        0),
    0
  );

  return { images, commentImageCount };
}

export function estimateKanbanAttachmentPreviewHeight(task: KanbanAttachmentTask): number {
  const { images, commentImageCount } = buildKanbanAttachmentPresentation(task);
  const mosaicHeight = MOSAIC_HEIGHT_BY_IMAGE_COUNT[images.length] ?? 140;
  return mosaicHeight + (commentImageCount > 0 ? COMMENT_IMAGE_INDICATOR_HEIGHT : 0);
}
