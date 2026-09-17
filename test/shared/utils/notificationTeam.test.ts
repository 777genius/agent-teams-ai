import {
  getNotificationTeamName,
  notificationBelongsToTeam,
} from '@shared/utils/notificationTeam';
import { describe, expect, it } from 'vitest';

describe('notificationTeam', () => {
  it('prefers the structured team target', () => {
    expect(
      getNotificationTeamName({
        sessionId: 'team:other',
        projectId: 'other',
        category: 'team',
        target: { teamName: 'mixed-v2150-20260917' },
      })
    ).toBe('mixed-v2150-20260917');
  });

  it('reads team:{name} session ids and team-category project ids', () => {
    expect(getNotificationTeamName({ sessionId: 'team:alpha' })).toBe('alpha');
    expect(getNotificationTeamName({ category: 'team', projectId: 'beta' })).toBe('beta');
    expect(
      getNotificationTeamName({
        sessionId: 'abc123',
        projectId: 'encoded-project-path',
        category: 'error',
      })
    ).toBeNull();
  });

  it('ignores non-team notification targets', () => {
    expect(
      getNotificationTeamName({
        sessionId: 'abc123',
        category: 'usage',
        target: { kind: 'token_usage', focus: 'overview' },
      })
    ).toBeNull();
  });

  it('matches only the named team', () => {
    const notification = {
      sessionId: 'team:mixed-v2150-20260917',
      category: 'team' as const,
      projectId: 'mixed-v2150-20260917',
    };
    expect(notificationBelongsToTeam(notification, 'mixed-v2150-20260917')).toBe(true);
    expect(notificationBelongsToTeam(notification, 'other-team')).toBe(false);
    expect(notificationBelongsToTeam(notification, '  ')).toBe(false);
  });
});
