let pendingSendIdCounter = 0;

export function createPendingSendId(): string {
  const randomId = globalThis.crypto?.randomUUID?.();
  if (randomId) return randomId;
  pendingSendIdCounter += 1;
  return `${Date.now()}-${pendingSendIdCounter}`;
}

export function buildRevisionCorrectionText(originalMessageId: string, text: string): string {
  return [
    `Correction for my previous message (MessageId: ${originalMessageId}).`,
    '',
    'Please use this corrected version instead:',
    '',
    text,
  ].join('\n');
}
