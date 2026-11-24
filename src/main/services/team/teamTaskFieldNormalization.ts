/**
 * Normalise escaped newline sequences (`\\n`) that some MCP/CLI sources
 * write as literal two-character strings instead of real line-breaks.
 * Also handles `\\t` for consistency.  Only operates on isolated escape
 * sequences — already-real newlines are left untouched.
 */
export function unescapeLiteralNewlines(text: string): string {
  // Replace literal two-char sequences \n and \t with real control chars.
  // The regex matches a single backslash followed by 'n' or 't'.
  return text.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
}

export function isValidMimeTypeString(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (!v) return false;
  // Keep it reasonably bounded and avoid control characters.
  if (v.length > 200) return false;
  if (v.includes('\0') || /[\r\n]/.test(v)) return false;
  // Minimal MIME shape: type/subtype
  const slash = v.indexOf('/');
  if (slash <= 0 || slash === v.length - 1) return false;
  return true;
}
