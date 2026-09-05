import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  noteOpenCodeLaneTurnActivity,
  OpenCodeLaneTurnActivityRegistry,
  openCodeLaneTurnActivityRegistry,
} from '../OpenCodeLaneTurnActivityRegistry';

describe('OpenCodeLaneTurnActivityRegistry', () => {
  it('keeps the latest turn state per team member, case-insensitively', () => {
    const registry = new OpenCodeLaneTurnActivityRegistry();
    registry.note({
      teamName: 'Team',
      memberName: 'Worker',
      laneId: 'secondary:opencode:Worker',
      state: 'active',
      observedAt: '2026-08-23T01:30:00.000Z',
    });
    expect(registry.getIdleSince('team', 'worker')).toBeNull();
    expect(registry.listTeam('team').get('worker')).toMatchObject({ state: 'active' });

    registry.note({
      teamName: 'team',
      memberName: 'worker',
      laneId: 'secondary:opencode:Worker',
      state: 'idle',
      observedAt: '2026-08-23T01:33:46.000Z',
    });
    expect(registry.getIdleSince('Team', 'Worker')).toBe('2026-08-23T01:33:46.000Z');

    registry.note({
      teamName: 'team',
      memberName: 'team-lead',
      laneId: 'primary',
      state: 'idle',
    });
    expect([...registry.listTeam('team').keys()].sort((a, b) => a.localeCompare(b))).toEqual([
      'team-lead',
      'worker',
    ]);
    expect(registry.listTeam('other').size).toBe(0);
  });

  it('separates members whose names would otherwise concatenate into the same key', () => {
    const registry = new OpenCodeLaneTurnActivityRegistry();
    registry.note({
      teamName: 'ab',
      memberName: 'c',
      laneId: 'lane-1',
      state: 'active',
      observedAt: '2026-08-23T01:30:00.000Z',
    });
    registry.note({
      teamName: 'a',
      memberName: 'bc',
      laneId: 'lane-2',
      state: 'idle',
      observedAt: '2026-08-23T01:31:00.000Z',
    });

    expect(registry.get('ab', 'c')).toMatchObject({ laneId: 'lane-1', state: 'active' });
    expect(registry.get('a', 'bc')).toMatchObject({ laneId: 'lane-2', state: 'idle' });
    expect(registry.listTeam('a').size).toBe(1);
  });
});

describe('noteOpenCodeLaneTurnActivity', () => {
  beforeEach(() => {
    openCodeLaneTurnActivityRegistry.clear();
  });

  it('records a secondary lane without ever emitting lead activity for it', () => {
    const notifyLeadTurnActivity = vi.fn();
    const logger = { warn: vi.fn() };

    noteOpenCodeLaneTurnActivity(
      {
        teamName: 'team',
        memberName: 'worker',
        laneId: 'secondary:opencode:worker',
        isLeadRecipient: false,
        state: 'idle',
        observedAt: '2026-08-23T01:33:46.000Z',
      },
      { notifyLeadTurnActivity, logger }
    );

    // Recorded: this is the only place a secondary lane's turn end is observable.
    expect(openCodeLaneTurnActivityRegistry.get('team', 'worker')).toMatchObject({
      laneId: 'secondary:opencode:worker',
      state: 'idle',
      observedAt: '2026-08-23T01:33:46.000Z',
    });
    // Not mirrored: a secondary lane has no lead card, so nothing is emitted.
    expect(notifyLeadTurnActivity).not.toHaveBeenCalled();

    noteOpenCodeLaneTurnActivity(
      {
        teamName: 'team',
        memberName: 'team-lead',
        laneId: 'primary',
        isLeadRecipient: true,
        state: 'active',
        observedAt: '2026-08-23T01:34:00.000Z',
      },
      { notifyLeadTurnActivity, logger }
    );

    expect(notifyLeadTurnActivity.mock.calls).toEqual([
      [
        {
          teamName: 'team',
          memberName: 'team-lead',
          laneId: 'primary',
          state: 'active',
        },
      ],
    ]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('keeps the recorded sample when the lead notifier throws', () => {
    const logger = { warn: vi.fn() };

    expect(() =>
      noteOpenCodeLaneTurnActivity(
        {
          teamName: 'team',
          memberName: 'team-lead',
          laneId: 'primary',
          isLeadRecipient: true,
          state: 'idle',
          observedAt: '2026-08-23T01:35:00.000Z',
        },
        {
          notifyLeadTurnActivity: () => {
            throw new Error('lead run went away');
          },
          logger,
        }
      )
    ).not.toThrow();

    expect(openCodeLaneTurnActivityRegistry.getIdleSince('team', 'team-lead')).toBe(
      '2026-08-23T01:35:00.000Z'
    );
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]?.[0]).toContain('lead run went away');
  });

  it('records a primary lane even when no lead notifier is wired', () => {
    const logger = { warn: vi.fn() };

    noteOpenCodeLaneTurnActivity(
      {
        teamName: 'team',
        memberName: 'team-lead',
        laneId: 'primary',
        isLeadRecipient: true,
        state: 'active',
        observedAt: '2026-08-23T01:36:00.000Z',
      },
      { logger }
    );

    expect(openCodeLaneTurnActivityRegistry.get('team', 'team-lead')).toMatchObject({
      state: 'active',
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('records a primary lane for a teammate the caller did not identify as the lead', () => {
    const notifyLeadTurnActivity = vi.fn();
    const logger = { warn: vi.fn() };

    noteOpenCodeLaneTurnActivity(
      {
        teamName: 'team',
        memberName: 'builder',
        laneId: 'primary',
        // Same-model teammates share the primary lane; only the lead card is mirrored.
        isLeadRecipient: false,
        state: 'active',
        observedAt: '2026-08-23T01:37:00.000Z',
      },
      { notifyLeadTurnActivity, logger }
    );

    expect(openCodeLaneTurnActivityRegistry.get('team', 'builder')).toMatchObject({
      laneId: 'primary',
      state: 'active',
    });
    expect(notifyLeadTurnActivity).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
