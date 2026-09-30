import type { RestoreReviewHistoryRequest } from '@shared/types/review';

export function parseReviewHistoryRestoreTarget(
  value: unknown
): RestoreReviewHistoryRequest['target'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid review history restore target');
  }
  const target = value as Record<string, unknown>;
  if (target.kind === 'start') return { kind: 'start' };
  if (
    target.kind !== 'after-action' ||
    (target.stack !== 'undo' && target.stack !== 'redo') ||
    typeof target.actionId !== 'string' ||
    target.actionId.length === 0 ||
    target.actionId.length > 256
  ) {
    throw new Error('Invalid review history restore target');
  }
  return { kind: 'after-action', stack: target.stack, actionId: target.actionId };
}

export function isDecisionlessReviewRecoveryKind(kind: string): boolean {
  return (
    kind === 'undo' || kind === 'redo' || kind === 'reload-external' || kind === 'restore-history'
  );
}
