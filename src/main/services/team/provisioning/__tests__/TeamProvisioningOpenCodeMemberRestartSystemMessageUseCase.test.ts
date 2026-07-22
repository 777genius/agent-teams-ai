import { describe, expect, it } from 'vitest';

import { createPersistOpenCodeMemberRestartSystemMessageUseCase } from '../TeamProvisioningOpenCodeMemberRestartSystemMessageUseCase';

describe('PersistOpenCodeMemberRestartSystemMessageUseCase', () => {
  it('persists manual restart instructions through the sent-message port', () => {
    const sentMessages: Array<{ teamName: string; message: Record<string, unknown> }> = [];
    const persistRestartMessage = createPersistOpenCodeMemberRestartSystemMessageUseCase({
      persistSentMessage: (teamName, message) => {
        sentMessages.push({ teamName, message });
      },
      nowIso: () => '2026-07-06T16:00:00.000Z',
      randomUUID: () => 'uuid-1',
    });

    persistRestartMessage({
      teamName: 'team-a',
      leadName: 'team-lead',
      leadSessionId: 'lead-session-1',
      displayName: 'Team A',
      member: {
        name: 'Worker',
        role: 'Developer',
        providerId: 'opencode',
        model: 'openai/gpt-5.4-mini',
      },
      reason: 'manual_restart',
    });

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]?.teamName).toBe('team-a');
    expect(sentMessages[0]?.message).toMatchObject({
      from: 'team-lead',
      to: 'Worker',
      timestamp: '2026-07-06T16:00:00.000Z',
      read: true,
      source: 'system_notification',
      leadSessionId: 'lead-session-1',
      messageId: 'member-restart:team-a:Worker:uuid-1',
      summary: 'Restarting Worker by user request',
    });
    expect(String(sentMessages[0]?.message.text)).toContain(
      'You are Worker, a Developer on team "Team A" (team-a).'
    );
    expect(String(sentMessages[0]?.message.text)).toContain('This is a teammate restart');
  });

  it('summarizes member updates when the lead session id is unavailable', () => {
    const sentMessages: Array<{ teamName: string; message: Record<string, unknown> }> = [];
    const persistRestartMessage = createPersistOpenCodeMemberRestartSystemMessageUseCase({
      persistSentMessage: (teamName, message) => {
        sentMessages.push({ teamName, message });
      },
      nowIso: () => '2026-07-06T16:05:00.000Z',
      randomUUID: () => 'uuid-2',
    });

    persistRestartMessage({
      teamName: 'team-a',
      leadName: 'team-lead',
      leadSessionId: null,
      displayName: 'Team A',
      member: { name: 'Worker' },
      reason: 'member_updated',
    });

    expect(sentMessages[0]?.message).toMatchObject({
      messageId: 'member-restart:team-a:Worker:uuid-2',
      summary: 'Restarting Worker after member settings update',
    });
    expect(sentMessages[0]?.message.leadSessionId).toBeUndefined();
  });
});
