/**
 * Preview type registry for binary files.
 *
 * Extensible: add a new PreviewType + extension set + component to support new formats.
 */

export type PreviewType = 'image' | 'unknown';

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico']);

const IMAGE_MAX_SIZE = 10 * 1024 * 1024; // 10 MB

const MIME_MAP: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
};

function getExtension(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  if (dot === -1) return '';
  return fileName.slice(dot + 1).toLowerCase();
}

export function getPreviewType(fileName: string): PreviewType {
  const ext = getExtension(fileName);
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  return 'unknown';
}

export function isPreviewable(fileName: string, size: number): boolean {
  const type = getPreviewType(fileName);
  if (type === 'image') return size <= IMAGE_MAX_SIZE;
  return false;
}

export function getMimeType(fileName: string): string | null {
  const ext = getExtension(fileName);
  return MIME_MAP[ext] ?? null;
}
