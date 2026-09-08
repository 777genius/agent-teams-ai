/**
 * Persisted launch-failure reasons are sometimes the raw JSON body of a
 * `SendMessage` result, and older builds truncated it mid-string. These helpers
 * recover the human-readable part from both shapes.
 */

function decodeJsonStringLiteral(value: string): string {
  try {
    return JSON.parse(`"${value}"`) as string;
  } catch {
    return value.replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\');
  }
}

function extractLooseJsonStringField(text: string, fieldName: string): string | undefined {
  const strictMatch = new RegExp(`"${fieldName}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`).exec(text);
  if (strictMatch?.[1]) {
    return decodeJsonStringLiteral(strictMatch[1]).trim() || undefined;
  }

  const looseMatch = new RegExp(`"${fieldName}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)$`).exec(text);
  return looseMatch?.[1] ? decodeJsonStringLiteral(looseMatch[1]).trim() || undefined : undefined;
}

function joinUniqueReasonParts(parts: readonly (string | undefined)[]): string | undefined {
  const uniqueParts = Array.from(
    new Set(parts.map((part) => part?.trim()).filter((part): part is string => !!part))
  );
  return uniqueParts.length > 0 ? uniqueParts.join(': ') : undefined;
}

export function extractMessageSendRoutingReason(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed.includes('Message sent to') && !trimmed.includes('"routing"')) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(trimmed) as {
      success?: unknown;
      message?: unknown;
      routing?: { summary?: unknown; content?: unknown };
    };
    if (parsed.success === true && parsed.routing && typeof parsed.routing === 'object') {
      return joinUniqueReasonParts([
        typeof parsed.routing.summary === 'string' ? parsed.routing.summary : undefined,
        typeof parsed.routing.content === 'string' ? parsed.routing.content : undefined,
      ]);
    }
  } catch {
    // Fall through to loose extraction for persisted reasons truncated by older builds.
  }

  return joinUniqueReasonParts([
    extractLooseJsonStringField(trimmed, 'summary'),
    extractLooseJsonStringField(trimmed, 'content'),
  ]);
}
