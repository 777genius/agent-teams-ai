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

/**
 * Returns true if the string looks like a Windows path (drive letter or UNC).
 * Used only to decide case-sensitivity for comparisons.
 */
export function isWindowsishPath(filePath: string): boolean {
  const p = filePath.replace(/\\/g, '/');
  return /^[A-Za-z]:\//.test(p) || p.startsWith('//');
}

/**
 * Normalize for comparisons:
 * - Convert `\` → `/`
 * - Lowercase only for Windows-ish paths (Windows is case-insensitive)
 *
 * Do NOT use this for filesystem operations; it's for comparisons only.
 */
export function normalizePathForComparison(filePath: string): string {
  const p = filePath.replace(/\\/g, '/');
  return isWindowsishPath(p) ? p.toLowerCase() : p;
}

/** Strip trailing path separators (except for root paths like "/" or "C:/"). */
export function stripTrailingSeparators(filePath: string): string {
  if (!filePath) return filePath;
  const p = filePath.replace(/\\/g, '/');
  if (p === '/' || /^[A-Za-z]:\/$/.test(p)) return filePath;
  // Trim trailing separators manually to avoid sonarjs/slow-regex
  let end = filePath.length;
  while (end > 0 && (filePath[end - 1] === '/' || filePath[end - 1] === '\\')) end--;
  return end === filePath.length ? filePath : filePath.slice(0, end);
}

/** Prefer the separator style already present in the path. */
export function getPreferredSeparator(filePath: string): '/' | '\\' {
  const hasBackslash = filePath.includes('\\');
  const hasSlash = filePath.includes('/');
  if (hasBackslash && !hasSlash) return '\\';
  return '/';
}

/** Join base + segments using the base path's preferred separator. */
export function joinPath(base: string, ...segments: string[]): string {
  const sep = getPreferredSeparator(base);
  let out = stripTrailingSeparators(base);
  for (const seg of segments) {
    // Trim leading and trailing separators manually to avoid sonarjs/slow-regex
    let start = 0;
    while (start < seg.length && (seg[start] === '/' || seg[start] === '\\')) start++;
    let segEnd = seg.length;
    while (segEnd > start && (seg[segEnd - 1] === '/' || seg[segEnd - 1] === '\\')) segEnd--;
    const cleaned = seg.slice(start, segEnd);
    if (!cleaned) continue;
    if (!out || out.endsWith('/') || out.endsWith('\\')) {
      out += cleaned;
    } else {
      out += sep + cleaned;
    }
  }
  return out;
}

/** True if fullPath is equal to prefix or is nested under prefix. */
export function isPathPrefix(prefix: string, fullPath: string): boolean {
  const p = stripTrailingSeparators(normalizePathForComparison(prefix));
  const f = stripTrailingSeparators(normalizePathForComparison(fullPath));
  if (f === p) return true;
  // Root prefixes are special: p already ends with "/" ("/" or "c:/").
  if (p === '/') return f.startsWith('/');
  if (/^[a-z]:\/$/.test(p)) return f.startsWith(p);
  return f.startsWith(p + '/');
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
