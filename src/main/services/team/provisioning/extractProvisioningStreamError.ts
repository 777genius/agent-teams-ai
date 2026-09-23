export function extractStreamUserText(msg: Record<string, unknown>): string | null {
  const topLevelContent = msg.content;
  if (typeof topLevelContent === 'string') {
    return topLevelContent;
  }
  if (Array.isArray(topLevelContent)) {
    const text = topLevelContent
      .filter(
        (part): part is Record<string, unknown> =>
          !!part &&
          typeof part === 'object' &&
          part.type === 'text' &&
          typeof part.text === 'string'
      )
      .map((part) => part.text as string)
      .join('\n')
      .trim();
    if (text.length > 0) return text;
  }

  const message = msg.message;
  if (!message || typeof message !== 'object') return null;
  const innerContent = (message as Record<string, unknown>).content;
  if (typeof innerContent === 'string') {
    const trimmed = innerContent.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (!Array.isArray(innerContent)) return null;
  const text = innerContent
    .filter(
      (part): part is Record<string, unknown> =>
        !!part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string'
    )
    .map((part) => part.text as string)
    .join('\n')
    .trim();
  return text.length > 0 ? text : null;
}

export function extractProvisioningStreamError(msg: Record<string, unknown>): string {
  if (typeof msg.error === 'string' && msg.error.trim()) {
    return msg.error.trim();
  }
  if (Array.isArray(msg.errors)) {
    const parts = msg.errors.filter(
      (entry): entry is string => typeof entry === 'string' && entry.trim().length > 0
    );
    if (parts.length > 0) {
      return parts.join('\n');
    }
  }
  const nested = msg.result;
  if (nested && typeof nested === 'object') {
    const nestedError = extractProvisioningStreamError(nested as Record<string, unknown>);
    if (nestedError !== 'unknown') {
      return nestedError;
    }
  }
  const assistantText = extractStreamUserText(msg);
  if (assistantText) {
    return assistantText.length > 500 ? `${assistantText.slice(0, 500)}…` : assistantText;
  }
  if (msg.error != null) {
    return JSON.stringify(msg.error);
  }
  return 'unknown';
}
