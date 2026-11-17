import { isReviewFlow, MAX_REVIEW_FLOW_PROMPT_LENGTH } from '@shared/constants/kanban';

import type { ReviewFlowSettings } from '@shared/types';

export function parseReviewFlowSettings(
  value: unknown
): { ok: true; settings: ReviewFlowSettings } | { ok: false; error: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'settings must be an object' };
  }
  const { reviewFlow, reviewFlowPrompt } = value as Record<string, unknown>;
  const settings: ReviewFlowSettings = {};
  if (reviewFlow !== undefined) {
    if (!isReviewFlow(reviewFlow)) return { ok: false, error: 'reviewFlow is not supported' };
    settings.reviewFlow = reviewFlow;
  }
  if (reviewFlowPrompt !== undefined) {
    if (typeof reviewFlowPrompt !== 'string') {
      return { ok: false, error: 'reviewFlowPrompt must be a string' };
    }
    if (reviewFlowPrompt.trim().length > MAX_REVIEW_FLOW_PROMPT_LENGTH) {
      return {
        ok: false,
        error: `reviewFlowPrompt must be at most ${MAX_REVIEW_FLOW_PROMPT_LENGTH} characters`,
      };
    }
    settings.reviewFlowPrompt = reviewFlowPrompt;
  }
  if (Object.keys(settings).length === 0) return { ok: false, error: 'settings are empty' };
  return { ok: true, settings };
}

