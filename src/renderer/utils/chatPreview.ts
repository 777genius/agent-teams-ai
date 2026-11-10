export const CHAT_PREVIEW_MAX_LENGTH = 88;

export function truncateChatPreview(text: string): string {
  const codePoints = Array.from(text);
  if (codePoints.length <= CHAT_PREVIEW_MAX_LENGTH) return text;
  return `${codePoints.slice(0, CHAT_PREVIEW_MAX_LENGTH - 1).join('')}…`;
}
