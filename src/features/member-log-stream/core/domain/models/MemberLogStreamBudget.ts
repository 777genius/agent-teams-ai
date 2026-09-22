export interface MemberLogStreamBudget {
  maxTranscriptFiles: number;
  maxSegments: number;
  maxChunks: number;
  maxSourceMessages: number;
  maxMessagesPerSegment: number;
  maxTotalContentChars: number;
  maxMessageContentChars: number;
  maxToolResultContentChars: number;
  openCodeMessageLimit: number;
  openCodeTimeoutMs: number;
}

export const DEFAULT_MEMBER_LOG_STREAM_BUDGET: MemberLogStreamBudget = {
  maxTranscriptFiles: 40,
  maxSegments: 30,
  maxChunks: 250,
  maxSourceMessages: 1200,
  maxMessagesPerSegment: 300,
  maxTotalContentChars: 800_000,
  maxMessageContentChars: 80_000,
  maxToolResultContentChars: 120_000,
  openCodeMessageLimit: 400,
  openCodeTimeoutMs: 5_000,
};

export function clampMemberLogStreamSegmentLimit(
  requested: number | undefined,
  budget: MemberLogStreamBudget = DEFAULT_MEMBER_LOG_STREAM_BUDGET
): number {
  if (typeof requested !== 'number' || !Number.isFinite(requested)) {
    return budget.maxSegments;
  }
  return Math.max(1, Math.min(80, Math.floor(requested), budget.maxSegments));
}
