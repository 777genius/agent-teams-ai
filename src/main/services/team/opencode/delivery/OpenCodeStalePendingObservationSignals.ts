import { getOpenCodeObservedSessionActivity } from './OpenCodePromptDeliveryStalePendingPolicy';

import type { OpenCodePromptDeliveryLedgerRecord } from './OpenCodePromptDeliveryLedger';
import type { OpenCodeStalePendingResolution } from './OpenCodePromptDeliveryStalePendingPolicy';
import type { OpenCodePromptDeliveryTurnActivityDecision } from './OpenCodePromptDeliveryWatchdog';

/**
 * A record is only probed for turn usage once it has been silent this long.
 *
 * It is deliberately shorter than OPENCODE_PROMPT_DELIVERY_STALE_PENDING_MS.
 * The first sample can only ever be a baseline - a lane that stopped an hour
 * ago still reports the tokens its last turn spent - so sampling first at the
 * stale window would mean the very observation that has to decide is the one
 * with nothing to compare against. Starting a few observe cycles earlier means
 * a baseline already exists by the time the stale decision is due, and it costs
 * one probe per observe cycle only for deliveries that have gone quiet.
 */
export const OPENCODE_PROMPT_DELIVERY_TURN_USAGE_BASELINE_MS = 60_000;

/** Context-window/turn usage for one lane member. */
export interface OpenCodeMemberContextUsageQuery {
  teamName: string;
  memberName: string;
  laneId?: string;
  model?: string;
}

/**
 * Optional probe for the runtime's turn token spend.
 *
 * There is no implementation wired by default. Unset, the probe short-circuits
 * and the stale-pending clock is pure wall time, which is exactly the behaviour
 * that existed before turn progress was tracked at all.
 */
export type OpenCodeMemberContextUsageProbe = (
  input: OpenCodeMemberContextUsageQuery
) => Promise<{ usedTokens?: number | null } | null>;

/**
 * Runtime turn usage for a record that has gone quiet.
 *
 * An ACP bridge reports `tools=0->0` and one assistant message for a whole
 * agent turn, so every ledger-inferred progress signal is dead for exactly the
 * lane the stale window kills. A growing turn spend is the only evidence left
 * that the turn is still running. Read it only once the record is quiet (the
 * observe loop runs per lane per cycle) and never let it change behaviour when
 * it fails or is not wired.
 */
export async function readOpenCodeStalePendingTurnUsedTokens(input: {
  teamName: string;
  memberName: string;
  laneId: string;
  model?: string;
  pendingAgeMs: number | null;
  read?: OpenCodeMemberContextUsageProbe;
}): Promise<number | null> {
  if (
    !input.read ||
    input.pendingAgeMs === null ||
    input.pendingAgeMs < OPENCODE_PROMPT_DELIVERY_TURN_USAGE_BASELINE_MS
  ) {
    return null;
  }
  try {
    const usage = await input.read({
      teamName: input.teamName,
      memberName: input.memberName,
      laneId: input.laneId,
      model: input.model,
    });
    const usedTokens = usage?.usedTokens;
    return typeof usedTokens === 'number' && Number.isFinite(usedTokens) ? usedTokens : null;
  } catch {
    return null;
  }
}

/** How many records the gate remembers a decision for at once. */
export const OPENCODE_STALE_PENDING_LOG_GATE_MAX_RECORDS = 512;

/**
 * Last `(action, reason)` recorded durably per ledger record.
 *
 * A stale record resolves to `keep_observing` on every observe pass, and the
 * follow-up policy re-observes a pending record every
 * OPENCODE_PROMPT_DELIVERY_OBSERVE_DELAY_MS. Writing each of those to the
 * durable sink adds kilobytes a minute for one stalled lane and buries the
 * failure signals this line exists to preserve. Only the transition into a
 * decision is durable; a repeat of the same decision stays on the console-only
 * `info` level, where the default log level drops it.
 */
export class OpenCodeStalePendingLogGate {
  private readonly lastLoggedByRecord = new Map<string, string>();

  /** True when this decision differs from the last one logged for the record. */
  isTransition(recordId: string, action: string, reason: string): boolean {
    const marker = `${action}:${reason}`;
    const previous = this.lastLoggedByRecord.get(recordId);
    if (previous === marker) {
      return false;
    }
    // The default gate is a module singleton in a main process that outlives
    // every run, and a record only drops out of the map when it reaches a
    // decision this module is told about. A record whose lane simply
    // disappeared - the team stopped, the ledger was deleted - never does, so
    // the map needs a bound of its own. An evicted record just logs its next
    // repeat durably once, which is the cheap half of this trade.
    if (
      previous === undefined &&
      this.lastLoggedByRecord.size >= OPENCODE_STALE_PENDING_LOG_GATE_MAX_RECORDS
    ) {
      const oldest = this.lastLoggedByRecord.keys().next();
      if (!oldest.done) {
        this.lastLoggedByRecord.delete(oldest.value);
      }
    }
    this.lastLoggedByRecord.set(recordId, marker);
    return true;
  }

  forget(recordId: string): void {
    this.lastLoggedByRecord.delete(recordId);
  }

  clear(): void {
    this.lastLoggedByRecord.clear();
  }
}

export const openCodeStalePendingLogGate = new OpenCodeStalePendingLogGate();

/**
 * One durable line per stale-pending decision *transition*.
 *
 * The lane-scoped ledger that holds the observation is deleted when the team
 * stops, so a decision that is not written here leaves no evidence of why a
 * delivery ended. Quiet on the console at every level, and quiet in the sink
 * while the decision repeats itself.
 */
export function logOpenCodeStalePendingResolution(
  logger: { diagnostic(message: string): void; info(message: string): void },
  input: {
    teamName: string;
    memberName: string;
    laneId: string;
    record: OpenCodePromptDeliveryLedgerRecord;
    resolution: OpenCodeStalePendingResolution;
    turnActivity: OpenCodePromptDeliveryTurnActivityDecision;
    hasExecutionEvidence: boolean;
    observedDiagnostics: readonly string[];
    pendingAgeMs: number | null;
    gate?: OpenCodeStalePendingLogGate;
  }
): void {
  const gate = input.gate ?? openCodeStalePendingLogGate;
  // 'none' is how a record leaves this loop without a decision: it was
  // read-committed, it answered, or its turn produced progress and its pending
  // age fell back under the stale window. Nothing later will report a terminal
  // decision for it, so this is the last chance to drop its marker.
  if (input.resolution.action === 'none') {
    gate.forget(input.record.id);
    return;
  }
  const reason = 'reason' in input.resolution ? input.resolution.reason : 'none';
  const level = gate.isTransition(input.record.id, input.resolution.action, reason)
    ? 'diagnostic'
    : 'info';
  // A settled/failed record leaves the observe loop, so drop its marker: it must
  // not grow the map, and a terminal decision is never worth silencing.
  if (input.resolution.action !== 'keep_observing') {
    gate.forget(input.record.id);
  }
  logger[level](
    `[${input.teamName}] opencode_prompt_delivery_stale_pending ` +
      `${input.memberName}/${input.laneId} msg=${input.record.inboxMessageId} ` +
      `action=${input.resolution.action} ` +
      `reason=${reason} ` +
      `activity=${getOpenCodeObservedSessionActivity(input.observedDiagnostics)} ` +
      `turnActive=${input.turnActivity.active}/${input.turnActivity.reason} ` +
      `executionEvidence=${input.hasExecutionEvidence} ` +
      `pendingAgeMs=${input.pendingAgeMs ?? -1} responseState=${input.record.responseState} ` +
      `diagnostics=${JSON.stringify(input.observedDiagnostics.slice(0, 4))}`
  );
}
