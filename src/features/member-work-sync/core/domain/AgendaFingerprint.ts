import type { MemberWorkSyncActionableWorkItem } from '../../contracts';

export const MEMBER_WORK_SYNC_AGENDA_FINGERPRINT_PREFIX = 'agenda:v1:';

function stableJson(value: unknown): string {
  if (value == null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}

export interface AgendaFingerprintPayload {
  version: 1;
  teamName: string;
  memberName: string;
  items: {
    taskId: string;
    displayId?: string;
    subject: string;
    kind: string;
    assignee: string;
    priority: string;
    evidence: MemberWorkSyncActionableWorkItem['evidence'];
  }[];
  sourceRevision?: string;
}

export function buildAgendaFingerprintPayload(input: {
  teamName: string;
  memberName: string;
  items: MemberWorkSyncActionableWorkItem[];
  sourceRevision?: string;
}): AgendaFingerprintPayload {
  return {
    version: 1,
    teamName: input.teamName,
    memberName: input.memberName,
    ...(input.sourceRevision ? { sourceRevision: input.sourceRevision } : {}),
    items: [...input.items]
      .sort((left, right) => {
        const leftKey = `${left.kind}:${left.taskId}:${left.displayId ?? ''}`;
        const rightKey = `${right.kind}:${right.taskId}:${right.displayId ?? ''}`;
        return leftKey.localeCompare(rightKey);
      })
      .map((item) => ({
        taskId: item.taskId,
        ...(item.displayId ? { displayId: item.displayId } : {}),
        subject: item.subject,
        kind: item.kind,
        assignee: item.assignee,
        priority: item.priority,
        evidence: {
          ...item.evidence,
          ...(item.evidence.blockerTaskIds
            ? { blockerTaskIds: [...item.evidence.blockerTaskIds].sort() }
            : {}),
          ...(item.evidence.blockedByTaskIds
            ? { blockedByTaskIds: [...item.evidence.blockedByTaskIds].sort() }
            : {}),
          ...(item.evidence.historyEventIds
            ? { historyEventIds: [...item.evidence.historyEventIds].sort() }
            : {}),
          ...(item.evidence.reviewDiagnostics
            ? { reviewDiagnostics: [...item.evidence.reviewDiagnostics].sort() }
            : {}),
        },
      })),
  };
}

export function canonicalizeAgendaFingerprintPayload(payload: AgendaFingerprintPayload): string {
  return stableJson(payload);
}

export function formatAgendaFingerprint(hashHex: string): string {
  return `${MEMBER_WORK_SYNC_AGENDA_FINGERPRINT_PREFIX}${hashHex}`;
}
