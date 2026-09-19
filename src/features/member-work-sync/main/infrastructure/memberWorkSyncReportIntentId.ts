import { createHash } from 'crypto';

import { normalizeMemberKey } from './memberWorkSyncStoreIdentity';

import type { MemberWorkSyncReportRequest } from '../../contracts';

function stableStringify(value: unknown): string {
  if (value == null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}

export function buildPendingReportIntentId(request: MemberWorkSyncReportRequest): string {
  const taskIds = [...new Set(request.taskIds ?? [])].sort();
  const payload = {
    teamName: request.teamName,
    memberName: normalizeMemberKey(request.memberName),
    state: request.state,
    agendaFingerprint: request.agendaFingerprint,
    reportToken: request.reportToken ?? '',
    ...(taskIds.length > 0 ? { taskIds } : {}),
    ...(request.note ? { note: request.note } : {}),
    ...(request.leaseTtlMs ? { leaseTtlMs: request.leaseTtlMs } : {}),
    ...(request.source ? { source: request.source } : {}),
  };
  return `member-work-sync-intent:${createHash('sha256')
    .update(stableStringify(payload))
    .digest('hex')}`;
}
