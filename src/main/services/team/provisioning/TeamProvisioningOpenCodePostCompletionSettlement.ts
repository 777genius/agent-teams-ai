/**
 * Post-completion settlement for the OpenCode member inbox relay.
 *
 * Once every live task on the board is completed and the team has already
 * messaged the user after the last structural board event, the app-generated
 * notices that keep trickling in (teammate "done" reports, comment
 * notifications, task-state notices) carry nothing the recipient can act on.
 * Each of them still cost a full runtime turn, and because a turn is memoryless
 * the recipient kept re-answering work that was finished before the notice was
 * even written.
 *
 * While the team stays settled, such a notice and the reply-optional notices
 * queued behind it are read-committed together, without a prompt. Any
 * structural board change or a new message from the user ends the settled state
 * and normal delivery resumes.
 *
 * The board predicate is re-implemented here rather than shared with the
 * controller: the controller applies the same rule to `message_send`, where a
 * post-completion agent->user message comes back as a success-shaped duplicate
 * instead of a rephrased recap. The two halves share a rule, not a module, so
 * neither side has to reach across the process boundary to evaluate it.
 */

import { isOpenCodeReplyOptionalDeliveryContract } from '../opencode/delivery/OpenCodeDeliveryReplyContract';

import {
  isCoalescableNoticeKind,
  type OpenCodeReplyOptionalCoalescePorts,
  selectOpenCodeSettleableQueuedNotices,
} from './TeamProvisioningOpenCodeInboxCoalescePolicy';

import type { RelayInboxMessage } from './TeamProvisioningInboxRelayPolicy';
import type { InboxMessage, TeamTask } from '@shared/types';

/**
 * Structural board events. A comment, an attachment or a review note is
 * activity, not a change to what the board asks of the team, so it must not
 * move the epoch: otherwise the closing comment on the last completed task
 * would reopen delivery for the very notices this settlement exists to absorb.
 */
const BOARD_EPOCH_EVENT_TYPES = new Set<string>([
  'task_created',
  'status_changed',
  'owner_changed',
]);

export const OPENCODE_POST_COMPLETION_READ_COMMIT_DIAGNOSTIC =
  'opencode_inbox_relay_post_completion_read_commit';

function parseTimeMs(value: unknown): number | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isUserParticipant(value: unknown): boolean {
  return typeof value === 'string' && value.trim().toLowerCase() === 'user';
}

/**
 * Newest structural board event across a board whose every live task is
 * completed. Returns null for an empty board or for any open work, which is
 * what makes "no board yet" and "still working" both fall through to normal
 * delivery.
 */
export function resolveBoardCompletionEpochMs(tasks: readonly TeamTask[]): number | null {
  const live = tasks.filter((task) => task && task.status !== 'deleted');
  if (live.length === 0) return null;
  if (!live.every((task) => task.status === 'completed')) return null;
  let epochMs = 0;
  for (const task of live) {
    let sawEvent = false;
    for (const event of task.historyEvents ?? []) {
      if (!event || !BOARD_EPOCH_EVENT_TYPES.has(event.type)) continue;
      const ms = parseTimeMs(event.timestamp);
      if (ms === null) continue;
      sawEvent = true;
      if (ms > epochMs) epochMs = ms;
    }
    // A task written before history events existed still has to anchor the
    // epoch somewhere; `updatedAt` is only trusted when no event was found,
    // because a comment also bumps it.
    for (const raw of [task.createdAt, sawEvent ? undefined : task.updatedAt]) {
      const ms = parseTimeMs(raw);
      if (ms !== null && ms > epochMs) epochMs = ms;
    }
  }
  return epochMs > 0 ? epochMs : null;
}

/** Most recent team->user message written at or after the completion epoch. */
export function findFinalUserMessage(
  userInbox: readonly InboxMessage[],
  epochMs: number
): InboxMessage | null {
  for (let index = userInbox.length - 1; index >= 0; index -= 1) {
    const message = userInbox[index];
    // A message FROM the user is an instruction, never the team's final word.
    if (!message || isUserParticipant(message.from)) continue;
    const ms = parseTimeMs(message.timestamp);
    if (ms === null || ms < epochMs) continue;
    return message;
  }
  return null;
}

export interface OpenCodePostCompletionSettlement {
  epochMs: number;
  finalMessageId: string | null;
  finalMessageAt: string;
}

export interface ResolveOpenCodePostCompletionSettlementPorts {
  readTasks(): Promise<readonly TeamTask[]>;
  readUserInbox(): Promise<readonly InboxMessage[]>;
}

/**
 * Settled = board complete + a final user-facing message already sent after the
 * last board event. Returns null whenever delivery must proceed normally.
 */
export async function resolveOpenCodePostCompletionSettlement(
  ports: ResolveOpenCodePostCompletionSettlementPorts
): Promise<OpenCodePostCompletionSettlement | null> {
  const tasks = await ports.readTasks().catch(() => [] as readonly TeamTask[]);
  const epochMs = resolveBoardCompletionEpochMs(tasks);
  if (epochMs === null) return null;
  const userInbox = await ports.readUserInbox().catch(() => [] as readonly InboxMessage[]);
  const finalMessage = findFinalUserMessage(userInbox, epochMs);
  if (!finalMessage) return null;
  return {
    epochMs,
    finalMessageId: finalMessage.messageId ?? null,
    finalMessageAt: finalMessage.timestamp,
  };
}

/** True when the board moved (new epoch or reopened work) since `settlement` was observed. */
export function hasBoardMovedSinceSettlement(
  tasks: readonly TeamTask[],
  settlement: OpenCodePostCompletionSettlement
): boolean {
  const epochMs = resolveBoardCompletionEpochMs(tasks);
  return epochMs === null || epochMs !== settlement.epochMs;
}

export interface OpenCodePostCompletionSettlementPorts
  extends ResolveOpenCodePostCompletionSettlementPorts, OpenCodeReplyOptionalCoalescePorts {
  /**
   * The board read again after the read-commit, bypassing whatever snapshot
   * `readTasks` may have cached for this relay pass.
   */
  readTasksAfterCommit(): Promise<readonly TeamTask[]>;
  markRead(messages: RelayInboxMessage[]): Promise<void>;
  /** Reports a failed read-commit. The notices stay unread and are delivered normally. */
  logReadCommitFailure(error: unknown): void;
  /** False once a newer relay generation has taken over this member. */
  isCurrentGeneration(): boolean;
}

export type OpenCodePostCompletionSettlementOutcome =
  /** A newer relay generation took over mid-read; abandon this pass. */
  | { kind: 'superseded' }
  /** Not settled, or the read-commit failed: deliver the anchor normally. */
  | { kind: 'deliver' }
  /** Anchor and followers were read-committed without spending a runtime turn. */
  | { kind: 'read_committed'; messages: RelayInboxMessage[]; diagnostic: string }
  /** The board moved while committing: deliver the anchor as a catch-up. */
  | { kind: 'catch_up'; diagnostic: string; tasks: readonly TeamTask[] };

function buildPostCompletionReadCommitDiagnostic(input: {
  settledBatch: readonly RelayInboxMessage[];
  settlement: OpenCodePostCompletionSettlement;
  boardMoved: boolean;
}): string {
  const messageIds = input.settledBatch.map((candidate) => candidate.messageId).join(',');
  const finalMessage = `final user message ${
    input.settlement.finalMessageId ?? 'unknown'
  } at ${input.settlement.finalMessageAt}`;
  const catchUp = input.boardMoved ? '; board moved, delivering anchor as catch-up' : '';
  return `${OPENCODE_POST_COMPLETION_READ_COMMIT_DIAGNOSTIC}: ${messageIds} (${finalMessage}${catchUp})`;
}

/**
 * Decides what the relay does with the unread row at `index` while the team may
 * be settled: read-commit it (with everything reply-optional queued behind it)
 * without a prompt, deliver it as a catch-up because the board moved during the
 * commit, or leave the decision alone and deliver normally.
 *
 * The board is read twice on purpose. The first read decides whether to suppress
 * the prompt; the second, taken after the rows are marked read, catches work
 * that reopened in between. Without it a task created during the commit would
 * lose its notice: the row is already read, and nothing would ever deliver it.
 */
export async function settleOpenCodePostCompletionNotices(input: {
  unread: readonly RelayInboxMessage[];
  index: number;
  anchorReplyRecipient: string;
  /**
   * The anchor already has a prompt-delivery ledger record, so it is mid-flight
   * in its own right and settlement must not read-commit it behind that record.
   */
  anchorHasLedgerRecord: boolean;
  ports: OpenCodePostCompletionSettlementPorts;
}): Promise<OpenCodePostCompletionSettlementOutcome> {
  const anchor = input.unread[input.index];
  if (
    !anchor ||
    input.anchorHasLedgerRecord ||
    !isCoalescableNoticeKind(anchor) ||
    !isOpenCodeReplyOptionalDeliveryContract(input.anchorReplyRecipient)
  ) {
    return { kind: 'deliver' };
  }
  const settlement = await resolveOpenCodePostCompletionSettlement(input.ports);
  if (!input.ports.isCurrentGeneration()) return { kind: 'superseded' };
  if (!settlement) return { kind: 'deliver' };
  const followers = await selectOpenCodeSettleableQueuedNotices({
    unread: input.unread,
    index: input.index,
    anchorReplyRecipient: input.anchorReplyRecipient,
    ports: input.ports,
  });
  if (!input.ports.isCurrentGeneration()) return { kind: 'superseded' };
  const settledBatch = [anchor, ...followers];
  try {
    await input.ports.markRead(settledBatch);
  } catch (error) {
    input.ports.logReadCommitFailure(error);
    return { kind: 'deliver' };
  }
  const freshTasks = await input.ports
    .readTasksAfterCommit()
    .catch(() => [] as readonly TeamTask[]);
  if (!input.ports.isCurrentGeneration()) return { kind: 'superseded' };
  const boardMoved = hasBoardMovedSinceSettlement(freshTasks, settlement);
  const diagnostic = buildPostCompletionReadCommitDiagnostic({
    settledBatch,
    settlement,
    boardMoved,
  });
  return boardMoved
    ? { kind: 'catch_up', diagnostic, tasks: freshTasks }
    : { kind: 'read_committed', messages: settledBatch, diagnostic };
}
