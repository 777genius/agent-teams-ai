export {
  getMessageAttachmentRoute,
  isStrictUtf8,
  decorateFileReferences,
} from './messageFileReferences.js';
export type { MessageAttachmentTarget } from './messageFileReferences.js';
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
  const ids = new Set<string>();
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
      candidate.filename.length > 4096 ||
      /[\0\r\n]/.test(candidate.filename)
    ) {
      return { valid: false, error: 'Attachment must have id and filename' };
    }
    if (ids.has(candidate.id)) {
      return { valid: false, error: 'Invalid or duplicate attachment ID' };
    }
    ids.add(candidate.id);
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
      candidate.mimeType.length > 255 ||
      /[\x00-\x1f\x7f-\x9f]/.test(candidate.mimeType)
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

    if (candidate.data.length > Math.ceil(perAttachmentLimit / 3) * 4) {
      return { valid: false, error: 'Attachment encoded data exceeds size limit' };
    }
    let binary: string;
    try {
      binary = atob(candidate.data);
      if (btoa(binary) !== candidate.data || binary.length !== candidate.size) {
        return { valid: false, error: 'Attachment data must be canonical base64 with exact size' };
      }
    } catch {
      return { valid: false, error: 'Attachment data must be canonical base64 with exact size' };
    }
    if (isVideo && ++videoCount > MAX_VIDEO_ATTACHMENTS) {
      return { valid: false, error: `Maximum ${MAX_VIDEO_ATTACHMENTS} video attachment allowed` };
    }

    totalSize += binary.length;
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
