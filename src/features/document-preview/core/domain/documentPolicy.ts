import type { DocumentFormat } from '../../contracts';

// Bound the IPC allocation and the parser input, independently of text editor limits.
export const DOCUMENT_PREVIEW_MAX_BYTES = 20 * 1024 * 1024;
const FORMATS = new Set<DocumentFormat>(['pdf', 'docx', 'xlsx', 'pptx']);

export function getDocumentFormat(fileName: string): DocumentFormat | null {
  const separator = Math.max(fileName.lastIndexOf('/'), fileName.lastIndexOf('\\'));
  const dot = fileName.lastIndexOf('.');
  if (dot <= separator) return null;
  const extension = fileName.slice(dot + 1).toLowerCase();
  return FORMATS.has(extension as DocumentFormat) ? (extension as DocumentFormat) : null;
}

export function isDocumentPreviewable(fileName: string, size: number): boolean {
  return (
    getDocumentFormat(fileName) !== null &&
    Number.isSafeInteger(size) &&
    size > 0 &&
    size <= DOCUMENT_PREVIEW_MAX_BYTES
  );
}
