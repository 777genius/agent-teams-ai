import type {
  MemberLogPreviewMember,
  MemberLogPreviewResponse,
  MemberLogStreamResponse,
  MemberRuntimeLogKind,
  MemberRuntimeLogTailResponse,
} from './dto';

export function createEmptyMemberLogStreamResponse(
  generatedAt = new Date().toISOString()
): MemberLogStreamResponse {
  return {
    participants: [],
    defaultFilter: 'all',
    segments: [],
    source: 'member_empty',
    coverage: [],
    warnings: [],
    truncated: false,
    generatedAt,
    metadata: {
      scannedTranscriptFileCount: 0,
      includedTranscriptFileCount: 0,
      droppedSegmentCount: 0,
      droppedChunkCount: 0,
      droppedMessageCount: 0,
    },
  };
}

export function normalizeMemberLogStreamResponse(
  response: MemberLogStreamResponse | null | undefined
): MemberLogStreamResponse {
  if (!response) {
    return createEmptyMemberLogStreamResponse();
  }

  return {
    ...createEmptyMemberLogStreamResponse(response.generatedAt),
    ...response,
    participants: Array.isArray(response.participants) ? response.participants : [],
    segments: Array.isArray(response.segments) ? response.segments : [],
    coverage: Array.isArray(response.coverage) ? response.coverage : [],
    warnings: Array.isArray(response.warnings) ? response.warnings : [],
    metadata: {
      ...createEmptyMemberLogStreamResponse(response.generatedAt).metadata,
      ...(response.metadata ?? {}),
    },
  };
}

export function createEmptyMemberLogPreviewResponse(
  generatedAt = new Date().toISOString()
): MemberLogPreviewResponse {
  return {
    members: [],
    generatedAt,
  };
}

function normalizeMemberLogPreviewMember(member: MemberLogPreviewMember): MemberLogPreviewMember {
  return {
    memberName: typeof member.memberName === 'string' ? member.memberName : '',
    items: Array.isArray(member.items) ? member.items : [],
    coverage: Array.isArray(member.coverage) ? member.coverage : [],
    warnings: Array.isArray(member.warnings) ? member.warnings : [],
    truncated: member.truncated === true,
    overflowCount:
      typeof member.overflowCount === 'number' && Number.isFinite(member.overflowCount)
        ? Math.max(0, Math.floor(member.overflowCount))
        : 0,
    generatedAt:
      typeof member.generatedAt === 'string' && member.generatedAt.length > 0
        ? member.generatedAt
        : new Date().toISOString(),
  };
}

export function normalizeMemberLogPreviewResponse(
  response: MemberLogPreviewResponse | null | undefined
): MemberLogPreviewResponse {
  if (!response) {
    return createEmptyMemberLogPreviewResponse();
  }

  return {
    members: Array.isArray(response.members)
      ? response.members.map(normalizeMemberLogPreviewMember)
      : [],
    generatedAt:
      typeof response.generatedAt === 'string' && response.generatedAt.length > 0
        ? response.generatedAt
        : new Date().toISOString(),
  };
}

const MEMBER_RUNTIME_LOG_KINDS = new Set<MemberRuntimeLogKind>(['stdout', 'stderr', 'events']);

function normalizeMemberRuntimeLogKind(kind: unknown): MemberRuntimeLogKind {
  return MEMBER_RUNTIME_LOG_KINDS.has(kind as MemberRuntimeLogKind)
    ? (kind as MemberRuntimeLogKind)
    : 'stdout';
}

function normalizeOptionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function createEmptyMemberRuntimeLogTailResponse(
  kind: MemberRuntimeLogKind = 'stdout'
): MemberRuntimeLogTailResponse {
  return {
    kind,
    content: '',
    truncated: false,
    bytesRead: 0,
    missing: true,
  };
}

export function normalizeMemberRuntimeLogTailResponse(
  response: MemberRuntimeLogTailResponse | null | undefined
): MemberRuntimeLogTailResponse {
  if (!response) {
    return createEmptyMemberRuntimeLogTailResponse();
  }

  const kind = normalizeMemberRuntimeLogKind(response.kind);
  const fileSizeBytes = normalizeOptionalFiniteNumber(response.fileSizeBytes);
  const updatedAt =
    typeof response.updatedAt === 'string' && response.updatedAt.length > 0
      ? response.updatedAt
      : undefined;

  return {
    kind,
    content: typeof response.content === 'string' ? response.content : '',
    truncated: response.truncated === true,
    bytesRead: normalizeOptionalFiniteNumber(response.bytesRead) ?? 0,
    ...(fileSizeBytes !== undefined ? { fileSizeBytes } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    missing: response.missing === true,
  };
}
