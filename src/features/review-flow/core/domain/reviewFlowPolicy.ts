import type { ReviewFlow, ReviewFlowPolicy, ReviewFlowSettings } from '../../contracts/types';

/**
 * Values are owned here for the TypeScript side. The controller (agent-teams-controller/src/internal/reviewFlow.js)
 * enforces the same rules for agents; a parity test keeps the two copies equal.
 */
export const REVIEW_FLOWS: readonly ReviewFlow[] = [
  'agent_approval',
  'human_approval',
  'lead_then_human',
];
export const DEFAULT_REVIEW_FLOW: ReviewFlow = 'agent_approval';
export const MAX_REVIEW_FLOW_PROMPT_LENGTH = 1000;

export const BUILT_IN_REVIEW_FLOW_SETTINGS: Readonly<ReviewFlowSettings> = Object.freeze({
  reviewFlow: DEFAULT_REVIEW_FLOW,
  reviewFlowPrompt: '',
});

export type ParseReviewFlowSettingsResult =
  | { ok: true; settings: ReviewFlowSettings }
  | { ok: false; error: string };

export function isReviewFlow(value: unknown): value is ReviewFlow {
  return REVIEW_FLOWS.includes(value as ReviewFlow);
}

/** Strict parser for untrusted input: a complete unit with a known flow and a bounded prompt. */
export function parseReviewFlowSettings(value: unknown): ParseReviewFlowSettingsResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'settings must be an object' };
  }
  const { reviewFlow, reviewFlowPrompt } = value as Record<string, unknown>;
  if (!isReviewFlow(reviewFlow)) return { ok: false, error: 'reviewFlow is not supported' };
  if (reviewFlowPrompt !== undefined && typeof reviewFlowPrompt !== 'string') {
    return { ok: false, error: 'reviewFlowPrompt must be a string' };
  }
  const prompt = (reviewFlowPrompt ?? '').trim();
  if (prompt.length > MAX_REVIEW_FLOW_PROMPT_LENGTH) {
    return {
      ok: false,
      error: `reviewFlowPrompt must be at most ${MAX_REVIEW_FLOW_PROMPT_LENGTH} characters`,
    };
  }
  return { ok: true, settings: { reviewFlow, reviewFlowPrompt: prompt } };
}

export type TeamReviewFlowState =
  | { kind: 'follows-default' }
  | { kind: 'override'; settings: ReviewFlowSettings }
  | { kind: 'invalid' };

/**
 * Classifies the review-flow part of a persisted kanban-state-like object. A team follows the
 * default unless it carries its own complete override. Review-flow fields that cannot be read
 * (unknown flow, a prompt without a flow) are `invalid`: the controller refuses to run such a team
 * until the override is reset, so callers must not treat it as following the default.
 */
export function inspectTeamReviewFlowState(state: unknown): TeamReviewFlowState {
  if (!state || typeof state !== 'object' || Array.isArray(state))
    return { kind: 'follows-default' };
  const { reviewFlow, reviewFlowPrompt } = state as Record<string, unknown>;
  if (reviewFlow === undefined) {
    return reviewFlowPrompt === undefined ? { kind: 'follows-default' } : { kind: 'invalid' };
  }
  const parsed = parseReviewFlowSettings(state);
  return parsed.ok ? { kind: 'override', settings: parsed.settings } : { kind: 'invalid' };
}

/** The single rule for combining a default with an optional team override. */
export function resolveReviewFlowPolicy(
  defaults: ReviewFlowSettings,
  teamOverride: ReviewFlowSettings | null | undefined
): ReviewFlowPolicy {
  return teamOverride ? { ...teamOverride, source: 'team' } : { ...defaults, source: 'default' };
}

/** True when the user, not an agent, gives the final approval (with or without a lead sign-off). */
export function isHumanApprovalFlow(policy: { reviewFlow?: string } | null | undefined): boolean {
  return policy?.reviewFlow === 'human_approval' || isLeadSignoffFlow(policy);
}

/** True when the lead must sign off after the reviewer, before the task reaches Done. */
export function isLeadSignoffFlow(policy: { reviewFlow?: string } | null | undefined): boolean {
  return policy?.reviewFlow === 'lead_then_human';
}

export function areReviewFlowSettingsEqual(a: ReviewFlowSettings, b: ReviewFlowSettings): boolean {
  return a.reviewFlow === b.reviewFlow && a.reviewFlowPrompt.trim() === b.reviewFlowPrompt.trim();
}

/** The same rule for an override that may be absent (`null`: the team follows the default). */
export function areReviewFlowOverridesEqual(
  a: ReviewFlowSettings | null,
  b: ReviewFlowSettings | null
): boolean {
  if (a === null || b === null) return a === b;
  return areReviewFlowSettingsEqual(a, b);
}
