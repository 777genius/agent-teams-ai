import {
  estimateAgentAttachmentSerializedPayloadBytes,
  isAgentVideoMimeType,
  MAX_AGENT_ATTACHMENT_DELIVERY_BYTES_TOTAL,
  MAX_AGENT_ATTACHMENT_SERIALIZED_PAYLOAD_BYTES,
  MAX_AGENT_VIDEO_ATTACHMENT_BYTES,
} from '../../../core/domain';

import type { AttachmentPayload } from '@shared/types';

const ALLOWED_ATTACHMENT_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'application/pdf',
  'text/plain',
]);
const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_SIZE = 20 * 1024 * 1024;
const MAX_VIDEO_ATTACHMENTS = 1;
const MAX_VIDEO_ATTACHMENT_BASE64_PAYLOAD_BYTES =
  Math.ceil(MAX_AGENT_ATTACHMENT_DELIVERY_BYTES_TOTAL / 3) * 4;
const utf8Encoder = new TextEncoder();

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
  let videoCount = 0;
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
    if (!ALLOWED_ATTACHMENT_TYPES.has(candidate.mimeType)) {
      return { valid: false, error: `Unsupported attachment type: ${candidate.mimeType}` };
    }

    const isVideo = isAgentVideoMimeType(candidate.mimeType);
    const perAttachmentLimit = isVideo ? MAX_AGENT_VIDEO_ATTACHMENT_BYTES : MAX_ATTACHMENT_SIZE;
    if (candidate.size > perAttachmentLimit) {
      return {
        valid: false,
        error: `Attachment "${candidate.filename}" exceeds ${isVideo ? '8MB' : '10MB'} limit`,
      };
    }

    const paddingBytes = candidate.data.endsWith('==') ? 2 : candidate.data.endsWith('=') ? 1 : 0;
    const estimatedBinarySize = Math.max(0, Math.ceil(candidate.data.length * 0.75) - paddingBytes);
    if (estimatedBinarySize > perAttachmentLimit * 1.1) {
      return { valid: false, error: `Attachment "${candidate.filename}" data exceeds size limit` };
    }
    if (isVideo && ++videoCount > MAX_VIDEO_ATTACHMENTS) {
      return { valid: false, error: `Maximum ${MAX_VIDEO_ATTACHMENTS} video attachment allowed` };
    }

    totalSize += Math.max(candidate.size, estimatedBinarySize);
    result.push({
      id: candidate.id,
      filename: candidate.filename,
      data: candidate.data,
      mimeType: candidate.mimeType,
      size: candidate.size,
    });
  }

  if (videoCount > 0 && totalSize > MAX_AGENT_ATTACHMENT_DELIVERY_BYTES_TOTAL) {
    return { valid: false, error: 'Video and other attachments exceed the 8MB total size limit' };
  }
  if (totalSize > MAX_TOTAL_ATTACHMENT_SIZE) {
    return { valid: false, error: 'Total attachment size exceeds 20MB limit' };
  }
  return { valid: true, value: result };
}

export function validateAgentAttachmentSerializedIpcPayload(input: {
  text: string;
  attachments: AttachmentPayload[];
}): { valid: true } | { valid: false; error: string } {
  const estimatedBytes = estimateAgentAttachmentSerializedPayloadBytes(input);
  const includesVideo = input.attachments.some((attachment) =>
    isAgentVideoMimeType(attachment.mimeType)
  );
  const serializedLimit = includesVideo
    ? MAX_VIDEO_ATTACHMENT_BASE64_PAYLOAD_BYTES +
      utf8Encoder.encode(JSON.stringify(input.text)).byteLength +
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
