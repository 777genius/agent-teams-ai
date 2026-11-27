import {
  BUILT_IN_REVIEW_FLOW_SETTINGS,
  MAX_REVIEW_FLOW_PROMPT_LENGTH,
  parseReviewFlowSettings,
  inspectTeamReviewFlowState,
  resolveReviewFlowPolicy,
} from '@features/review-flow';
import { describe, expect, it } from 'vitest';

const HUMAN = { reviewFlow: 'human_approval', reviewFlowPrompt: 'Run the e2e suite.' } as const;

describe('review flow policy', () => {
  it('lets a team override replace the default as a unit, never merging the prompts', () => {
    const defaults = { reviewFlow: 'human_approval', reviewFlowPrompt: 'Default text' } as const;
    expect(resolveReviewFlowPolicy(defaults, null)).toEqual({ ...defaults, source: 'default' });
    expect(
      resolveReviewFlowPolicy(defaults, { reviewFlow: 'agent_approval', reviewFlowPrompt: '' })
    ).toEqual({ reviewFlow: 'agent_approval', reviewFlowPrompt: '', source: 'team' });
  });

  it('parses only complete, bounded settings and trims the prompt', () => {
    expect(parseReviewFlowSettings({ ...HUMAN, reviewFlowPrompt: '  Run the e2e suite.  ' })).toEqual({
      ok: true,
      settings: HUMAN,
    });
    expect(parseReviewFlowSettings({ reviewFlow: 'agent_approval' })).toEqual({
      ok: true,
      settings: BUILT_IN_REVIEW_FLOW_SETTINGS,
    });
    for (const bad of [
      null,
      [],
      'human_approval',
      {},
      { reviewFlowPrompt: 'only a prompt' },
      { reviewFlow: 'everyone' },
      { reviewFlow: 'human_approval', reviewFlowPrompt: 5 },
      { reviewFlow: 'human_approval', reviewFlowPrompt: 'x'.repeat(MAX_REVIEW_FLOW_PROMPT_LENGTH + 1) },
    ]) {
      expect(parseReviewFlowSettings(bad)).toMatchObject({ ok: false });
    }
  });

  it('tells apart following the default, a valid override and unreadable settings', () => {
    expect(inspectTeamReviewFlowState({ teamName: 'a', tasks: {} })).toEqual({ kind: 'follows-default' });
    expect(inspectTeamReviewFlowState(null)).toEqual({ kind: 'follows-default' });
    // The controller refuses to run these, so they must never look like "follows the default".
    expect(inspectTeamReviewFlowState({ reviewFlowPrompt: 'orphan prompt' })).toEqual({ kind: 'invalid' });
    expect(inspectTeamReviewFlowState({ reviewFlow: 'everyone' })).toEqual({ kind: 'invalid' });
    expect(inspectTeamReviewFlowState({ ...HUMAN, tasks: {} })).toEqual({
      kind: 'override',
      settings: HUMAN,
    });
  });
});
