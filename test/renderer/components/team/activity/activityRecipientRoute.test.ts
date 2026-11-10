import {
  isDirectParticipantSender,
  shouldHideDirectMemberRoute,
} from '@renderer/components/team/activity/activityRecipientRoute';
import { describe, expect, it } from 'vitest';

describe('shouldHideDirectMemberRoute', () => {
  it('never hides member routes in the team feed', () => {
    expect(shouldHideDirectMemberRoute('cody', 'oscar', undefined)).toBe(false);
  });

  it('hides routes involving the user in a 1:1 thread', () => {
    expect(shouldHideDirectMemberRoute('user', 'alice', 'alice')).toBe(true);
    expect(shouldHideDirectMemberRoute('alice', 'user', 'alice')).toBe(true);
  });

  it('keeps lead→teammate routes visible in the lead thread', () => {
    expect(shouldHideDirectMemberRoute('cody', 'oscar', 'oscar')).toBe(false);
    expect(shouldHideDirectMemberRoute('cody', 'lead', 'team-lead')).toBe(false);
  });

  it('shows routes between teammates even when the recipient is the open chat participant', () => {
    expect(shouldHideDirectMemberRoute('alice', 'oscar', 'alice')).toBe(false);
    expect(shouldHideDirectMemberRoute('alice', 'lead', 'alice')).toBe(false);
    expect(shouldHideDirectMemberRoute('lead', 'atlas', 'oscar')).toBe(false);
    expect(shouldHideDirectMemberRoute('team-lead', 'atlas', 'oscar')).toBe(false);
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
