import {
  ATTACHMENT_CHUNK_BYTES as BACKEND_ATTACHMENT_CHUNK_BYTES,
  ATTACHMENT_MAX_BYTES as BACKEND_ATTACHMENT_MAX_BYTES,
} from '@agent-teams/legacy-agent-host/attachments/portable';
export { BACKEND_ATTACHMENT_CHUNK_BYTES, BACKEND_ATTACHMENT_MAX_BYTES };
export interface BackendAttachmentMetadata {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  addedAt?: string;
}
export interface BackendTaskAttachmentRead {
  taskId: string;
  attachmentId: string;
  offset: number;
  expectedSha256?: string;
}
export interface BackendAttachmentChunk {
  attachment: BackendAttachmentMetadata;
  sha256: string;
  offset: number;
  base64: string;
  nextOffset: number | null;
}
/** Browser-safe structural/integrity envelope check; no path survives this projection. */
export function readBackendAttachmentChunk(
  value: unknown,
  input: Pick<BackendTaskAttachmentRead, 'attachmentId' | 'offset' | 'expectedSha256'> & {
    taskId?: string;
    reference?: string;
  }
): BackendAttachmentChunk | null {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid attachment read');
  const row = value as Record<string, unknown>,
    metadata = row.attachment as Record<string, unknown> | undefined;
  if (
    !metadata ||
    typeof metadata !== 'object' ||
    Array.isArray(metadata) ||
    metadata.id !== input.attachmentId ||
    ['id', 'filename', 'mimeType'].some(
      (key) =>
        typeof metadata[key] !== 'string' || !metadata[key].length || /[\0\r\n]/.test(metadata[key])
    ) ||
    metadata.id.length > 128 ||
    (metadata.filename as string).length > 1024 ||
    (metadata.mimeType as string).length > 256 ||
    !Number.isSafeInteger(metadata.size) ||
    (metadata.size as number) < 0 ||
    (metadata.size as number) > BACKEND_ATTACHMENT_MAX_BYTES ||
    (metadata.addedAt !== undefined &&
      (typeof metadata.addedAt !== 'string' ||
        !metadata.addedAt ||
        metadata.addedAt.length > 128)) ||
    typeof row.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(row.sha256) ||
    (input.expectedSha256 !== undefined && row.sha256 !== input.expectedSha256) ||
    row.offset !== input.offset ||
    typeof row.base64 !== 'string' ||
    row.base64.length > Math.ceil(BACKEND_ATTACHMENT_CHUNK_BYTES / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(row.base64)
  )
    throw new Error('Invalid attachment read');
  const padding = row.base64.endsWith('==') ? 2 : row.base64.endsWith('=') ? 1 : 0;
  const length = (row.base64.length / 4) * 3 - padding,
    size = metadata.size as number,
    end = input.offset + length;
  if (
    end > size ||
    length !== Math.min(BACKEND_ATTACHMENT_CHUNK_BYTES, size - input.offset) ||
    row.nextOffset !== (end < size ? end : null)
  )
    throw new Error('Invalid attachment read');
  return {
    attachment: {
      id: metadata.id,
      filename: metadata.filename as string,
      mimeType: metadata.mimeType as string,
      size,
      ...(metadata.addedAt === undefined ? {} : { addedAt: metadata.addedAt }),
    },
    sha256: row.sha256,
    offset: input.offset,
    base64: row.base64,
    nextOffset: row.nextOffset as number | null,
  };
}

export interface BackendMessageAttachmentsRead {
  reference: string;
}
export interface BackendMessageAttachmentRead extends BackendMessageAttachmentsRead {
  attachmentId: string;
  offset: number;
  expectedSha256?: string;
}
export function readBackendMessageAttachments(value: unknown): BackendAttachmentMetadata[] {
  if (!Array.isArray(value) || value.length > 64) throw new Error('Invalid message attachments');
  const result = value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item))
      throw new Error('Invalid attachment metadata');
    const row = item as BackendAttachmentMetadata;
    if (
      typeof row.id !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(row.id) ||
      !Number.isSafeInteger(row.size) ||
      row.size < 0 ||
      row.size > BACKEND_ATTACHMENT_MAX_BYTES ||
      typeof row.filename !== 'string' ||
      !row.filename ||
      row.filename.length > 1024 ||
      typeof row.mimeType !== 'string' ||
      !row.mimeType ||
      row.mimeType.length > 256 ||
      /[\0\r\n]/.test(row.filename + row.mimeType) ||
      (row.addedAt !== undefined &&
        (typeof row.addedAt !== 'string' || !row.addedAt || row.addedAt.length > 128))
    )
      throw new Error('Invalid attachment metadata');
    return {
      id: row.id,
      filename: row.filename,
      mimeType: row.mimeType,
      size: row.size,
      ...(row.addedAt === undefined ? {} : { addedAt: row.addedAt }),
    };
  });
  if (
    new Set(result.map((item) => item.id)).size !== result.length ||
    result.reduce((size, item) => size + item.size, 0) > BACKEND_ATTACHMENT_MAX_BYTES
  )
    throw new Error('Invalid message attachments');
  return result;
}
