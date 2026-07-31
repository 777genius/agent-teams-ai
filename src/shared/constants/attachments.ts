/**
 * Attachment file categorization and MIME type helpers.
 *
 * Browser MIME types are unreliable:
 *   .ts → "video/mp2t", .json → "application/json", .go/.rs/.yaml → ""
 * So categorization is ALWAYS by file extension (primary), with browser MIME
 * used only as a fallback for images.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
export const VIDEO_MIME_TYPES = new Set(['video/mp4', 'video/webm', 'video/quicktime']);

/** Extensions recognized as image files (fallback when browser MIME is empty). */
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

/** Extensions recognized as provider-supported video files. */
const VIDEO_EXT_TO_MIME: Record<string, string> = {
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
};

/** Extensions recognized as text-based files → sent as `document` block with `text/plain`. */
export const TEXT_FILE_EXTENSIONS = new Set([
  // Data
  'json',
  'jsonl',
  'txt',
  'md',
  'mdx',
  'csv',
  'tsv',
  // JavaScript / TypeScript
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  // Other languages
  'py',
  'go',
  'rs',
  'java',
  'kt',
  'rb',
  'c',
  'h',
  'cpp',
  'hpp',
  'cs',
  'swift',
  'dart',
  'php',
  'lua',
  'scala',
  'ex',
  'exs',
  // Web
  'html',
  'css',
  'scss',
  'less',
  'vue',
  'svelte',
  // Config / markup
  'xml',
  'yaml',
  'yml',
  'toml',
  'ini',
  'cfg',
  'conf',
  // Shell
  'sh',
  'bash',
  'zsh',
  'fish',
  // Query / schema
  'sql',
  'graphql',
  'gql',
  'proto',
  // Misc text
  'env',
  'log',
  'rst',
  'diff',
  'patch',
  // Known filenames that happen to equal their "extension" when split on '.'
  'dockerfile',
  'makefile',
  'gitignore',
  'dockerignore',
  'editorconfig',
]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FileCategory = 'image' | 'video' | 'pdf' | 'text' | 'unsupported';

// ---------------------------------------------------------------------------
// Categorization
// ---------------------------------------------------------------------------

/**
 * Categorize a `File` by its **extension** (primary) — browser MIME is
 * unreliable for anything other than images.
 */
export function categorizeFile(file: File): FileCategory {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';

  // 1. Preserve the existing reliable image MIME path.
  if (IMAGE_MIME_TYPES.has(file.type)) return 'image';

  // 2. Check known extensions before video MIME because browsers report source
  // files such as `.ts` as `video/mp2t`.
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  if (TEXT_FILE_EXTENSIONS.has(ext)) return 'text';

  // 3. Special filenames / patterns
  const baseName = file.name.toLowerCase();
  if (baseName.startsWith('.env')) return 'text'; // .env.local, .env.production, etc.

  // 4. Recognize only explicit provider-supported video extensions/MIME types.
  if (ext in VIDEO_EXT_TO_MIME) return 'video';
  if (VIDEO_MIME_TYPES.has(file.type)) return 'video';

  return 'unsupported';
}

// ---------------------------------------------------------------------------
// MIME helpers
// ---------------------------------------------------------------------------

const IMAGE_EXT_TO_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

/**
 * Return the MIME type that should be stored in `AttachmentPayload.mimeType`
 * (used by the backend to choose the correct content block type).
 */
export function getEffectiveMimeType(file: File): string {
  const cat = categorizeFile(file);

  if (cat === 'image') {
    if (file.type && IMAGE_MIME_TYPES.has(file.type)) return file.type;
    // Fallback when browser returns empty MIME for an image extension
    const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
    return IMAGE_EXT_TO_MIME[ext] ?? 'image/png';
  }
  if (cat === 'video') {
    if (file.type && VIDEO_MIME_TYPES.has(file.type)) return file.type;
    const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
    return VIDEO_EXT_TO_MIME[ext] ?? 'video/mp4';
  }
  if (cat === 'pdf') return 'application/pdf';
  if (cat === 'text') return 'text/plain';

  return file.type || 'application/octet-stream';
}

// ---------------------------------------------------------------------------
// MIME type guards (used by backend routing & preview components)
// ---------------------------------------------------------------------------

export function isImageMime(mime: string): boolean {
  return IMAGE_MIME_TYPES.has(mime);
}

export function isVideoMime(mime: string): boolean {
  return VIDEO_MIME_TYPES.has(mime);
}

export function isPdfMime(mime: string): boolean {
  return mime === 'application/pdf';
}

export function isTextDocMime(mime: string): boolean {
  return mime === 'text/plain';
}

export function isNativeAttachmentMime(mime: string): boolean {
  return isImageMime(mime) || isVideoMime(mime) || isPdfMime(mime) || isTextDocMime(mime);
}
