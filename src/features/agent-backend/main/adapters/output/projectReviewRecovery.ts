import {
  isReviewWriterMethod,
  parseReviewOriginScope,
} from '@agent-teams/task-change-ledger/review-transport';

import type {
  ReviewCommandLookup,
  ReviewOriginScope,
  ReviewRecoveryCommand,
  ReviewRecoveryRead,
} from '@agent-teams/task-change-ledger/review-transport';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid Host review recovery');
  return value as Record<string, unknown>;
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 256 || value.includes('\0'))
    throw new Error('Invalid Host review recovery');
  return value;
}
export function projectReviewReferences(value: unknown): ReviewCommandLookup['references'] {
  if (value === undefined) return undefined;
  const ref = object(value);
  if (
    ref.decisionRevision !== undefined &&
    (!Number.isSafeInteger(ref.decisionRevision) || (ref.decisionRevision as number) < 0)
  )
    throw new Error('Invalid Host review recovery');
  return {
    ...(ref.walId === undefined ? {} : { walId: identifier(ref.walId) }),
    ...(ref.actionId === undefined ? {} : { actionId: identifier(ref.actionId) }),
    ...(ref.decisionRevision === undefined
      ? {}
      : { decisionRevision: ref.decisionRevision as number }),
  };
}
export function projectReviewRecovery(
  value: unknown,
  scope: ReviewOriginScope
): ReviewRecoveryRead {
  const row = object(value);
  const origin = parseReviewOriginScope(row.origin);
  if (
    row.kind !== 'review-recovery' ||
    origin.taskId !== scope.taskId ||
    origin.memberName !== scope.memberName ||
    !Array.isArray(row.commands) ||
    row.commands.length > 64
  )
    throw new Error('Invalid Host review recovery');
  const ids = new Set<string>();
  const commands: ReviewRecoveryCommand[] = row.commands.map((value) => {
    const entry = object(value);
    const commandId = identifier(entry.commandId);
    if (
      ids.has(commandId) ||
      !isReviewWriterMethod(entry.method) ||
      !['prepared', 'held', 'completed'].includes(String(entry.phase)) ||
      entry.outcome !== (entry.phase === 'completed' ? 'completed' : 'unknown') ||
      typeof entry.responseAvailable !== 'boolean' ||
      (entry.phase !== 'completed' && entry.responseAvailable)
    )
      throw new Error('Invalid Host review recovery');
    ids.add(commandId);
    const references = projectReviewReferences(entry.references);
    return {
      commandId,
      method: entry.method,
      phase: entry.phase as ReviewRecoveryCommand['phase'],
      outcome: entry.outcome as ReviewRecoveryCommand['outcome'],
      responseAvailable: entry.responseAvailable,
      ...(references === undefined ? {} : { references }),
    };
  });
  return { kind: 'review-recovery', origin, commands };
}
