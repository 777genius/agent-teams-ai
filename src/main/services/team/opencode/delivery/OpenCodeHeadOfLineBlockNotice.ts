import { getOpenCodePromptDeliveryPendingAgeMs } from './OpenCodePromptDeliveryStalePendingPolicy';
import {
  OPENCODE_HEAD_OF_LINE_BLOCK_CRITICAL_MARKER,
  OPENCODE_HEAD_OF_LINE_BLOCK_DIAGNOSTIC_PREFIX,
} from './OpenCodeRuntimeDeliveryDiagnostics';

import type { OpenCodePromptDeliveryLedgerRecord } from './OpenCodePromptDeliveryLedger';

/**
 * What a head-of-line block on an OpenCode lane looks like from the outside.
 *
 * A lane serialises one prompt at a time, so a record that never reaches a
 * terminal state queues every later message behind it. That is ordinary for a
 * few seconds and a run-ending fault after a few minutes, and the two were
 * indistinguishable: every refused delivery returned the same context-free line,
 * "OpenCode delivery is queued behind <id>", with no age and no idea how much
 * was stuck behind it. A lane that had been blocked for a quarter of an hour
 * with a dozen messages waiting - including the board's own completion notice,
 * so the team's closing message never happened - said exactly what a lane that
 * had been busy for two seconds said.
 *
 * So the diagnostic carries the blocker's pending age and the count of DISTINCT
 * messages refused behind it. The count is tracked here rather than read from
 * the inbox because the delivery service sees one message per call and the depth
 * of the queue is not in the ledger; counting distinct ids also keeps a retry
 * loop on one message from inflating the number.
 */

/** Blocked longer than this and the lane is stuck, not busy. */
export const OPENCODE_HEAD_OF_LINE_BLOCK_CRITICAL_MS = 5 * 60_000;

/**
 * How many lanes the tracker remembers at once.
 *
 * The default tracker is a module singleton in a main process that outlives
 * every run, each run mints a fresh `laneId` for its secondary lanes, and
 * nothing in `src/` ever calls `clear()`. Without a bound, one entry - plus the
 * `queuedMessageIds` set of whatever jammed that lane - would be retained per
 * lane that ever blocked, for the life of the app.
 */
export const OPENCODE_HEAD_OF_LINE_BLOCK_MAX_LANES = 512;

/**
 * How many distinct queued message ids one blocked lane remembers.
 *
 * The lane bound above caps how many jams are tracked, not how big one jam may
 * get: a blocker that never terminalises keeps taking new ids on the same lane
 * for as long as the inbox keeps producing them. Past this many the depth is
 * reported as a lower bound (`queuedBehind=256+`) instead of a count, because a
 * diagnostic that separates "busy" from "wedged" has already said everything it
 * has to say at 256 waiting messages, and dedup below the cap is what the count
 * exists for.
 */
export const OPENCODE_HEAD_OF_LINE_BLOCK_MAX_QUEUED_IDS = 256;

interface HeadOfLineBlockState {
  blockerMessageId: string;
  queuedMessageIds: Set<string>;
}

export class OpenCodeHeadOfLineBlockTracker {
  private readonly stateByLane = new Map<string, HeadOfLineBlockState>();

  /**
   * Distinct messages refused behind `blockerMessageId` on this lane, including
   * this one. A new blocker resets the count: it is a different jam.
   *
   * A lane evicted by the bound simply starts counting from 1 again; the count
   * is a diagnostic number, so losing the oldest lane's history is cheaper than
   * holding it forever. The same trade caps one lane's id set: at
   * OPENCODE_HEAD_OF_LINE_BLOCK_MAX_QUEUED_IDS the count stops rising and is
   * rendered as a lower bound.
   */
  note(input: { laneKey: string; blockerMessageId: string; queuedMessageId: string }): number {
    const existing = this.stateByLane.get(input.laneKey);
    if (existing?.blockerMessageId !== input.blockerMessageId) {
      if (!existing && this.stateByLane.size >= OPENCODE_HEAD_OF_LINE_BLOCK_MAX_LANES) {
        const oldestKey = this.stateByLane.keys().next();
        if (!oldestKey.done) {
          this.stateByLane.delete(oldestKey.value);
        }
      }
      this.stateByLane.set(input.laneKey, {
        blockerMessageId: input.blockerMessageId,
        queuedMessageIds: new Set([input.queuedMessageId]),
      });
      return 1;
    }
    if (existing.queuedMessageIds.size < OPENCODE_HEAD_OF_LINE_BLOCK_MAX_QUEUED_IDS) {
      existing.queuedMessageIds.add(input.queuedMessageId);
    }
    return existing.queuedMessageIds.size;
  }

  clear(): void {
    this.stateByLane.clear();
  }
}

export const openCodeHeadOfLineBlockTracker = new OpenCodeHeadOfLineBlockTracker();

export function buildOpenCodeHeadOfLineBlockLaneKey(input: {
  teamName: string;
  laneId: string;
  memberName: string;
}): string {
  return `${input.teamName}::${input.laneId}::${input.memberName.trim().toLowerCase()}`;
}

/** The ledger fields a blocked lane is described from. */
export type OpenCodeHeadOfLineBlocker = Pick<
  OpenCodePromptDeliveryLedgerRecord,
  'inboxMessageId' | 'lastTurnProgressAt' | 'lastAttemptAt' | 'acceptedAt' | 'createdAt'
>;

/**
 * The `queued behind` diagnostic, with the two numbers that separate a busy lane
 * from a stuck one. `critical` is a read of those numbers, not a new threshold
 * for anything to act on: the stale-pending policy still owns settlement. What
 * it does change is how loudly the line is reported - below the window the
 * diagnostic is expected control flow, above it the lane needs looking at.
 */
export function describeOpenCodeHeadOfLineBlock(input: {
  blocker: OpenCodeHeadOfLineBlocker;
  queuedCount: number;
  nowMs: number;
}): { diagnostic: string; blockedForMs: number | null; critical: boolean } {
  const blockedForMs = getOpenCodePromptDeliveryPendingAgeMs(input.blocker, input.nowMs);
  const critical = blockedForMs !== null && blockedForMs >= OPENCODE_HEAD_OF_LINE_BLOCK_CRITICAL_MS;
  // The age is rendered in whole minutes because the line is also a dedup
  // signature: raw milliseconds change on every observe wake, so a stuck lane
  // would leave a fresh entry every few seconds. A minute tick keeps exactly one
  // durable line per minute of jam - a blocked lane must keep leaving a trace,
  // silence is what made this failure invisible, but not four traces a minute.
  const blockedForMin = blockedForMs === null ? null : Math.floor(blockedForMs / 60_000);
  const criticalMarker = critical ? ` ${OPENCODE_HEAD_OF_LINE_BLOCK_CRITICAL_MARKER}` : '';
  // At the id cap the tracker can no longer tell a new message from one it
  // already counted, so the depth is a lower bound and says so.
  const queuedDepth =
    input.queuedCount >= OPENCODE_HEAD_OF_LINE_BLOCK_MAX_QUEUED_IDS
      ? `${input.queuedCount}+`
      : `${input.queuedCount}`;
  return {
    blockedForMs,
    critical,
    diagnostic:
      `${OPENCODE_HEAD_OF_LINE_BLOCK_DIAGNOSTIC_PREFIX}${input.blocker.inboxMessageId} ` +
      `(blockedForMin=${blockedForMin ?? 'unknown'} queuedBehind=${queuedDepth}` +
      `${criticalMarker}).`,
  };
}

/**
 * Count this refusal and render the diagnostic for it - the one call the
 * delivery service makes, so the lane key and the tracker stay in this module.
 */
export function noteOpenCodeHeadOfLineBlockDiagnostic(input: {
  teamName: string;
  laneId: string;
  memberName: string;
  blocker: OpenCodeHeadOfLineBlocker;
  /** A message with no id counts as one anonymous slot, never as a new one. */
  queuedMessageId: string | undefined;
  nowMs: number;
}): string {
  const queuedCount = openCodeHeadOfLineBlockTracker.note({
    laneKey: buildOpenCodeHeadOfLineBlockLaneKey(input),
    blockerMessageId: input.blocker.inboxMessageId,
    queuedMessageId: input.queuedMessageId ?? 'unidentified',
  });
  return describeOpenCodeHeadOfLineBlock({
    blocker: input.blocker,
    queuedCount,
    nowMs: input.nowMs,
  }).diagnostic;
}
