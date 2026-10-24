/** Browser-safe attachment normalization shared by the existing UI and selected Team owner. */
export interface NormalizedAttachmentPayload {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  data: string;
}
export const MAX_AGENT_ATTACHMENT_DELIVERY_BYTES_TOTAL = 8 * 1024 * 1024;
export const MAX_AGENT_VIDEO_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const MAX_AGENT_ATTACHMENT_SERIALIZED_PAYLOAD_BYTES = 7_500_000;
const isAgentVideoMimeType = (mime: string) =>
  ['video/mp4', 'video/webm', 'video/quicktime'].includes(mime);
export const SAFE_ATTACHMENT_STORAGE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,120}$/;
export function isSafeAttachmentStorageId(value: string): boolean {
  return SAFE_ATTACHMENT_STORAGE_ID_RE.test(value);
}
export function assertSafeAttachmentStorageId(label: string, value: string): void {
  if (!isSafeAttachmentStorageId(value)) throw new Error(`Invalid ${label}`);
}
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
export const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_SIZE = 20 * 1024 * 1024;
export const MAX_TASK_ATTACHMENT_SIZE = MAX_TOTAL_ATTACHMENT_SIZE;
export const ATTACHMENT_CHUNK_BYTES = 384 * 1024;
export const ATTACHMENT_MAX_BYTES = MAX_TOTAL_ATTACHMENT_SIZE;
const MAX_VIDEO_ATTACHMENTS = 1;

export const MAX_AGENT_IPC_ATTACHMENTS = 5;
export const MAX_TASK_ATTACHMENT_BYTES_TOTAL = MAX_TASK_ATTACHMENT_SIZE * MAX_AGENT_IPC_ATTACHMENTS;

export function validateAgentAttachmentIpcPayload(
  attachments: unknown,
  purpose: 'task' | 'message' = 'message'
): { valid: true; value: NormalizedAttachmentPayload[] } | { valid: false; error: string } {
  if (!Array.isArray(attachments)) {
    return { valid: false, error: 'attachments must be an array' };
  }
  if (attachments.length > MAX_AGENT_IPC_ATTACHMENTS) {
    return { valid: false, error: `Maximum ${MAX_AGENT_IPC_ATTACHMENTS} attachments allowed` };
  }

  let totalSize = 0;
  let videoCount = 0;
  const result: NormalizedAttachmentPayload[] = [];
  for (const attachment of attachments) {
    if (!attachment || typeof attachment !== 'object') {
      return { valid: false, error: 'Invalid attachment entry' };
    }
    const candidate = attachment as Partial<NormalizedAttachmentPayload>;
    if (
      typeof candidate.id !== 'string' ||
      !isSafeAttachmentStorageId(candidate.id) ||
      typeof candidate.filename !== 'string' ||
      !candidate.filename.trim() ||
      candidate.filename.length > 1024 ||
      /[\0\r\n]/.test(candidate.filename)
    ) {
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
    if (
      !candidate.mimeType ||
      candidate.mimeType.length > 256 ||
      /[\0\r\n]/.test(candidate.mimeType) ||
      (purpose === 'message' && !ALLOWED_ATTACHMENT_TYPES.has(candidate.mimeType))
    ) {
      return { valid: false, error: `Unsupported attachment type: ${candidate.mimeType}` };
    }

    const isVideo = purpose === 'message' && isAgentVideoMimeType(candidate.mimeType);
    const perAttachmentLimit =
      purpose === 'task'
        ? MAX_TASK_ATTACHMENT_SIZE
        : isVideo
          ? MAX_AGENT_VIDEO_ATTACHMENT_BYTES
          : MAX_ATTACHMENT_SIZE;
    if (candidate.size > perAttachmentLimit) {
      return {
        valid: false,
        error: `Attachment "${candidate.filename}" exceeds ${purpose === 'task' ? '20MB' : isVideo ? '8MB' : '10MB'} limit`,
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
      filename: candidate.filename.trim(),
      data: candidate.data,
      mimeType: candidate.mimeType.trim(),
      size: candidate.size,
    });
  }

  if (videoCount > 0 && totalSize > MAX_AGENT_ATTACHMENT_DELIVERY_BYTES_TOTAL) {
    return { valid: false, error: 'Video and other attachments exceed the 8MB total size limit' };
  }
  const totalLimit =
    purpose === 'task' ? MAX_TASK_ATTACHMENT_BYTES_TOTAL : MAX_TOTAL_ATTACHMENT_SIZE;
  if (totalSize > totalLimit) {
    return {
      valid: false,
      error: `Total attachment size exceeds ${purpose === 'task' ? '100MB' : '20MB'} limit`,
    };
  }
  return { valid: true, value: result };
}
