import { goalWaitBackoffMs, goalWaitKey, isGoalWaitReport } from './policy/core/domain/GoalWaitPolicy.js';
import type { GoalWorkWait } from './policy/core/domain/GoalContinuationPolicy.js';
import type { GoalWaitReport } from './policy/core/domain/GoalWaitPolicy.js';
import type { WorkSyncCommandReceipt } from './commandContracts.js';
import type { GoalContinuation } from '../team/goalContracts.js';

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** Derive waits from the original report receipts; there is no second wait inventory. */
export function inspectGoalWaits(
  reports: readonly WorkSyncCommandReceipt[],
  continuations: readonly (GoalContinuation & { inputId: string; createdAt: string })[],
  deadlineAt: string
): GoalWorkWait[] {
  const grouped = new Map<string, { receipt: WorkSyncCommandReceipt; wait: GoalWaitReport }[]>();
  for (const receipt of reports) {
    if (receipt.operation !== 'report' || receipt.phase !== 'completed' ||
        receipt.nativeInput.team.mode !== 'goal' || !object(receipt.result) ||
        receipt.result.accepted !== true || !object(receipt.payload) || !isGoalWaitReport(receipt.payload.wait)) continue;
    const wait = receipt.payload.wait, key = goalWaitKey(wait);
    const rows = grouped.get(key) ?? [];
    rows.push({ receipt, wait }); grouped.set(key, rows);
  }
  // Select a replacement operation by its original first receipt, not a late completion timestamp.
  // Thus an old commit's green result cannot displace a newer pending check for the same obligation.
  const current = new Map<string, { key: string; first: number }>();
  const slots = (wait: GoalWaitReport) => JSON.stringify([wait.repository.toLowerCase(), wait.taskId ?? null]);
  for (const [key, rows] of grouped) {
    const first = Math.min(...rows.map(row => Date.parse(row.receipt.receivedAt)));
    for (const row of rows) {
      const slot = slots(row.wait), prior = current.get(slot);
      if (!prior || first > prior.first) current.set(slot, { key, first });
    }
  }
  const result: GoalWorkWait[] = [];
  for (const [key, rows] of grouped) {
    const currentRows = rows.filter(row => current.get(slots(row.wait))?.key === key);
    if (!currentRows.length) continue;
    rows.sort((a, b) => Date.parse(a.receipt.receivedAt) - Date.parse(b.receipt.receivedAt) ||
      a.receipt.commandId.localeCompare(b.receipt.commandId));
    const first = rows[0]!, latest = rows.at(-1)!;
    const attempts = continuations.filter(row => row.obligationKey === `wait:${key}`)
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    const lastAttempt = attempts.at(-1);
    const lastObserved = Date.parse(latest.receipt.receivedAt);
    const anchor = Math.max(Date.parse(first.receipt.receivedAt), lastObserved,
      lastAttempt ? Date.parse(lastAttempt.createdAt) : 0);
    const unreported = attempts.filter(attempt => Date.parse(attempt.createdAt) >= lastObserved && !rows.some(row =>
      row.receipt.nativeInput.original.inputId === attempt.inputId));
    const description = `CI run ${latest.wait.repository}#${latest.wait.runId} at commit ${latest.wait.expectedCommit}`;
    result.push({ key,
      taskIds: [...new Set(currentRows.flatMap(row => row.wait.taskId ? [row.wait.taskId] : []))],
      observer: first.receipt.nativeInput.team.memberName,
      // A duplicate report cannot move the original operation horizon later.
      horizonAt: Math.min(Date.parse(deadlineAt), ...rows.map(row => Date.parse(row.wait.horizonAt))),
      dueAt: anchor + goalWaitBackoffMs(attempts.length),
      pending: latest.wait.status === 'pending', description,
      ...(latest.wait.status === 'failed' || latest.wait.status === 'cancelled'
        ? { attentionReason: `${description} ${latest.wait.status}; resolve it within the original objective permissions.` }
        : unreported.length >= 2 ? { attentionReason: `Two check attempts returned no accepted result for ${description}.` } : {}),
    });
  }
  return result;
}
