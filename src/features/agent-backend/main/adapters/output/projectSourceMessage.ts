import { createHash } from 'node:crypto';

import { projectAttachmentMetadata } from './projectAttachmentMetadata';

import type { SourceMessageSnapshot } from '@shared/types/team';

/** Canonical Team is private routing provenance, never a renderer path selector. */
export function projectTaskSourceMessage(
  source: Record<string, unknown>,
  teamName: string
): {
  sourceMessageId?: string;
  sourceMessage?: SourceMessageSnapshot;
} {
  // Legacy tasks can retain an ID without a source snapshot; no attachment read can be derived from that ID.
  if (source.sourceMessage === undefined) return {};
  const message = source.sourceMessage;
  if (
    !message ||
    typeof message !== 'object' ||
    Array.isArray(message) ||
    typeof source.sourceMessageId !== 'string' ||
    !source.sourceMessageId ||
    source.sourceMessageId.length > 512 ||
    source.sourceMessageId.includes('\0') ||
    typeof source.id !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(source.id)
  )
    throw new Error('Invalid source message');
  const row = message as Record<string, unknown>;
  const text = (value: unknown): string => {
    if (typeof value !== 'string' || value.includes('\0'))
      throw new Error('Invalid source message');
    return value;
  };
  const hash = createHash('sha256')
    .update(JSON.stringify([teamName, source.id, source.sourceMessageId]))
    .digest('hex');
  return {
    sourceMessageId: `im1:${source.id}:${hash}`,
    sourceMessage: {
      text: text(row.text),
      from: text(row.from),
      timestamp: text(row.timestamp),
      ...(row.source === undefined ? {} : { source: text(row.source) }),
      ...(row.attachments === undefined
        ? {}
        : { attachments: projectAttachmentMetadata(row.attachments) }),
    },
  };
}
