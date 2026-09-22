import { stripAgentBlocks } from '@shared/constants/agentBlocks';

import type { InboxMessage } from '@shared/types';

export const PENDING_INBOX_RELAY_TTL_MS = 2 * 60 * 1000;
export const INBOX_RELAY_IN_FLIGHT_TIMEOUT_MS = 2 * 60_000;
// Preserve ownership for one additional caller timeout before treating work as hung.
export const INBOX_RELAY_IN_FLIGHT_LEASE_MS = INBOX_RELAY_IN_FLIGHT_TIMEOUT_MS * 2;
export const SILENT_TEAMMATE_FORWARD_CLEAR_MS = 60_000;

export interface PendingInboxRelayCandidate {
  recipient: string;
  sourceMessageId: string;
  normalizedText: string;
  normalizedSummary: string;
  queuedAtMs: number;
}

export interface SilentTeammateForward {
  target: string;
  startedAt: string;
  mode: 'user_dm' | 'member_inbox_relay';
}

export interface InboxRelayCandidateRunState {
  pendingInboxRelayCandidates: PendingInboxRelayCandidate[];
}

export interface SilentTeammateForwardRunState {
  silentUserDmForward: SilentTeammateForward | null;
  silentUserDmForwardClearHandle: NodeJS.Timeout | null;
}

export class InboxRelayInFlightTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InboxRelayInFlightTimeoutError';
  }
}

export function isInboxRelayInFlightTimeoutError(
  error: unknown
): error is InboxRelayInFlightTimeoutError {
  return error instanceof InboxRelayInFlightTimeoutError;
}

export async function waitForInboxRelayInFlight<T>(input: {
  promise: Promise<T>;
  relayName: string;
  relayKey: string;
  timeoutMs?: number;
}): Promise<T> {
  const timeoutMs = input.timeoutMs ?? INBOX_RELAY_IN_FLIGHT_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      input.promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new InboxRelayInFlightTimeoutError(
              `${input.relayName} timed out after ${timeoutMs}ms: ${input.relayKey}`
            )
          );
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export function normalizeRelayCandidateText(text: string): string {
  return stripAgentBlocks(String(text)).trim().replace(/\r\n/g, '\n');
}

export function normalizeRelayCandidateSummary(summary?: string): string {
  return typeof summary === 'string' ? summary.trim() : '';
}

export function prunePendingInboxRelayCandidates(
  run: InboxRelayCandidateRunState,
  nowMs = Date.now()
): PendingInboxRelayCandidate[] {
  const cutoff = nowMs - PENDING_INBOX_RELAY_TTL_MS;
  run.pendingInboxRelayCandidates = (run.pendingInboxRelayCandidates ?? []).filter(
    (candidate) => candidate.queuedAtMs >= cutoff
  );
  return run.pendingInboxRelayCandidates;
}

export function rememberPendingInboxRelayCandidates(
  run: InboxRelayCandidateRunState,
  recipient: string,
  messages: Pick<InboxMessage, 'messageId' | 'text' | 'summary'>[],
  nowMs = Date.now()
): string[] {
  const candidates = prunePendingInboxRelayCandidates(run, nowMs);
  const rememberedIds: string[] = [];
  for (const message of messages) {
    const sourceMessageId = typeof message.messageId === 'string' ? message.messageId.trim() : '';
    const normalizedText = normalizeRelayCandidateText(message.text);
    if (!sourceMessageId || !normalizedText) {
      continue;
    }
    candidates.push({
      recipient,
      sourceMessageId,
      normalizedText,
      normalizedSummary: normalizeRelayCandidateSummary(message.summary),
      queuedAtMs: nowMs,
    });
    rememberedIds.push(sourceMessageId);
  }
  return rememberedIds;
}

export function forgetPendingInboxRelayCandidates(
  run: InboxRelayCandidateRunState,
  recipient: string,
  sourceMessageIds: readonly string[]
): void {
  if (sourceMessageIds.length === 0) {
    return;
  }
  const idSet = new Set(sourceMessageIds);
  run.pendingInboxRelayCandidates = prunePendingInboxRelayCandidates(run).filter(
    (candidate) => !(candidate.recipient === recipient && idSet.has(candidate.sourceMessageId))
  );
}

export function consumePendingInboxRelayCandidate(
  run: InboxRelayCandidateRunState,
  recipient: string,
  text: string,
  summary?: string
): string | undefined {
  const normalizedText = normalizeRelayCandidateText(text);
  if (!normalizedText) {
    return undefined;
  }
  const normalizedSummary = normalizeRelayCandidateSummary(summary);
  const candidates = prunePendingInboxRelayCandidates(run);
  const exactSummaryIdx = candidates.findIndex(
    (candidate) =>
      candidate.recipient === recipient &&
      candidate.normalizedText === normalizedText &&
      candidate.normalizedSummary === normalizedSummary
  );
  const fallbackIdx =
    exactSummaryIdx >= 0
      ? exactSummaryIdx
      : candidates.findIndex(
          (candidate) =>
            candidate.recipient === recipient && candidate.normalizedText === normalizedText
        );
  if (fallbackIdx < 0) {
    return undefined;
  }
  const [matched] = candidates.splice(fallbackIdx, 1);
  return matched?.sourceMessageId;
}

export function armSilentTeammateForward(
  run: SilentTeammateForwardRunState,
  teammateName: string,
  mode: SilentTeammateForward['mode'],
  nowIso = new Date().toISOString()
): void {
  run.silentUserDmForward = { target: teammateName, startedAt: nowIso, mode };
  if (run.silentUserDmForwardClearHandle) {
    clearTimeout(run.silentUserDmForwardClearHandle);
    run.silentUserDmForwardClearHandle = null;
  }
  run.silentUserDmForwardClearHandle = setTimeout(() => {
    run.silentUserDmForward = null;
    run.silentUserDmForwardClearHandle = null;
  }, SILENT_TEAMMATE_FORWARD_CLEAR_MS);
  run.silentUserDmForwardClearHandle.unref();
}
