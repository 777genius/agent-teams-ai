/**
 * Cross-platform path utilities for the renderer process.
 *
 * The renderer has no access to Node's `path` module, and session data
 * may originate from any OS, so all helpers handle both `/` and `\`.
 */

const SEP_RE = /[\\/]/;

/**
 * Returns the last segment of a path (the file or directory name).
 * Equivalent to `path.basename()` but handles both separators.
 */
export function getBaseName(filePath: string): string {
  const parts = filePath.split(SEP_RE);
  return parts[parts.length - 1] || '';
}

/**
 * Returns the first meaningful segment of a path.
 * Leading empty segments (from absolute paths like `/foo`) are skipped.
 */
export function getFirstSegment(filePath: string): string {
  const parts = filePath.split(SEP_RE).filter(Boolean);
  return parts[0] ?? '';
}

/**
 * Splits a path into non-empty segments.
 */
export function splitPathSegments(filePath: string): string[] {
  return filePath.split(SEP_RE).filter(Boolean);
}

/**
 * Returns true if the string contains a path separator (`/` or `\`).
 */
export function hasPathSeparator(filePath: string): boolean {
  return SEP_RE.test(filePath);
}

/**
 * Returns true if the path starts with `./`, `.\`, `../`, or `..\`.
 */
export function isRelativePath(filePath: string): boolean {
  return /^\.\.?[\\/]/.test(filePath);
}
