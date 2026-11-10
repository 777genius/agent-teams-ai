import { createHash } from 'crypto';

import type {
  MemberLogStreamProvider,
  MemberLogStreamSegmentSource,
  MemberLogStreamWarning,
} from '../../../../contracts';
import type { MemberLogFileRef } from '@main/services/team/TeamMemberLogsFinder';
import type {
  BoardTaskLogActor,
  BoardTaskLogParticipant,
  BoardTaskLogSegment,
} from '@shared/types';

export function normalizeMemberName(value: string): string {
  return value.trim().toLowerCase();
}

export function normalizeTeamName(value: string): string {
  return value.trim().toLowerCase();
}

export const OPENCODE_NATIVE_RUNTIME_LABEL = 'OpenCode runtime';
export const OPENCODE_NATIVE_HISTORY_UNAVAILABLE_WARNING: MemberLogStreamWarning = {
  code: 'opencode_runtime_unavailable',
  message: 'OpenCode native runtime history is unavailable; showing retained member activity only.',
};

/** Exec messages can contain minified Bun source. Only finite process metadata is authority. */
export function classifyOpenCodeTranscriptError(error: unknown): MemberLogStreamWarning {
  const record = error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
  if (
    record.killed === true ||
    record.signal === 'SIGTERM' ||
    record.signal === 'SIGKILL' ||
    record.code === 'ETIMEDOUT' ||
    record.code === 'ERR_CHILD_PROCESS_TIMEOUT' ||
    record.code === 143
  ) {
    return {
      code: 'opencode_runtime_timeout',
      message: 'OpenCode runtime transcript timed out; showing retained member activity only.',
    };
  }
  return OPENCODE_NATIVE_HISTORY_UNAVAILABLE_WARNING;
}

function isPreferredRef(candidate: MemberLogFileRef, existing: MemberLogFileRef): boolean {
  const candidateMessageCount = candidate.messageCount ?? -1;
  const existingMessageCount = existing.messageCount ?? -1;
  if (candidateMessageCount !== existingMessageCount) {
    return candidateMessageCount > existingMessageCount;
  }

  const candidateSize = candidate.sizeBytes ?? -1;
  const existingSize = existing.sizeBytes ?? -1;
  if (candidateSize !== existingSize) {
    return candidateSize > existingSize;
  }

  return candidate.mtimeMs > existing.mtimeMs;
}

export function dedupeMemberLogRefs(refs: readonly MemberLogFileRef[]): MemberLogFileRef[] {
  const byFilePath = new Map<string, MemberLogFileRef>();
  const bySession = new Map<string, MemberLogFileRef>();
  const passthrough: MemberLogFileRef[] = [];

  for (const ref of refs) {
    if (byFilePath.has(ref.filePath)) continue;
    byFilePath.set(ref.filePath, ref);

    if (ref.kind === 'lead_session') {
      passthrough.push(ref);
      continue;
    }

    const key = `${ref.kind ?? 'unknown'}:${normalizeMemberName(ref.memberName)}:${ref.sessionId}`;
    const existing = bySession.get(key);
    if (!existing || isPreferredRef(ref, existing)) {
      bySession.set(key, ref);
    }
  }

  return [...passthrough, ...bySession.values()].sort((left, right) => {
    const byTime = right.mtimeMs - left.mtimeMs;
    return byTime !== 0 ? byTime : left.filePath.localeCompare(right.filePath);
  });
}

export function buildMemberParticipant(
  memberName: string,
  role: 'member' | 'lead' = 'member'
): BoardTaskLogParticipant {
  const isLead = role === 'lead';
  return {
    key: `member:${normalizeMemberName(memberName)}`,
    label: memberName,
    role,
    isLead,
    isSidechain: !isLead,
  };
}

export function buildMemberActor(input: {
  memberName: string;
  sessionId: string;
  role?: 'member' | 'lead';
}): BoardTaskLogActor {
  const role = input.role ?? 'member';
  return {
    memberName: input.memberName,
    role,
    sessionId: input.sessionId,
    isSidechain: role !== 'lead',
  };
}

export function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

export function buildSegmentId(input: {
  provider: MemberLogStreamProvider;
  teamName: string;
  memberName: string;
  sessionId: string;
  fingerprint: string;
  startTimestamp: string;
}): string {
  return [
    input.provider,
    normalizeTeamName(input.teamName),
    normalizeMemberName(input.memberName),
    input.sessionId,
    shortHash(`${input.fingerprint}:${input.startTimestamp}`),
  ].join(':');
}

export function withSegmentSource<T extends BoardTaskLogSegment>(
  segment: T,
  source: MemberLogStreamSegmentSource
): T & { source: MemberLogStreamSegmentSource } {
  return { ...segment, source };
}
