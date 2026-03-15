import { describe, expect, it } from 'vitest';

import {
  buildDetectedErrorFromTeam,
  type TeamEventType,
  type TeamNotificationPayload,
} from '@main/utils/teamNotificationBuilder';

function makePayload(overrides: Partial<TeamNotificationPayload> = {}): TeamNotificationPayload {
  return {
    teamEventType: 'user_inbox',
    teamName: 'my-team',
    teamDisplayName: 'My Team',
    from: 'alice',
    summary: 'Hello from Alice',
    body: 'Full message body here',
    dedupeKey: 'inbox:my-team:alice:123',
    ...overrides,
  };
}

describe('buildDetectedErrorFromTeam', () => {
  it('creates a DetectedError with category "team"', () => {
    const result = buildDetectedErrorFromTeam(makePayload());
    expect(result.category).toBe('team');
  });

  it('sets sessionId as "team:{teamName}"', () => {
    const result = buildDetectedErrorFromTeam(makePayload({ teamName: 'alpha-team' }));
    expect(result.sessionId).toBe('team:alpha-team');
  });

  it('sets projectId to teamName', () => {
    const result = buildDetectedErrorFromTeam(makePayload({ teamName: 'beta' }));
    expect(result.projectId).toBe('beta');
  });

  it('sets source to teamEventType', () => {
    const result = buildDetectedErrorFromTeam(makePayload({ teamEventType: 'task_clarification' }));
    expect(result.source).toBe('task_clarification');
  });

  it('includes dedupeKey', () => {
    const result = buildDetectedErrorFromTeam(
      makePayload({ dedupeKey: 'clarification:team1:42' })
    );
    expect(result.dedupeKey).toBe('clarification:team1:42');
  });

  it('sets teamEventType on the result', () => {
    const result = buildDetectedErrorFromTeam(makePayload({ teamEventType: 'rate_limit' }));
    expect(result.teamEventType).toBe('rate_limit');
  });

  it('constructs message from "from" and body', () => {
    const result = buildDetectedErrorFromTeam(
      makePayload({ from: 'bob', body: 'Something happened' })
    );
    expect(result.message).toBe('[bob] Something happened');
  });

  it('truncates body to 300 chars in message', () => {
    const longBody = 'x'.repeat(500);
    const result = buildDetectedErrorFromTeam(makePayload({ body: longBody }));
    // "[alice] " = 8 chars + 300 chars body = 308 total
    expect(result.message.length).toBe(8 + 300);
  });

  it('sets context.projectName to teamDisplayName', () => {
    const result = buildDetectedErrorFromTeam(makePayload({ teamDisplayName: 'Alpha Squad' }));
    expect(result.context.projectName).toBe('Alpha Squad');
  });

  it('sets context.cwd to projectPath when provided', () => {
    const result = buildDetectedErrorFromTeam(makePayload({ projectPath: '/home/user/project' }));
    expect(result.context.cwd).toBe('/home/user/project');
  });

  it('generates a UUID id', () => {
    const result = buildDetectedErrorFromTeam(makePayload());
    expect(result.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('sets filePath to empty string', () => {
    const result = buildDetectedErrorFromTeam(makePayload());
    expect(result.filePath).toBe('');
  });

  const EXPECTED_CONFIG: Record<TeamEventType, { triggerName: string; triggerColor: string }> = {
    rate_limit: { triggerName: 'Rate Limit', triggerColor: 'red' },
    lead_inbox: { triggerName: 'Team Inbox', triggerColor: 'blue' },
    user_inbox: { triggerName: 'User Inbox', triggerColor: 'green' },
    task_clarification: { triggerName: 'Clarification', triggerColor: 'orange' },
    task_status_change: { triggerName: 'Status Change', triggerColor: 'purple' },
    task_comment: { triggerName: 'Task Comment', triggerColor: 'cyan' },
    schedule_completed: { triggerName: 'Schedule Done', triggerColor: 'green' },
    schedule_failed: { triggerName: 'Schedule Failed', triggerColor: 'red' },
  };

  for (const [eventType, expected] of Object.entries(EXPECTED_CONFIG)) {
    it(`maps ${eventType} → triggerName="${expected.triggerName}", triggerColor="${expected.triggerColor}"`, () => {
      const result = buildDetectedErrorFromTeam(
        makePayload({ teamEventType: eventType as TeamEventType })
      );
      expect(result.triggerName).toBe(expected.triggerName);
      expect(result.triggerColor).toBe(expected.triggerColor);
    });
  }
});
