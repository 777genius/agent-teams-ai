import { isImageMimeType } from '@renderer/utils/attachmentUtils';

import type { TaskAttachmentMeta } from '@shared/types';

const MOSAIC_HEIGHT_BY_IMAGE_COUNT = [0, 104, 96, 104] as const;

export function estimateKanbanImageMosaicHeight(
  attachments: readonly TaskAttachmentMeta[] | undefined
): number {
  const imageCount =
    attachments?.filter((attachment) => isImageMimeType(attachment.mimeType)).length ?? 0;
  return MOSAIC_HEIGHT_BY_IMAGE_COUNT[imageCount] ?? 140;
}
