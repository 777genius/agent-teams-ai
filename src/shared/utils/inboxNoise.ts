/**
 * Inbox "noise" messages are structured JSON objects that represent internal coordination
 * signals (idle/shutdown/etc.). They should not trigger user-facing notifications or
 * automatic lead relays.
 */
export const INBOX_NOISE_TYPES = [
  'idle_notification',
  'shutdown_approved',
  'teammate_terminated',
  'shutdown_request',
] as const;

const INBOX_NOISE_SET = new Set<string>(INBOX_NOISE_TYPES);

export function parseInboxJson(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // not JSON
  }
  return null;
}

export function getInboxJsonType(text: string): string | null {
  const parsed = parseInboxJson(text);
  if (!parsed) return null;
  return typeof parsed.type === 'string' ? parsed.type : null;
}

export function isInboxNoiseMessage(text: string): boolean {
  const type = getInboxJsonType(text);
  return !!type && INBOX_NOISE_SET.has(type);
}

// ---------------------------------------------------------------------------
// Teammate permission request parsing
// ---------------------------------------------------------------------------

/** Parsed teammate permission request from inbox message. */
export interface ParsedPermissionRequest {
  requestId: string;
  agentId: string;
  toolName: string;
  toolUseId: string;
  description: string;
  input: Record<string, unknown>;
}

/**
 * Parses a `permission_request` JSON message from a teammate's inbox entry.
 * Returns null if the text is not a valid permission_request.
 */
export function parsePermissionRequest(text: string): ParsedPermissionRequest | null {
  const parsed = parseInboxJson(text);
  if (!parsed || parsed.type !== 'permission_request') return null;

  const requestId = typeof parsed.request_id === 'string' ? parsed.request_id : null;
  const agentId = typeof parsed.agent_id === 'string' ? parsed.agent_id : null;
  const toolName = typeof parsed.tool_name === 'string' ? parsed.tool_name : null;

  if (!requestId || !agentId || !toolName) return null;

  return {
    requestId,
    agentId,
    toolName,
    toolUseId: typeof parsed.tool_use_id === 'string' ? parsed.tool_use_id : '',
    description: typeof parsed.description === 'string' ? parsed.description : '',
    input:
      parsed.input && typeof parsed.input === 'object' && !Array.isArray(parsed.input)
        ? (parsed.input as Record<string, unknown>)
        : {},
  };
}

// ---------------------------------------------------------------------------
// Teammate-message XML block detection & stripping
// ---------------------------------------------------------------------------

const TEAMMATE_MESSAGE_BLOCK_RE = /<teammate-message\s[^>]*>[\s\S]*?<\/teammate-message>/g;

/**
 * Removes `<teammate-message>` XML blocks from text.
 * Used to clean protocol artifacts that leak into lead thoughts.
 */
export function stripTeammateMessageBlocks(text: string): string {
  return text
    .replace(TEAMMATE_MESSAGE_BLOCK_RE, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Returns true if the entire text consists only of `<teammate-message>` blocks
 * (possibly with whitespace between them) and no meaningful user-visible content.
 */
export function isOnlyTeammateMessageBlocks(text: string): boolean {
  const stripped = stripTeammateMessageBlocks(text);
  return stripped.length === 0;
}

// ---------------------------------------------------------------------------
// Combined protocol noise check for lead thoughts
// ---------------------------------------------------------------------------

/**
 * Returns true if a lead thought text is entirely protocol noise and should
 * be hidden from the user.  Covers:
 * 1. Structured JSON noise (idle_notification, shutdown_*, etc.)
 * 2. Text that consists solely of `<teammate-message>` XML blocks
 */
export function isThoughtProtocolNoise(text: string): boolean {
  if (isInboxNoiseMessage(text)) return true;
  if (isOnlyTeammateMessageBlocks(text)) return true;
  return false;
}
