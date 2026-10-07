import { DOCUMENT_PREVIEW_MAX_BYTES, getDocumentFormat } from '../../core/domain/documentPolicy';

export const PREVIEW_PROTOCOL = 'document-preview-v1';
export interface PreviewLoadMessage {
  protocol: typeof PREVIEW_PROTOCOL;
  requestId: string;
  kind: 'load';
  buffer: ArrayBuffer;
  fileName: string;
  theme: 'light' | 'dark';
}

export function isPreviewLoadMessage(value: unknown): value is PreviewLoadMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as Partial<PreviewLoadMessage>;
  return (
    message.protocol === PREVIEW_PROTOCOL &&
    message.kind === 'load' &&
    typeof message.requestId === 'string' &&
    message.requestId.length <= 100 &&
    typeof message.fileName === 'string' &&
    !/[/\\]/.test(message.fileName) &&
    getDocumentFormat(message.fileName) !== null &&
    message.buffer instanceof ArrayBuffer &&
    message.buffer.byteLength > 0 &&
    message.buffer.byteLength <= DOCUMENT_PREVIEW_MAX_BYTES &&
    (message.theme === 'light' || message.theme === 'dark')
  );
}

// The preview has a dedicated origin in development and production.
// The actual iframe WindowProxy is checked separately by its parent.
export function isPreviewOrigin(origin: string): boolean {
  return origin === 'document-preview://viewer';
}
