import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  TeamMessageNotificationScanner,
  type TeamNotificationMessage,
} from '../../../../src/main/ipc/teams/teamMessageNotificationScanner';

import type { RateLimitAutoResumePlan } from '../../../../src/main/services/team/AutoResumeService';
import type { TeamNotificationPayload } from '../../../../src/main/utils/teamNotificationBuilder';

function createMessage(overrides: Partial<TeamNotificationMessage> = {}): TeamNotificationMessage {
  return {
    from: 'team-lead',
    text: "You've hit your limit. Resets in 5 minutes.",
    timestamp: '2026-04-17T12:00:00.000Z',
    messageId: 'msg-1',
    source: 'lead_session',
    leadSessionId: 'sess-live',
    ...overrides,
  };
}

describe('TeamMessageNotificationScanner', () => {
  const notificationSink = {
    addTeamNotification: vi.fn<() => Promise<unknown>>(),
  };
  const autoResumeSink = {
    handleRateLimitMessage: vi.fn(),
  };
  let autoResumeEnabled = true;

  beforeEach(() => {
    notificationSink.addTeamNotification.mockReset();
    notificationSink.addTeamNotification.mockResolvedValue(null);
    autoResumeSink.handleRateLimitMessage.mockReset();
    autoResumeEnabled = true;
  });

  function createScanner(options?: {
    isRateLimit?: (text: string) => boolean;
    isApiError?: (text: string) => boolean;
    planAutoResume?: (input: {
      enabled: boolean;
      canAutoResume: boolean;
      messageText: string;
      observedAt: Date;
      messageTimestamp?: Date;
    }) => RateLimitAutoResumePlan;
  }): TeamMessageNotificationScanner {
    return new TeamMessageNotificationScanner({
      configReader: {
        getConfig: () => ({ notifications: { autoResumeOnRateLimit: autoResumeEnabled } }),
      },
      notificationSink,
      autoResumeSink,
      now: () => new Date('2026-04-17T12:02:00.000Z'),
      formatClockTime: () => '12:05',
      isRateLimit: options?.isRateLimit ?? ((text) => text.includes('limit')),
      isApiError: options?.isApiError ?? ((text) => text.startsWith('API Error:')),
      planAutoResume:
        options?.planAutoResume ??
        ((input) =>
          input.enabled && input.canAutoResume
            ? {
                kind: 'scheduled',
                resetTime: new Date('2026-04-17T12:05:00.000Z'),
                delayMs: 180_000,
                fireAtMs: Date.parse('2026-04-17T12:05:30.000Z'),
                rawDelayMs: 180_000,
              }
            : { kind: 'manual', reason: 'disabled' }),
    });
  }

  it('notifies and schedules auto-resume for a live lead rate-limit message', () => {
    const scanner = createScanner();

    scanner.checkRateLimitMessages([createMessage()], {
      teamName: 'my-team',
      teamDisplayName: 'My Team',
      projectPath: '/tmp/project',
      teamIsAlive: true,
      currentLeadSessionId: 'sess-live',
    });

    expect(notificationSink.addTeamNotification).toHaveBeenCalledWith(
      expect.objectContaining<TeamNotificationPayload>({
        teamEventType: 'rate_limit',
        teamName: 'my-team',
        teamDisplayName: 'My Team',
        from: 'team-lead',
        summary: 'Rate limit',
        body: 'Auto-resume scheduled at 12:05',
        dedupeKey: 'rate-limit:my-team:msg-1',
        target: { kind: 'member', teamName: 'my-team', memberName: 'team-lead', focus: 'logs' },
        projectPath: '/tmp/project',
      })
    );
    expect(autoResumeSink.handleRateLimitMessage).toHaveBeenCalledWith(
      'my-team',
      "You've hit your limit. Resets in 5 minutes.",
      new Date('2026-04-17T12:02:00.000Z'),
      new Date('2026-04-17T12:00:00.000Z')
    );
  });

  it('dedupes notification storage but still re-evaluates auto-resume later', () => {
    const scanner = createScanner();
    const context = {
      teamName: 'my-team',
      teamDisplayName: 'My Team',
      teamIsAlive: true,
      currentLeadSessionId: 'sess-live',
    };

    autoResumeEnabled = false;
    scanner.checkRateLimitMessages([createMessage()], context);
    expect(notificationSink.addTeamNotification).toHaveBeenCalledTimes(1);
    expect(autoResumeSink.handleRateLimitMessage).not.toHaveBeenCalled();

    autoResumeEnabled = true;
    scanner.checkRateLimitMessages([createMessage()], context);

    expect(notificationSink.addTeamNotification).toHaveBeenCalledTimes(1);
    expect(autoResumeSink.handleRateLimitMessage).toHaveBeenCalledTimes(1);
  });

  it('does not schedule auto-resume from an older lead session', () => {
    const scanner = createScanner();

    scanner.checkRateLimitMessages(
      [createMessage({ leadSessionId: 'sess-old', messageId: 'old-session' })],
      {
        teamName: 'my-team',
        teamDisplayName: 'My Team',
        teamIsAlive: true,
        currentLeadSessionId: 'sess-live',
      }
    );

    expect(notificationSink.addTeamNotification).toHaveBeenCalledTimes(1);
    expect(autoResumeSink.handleRateLimitMessage).not.toHaveBeenCalled();
  });

  it('sends API-error notifications while leaving rate limits to the rate-limit path', () => {
    const scanner = createScanner({
      isRateLimit: (text) => text.includes('429'),
      isApiError: (text) => text.startsWith('API Error:'),
    });

    scanner.checkApiErrorMessages(
      [
        createMessage({ text: 'API Error: 429 rate limited', messageId: 'rate-limit-api' }),
        createMessage({ text: 'API Error: 500 server failed', messageId: 'api-500' }),
      ],
      {
        teamName: 'my-team',
        teamDisplayName: 'My Team',
      }
    );

    expect(notificationSink.addTeamNotification).toHaveBeenCalledTimes(1);
    expect(notificationSink.addTeamNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        teamEventType: 'api_error',
        summary: 'API Error 500',
        dedupeKey: 'api-error:my-team:api-500',
      })
    );
  });
});
