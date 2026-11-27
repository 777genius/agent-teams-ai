import { reviewFlowTeamKindOf } from '@features/review-flow';
import { describe, expect, it } from 'vitest';

describe('reviewFlowTeamKindOf', () => {
  it('gives a per-project team one setting and refuses its copies their own', () => {
    expect(reviewFlowTeamKindOf('logical', false)).toBe('project-team');
    expect(reviewFlowTeamKindOf('alias', true)).toBe('project-copy');
  });

  it('keeps an ordinary team and a copy an ordinary team kept as boards of their own', () => {
    expect(reviewFlowTeamKindOf('native', false)).toBe('board');
    expect(reviewFlowTeamKindOf('alias', false)).toBe('board');
  });
});
