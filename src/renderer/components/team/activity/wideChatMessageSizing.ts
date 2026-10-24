/** Only rendered message content, not a reply's fenced transport envelope, can widen a bubble. */
export function requiresWideChatContent(displayText: string | null, replyText?: string): boolean {
  const visibleText = replyText ?? displayText;
  return !!visibleText && (visibleText.length >= 600 || /```|^\s*\|.+\|\s*$/m.test(visibleText));
}
