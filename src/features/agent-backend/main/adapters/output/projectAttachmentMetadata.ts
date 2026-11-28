import { attachmentMetadataSchema } from '@agent-teams/legacy-agent-host/stopped-team-import';

import type { BackendAttachmentMetadata } from '../../../contracts/attachments';

export function projectAttachmentMetadata(value: unknown): BackendAttachmentMetadata[] {
  if (!Array.isArray(value) || value.length > 4096) throw new Error('Invalid attachment metadata');
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item))
      throw new Error('Invalid attachment metadata');
    const row = item as Record<string, unknown>;
    return attachmentMetadataSchema.parse(
      Object.fromEntries(
        ['id', 'filename', 'mimeType', 'size', 'addedAt']
          .filter((key) => row[key] !== undefined)
          .map((key) => [key, row[key]])
      )
    );
  });
}
