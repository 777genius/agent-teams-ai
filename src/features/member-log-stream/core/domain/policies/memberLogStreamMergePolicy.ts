import type {
  MemberLogStreamCoverage,
  MemberLogStreamProvider,
  MemberLogStreamResponse,
  MemberLogStreamSegment,
  MemberLogStreamSource,
  MemberLogStreamWarning,
} from '../../../contracts';
import type { MemberLogStreamBudget } from '../models/MemberLogStreamBudget';
import type { BoardTaskLogParticipant } from '@shared/types';

export const MEMBER_LOG_STREAM_PROVIDER_ORDER: readonly MemberLogStreamProvider[] = [
  'claude_transcript',
  'opencode_runtime',
  'codex_native_trace',
];

function getSegmentStartMs(segment: MemberLogStreamSegment): number {
  const parsed = Date.parse(segment.startTimestamp);
  return Number.isFinite(parsed) ? parsed : 0;
}

function dedupeParticipants(
  participants: readonly BoardTaskLogParticipant[]
): BoardTaskLogParticipant[] {
  const deduped = new Map<string, BoardTaskLogParticipant>();
  for (const participant of participants) {
    if (!deduped.has(participant.key)) {
      deduped.set(participant.key, participant);
    }
  }
  return [...deduped.values()];
}

export function inferMemberLogStreamSource(
  segments: readonly MemberLogStreamSegment[]
): MemberLogStreamSource {
  if (segments.length === 0) {
    return 'member_empty';
  }

  const hasTranscript = segments.some((segment) => segment.source.provider === 'claude_transcript');
  const hasRuntime = segments.some((segment) => segment.source.provider === 'opencode_runtime');

  if (hasTranscript && hasRuntime) {
    return 'member_mixed_runtime';
  }
  if (hasRuntime) {
    return 'member_runtime_only';
  }
  return 'member_transcript';
}

export function buildMemberLogStreamResponse(input: {
  participants: readonly BoardTaskLogParticipant[];
  segments: readonly MemberLogStreamSegment[];
  coverage: readonly MemberLogStreamCoverage[];
  warnings: readonly MemberLogStreamWarning[];
  generatedAt: string;
  budget: MemberLogStreamBudget;
  limitSegments: number;
  metadata: {
    scannedTranscriptFileCount: number;
    includedTranscriptFileCount: number;
    droppedSegmentCount: number;
    droppedChunkCount: number;
    droppedMessageCount: number;
  };
}): MemberLogStreamResponse {
  const warnings = [...input.warnings];
  const sorted = [...input.segments].sort((left, right) => {
    const byTime = getSegmentStartMs(left) - getSegmentStartMs(right);
    return byTime !== 0 ? byTime : left.id.localeCompare(right.id);
  });

  let droppedSegmentCount = input.metadata.droppedSegmentCount;
  let droppedChunkCount = input.metadata.droppedChunkCount;
  let limitedSegments = sorted;
  const maxSegments = Math.min(input.limitSegments, input.budget.maxSegments);
  if (limitedSegments.length > maxSegments) {
    droppedSegmentCount += limitedSegments.length - maxSegments;
    limitedSegments = limitedSegments.slice(-maxSegments);
  }

  const totalChunks = limitedSegments.reduce((sum, segment) => sum + segment.chunks.length, 0);
  if (totalChunks > input.budget.maxChunks) {
    const retained: MemberLogStreamSegment[] = [];
    let remaining = input.budget.maxChunks;
    for (const segment of [...limitedSegments].reverse()) {
      if (remaining <= 0) {
        droppedSegmentCount += 1;
        continue;
      }
      if (segment.chunks.length <= remaining) {
        retained.push(segment);
        remaining -= segment.chunks.length;
        continue;
      }
      const keptChunks = segment.chunks.slice(-remaining);
      droppedChunkCount += segment.chunks.length - keptChunks.length;
      retained.push({
        ...segment,
        chunks: keptChunks,
        source: { ...segment.source, truncated: true },
      });
      remaining = 0;
    }
    const retainedInDisplayOrder = [...retained].reverse();
    limitedSegments = retainedInDisplayOrder;
  }

  const truncated =
    droppedSegmentCount > input.metadata.droppedSegmentCount ||
    droppedChunkCount > input.metadata.droppedChunkCount ||
    input.metadata.droppedMessageCount > 0 ||
    limitedSegments.some((segment) => segment.source.truncated);

  if (truncated && !warnings.some((warning) => warning.code === 'large_log_window_limited')) {
    warnings.push({
      code: 'large_log_window_limited',
      message: 'Showing a bounded recent member log stream to keep the popup responsive.',
    });
  }

  const participants = dedupeParticipants(input.participants);
  return {
    participants,
    defaultFilter: participants.length === 1 ? (participants[0]?.key ?? 'all') : 'all',
    segments: limitedSegments,
    source: inferMemberLogStreamSource(limitedSegments),
    coverage: [...input.coverage].sort(
      (left, right) =>
        MEMBER_LOG_STREAM_PROVIDER_ORDER.indexOf(left.provider) -
        MEMBER_LOG_STREAM_PROVIDER_ORDER.indexOf(right.provider)
    ),
    warnings,
    truncated,
    generatedAt: input.generatedAt,
    metadata: {
      scannedTranscriptFileCount: input.metadata.scannedTranscriptFileCount,
      includedTranscriptFileCount: input.metadata.includedTranscriptFileCount,
      droppedSegmentCount,
      droppedChunkCount,
      droppedMessageCount: input.metadata.droppedMessageCount,
    },
  };
}
