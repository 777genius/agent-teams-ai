import { asEnhancedChunkArray } from '@renderer/types/data';

import type { BoardTaskLogParticipant, BoardTaskLogSegment } from '@shared/types';

export interface ExecutionLogStreamLike {
  participants: BoardTaskLogParticipant[];
  defaultFilter: string;
  segments: BoardTaskLogSegment[];
}

export function normalizeExecutionLogStream<TStream extends ExecutionLogStreamLike>(
  response: TStream
): TStream {
  return {
    ...response,
    segments: response.segments.map((segment) => ({
      ...segment,
      chunks: asEnhancedChunkArray(segment.chunks) ?? [],
    })),
  };
}

export function buildDefaultExecutionSegmentRenderKey(segment: BoardTaskLogSegment): string {
  const firstChunkId = segment.chunks[0]?.id;
  if (firstChunkId) {
    return `${segment.participantKey}:${firstChunkId}`;
  }
  return `${segment.participantKey}:${segment.startTimestamp}`;
}
