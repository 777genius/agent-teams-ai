export interface FullPeerTarget {
  messageId: string;
  from: string;
  to: string;
  text: string;
  laneId: string;
  runtimeSessionId: string;
}
export interface FullPeerObservation {
  rows: { messageId?: string; from?: string; to?: string; text?: string; read?: boolean }[];
  receipts: { inboxMessageId?: string; teamName?: string; memberName?: string; runId?: string | null;
    laneId?: string; runtimeSessionId?: string | null; replyRecipient?: string;
    status?: string; responseState?: string; inboxReadCommittedAt?: string | null;
    inboxReadCommitError?: string | null; cancelledAt?: string | null;
    acceptedAt?: string | null; acceptanceUnknown?: boolean; runtimePromptMessageId?: string | null;
    lastRuntimePromptMessageId?: string | null; deliveredUserMessageId?: string | null;
    observedAssistantMessageId?: string | null; observedAssistantPreview?: string | null;
    observedToolCallNames?: string[]; respondedAt?: string | null; lastReason?: string | null }[];
}

/** Observation only: never submit/retry a message while waiting for its read receipt. */
export async function settleFullTeamPeers(input: {
  teamName: string;
  runId: string;
  targets: FullPeerTarget[];
  read: () => Promise<FullPeerObservation>;
  timeoutMs: number;
  now?: () => number;
  pause?: (ms: number) => Promise<void>;
}) {
  if (input.targets.length !== 4 || new Set(input.targets.map(row => row.messageId)).size !== 4 ||
    input.targets.some(row => !row.messageId || !row.from || !row.to || !row.text || !row.laneId || !row.runtimeSessionId))
    throw new Error('Four distinct exact peer targets required');
  const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
  const timestamp = (value: unknown) => nonempty(value) && Number.isFinite(Date.parse(value));
  const now = input.now ?? Date.now;
  const pause = input.pause ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const deadline = now() + input.timeoutMs;
  let checks: { messageId: string; inboxRead: boolean; readCommitted: boolean }[] = [];
  let unavailable = false;
  do {
    let readTimedOut = false;
    let readTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      // A stalled filesystem observation must not prevent the caller's Stop.
      // Leave the original read pending: it has no effects and must not be retried.
      const observed = await Promise.race([
        Promise.resolve().then(input.read),
        new Promise<never>((_, reject) => {
          readTimer = setTimeout(() => {
            readTimedOut = true;
            reject(new Error('Peer read observation deadline'));
          }, Math.max(0, deadline - now()));
        }),
      ]);
      unavailable = false;
      checks = input.targets.map(target => {
        const rows = observed.rows.filter(row => row.messageId === target.messageId);
        const receipts = observed.receipts.filter(row => row.inboxMessageId === target.messageId &&
          row.teamName === input.teamName && row.runId === input.runId && row.memberName === target.to &&
          row.laneId === target.laneId && row.runtimeSessionId === target.runtimeSessionId &&
          row.replyRecipient === target.from);
        const receipt = receipts.length === 1 ? receipts[0] : undefined;
        const promptId = receipt?.lastRuntimePromptMessageId ?? receipt?.runtimePromptMessageId;
        const boundCompletedResponse = receipt && !receipt.cancelledAt &&
          receipt.inboxReadCommitError === null && timestamp(receipt.acceptedAt) &&
          receipt.acceptanceUnknown === false && nonempty(promptId) &&
          receipt.deliveredUserMessageId === promptId && nonempty(receipt.observedAssistantMessageId);
        const responded = receipt?.status === 'responded' && timestamp(receipt.respondedAt) &&
          ['responded_tool_call', 'responded_visible_message', 'responded_non_visible_tool',
            'responded_plain_text'].includes(receipt.responseState ?? '');
        // Direct ACKs are deliberately silent. Production commits their exact
        // completed child without changing unanswered to responded.
        const silentAck = target.text.startsWith('ACK:') && receipt?.status === 'unanswered' &&
          receipt.responseState === 'empty_assistant_turn' &&
          receipt.lastReason === 'assistant_child_completed_without_visible_or_meaningful_response' &&
          !receipt.observedAssistantPreview?.trim() && Array.isArray(receipt.observedToolCallNames) &&
          receipt.observedToolCallNames.length === 0;
        return {
          messageId: target.messageId,
          inboxRead: rows.length === 1 && rows[0]?.from === target.from &&
            rows[0]?.to === target.to && rows[0]?.text === target.text && rows[0]?.read === true,
          readCommitted: Boolean(boundCompletedResponse && timestamp(receipt?.inboxReadCommittedAt) &&
            (responded || silentAck)),
        };
      });
      if (checks.every(row => row.inboxRead && row.readCommitted))
        return { settled: true, unavailable, checks };
    } catch { unavailable = true; }
    finally { clearTimeout(readTimer); }
    if (readTimedOut || now() >= deadline) break;
    await pause(Math.min(2_000, deadline - now()));
  } while (now() <= deadline);
  return { settled: false, unavailable, checks };
}
