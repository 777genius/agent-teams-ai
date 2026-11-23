import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getAttentionStoreState,
  setAttentionContext,
  subscribeAttention,
} from '../../../../src/features/user-attention/renderer/hooks/attentionSnapshotStore';

import type { AttentionSnapshot, AttentionTeamSnapshot } from '../../../../src/features/user-attention/contracts';
import type { TeamChangeEvent } from '../../../../src/shared/types/team';

const fake = vi.hoisted(() => ({
  fetch: vi.fn<(teamName?: string) => Promise<AttentionSnapshot>>(),
  changeListener: null as ((event: unknown, data: TeamChangeEvent) => void) | null,
}));

vi.mock('@renderer/api', () => ({
  api: {
    getUserAttentionSnapshot: (teamName?: string) => fake.fetch(teamName),
    teams: {
      onTeamChange: (callback: (event: unknown, data: TeamChangeEvent) => void) => {
        fake.changeListener = callback;
        return () => { fake.changeListener = null; };
      },
    },
  },
}));

vi.mock('@renderer/utils/teamMessageReadStorage', () => ({
  subscribeTeamMessageReadStore: () => () => {},
}));

function team(name: string): AttentionTeamSnapshot {
  return { teamName: name, teamDisplayName: name, tasks: [], messages: [] };
}

function snapshot(contextId: string, names: string[]): AttentionSnapshot {
  return { contextId, complete: true, teams: names.map(team) };
}

describe('Attention snapshot live update scheduling', () => {
  let unsubscribe: (() => void) | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    fake.fetch.mockReset();
    fake.changeListener = null;
  });

  afterEach(() => {
    unsubscribe?.();
    unsubscribe = null;
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('replays a pending team change without accidentally fetching the entire workspace', async () => {
    const context = 'attention-live-queue-fixture';
    const initial = snapshot(context, ['alpha', 'beta']);
    fake.fetch.mockResolvedValue(initial);
    setAttentionContext(context, 1);
    unsubscribe = subscribeAttention(() => {});
    await vi.advanceTimersByTimeAsync(250);
    expect(fake.fetch).toHaveBeenCalledTimes(1);
    expect(fake.fetch).toHaveBeenCalledWith(undefined);

    let releaseAlpha!: (value: AttentionSnapshot) => void;
    fake.fetch.mockImplementation((name?: string) => name === 'alpha'
      ? new Promise<AttentionSnapshot>((resolve) => { releaseAlpha = resolve; })
      : Promise.resolve(snapshot(context, [name ?? 'unexpected-full'])));

    fake.changeListener?.(null, { type: 'task', teamName: 'alpha' } as TeamChangeEvent);
    await vi.advanceTimersByTimeAsync(250);
    expect(fake.fetch).toHaveBeenCalledWith('alpha');

    // Beta updates while Alpha's source read is pending.
    fake.changeListener?.(null, { type: 'inbox', teamName: 'beta' } as TeamChangeEvent);
    releaseAlpha(snapshot(context, ['alpha']));
    await vi.advanceTimersByTimeAsync(250);
    expect(fake.fetch.mock.calls.map(([name]) => name)).toEqual([
      undefined, 'alpha', 'beta',
    ]);
    expect(getAttentionStoreState().snapshot?.teams.map((row) => row.teamName).sort())
      .toEqual(['alpha', 'beta']);
  });

  it('discards old-workspace responses even when they resolve after a root switch', async () => {
    const first = 'attention-first-root';
    const second = 'attention-second-root';
    let releaseFirst!: (value: AttentionSnapshot) => void;
    fake.fetch.mockImplementation(() => new Promise<AttentionSnapshot>((resolve) => {
      releaseFirst = resolve;
    }));

    setAttentionContext(first, 2);
    unsubscribe = subscribeAttention(() => {});
    await vi.advanceTimersByTimeAsync(250);
    expect(fake.fetch).toHaveBeenCalledTimes(1);

    setAttentionContext(second, 3);
    fake.fetch.mockImplementation(async () => snapshot(second, ['safe-team']));
    releaseFirst(snapshot(first, ['private-team']));
    await vi.advanceTimersByTimeAsync(250);

    expect(getAttentionStoreState().snapshot?.teams.map((row) => row.teamName))
      .toEqual(['safe-team']);
    expect(getAttentionStoreState().contextId).toBe(second);
  });
});
