const SAFE_ATTACHMENT_STORAGE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,120}$/;

export function isSafeAttachmentStorageId(value: string): boolean {
  return SAFE_ATTACHMENT_STORAGE_ID_RE.test(value);
}

export function assertSafeAttachmentStorageId(label: string, value: string): void {
  if (!isSafeAttachmentStorageId(value)) {
    throw new Error(`Invalid ${label}`);
  }
}
