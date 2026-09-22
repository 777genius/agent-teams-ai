import { describe, expect, it } from 'vitest';

import { DEFAULT_MEMBER_LOG_STREAM_BUDGET } from '../../models/MemberLogStreamBudget';
import { buildMemberLogStreamResponse } from '../memberLogStreamMergePolicy';

import type { MemberLogStreamSegment } from '../../../../contracts';
import type { BoardTaskLogParticipant } from '@shared/types';

const participant: BoardTaskLogParticipant = {
  key: 'member:alice',
  label: 'alice',
  role: 'member',
  isLead: false,
  isSidechain: false,
};

function segment(
  id: string,
  timestamp: string,
  provider: MemberLogStreamSegment['source']['provider'] = 'claude_transcript'
): MemberLogStreamSegment {
  return {
    id,
    participantKey: participant.key,
    actor: {
      memberName: 'alice',
      role: 'member',
      sessionId: `session-${id}`,
      isSidechain: false,
    },
    startTimestamp: timestamp,
    endTimestamp: timestamp,
    chunks: [],
    source: {
      provider,
      label: provider,
      sessionId: `session-${id}`,
    },
  };
}

describe('buildMemberLogStreamResponse', () => {
  it('sorts segments chronologically, keeps the recent limit, and marks bounded windows as truncated', () => {
    const response = buildMemberLogStreamResponse({
      participants: [participant, participant],
      segments: [
        segment('newest', '2026-01-01T00:03:00.000Z'),
        segment('oldest', '2026-01-01T00:01:00.000Z'),
        segment('middle', '2026-01-01T00:02:00.000Z'),
      ],
      coverage: [
        { provider: 'codex_native_trace', status: 'skipped' },
        { provider: 'claude_transcript', status: 'included' },
      ],
      warnings: [],
      generatedAt: '2026-01-01T00:04:00.000Z',
      budget: DEFAULT_MEMBER_LOG_STREAM_BUDGET,
      limitSegments: 2,
      metadata: {
        scannedTranscriptFileCount: 3,
        includedTranscriptFileCount: 3,
        droppedSegmentCount: 0,
        droppedChunkCount: 0,
        droppedMessageCount: 0,
      },
    });

    expect(response.segments.map((item) => item.id)).toEqual(['middle', 'newest']);
    expect(response.participants).toEqual([participant]);
    expect(response.coverage.map((item) => item.provider)).toEqual([
      'claude_transcript',
      'codex_native_trace',
    ]);
    expect(response.truncated).toBe(true);
    expect(response.metadata.droppedSegmentCount).toBe(1);
    expect(response.warnings).toEqual([
      {
        code: 'large_log_window_limited',
        message: 'Showing a bounded recent member log stream to keep the popup responsive.',
      },
    ]);
  });

  it('classifies mixed transcript and runtime streams without relying on coverage-only data', () => {
    const mixed = buildMemberLogStreamResponse({
      participants: [participant],
      segments: [
        segment('claude', '2026-01-01T00:01:00.000Z', 'claude_transcript'),
        segment('opencode', '2026-01-01T00:02:00.000Z', 'opencode_runtime'),
      ],
      coverage: [
        { provider: 'claude_transcript', status: 'included' },
        { provider: 'opencode_runtime', status: 'included' },
        { provider: 'codex_native_trace', status: 'skipped' },
      ],
      warnings: [],
      generatedAt: '2026-01-01T00:03:00.000Z',
      budget: DEFAULT_MEMBER_LOG_STREAM_BUDGET,
      limitSegments: 10,
      metadata: {
        scannedTranscriptFileCount: 1,
        includedTranscriptFileCount: 1,
        droppedSegmentCount: 0,
        droppedChunkCount: 0,
        droppedMessageCount: 0,
      },
    });

    expect(mixed.source).toBe('member_mixed_runtime');
  });
});
