/** Redact credential fields inside prose, JSON, and environment assignments.
 * Scan quoted values before callers collapse whitespace or truncate the input:
 * escaped quotes and newlines can be part of a secret, and an unfinished quoted
 * value must fail closed through the end of the diagnostic.
 */
export function redactDiagnosticAssignments(
  value: string,
  isSensitiveKey: (key: string) => boolean
): string {
  // Do not restart at every hyphen in a non-assignment: that makes long dashed
  // diagnostics quadratic before the bridge has a chance to cap the result.
  const assignments = /(?<![a-z0-9_-])([a-z0-9_-]+)(\\*["'`])?\s*([:=])\s*/gi;
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
    const quote = value[start + (value[start] === '\\' ? 1 : 0)];
    let end = start;
    // Support raw and once-escaped JSON. Deeper or unsupported encodings must
    // not expose a suffix when their quote boundaries cannot be established.
    if ((match[2]?.length ?? 1) > 2 || value.startsWith('\\\\', start)) {
      end = value.length;
    } else if (quote === '"' || quote === "'" || quote === '`') {
      end = quotedValueEnd(value, start);
    } else if (jsonField && value.startsWith('[redacted]', start)) {
      end += '[redacted]'.length;
    } else if (jsonField && (value[start] === '{' || value[start] === '[')) {
      end = containerValueEnd(value, start, match[2]?.startsWith('\\') ?? false);
    } else {
      const delimiter = jsonField ? /[\s,"'`;}\]]/ : /[\s"'`]/;
      while (end < value.length && !delimiter.test(value.charAt(end))) end += 1;
    }
    if (jsonField) {
      // A valid value followed by malformed text is still unsafe; this also
      // keeps re-redaction from exposing a suffix after our own marker.
      let next = end;
      while (next < value.length && /\s/.test(value.charAt(next))) next += 1;
      if (next < value.length && !/[,;}\]]/.test(value.charAt(next))) end = value.length;
    }
    result += value.slice(cursor, start) + '[redacted]';
    cursor = Math.min(end, value.length);
    assignments.lastIndex = cursor;
  }
  return result + value.slice(cursor);
}

function quotedValueEnd(value: string, start: number): number {
  const escapedQuote = value[start] === '\\';
  const quote = value[start + (escapedQuote ? 1 : 0)];
  let end = start + (escapedQuote ? 2 : 1);
  while (end < value.length) {
    if (value[end] === '\\') {
      if (escapedQuote) {
        const slashStart = end;
        while (value[end] === '\\') end += 1;
        // In JSON-escaped text, \" closes a value, but \\\" is content.
        if (value[end] === quote && (end - slashStart) % 4 === 1) return end + 1;
        if (value[end] === quote) end += 1;
      } else {
        end += 2;
      }
    } else if (value[end++] === quote && !escapedQuote) {
      return end;
    }
  }
  return value.length;
}

/** Consume the whole sensitive object/array, including nested and quoted data.
 * Unclosed strings/containers or mismatched brackets discard the remaining text.
 */
function containerValueEnd(value: string, start: number, escaped: boolean): number {
  const closers: string[] = [];
  let end = start;
  while (end < value.length) {
    const char = value.charAt(end);
    if (/["'`]/.test(char) || (char === '\\' && /["'`]/.test(value.charAt(end + 1)))) {
      end = quotedValueEnd(value, end);
      continue;
    }
    if (char === '{' || char === '[') {
      closers.push(char === '{' ? '}' : ']');
    } else if (char === '}' || char === ']') {
      if (closers.pop() !== char) return value.length;
      if (closers.length === 0) {
        try {
          const text = value.slice(start, end + 1);
          const decoded: unknown = escaped ? JSON.parse(`"${text}"`) : text;
          if (typeof decoded !== 'string') return value.length;
          JSON.parse(decoded);
          return end + 1;
        } catch {
          return value.length;
        }
      }
    }
    end += 1;
  }
  return value.length;
}
