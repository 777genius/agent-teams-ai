import { describe, expect, it, vi } from 'vitest';

import { notifyTeamChangeObserversSafely } from '../../../../src/main/services/team/TeamChangeFanout';

import type { TeamChangeEvent } from '@shared/types';

describe('TeamChangeFanout', () => {
  it('continues notifying observers when one observer throws', () => {
    const event: TeamChangeEvent = {
      type: 'task',
      teamName: 'team-a',
      detail: 'task-1.json',
    };
    const calls: string[] = [];
    const logger = { warn: vi.fn() };

    notifyTeamChangeObserversSafely(
      event,
      [
        {
          name: 'before',
          notify: () => calls.push('before'),
        },
        {
          name: 'broken',
          notify: () => {
            calls.push('broken');
            throw new Error('boom');
          },
        },
        {
          name: 'memberWorkSync',
          notify: () => calls.push('memberWorkSync'),
        },
      ],
      logger
    );

    expect(calls).toEqual(['before', 'broken', 'memberWorkSync']);
    expect(logger.warn).toHaveBeenCalledWith('team change observer failed', {
      observer: 'broken',
      teamName: 'team-a',
      type: 'task',
      detail: 'task-1.json',
      error: 'boom',
    });
  });

  it('continues notifying observers when failure logging throws', () => {
    const event: TeamChangeEvent = {
      type: 'task',
      teamName: 'team-a',
      detail: 'task-1.json',
    };
    const calls: string[] = [];

    notifyTeamChangeObserversSafely(
      event,
      [
        {
          name: 'broken',
          notify: () => {
            calls.push('broken');
            throw new Error('boom');
          },
        },
        {
          name: 'memberWorkSync',
          notify: () => calls.push('memberWorkSync'),
        },
      ],
      {
        warn: () => {
          throw new Error('logger failed');
        },
      }
    );

    expect(calls).toEqual(['broken', 'memberWorkSync']);
  });
});
