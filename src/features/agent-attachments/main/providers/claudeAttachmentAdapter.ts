import { AgentAttachmentError } from '@features/agent-attachments/core/domain';

import type { AttachmentPayload } from '@shared/types';

export type ClaudeInputBlock =
  | { type: 'text'; text: string }
  | {
      type: 'image';
      source: { type: 'base64'; media_type: string; data: string };
    }
  | {
      type: 'document';
      source:
        | { type: 'base64'; media_type: string; data: string }
        | { type: 'text'; media_type: 'text/plain'; data: string };
      title?: string;
    };

export interface ClaudeAttachmentDeliveryParts {
  kind: 'legacy_text' | 'structured_blocks';
  blocks: ClaudeInputBlock[];
}

function decodeBase64Text(data: string): { ok: true; text: string } | { ok: false } {
  const decoded = Buffer.from(data, 'base64').toString('utf-8');
  if (decoded.includes('\uFFFD')) return { ok: false };
  return { ok: true, text: decoded };
}

export function buildClaudeAttachmentDeliveryParts(input: {
  text: string;
  attachments?: AttachmentPayload[];
}): ClaudeAttachmentDeliveryParts {
  const contentBlocks: ClaudeInputBlock[] = [{ type: 'text', text: input.text }];
  const attachments = input.attachments ?? [];

  if (attachments.length === 0) {
    return { kind: 'legacy_text', blocks: contentBlocks };
  }

  for (const attachment of attachments) {
    if (attachment.mimeType === 'application/pdf') {
      contentBlocks.push({
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: attachment.data,
        },
        title: attachment.filename,
      });
      continue;
    }

    if (attachment.mimeType === 'text/plain') {
      const decoded = decodeBase64Text(attachment.data);
      contentBlocks.push(
        decoded.ok
          ? {
              type: 'document',
              source: {
                type: 'text',
                media_type: 'text/plain',
                data: decoded.text,
              },
              title: attachment.filename,
            }
          : {
              type: 'document',
              source: {
                type: 'base64',
                media_type: 'text/plain',
                data: attachment.data,
              },
              title: attachment.filename,
            }
      );
      continue;
    }

    if (attachment.mimeType === 'image/png' || attachment.mimeType === 'image/jpeg') {
      contentBlocks.push({
        type: 'image',
        source: {
          // Claude expects image bytes inside the structured image block as base64.
          // This is provider-native payload data, not text appended to the user prompt.
          type: 'base64',
          media_type: attachment.mimeType,
          data: attachment.data,
        },
      });
      continue;
    }

    throw new AgentAttachmentError(
      'attachment_type_unsupported',
      `Claude image MIME unsupported: ${attachment.mimeType}`,
      { attachmentId: attachment.id, retryable: false }
    );
  }

  return { kind: 'structured_blocks', blocks: contentBlocks };
}

export function redactClaudeBlocksForDiagnostics(blocks: ClaudeInputBlock[]): ClaudeInputBlock[] {
  return blocks.map((block) => {
    if (block.type === 'image') {
      return {
        ...block,
        source: {
          ...block.source,
          data: `[redacted image bytes: ${block.source.media_type}]`,
        },
      };
    }
    if (block.type === 'document' && block.source.type === 'base64') {
      return {
        ...block,
        source: {
          ...block.source,
          data: `[redacted document bytes: ${block.source.media_type}]`,
        },
      };
    }
    return block;
  });
}
