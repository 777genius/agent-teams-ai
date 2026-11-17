import { createRequire } from 'node:module';

import {
  DEFAULT_REVIEW_FLOW,
  isHumanApprovalFlow,
  MAX_REVIEW_FLOW_PROMPT_LENGTH,
  parseReviewFlowSettings,
  resolveReviewFlowPolicy,
  REVIEW_FLOWS,
} from '@features/review-flow/core/domain';
import { describe, expect, it } from 'vitest';

interface ControllerReviewFlow {
  DEFAULT_REVIEW_FLOW: string;
  MAX_REVIEW_FLOW_PROMPT_LENGTH: number;
  REVIEW_FLOWS: readonly string[];
  isHumanApproval: (policy: unknown) => boolean;
  parseReviewFlowSettings: (raw: unknown) => { reviewFlow: string; reviewFlowPrompt: string };
  resolvePolicy: (
    defaults: { reviewFlow: string; reviewFlowPrompt: string },
    override: { reviewFlow: string; reviewFlowPrompt: string } | null
  ) => { reviewFlow: string; reviewFlowPrompt: string; source: string };
}

const nodeRequire = createRequire(import.meta.url);
const controller = nodeRequire(
  '../../agent-teams-controller/src/internal/reviewFlow.js'
) as ControllerReviewFlow;

describe('review flow rules shared by the controller and the TypeScript domain', () => {
  it('keep identical constants', () => {
    expect([...REVIEW_FLOWS]).toEqual([...controller.REVIEW_FLOWS]);
    expect(DEFAULT_REVIEW_FLOW).toBe(controller.DEFAULT_REVIEW_FLOW);
    expect(MAX_REVIEW_FLOW_PROMPT_LENGTH).toBe(controller.MAX_REVIEW_FLOW_PROMPT_LENGTH);
  });

  it('accept and reject the same settings units', () => {
    const cases: unknown[] = [
      { reviewFlow: 'human_approval' },
      { reviewFlow: 'agent_approval', reviewFlowPrompt: '  Check migrations.  ' },
      { reviewFlow: 'human_approval', reviewFlowPrompt: 'x'.repeat(MAX_REVIEW_FLOW_PROMPT_LENGTH) },
      { reviewFlow: 'human_approval', reviewFlowPrompt: 'x'.repeat(MAX_REVIEW_FLOW_PROMPT_LENGTH + 1) },
      { reviewFlow: 'human_approval', reviewFlowPrompt: 5 },
      { reviewFlow: 'everyone' },
      { reviewFlowPrompt: 'a prompt alone is not a unit' },
      {},
      [],
      null,
      'human_approval',
    ];
    for (const raw of cases) {
      const domain = parseReviewFlowSettings(raw);
      let fromController: { reviewFlow: string; reviewFlowPrompt: string } | null = null;
      try {
        fromController = controller.parseReviewFlowSettings(raw);
      } catch {
        fromController = null;
      }
      expect(fromController !== null).toBe(domain.ok);
      if (domain.ok) expect(fromController).toEqual(domain.settings);
    }
  });

  it('resolve the policy the same way: an override replaces flow and prompt as a unit', () => {
    const defaults = { reviewFlow: 'human_approval' as const, reviewFlowPrompt: 'Default prompt' };
    const override = { reviewFlow: 'agent_approval' as const, reviewFlowPrompt: '' };
    expect(controller.resolvePolicy(defaults, override)).toEqual(
      resolveReviewFlowPolicy(defaults, override)
    );
    expect(controller.resolvePolicy(defaults, null)).toEqual(
      resolveReviewFlowPolicy(defaults, null)
    );
    expect(resolveReviewFlowPolicy(defaults, override).reviewFlowPrompt).toBe('');
  });

  it('treat only human_approval as the human-only policy', () => {
    for (const policy of [
      { reviewFlow: 'human_approval' },
      { reviewFlow: 'agent_approval' },
      {},
      null,
    ]) {
      expect(controller.isHumanApproval(policy)).toBe(isHumanApprovalFlow(policy));
    }
    expect(isHumanApprovalFlow({ reviewFlow: 'human_approval' })).toBe(true);
    expect(isHumanApprovalFlow(null)).toBe(false);
  });
});
