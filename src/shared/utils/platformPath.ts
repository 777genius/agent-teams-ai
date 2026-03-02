/**
 * Cross-platform path utilities for the renderer process.
 *
 * Node's `path` module is unavailable in the renderer, and incoming paths
 * may originate from any OS (Unix `/` or Windows `\`).  Every helper here
 * handles both separators transparently.
 */

const SEP_RE = /[/\\]/;

/** Split a file path on both `/` and `\` separators. */
export function splitPath(filePath: string): string[] {
  return filePath.split(SEP_RE).filter(Boolean);
}

/** Get the last segment (filename) from a path. */
export function getBasename(filePath: string): string {
  const parts = splitPath(filePath);
  return parts[parts.length - 1] ?? '';
}

/** Get directory part of a path (everything before the last separator). */
export function getDirname(filePath: string): string {
  const lastSep = lastSeparatorIndex(filePath);
  return lastSep === -1 ? '' : filePath.substring(0, lastSep);
}

/** Find the last path separator index (handles both `/` and `\`). */
export function lastSeparatorIndex(filePath: string): number {
  return Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
}
