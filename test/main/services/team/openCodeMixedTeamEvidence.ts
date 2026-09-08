import { expect } from 'vitest';
type JsonRecord = Record<string, unknown>;
// Read structured assistant tool evidence, never substring-match a user prompt or raw JSON dump.
export function successfulTools(
  transcript: unknown
): { name: string; input: string; output: string }[] {
  const data = record(record(transcript)?.data);
  const messages = data?.messages;
  if (!Array.isArray(messages)) return [];
  const calls: { name: string; input: string; output: string }[] = [];
  for (const rawMessage of messages) {
    const message = record(rawMessage);
    if (message?.role !== 'assistant' || !Array.isArray(message.contentBlocks)) continue;
    const blocks = message.contentBlocks
      .map(record)
      .filter((block): block is JsonRecord => block !== null);
    for (const block of blocks) {
      if (
        block.type !== 'tool_use' ||
        typeof block.name !== 'string' ||
        typeof block.id !== 'string'
      )
        continue;
      const result = blocks.find(
        (candidate) =>
          candidate.type === 'tool_result' &&
          candidate.toolUseId === block.id &&
          candidate.isError !== true &&
          candidate.status === 'completed'
      );
      if (result)
        calls.push({
          name: block.name,
          input: JSON.stringify(block.input),
          output: String(result.contentText ?? ''),
        });
    }
  }
  return calls;
}
export function assertTranscriptModel(transcript: unknown, selected: string): void {
  const messages = record(record(transcript)?.data)?.messages;
  expect(Array.isArray(messages)).toBe(true);
  const modelPairs = (Array.isArray(messages) ? messages : [])
    .map(record)
    .filter((message) => message?.role === 'assistant' && message.providerId && message.modelId)
    .map((message) => `${message!.providerId}/${message!.modelId}`);
  expect(modelPairs.length).toBeGreaterThan(0);
  expect([...new Set(modelPairs)]).toEqual([selected]);
}

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

export function relayMetadata(value: unknown) {
  const root = record(value) ?? {};
  const delivery = record(root.lastDelivery) ?? {};
  const number = (item: unknown) =>
    typeof item === 'number' && Number.isFinite(item) ? item : null;
  const boolean = (item: unknown) => (typeof item === 'boolean' ? item : null);
  return {
    attempted: number(root.attempted),
    relayed: number(root.relayed),
    failed: number(root.failed),
    accepted: boolean(delivery.accepted),
    responsePending: boolean(delivery.responsePending),
    acceptanceUnknown: boolean(delivery.acceptanceUnknown),
    ledgerStatus: [
      'pending',
      'accepted',
      'responded',
      'unanswered',
      'retry_scheduled',
      'retried',
      'failed_retryable',
      'failed_terminal',
    ].includes(String(delivery.ledgerStatus))
      ? delivery.ledgerStatus
      : null,
    terminalFailure:
      delivery.ledgerStatus === 'failed_terminal' &&
      delivery.accepted !== true &&
      delivery.acceptanceUnknown !== true &&
      delivery.responsePending !== true,
  };
}
