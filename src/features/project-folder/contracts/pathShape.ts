/**
 * Renderer-safe path shape check that matches `parseProjectFolderPath` enough to
 * reject relative, empty, NUL, and filesystem-root values before a 250ms probe.
 * Main still re-validates with `path.isAbsolute` / `path.resolve`.
 */
export function isInvalidProjectFolderPathShape(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes('\0')) return true;
  const isWindowsAbsolute = /^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith('\\\\');
  const isPosixAbsolute = trimmed.startsWith('/');
  if (!isWindowsAbsolute && !isPosixAbsolute) return true;
  if (trimmed === '/' || trimmed === '\\') return true;
  return /^[A-Za-z]:[\\/]?$/.test(trimmed);
}
