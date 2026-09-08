import type { OpenCodeDeliveryResponseObservation } from '../bridge/OpenCodeBridgeCommandContract';

/**
 * Turn-progress stamps carried on a prompt-delivery ledger record.
 *
 * The stale-pending window is meant to measure how long a turn has been
 * *silent*. Before these stamps existed it measured elapsed time since the last
 * send, and the only thing that ever moved that anchor was another send. Once
 * the retry gate stopped re-sending into a live turn the anchor froze, so the
 * window began expiring on turns that were demonstrably still producing output.
 * The stamps give the window an anchor that moves with the turn instead of with
 * the mailbox.
 */
export interface OpenCodeTurnProgress {
  /** Last observation that showed the turn producing output. */
  lastTurnProgressAt?: string | null;
  /** Last observed runtime turn token usage; only growth counts as progress. */
  observedTurnUsedTokens?: number | null;
}

/** Observed-turn fields the progress check compares against. */
export interface OpenCodeObservedTurnRecord extends OpenCodeTurnProgress {
  observedAssistantMessageId: string | null;
  observedAssistantPreview: string | null;
  observedToolCallNames: string[];
}

export interface OpenCodeTurnProgressObservation {
  responseObservation: Pick<
    OpenCodeDeliveryResponseObservation,
    'assistantMessageId' | 'toolCallNames' | 'latestAssistantPreview'
  >;
  turnUsedTokens?: number | null;
  observedAt: string;
}

/**
 * The three signals `decideOpenCodePromptDeliveryTurnActivity` infers a live
 * turn from, applied to the ledger record instead of to a snapshot taken before
 * `applyObservation`. Kept in lockstep with that policy on purpose: a signal
 * that defers a retry must also stop the stale clock, or the two policies
 * disagree about the same observation.
 */
export function hasOpenCodeInferredTurnProgress(
  record: OpenCodeObservedTurnRecord,
  observation: OpenCodeTurnProgressObservation['responseObservation']
): boolean {
  const assistantMessageId = observation.assistantMessageId?.trim() ?? '';
  const previousAssistantMessageId = record.observedAssistantMessageId?.trim() ?? '';
  if (
    previousAssistantMessageId &&
    assistantMessageId &&
    assistantMessageId !== previousAssistantMessageId
  ) {
    return true;
  }
  if ((observation.toolCallNames?.length ?? 0) > record.observedToolCallNames.length) {
    return true;
  }
  const assistantPreview = observation.latestAssistantPreview?.trim() ?? '';
  return Boolean(assistantPreview && assistantPreview !== record.observedAssistantPreview?.trim());
}

export function normalizeOpenCodeTurnUsedTokens(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}

/**
 * Fields to merge into the record on an observation. A growing runtime turn
 * usage is the only progress signal an ACP bridge produces - it reports one
 * assistant message and no tool calls for a whole agent turn - so it refreshes
 * the stamp exactly like a growing tool list does.
 */
export function resolveOpenCodeTurnProgress(
  record: OpenCodeObservedTurnRecord,
  input: OpenCodeTurnProgressObservation
): Required<OpenCodeTurnProgress> {
  const sampledTokens = normalizeOpenCodeTurnUsedTokens(input.turnUsedTokens);
  const previousTokens = normalizeOpenCodeTurnUsedTokens(record.observedTurnUsedTokens);
  // The first sample is a baseline, never progress: a lane that died an hour
  // ago still reports the tokens its last turn spent.
  const usageProgressed =
    sampledTokens !== null && previousTokens !== null && sampledTokens > previousTokens;
  const progressed =
    usageProgressed || hasOpenCodeInferredTurnProgress(record, input.responseObservation);
  return {
    lastTurnProgressAt: progressed ? input.observedAt : (record.lastTurnProgressAt ?? null),
    observedTurnUsedTokens: sampledTokens ?? previousTokens,
  };
}
