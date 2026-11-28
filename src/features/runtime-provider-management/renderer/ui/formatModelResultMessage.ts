function decodeJsonStringLiteral(value: string): string {
  let decoded = value.trim();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (!decoded.startsWith('"') || !decoded.endsWith('"')) {
      break;
    }
    try {
      const parsed = JSON.parse(decoded);
      if (typeof parsed !== 'string') {
        break;
      }
      decoded = parsed.trim();
    } catch {
      break;
    }
  }
  return decoded;
}

function parseNestedJsonStrings(value: unknown, depth = 0): unknown {
  if (depth >= 4) {
    return value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))
    ) {
      try {
        return parseNestedJsonStrings(JSON.parse(trimmed), depth + 1);
      } catch {
        return value;
      }
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => parseNestedJsonStrings(entry, depth + 1));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, parseNestedJsonStrings(entry, depth + 1)])
    );
  }
  return value;
}

interface JsonPayloadRange {
  readonly start: number;
  readonly end: number;
}

const MAX_JSON_PAYLOAD_PARSE_ATTEMPTS = 64;
const MAX_JSON_PAYLOAD_LENGTH = 256_000;
function isPlausibleJsonPayloadStart(value: string, start: number): boolean {
  const opener = value[start];
  let cursor = start + 1;
  while (cursor < value.length && /\s/u.test(value[cursor] ?? '')) {
    cursor += 1;
  }
  const next = value[cursor];
  if (opener === '{') {
    return next === '"' || next === '}';
  }
  if (opener === '[') {
    return (
      next === '"' ||
      next === '{' ||
      next === '[' ||
      next === ']' ||
      next === '-' ||
      next === 't' ||
      next === 'f' ||
      next === 'n' ||
      (next !== undefined && /\d/u.test(next))
    );
  }
  return false;
}

function findBalancedJsonPayloadRanges(value: string): JsonPayloadRange[] {
  const stack: Array<{ opener: '{' | '['; start: number }> = [];
  const ranges: JsonPayloadRange[] = [];
  let inString = false;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      // Quotes in the human-readable prefix are not JSON strings. Start string
      // tracking only after a plausible JSON container has opened.
      inString = stack.length > 0;
      continue;
    }
    if (character === '{' || character === '[') {
      if (isPlausibleJsonPayloadStart(value, index)) {
        stack.push({ opener: character, start: index });
      } else if (stack.length > 0) {
        stack.length = 0;
      }
      continue;
    }
    if (character !== '}' && character !== ']') {
      continue;
    }

    const frame = stack.at(-1);
    const expectedCloser = frame?.opener === '{' ? '}' : frame?.opener === '[' ? ']' : null;
    if (!frame || character !== expectedCloser) {
      // Keep scanning after malformed labels or truncated payloads. A later
      // self-contained JSON object can still be presented usefully.
      stack.length = 0;
      continue;
    }

    stack.pop();
    const length = index - frame.start + 1;
    if (
      ranges.length < MAX_JSON_PAYLOAD_PARSE_ATTEMPTS &&
      length <= MAX_JSON_PAYLOAD_LENGTH &&
      isPlausibleJsonPayloadStart(value, frame.start)
    ) {
      ranges.push({ start: frame.start, end: index });
    }
  }

  return ranges.sort((left, right) => left.start - right.start || right.end - left.end);
}

export function formatModelResultMessage(message: string): {
  readonly summary: string;
  readonly details: unknown | null;
} {
  const decoded = decodeJsonStringLiteral(message);
  for (const { start, end } of findBalancedJsonPayloadRanges(decoded)) {
    try {
      const details = parseNestedJsonStrings(JSON.parse(decoded.slice(start, end + 1)));
      return {
        summary: decoded
          .slice(0, start)
          .trim()
          .replace(/[:\s-]+$/u, ''),
        details,
      };
    } catch {
      // A label may contain balanced non-JSON brackets before the actual payload.
    }
  }

  return { summary: decoded, details: null };
}
