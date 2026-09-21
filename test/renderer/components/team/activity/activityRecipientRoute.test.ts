import {
  isDirectParticipantSender,
  shouldHideDirectMemberRoute,
} from '@renderer/components/team/activity/activityRecipientRoute';
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

  it('hides -> lead when the 1:1 participant is the real lead name', () => {
    expect(shouldHideDirectMemberRoute('lead', 'atlas', 'oscar')).toBe(true);
    expect(shouldHideDirectMemberRoute('team-lead', 'atlas', 'oscar')).toBe(true);
  });

  it('does not treat orchestrator as a conversation lead route', () => {
    expect(shouldHideDirectMemberRoute('orchestrator', 'atlas', 'oscar')).toBe(false);
  });
});

describe('isDirectParticipantSender', () => {
  it('matches only the selected participant, case-insensitively', () => {
    expect(isDirectParticipantSender(' Alice ', 'alice')).toBe(true);
    expect(isDirectParticipantSender('oscar', 'alice')).toBe(false);
    expect(isDirectParticipantSender('alice', undefined)).toBe(false);
  });
});
