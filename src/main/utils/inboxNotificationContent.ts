import { parseInboxJson } from '@shared/utils/inboxNoise';

/**
 * Extracts human-readable summary and body from an inbox message.
 * Handles both plain text and serialized JSON ({"type":"message","content":"...","summary":"..."}).
 */
export function extractNotificationContent(text: string): { summary: string; body: string } {
  const parsed = parseInboxJson(text);
  if (!parsed) return { summary: text.slice(0, 80), body: text };

  const content = typeof parsed.content === 'string' ? parsed.content : null;
  const summary = typeof parsed.summary === 'string' ? parsed.summary : null;
  const message = typeof parsed.message === 'string' ? parsed.message : null;

  const bestBody = content || message || summary || text;
  const bestSummary =
    summary || (content ? content.slice(0, 80) : null) || message || text.slice(0, 80);

  return { summary: bestSummary, body: bestBody };
}
