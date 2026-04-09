import { describe, expect, it } from 'vitest';

import {
  shouldWarnOnMissingRegisteredMember,
  shouldWarnOnUnreadableMemberAuditConfig,
} from '@main/services/team/TeamProvisioningService';

describe('TeamProvisioningService audit warning policy', () => {
  it('suppresses unreadable config warnings during the short post-accept grace window', () => {
    const nowMs = Date.parse('2026-04-09T12:01:00.000Z');
    const memberSpawnStatuses = new Map([
      [
        'alice',
        {
          agentToolAccepted: true,
          firstSpawnAcceptedAt: '2026-04-09T12:00:30.000Z',
        },
      ],
    ]);

    expect(
      shouldWarnOnUnreadableMemberAuditConfig({
        nowMs,
        lastWarnAt: 0,
        expectedMembers: ['alice'],
        memberSpawnStatuses,
      })
    ).toBe(false);
  });

  it('warns on unreadable config only after a teammate has exceeded the launch grace window', () => {
    const nowMs = Date.parse('2026-04-09T12:02:00.000Z');
    const memberSpawnStatuses = new Map([
      [
        'alice',
        {
          agentToolAccepted: true,
          firstSpawnAcceptedAt: '2026-04-09T12:00:00.000Z',
        },
      ],
    ]);

    expect(
      shouldWarnOnUnreadableMemberAuditConfig({
        nowMs,
        lastWarnAt: 0,
        expectedMembers: ['alice'],
        memberSpawnStatuses,
      })
    ).toBe(true);
  });

  it('only warns about missing registered members after grace expiry', () => {
    const nowMs = Date.parse('2026-04-09T12:02:00.000Z');

    expect(
      shouldWarnOnMissingRegisteredMember({
        nowMs,
        lastWarnAt: 0,
        graceExpired: false,
      })
    ).toBe(false);

    expect(
      shouldWarnOnMissingRegisteredMember({
        nowMs,
        lastWarnAt: 0,
        graceExpired: true,
      })
    ).toBe(true);
  });
});
