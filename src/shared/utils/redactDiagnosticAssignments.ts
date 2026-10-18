/** Redact credential fields inside prose, JSON, and environment assignments.
 * Scan quoted values before callers collapse whitespace or truncate the input:
 * escaped quotes and newlines can be part of a secret, and an unfinished quoted
 * value must fail closed through the end of the diagnostic.
 */
export function redactDiagnosticAssignments(
  value: string,
  isSensitiveKey: (key: string) => boolean
): string {
  const assignments = /\b([a-z0-9_-]+)(\\?["'`])?\s*([:=])\s*/gi;
  let result = '';
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = assignments.exec(value)) !== null) {
    const key = match[1];
    if (!key || !isSensitiveKey(key)) continue;

    const jsonField = match[2] !== undefined && match[3] === ':';
    let start = assignments.lastIndex;
    // A bare Authorization header has a scheme followed by its credential.
    const scheme = /^(?:Bearer|Basic)\s+/i.exec(value.slice(start));
    if (scheme) start += scheme[0].length;
    const escapedQuote = value[start] === '\\' && /["'`]/.test(value[start + 1] ?? '');
    const quote = value[start + (escapedQuote ? 1 : 0)];
    let end = start;
    if (quote === '"' || quote === "'" || quote === '`') {
      end += escapedQuote ? 2 : 1;
      while (end < value.length) {
        if (value[end] === '\\') {
          if (escapedQuote) {
            const slashStart = end;
            while (value[end] === '\\') end += 1;
            // In JSON-escaped text, \" closes a value, but \\\" is content.
            if (value[end] === quote && (end - slashStart) % 4 === 1) {
              end += 1;
              break;
            }
            if (value[end] === quote) end += 1;
          } else {
            end += 2;
          }
        } else if (value[end++] === quote && !escapedQuote) {
          break;
        }
      }
    } else if (jsonField && value.startsWith('[redacted]', start)) {
      end += '[redacted]'.length;
    } else {
      const delimiter = jsonField ? /[\s,"'`;}\]]/ : /[\s"'`]/;
      while (end < value.length && !delimiter.test(value.charAt(end))) end += 1;
    }
    result += value.slice(cursor, start) + '[redacted]';
    cursor = Math.min(end, value.length);
    assignments.lastIndex = cursor;
  }
  return result + value.slice(cursor);
}
