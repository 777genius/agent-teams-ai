import type { AttachmentPayload } from '@shared/types';

export interface LeadAttachmentInput {
  data: string;
  mimeType: string;
  filename?: string;
}

export interface CodexNativeImagePartLike {
  path: string;
  mimeType: string;
}

export function toLeadAttachmentPayloads(
  attachments?: readonly LeadAttachmentInput[]
): AttachmentPayload[] {
  return (attachments ?? []).map((attachment, index) => {
    const filename = attachment.filename?.trim() || `attachment-${index + 1}`;
    const bytes = Buffer.from(attachment.data, 'base64');
    return {
      id: `lead_att_${index + 1}`,
      filename,
      mimeType: attachment.mimeType,
      size: bytes.byteLength,
      data: attachment.data,
    };
  });
}

export function codexImagePartToContentBlock(
  part: CodexNativeImagePartLike
): Record<string, unknown> {
  return {
    type: 'image',
    source: {
      type: 'file',
      path: part.path,
      media_type: part.mimeType,
    },
  };
}
