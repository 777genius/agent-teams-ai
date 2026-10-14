import {
  estimateAgentAttachmentSerializedPayloadBytes,
  MAX_AGENT_ATTACHMENT_DELIVERY_BYTES_TOTAL,
  MAX_AGENT_ATTACHMENT_SERIALIZED_PAYLOAD_BYTES,
} from '../../../core/domain';
import { isSafeAttachmentStorageId } from '../../../core/domain/storageIds';

import type { AttachmentPayload } from '@shared/types';

const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_SIZE = 20 * 1024 * 1024;

export const MAX_AGENT_IPC_ATTACHMENTS = 5;

export function validateAgentAttachmentIpcPayload(
  attachments: unknown
): { valid: true; value: AttachmentPayload[] } | { valid: false; error: string } {
  if (!Array.isArray(attachments)) {
    return { valid: false, error: 'attachments must be an array' };
  }
  if (attachments.length > MAX_AGENT_IPC_ATTACHMENTS) {
    return { valid: false, error: `Maximum ${MAX_AGENT_IPC_ATTACHMENTS} attachments allowed` };
  }

  let totalSize = 0;
  const ids = new Set<string>();
  const result: AttachmentPayload[] = [];
  for (const attachment of attachments) {
    if (!attachment || typeof attachment !== 'object') {
      return { valid: false, error: 'Invalid attachment entry' };
    }
    const candidate = attachment as Partial<AttachmentPayload>;
    if (typeof candidate.id !== 'string' || typeof candidate.filename !== 'string') {
      return { valid: false, error: 'Attachment must have id and filename' };
    }
    if (typeof candidate.data !== 'string' || typeof candidate.mimeType !== 'string') {
      return { valid: false, error: 'Attachment must have data and mimeType' };
    }
    if (
      typeof candidate.size !== 'number' ||
      !Number.isSafeInteger(candidate.size) ||
      candidate.size <= 0
    ) {
      return { valid: false, error: 'Attachment must have a positive size' };
    }
    if (!isSafeAttachmentStorageId(candidate.id) || ids.has(candidate.id)) {
      return { valid: false, error: 'Invalid or duplicate attachment ID' };
    }
    ids.add(candidate.id);
    if (
      !candidate.filename.trim() ||
      candidate.filename.length > 4096 ||
      candidate.filename.includes('\0')
    ) {
      return { valid: false, error: 'Invalid attachment filename' };
    }
    if (
      !candidate.mimeType ||
      candidate.mimeType.length > 255 ||
      /[\x00-\x1f\x7f-\x9f]/.test(candidate.mimeType)
    ) {
      return { valid: false, error: 'Invalid attachment MIME type' };
    }
    if (candidate.size > MAX_ATTACHMENT_SIZE) {
      return { valid: false, error: `Attachment "${candidate.filename}" exceeds 10MB limit` };
    }
    if (candidate.data.length > Math.ceil(MAX_ATTACHMENT_SIZE / 3) * 4) {
      return { valid: false, error: 'Attachment encoded data exceeds size limit' };
    }
    const bytes = Buffer.from(candidate.data, 'base64');
    if (bytes.toString('base64') !== candidate.data || bytes.length !== candidate.size) {
      return { valid: false, error: 'Attachment data must be canonical base64 with exact size' };
    }
    totalSize += bytes.length;
    result.push({
      id: candidate.id,
      filename: candidate.filename,
      data: candidate.data,
      mimeType: candidate.mimeType,
      size: candidate.size,
    });
  }

  if (totalSize > MAX_TOTAL_ATTACHMENT_SIZE) {
    return { valid: false, error: 'Total attachment size exceeds 20MB limit' };
  }
  return { valid: true, value: result };
}

export function validateAgentAttachmentSerializedIpcPayload(input: {
  text: string;
  attachments: AttachmentPayload[];
  /** Main confirms the selected native video route, never renderer-controlled. */
  nativeVideoDelivery?: boolean;
}): { valid: true } | { valid: false; error: string } {
  const estimatedBytes = estimateAgentAttachmentSerializedPayloadBytes(input);
  const serializedLimit = input.nativeVideoDelivery
    ? Math.ceil(MAX_AGENT_ATTACHMENT_DELIVERY_BYTES_TOTAL / 3) * 4 +
      new TextEncoder().encode(JSON.stringify(input.text)).byteLength +
      4096
    : MAX_AGENT_ATTACHMENT_SERIALIZED_PAYLOAD_BYTES;
  if (estimatedBytes <= serializedLimit) return { valid: true };

  return {
    valid: false,
    error: `Attachment payload is too large after optimization: ${formatBytes(
      estimatedBytes
    )} serialized. Limit is ${formatBytes(
      serializedLimit
    )}. Remove an attachment or use a smaller file.`,
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
