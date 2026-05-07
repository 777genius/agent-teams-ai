export interface MemberLogPreviewBudget {
  maxMembers: number;
  maxItemsPerMember: number;
  maxTextChars: number;
  maxTranscriptFiles: number;
  maxSourceMessagesPerProvider: number;
  openCodeMessageLimit: number;
  openCodeTimeoutMs: number;
  cacheTtlMs: number;
}

export const DEFAULT_MEMBER_LOG_PREVIEW_BUDGET: MemberLogPreviewBudget = {
  maxMembers: 40,
  maxItemsPerMember: 3,
  maxTextChars: 200,
  maxTranscriptFiles: 8,
  maxSourceMessagesPerProvider: 120,
  openCodeMessageLimit: 80,
  openCodeTimeoutMs: 2_500,
  cacheTtlMs: 3_000,
};

export function clampMemberLogPreviewItemLimit(
  requested: number | undefined,
  budget: MemberLogPreviewBudget = DEFAULT_MEMBER_LOG_PREVIEW_BUDGET
): number {
  if (typeof requested !== 'number' || !Number.isFinite(requested)) {
    return budget.maxItemsPerMember;
  }
  return Math.max(1, Math.min(3, budget.maxItemsPerMember, Math.floor(requested)));
}

export function clampMemberLogPreviewTextLimit(
  requested: number | undefined,
  budget: MemberLogPreviewBudget = DEFAULT_MEMBER_LOG_PREVIEW_BUDGET
): number {
  if (typeof requested !== 'number' || !Number.isFinite(requested)) {
    return budget.maxTextChars;
  }
  return Math.max(80, Math.min(240, budget.maxTextChars, Math.floor(requested)));
}
