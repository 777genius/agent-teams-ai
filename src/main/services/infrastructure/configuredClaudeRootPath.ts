import * as path from 'path';

export function normalizeConfiguredClaudeRootPath(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const normalized = path.normalize(trimmed);
  if (!path.isAbsolute(normalized)) {
    return null;
  }

  const resolved = path.resolve(normalized);
  const root = path.parse(resolved).root;
  if (resolved === root) {
    return resolved;
  }
  let end = resolved.length;
  while (end > root.length) {
    const char = resolved[end - 1];
    if (char !== '/' && char !== '\\') {
      break;
    }
    end--;
  }

  return resolved.slice(0, end);
}
