import {
  estimateAgentAttachmentSerializedPayloadBytes,
  MAX_AGENT_ATTACHMENT_SERIALIZED_PAYLOAD_BYTES,
} from '@features/agent-attachments/contracts';
import { getErrorMessage } from '@shared/utils/errorHandling';

import type { AttachmentPayload } from '@shared/types';

const ALLOWED_ATTACHMENT_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/plain',
]);
const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;
const MAX_ATTACHMENTS = 5;
const MAX_TOTAL_ATTACHMENT_SIZE = 20 * 1024 * 1024;

export type AttachmentValidationResult =
  | { valid: true; value: AttachmentPayload[] }
  | { valid: false; error: string };

export function validateAttachments(attachments: unknown): AttachmentValidationResult {
  if (!Array.isArray(attachments)) {
    return { valid: false, error: 'attachments must be an array' };
  }
  if (attachments.length > MAX_ATTACHMENTS) {
    return { valid: false, error: `Maximum ${MAX_ATTACHMENTS} attachments allowed` };
  }
  let totalSize = 0;
  const result: AttachmentPayload[] = [];
  for (const att of attachments) {
    if (!att || typeof att !== 'object') {
      return { valid: false, error: 'Invalid attachment entry' };
    }
    const attachment = att as Partial<AttachmentPayload>;
    if (typeof attachment.id !== 'string' || typeof attachment.filename !== 'string') {
      return { valid: false, error: 'Attachment must have id and filename' };
    }
    if (typeof attachment.data !== 'string' || typeof attachment.mimeType !== 'string') {
      return { valid: false, error: 'Attachment must have data and mimeType' };
    }
    if (
      typeof attachment.size !== 'number' ||
      !Number.isFinite(attachment.size) ||
      attachment.size <= 0
    ) {
      return { valid: false, error: 'Attachment must have a positive size' };
    }
    if (!ALLOWED_ATTACHMENT_TYPES.has(attachment.mimeType)) {
      return { valid: false, error: `Unsupported attachment type: ${attachment.mimeType}` };
    }
    if (attachment.size > MAX_ATTACHMENT_SIZE) {
      return {
        valid: false,
        error: `Attachment "${attachment.filename}" exceeds 10MB limit`,
      };
    }
    const estimatedBinarySize = Math.ceil(attachment.data.length * 0.75);
    if (estimatedBinarySize > MAX_ATTACHMENT_SIZE * 1.1) {
      return {
        valid: false,
        error: `Attachment "${attachment.filename}" data exceeds size limit`,
      };
    }
    totalSize += Math.max(attachment.size, estimatedBinarySize);
    result.push({
      id: attachment.id,
      filename: attachment.filename,
      data: attachment.data,
      mimeType: attachment.mimeType,
      size: attachment.size,
    });
  }
  if (totalSize > MAX_TOTAL_ATTACHMENT_SIZE) {
    return { valid: false, error: 'Total attachment size exceeds 20MB limit' };
  }
  return { valid: true, value: result };
}

export function validateAttachmentSerializedPayload(input: {
  text: string;
  attachments: AttachmentPayload[];
}): { valid: true } | { valid: false; error: string } {
  const estimatedBytes = estimateAgentAttachmentSerializedPayloadBytes(input);
  if (estimatedBytes <= MAX_AGENT_ATTACHMENT_SERIALIZED_PAYLOAD_BYTES) {
    return { valid: true };
  }
  return {
    valid: false,
    error: `Attachment payload is too large after optimization: ${formatAttachmentBytes(
      estimatedBytes
    )} serialized. Limit is ${formatAttachmentBytes(
      MAX_AGENT_ATTACHMENT_SERIALIZED_PAYLOAD_BYTES
    )}. Remove an image or use a smaller screenshot.`,
  };
}

export function formatAttachmentDeliveryFailure(error: unknown, teamStillAlive: boolean): string {
  if (!teamStillAlive) {
    return 'Failed to deliver message with attachments: team process became unavailable';
  }
  const message = getErrorMessage(error);
  if (message.startsWith('Failed to deliver message with attachments:')) {
    return message;
  }
  return `Failed to deliver message with attachments: ${message}`;
}

function formatAttachmentBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
