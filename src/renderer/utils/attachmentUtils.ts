import type { AttachmentPayload, ImageMimeType } from '@shared/types';

export const ALLOWED_MIME_TYPES = new Set<ImageMimeType>([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

export const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
export const MAX_FILES = 5;
export const MAX_TOTAL_SIZE = 20 * 1024 * 1024; // 20MB

export function isImageMimeType(type: string): type is ImageMimeType {
  return ALLOWED_MIME_TYPES.has(type as ImageMimeType);
}

export function validateAttachment(file: File): { valid: true } | { valid: false; error: string } {
  if (!isImageMimeType(file.type)) {
    return { valid: false, error: `Unsupported file type: ${file.type}` };
  }
  if (file.size > MAX_FILE_SIZE) {
    return { valid: false, error: `File "${file.name}" exceeds 10MB limit` };
  }
  return { valid: true };
}

export async function fileToAttachmentPayload(file: File): Promise<AttachmentPayload> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      // Strip "data:image/png;base64," prefix to get raw base64
      const base64 = dataUrl.split(',')[1] ?? '';
      resolve({
        id: crypto.randomUUID(),
        filename: file.name,
        mimeType: file.type,
        size: file.size,
        data: base64,
      });
    };
    reader.onerror = () => reject(new Error(`Failed to read file: ${file.name}`));
    reader.readAsDataURL(file);
  });
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
