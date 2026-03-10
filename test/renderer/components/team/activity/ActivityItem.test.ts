import { describe, expect, it } from 'vitest';

import {
  getCrossTeamSentMemberName,
  getCrossTeamSentTarget,
  getSystemMessageLabel,
  isQualifiedExternalRecipient,
} from '@renderer/components/team/activity/ActivityItem';

describe('ActivityItem legacy system message fallback', () => {
  it('recognizes historical assignment and review message wording', () => {
    expect(getSystemMessageLabel('New task assigned to you: #abcd1234 "Implement feature".')).toBe(
      'Task assignment'
    );
    expect(getSystemMessageLabel('Task #abcd1234 approved by reviewer.')).toBe('Task approved');
    expect(getSystemMessageLabel('Task #abcd1234 needs fixes before approval.')).toBe(
      'Review changes requested'
    );
  });

  it('does not treat new controller-authored summaries as legacy system noise', () => {
    expect(getSystemMessageLabel('Review request for #abcd1234')).toBeNull();
    expect(getSystemMessageLabel('Approved abcd1234')).toBeNull();
    expect(getSystemMessageLabel('Fix request for abcd1234')).toBeNull();
  });

  it('does not classify dotted local teammates as external recipients', () => {
    expect(isQualifiedExternalRecipient('ops.bot', 'my-team', new Set(['ops.bot']))).toBe(false);
    expect(isQualifiedExternalRecipient('team-best.user', 'my-team', new Set(['ops.bot']))).toBe(
      true
    );
  });

  it('recognizes pseudo cross-team recipients in activity rows', () => {
    expect(getCrossTeamSentTarget('cross-team:team-best', 'my-team', new Set(['ops.bot']))).toBe(
      'team-best'
    );
    expect(getCrossTeamSentTarget('team-best.user', 'my-team', new Set(['ops.bot']))).toBe(
      'team-best'
    );
    expect(getCrossTeamSentMemberName('team-best.user')).toBe('user');
    expect(getCrossTeamSentMemberName('cross-team:team-best')).toBeNull();
  });
});
