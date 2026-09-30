export * from './ipc';
export type * from './types';

export const MEMBER_WORK_SYNC_RUNTIME_CONTROL_REASON_LIMIT = 256;

export function isValidMemberWorkSyncRuntimeControlReason(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= MEMBER_WORK_SYNC_RUNTIME_CONTROL_REASON_LIMIT
  );
}

export function normalizeMemberWorkSyncRuntimeControlReason(
  value: unknown,
  fallback: string
): string | undefined {
  if (typeof value === 'string' && value.length > MEMBER_WORK_SYNC_RUNTIME_CONTROL_REASON_LIMIT) {
    return undefined;
  }
  const normalized = typeof value === 'string' ? value.trim() : '';
  const reason = normalized || fallback;
  return isValidMemberWorkSyncRuntimeControlReason(reason) ? reason : undefined;
}
