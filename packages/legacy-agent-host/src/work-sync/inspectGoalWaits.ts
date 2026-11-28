import { goalWaitBackoffMs, goalWaitKey, isGoalWaitReport } from './policy/core/domain/GoalWaitPolicy.js';
import { TeamOwnerError } from '../team/contracts.js';
import type { GoalWorkWait } from './policy/core/domain/GoalContinuationPolicy.js';
import type { GoalWaitReport } from './policy/core/domain/GoalWaitPolicy.js';
import type { WorkSyncCommandReceipt } from './commandContracts.js';
import type { GoalContinuation } from '../team/goalContracts.js';

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
type WaitRow = { receipt: WorkSyncCommandReceipt; wait: GoalWaitReport };
const scopeKey = (wait: GoalWaitReport) => JSON.stringify([goalWaitKey(wait), wait.taskId ?? null]);

function ancestry(scope: string, parents: ReadonlyMap<string, string>): Set<string> {
  const seen = new Set<string>();
  let current: string | undefined = scope;
  while (current !== undefined) {
    if (seen.has(current)) throw new TeamOwnerError('hold');
    seen.add(current); current = parents.get(current);
  }
  return seen;
}

/** Original accepted receipts are the sole inventory, including explicit replacement links. */
function waitFacts(reports: readonly WorkSyncCommandReceipt[]) {
  const rows: WaitRow[] = [];
  for (const receipt of reports) {
    if (receipt.operation !== 'report' || receipt.phase !== 'completed' ||
        receipt.nativeInput.team.mode !== 'goal' || !object(receipt.result) ||
        receipt.result.accepted !== true) continue;
    if (!object(receipt.payload)) throw new TeamOwnerError('hold');
    if (receipt.payload.wait === undefined) continue;
    if (!isGoalWaitReport(receipt.payload.wait)) throw new TeamOwnerError('hold');
    rows.push({ receipt, wait: receipt.payload.wait });
  }
  rows.sort((a, b) => Date.parse(a.receipt.receivedAt) - Date.parse(b.receipt.receivedAt) ||
    a.receipt.commandId.localeCompare(b.receipt.commandId));
  const grouped = new Map<string, WaitRow[]>(), scoped = new Map<string, WaitRow[]>();
  for (const row of rows) {
    const key = goalWaitKey(row.wait), scope = scopeKey(row.wait);
    const operation = grouped.get(key) ?? [], association = scoped.get(scope) ?? [];
    operation.push(row); grouped.set(key, operation);
    association.push(row); scoped.set(scope, association);
  }
  const parents = new Map<string, string>(), successors = new Map<string, string>();
  for (const { wait } of rows) {
    if (!wait.supersedes) continue;
    const scope = scopeKey(wait), previous = scopeKey({ ...wait, ...wait.supersedes });
    if (!scoped.has(previous) || parents.has(scope) && parents.get(scope) !== previous ||
        successors.has(previous) && successors.get(previous) !== scope) throw new TeamOwnerError('hold');
    parents.set(scope, previous); successors.set(previous, scope);
  }
  for (const scope of parents.keys()) ancestry(scope, parents);
  return { grouped, scoped, parents, retired: new Set(parents.values()) };
}

function inheritedRows(scopes: Iterable<string>, facts: ReturnType<typeof waitFacts>): WaitRow[] {
  const keys = new Set<string>();
  for (const scope of scopes) for (const prior of ancestry(scope, facts.parents))
    keys.add(goalWaitKey(facts.scoped.get(prior)![0]!.wait));
  return [...keys].flatMap(key => facts.grouped.get(key)!);
}

/** Called within the existing report gate and its original publication guards, never by model authority. */
export function assertGoalWaitSupersession(wait: GoalWaitReport, reports: readonly WorkSyncCommandReceipt[],
  actor: Pick<WorkSyncCommandReceipt['nativeInput']['team'], 'actorId' | 'role'>, deadlineAt: string): void {
  if (!wait.supersedes) return;
  const facts = waitFacts(reports), scope = scopeKey(wait);
  const previous = scopeKey({ ...wait, ...wait.supersedes });
  if (facts.scoped.has(scope)) {
    // A later observation may repeat the first link, never retrofit or change it.
    if (facts.parents.get(scope) !== previous) throw new TeamOwnerError('invalid');
    return;
  }
  const original = facts.scoped.get(previous);
  if (!original || facts.retired.has(previous)) throw new TeamOwnerError('invalid');
  const operation = facts.grouped.get(goalWaitKey(original[0]!.wait))!;
  if (!['failed', 'cancelled'].includes(operation.at(-1)!.wait.status)) throw new TeamOwnerError('invalid');
  if (actor.role !== 'lead' && actor.actorId !== original[0]!.receipt.nativeInput.team.actorId)
    throw new TeamOwnerError('forbidden');
  const horizon = Math.min(Date.parse(deadlineAt),
    ...inheritedRows([previous], facts).map(row => Date.parse(row.wait.horizonAt)));
  if (Date.parse(wait.horizonAt) > horizon) throw new TeamOwnerError('invalid');
}

/** Derive waits from original receipts; a new run alone never retires an unresolved check. */
export function inspectGoalWaits(
  reports: readonly WorkSyncCommandReceipt[],
  continuations: readonly (GoalContinuation & { inputId: string; createdAt: string })[],
  deadlineAt: string
): GoalWorkWait[] {
  const facts = waitFacts(reports), result: GoalWorkWait[] = [];
  for (const [key, rows] of facts.grouped) {
    const currentRows = rows.filter(row => !facts.retired.has(scopeKey(row.wait)));
    if (!currentRows.length) continue;
    const inherited = inheritedRows(new Set(currentRows.map(row => scopeKey(row.wait))), facts);
    const inheritedKeys = new Set(inherited.map(row => `wait:${goalWaitKey(row.wait)}`));
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
      // Replacement preserves the original horizon and poll backoff, but not stale observation times.
      horizonAt: Math.min(Date.parse(deadlineAt), ...inherited.map(row => Date.parse(row.wait.horizonAt))),
      dueAt: anchor + goalWaitBackoffMs(continuations.filter(row => inheritedKeys.has(row.obligationKey)).length),
      pending: latest.wait.status === 'pending', description,
      ...(latest.wait.status === 'failed' || latest.wait.status === 'cancelled'
        ? { attentionReason: `${description} ${latest.wait.status}; resolve it within the original objective permissions.` }
        : unreported.length >= 2 ? { attentionReason: `Two check attempts returned no accepted result for ${description}.` } : {}),
    });
  }
  return result;
}
