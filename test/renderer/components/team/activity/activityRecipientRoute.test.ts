import { shouldHideDirectMemberRoute } from '@renderer/components/team/activity/activityRecipientRoute';
import { describe, expect, it } from 'vitest';

describe('shouldHideDirectMemberRoute', () => {
  it('never hides member routes in the team feed', () => {
    expect(shouldHideDirectMemberRoute('cody', 'oscar', undefined)).toBe(false);
  });

  it('hides the user and the 1:1 participant', () => {
    expect(shouldHideDirectMemberRoute('user', 'alice', 'alice')).toBe(true);
    expect(shouldHideDirectMemberRoute('alice', 'lead', 'alice')).toBe(true);
    expect(shouldHideDirectMemberRoute('lead', 'alice', 'team-lead')).toBe(true);
  });

  it('keeps lead→teammate routes visible in the lead thread', () => {
    expect(shouldHideDirectMemberRoute('cody', 'oscar', 'oscar')).toBe(false);
    expect(shouldHideDirectMemberRoute('cody', 'lead', 'team-lead')).toBe(false);
  });
});
