/**
 * Broad MIME type string (e.g. "image/png", "application/pdf").
 *
 * Note: the UI may still choose to preview only certain types (e.g. images),
 * but tasks/comments can store arbitrary attachments for agent workflows.
 */
// eslint-disable-next-line sonarjs/redundant-type-aliases -- semantic alias for documentation/readability
export type AttachmentMediaType = string;

/** Supported image MIME types (used for preview/validation in UI). */
export type ImageMimeType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

export interface NativeAttachmentDigest {
  sha256?: string;
}
export interface NativeMemberCapability {
  nativeInboxAttachmentsSupported?: boolean;
}

export interface AttachmentMeta extends NativeAttachmentDigest {
  id: string;
  filename: string;
  mimeType: AttachmentMediaType;
  size: number;
  filePath?: string;
}
export interface AttachmentPayload extends AttachmentMeta {
  data: string;
}

export interface NativeAttachmentDeliveryEnvelope {
  version: 1;
  recipientRuntimeInstanceId: string;
}

export interface AttachmentFileData {
  id: string;
  data: string;
  mimeType: AttachmentMediaType;
  /** Absolute path to the persisted attachment file when available. */
  filePath?: string;
}
