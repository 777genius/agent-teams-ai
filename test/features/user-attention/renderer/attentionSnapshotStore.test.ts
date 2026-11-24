import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getAttentionStoreState,
  setAttentionContext,
  subscribeAttention,
} from '../../../../src/features/user-attention/renderer/hooks/attentionSnapshotStore';

import { UserAttentionUnsupportedError, type AttentionSnapshot, type AttentionTeamSnapshot } from '../../../../src/features/user-attention/contracts';
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

  it('coalesces burst updates for the same team and reconciles on focus', async () => {
    const context = 'attention-burst-and-focus';
    fake.fetch.mockResolvedValue(snapshot(context, ['alpha']));
    setAttentionContext(context, 21);
    unsubscribe = subscribeAttention(() => {});
    await vi.advanceTimersByTimeAsync(250);
    expect(fake.fetch).toHaveBeenCalledTimes(1);

    fake.changeListener?.(null, { type: 'task', teamName: 'alpha' } as TeamChangeEvent);
    fake.changeListener?.(null, { type: 'inbox', teamName: 'alpha' } as TeamChangeEvent);
    fake.changeListener?.(null, { type: 'lead-message', teamName: 'alpha' } as TeamChangeEvent);
    await vi.advanceTimersByTimeAsync(250);
    expect(fake.fetch.mock.calls.map(([name]) => name)).toEqual([undefined, 'alpha']);

    // An idle team need not be actively watched: a focus catch-up scans all.
    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(250);
    expect(fake.fetch.mock.calls.map(([name]) => name)).toEqual([undefined, 'alpha', undefined]);
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

  it('retains a failed team refresh until that team or its logical parent is refreshed', async () => {
    const context = 'attention-partial-transport-error';
    const alias = { ...team('native-a'), logicalTeamName: 'alpha' };
    fake.fetch.mockResolvedValue({
      contextId: context, complete: true, teams: [team('alpha'), team('beta'), alias],
    });
    setAttentionContext(context, 8);
    unsubscribe = subscribeAttention(() => {});
    await vi.advanceTimersByTimeAsync(250);

    fake.fetch.mockImplementation(async (name) => {
      if (name === 'native-a') throw new Error('Temporary HTTP failure');
      return snapshot(context, ['beta']);
    });
    fake.changeListener?.(null, { type: 'inbox', teamName: 'native-a' } as TeamChangeEvent);
    fake.changeListener?.(null, { type: 'task', teamName: 'beta' } as TeamChangeEvent);
    await vi.advanceTimersByTimeAsync(250);
    expect(getAttentionStoreState().snapshot?.complete).toBe(false);
    expect(getAttentionStoreState().error).toBeTruthy();
    expect(getAttentionStoreState().snapshot?.teams.map((row) => row.teamName).sort())
      .toEqual(['alpha', 'beta', 'native-a']);

    // A successful read of the logical parent removes an alias that no longer exists.
    fake.fetch.mockResolvedValue(snapshot(context, ['alpha']));
    fake.changeListener?.(null, { type: 'task', teamName: 'alpha' } as TeamChangeEvent);
    await vi.advanceTimersByTimeAsync(250);
    expect(getAttentionStoreState().snapshot?.complete).toBe(true);
    expect(getAttentionStoreState().error).toBeNull();
    expect(getAttentionStoreState().snapshot?.teams.map((row) => row.teamName).sort())
      .toEqual(['alpha', 'beta']);
  });

  it('does not certify a failed full workspace refresh with a targeted success', async () => {
    const context = 'attention-full-transport-error';
    fake.fetch.mockResolvedValue(snapshot(context, ['alpha', 'beta']));
    setAttentionContext(context, 9);
    unsubscribe = subscribeAttention(() => {});
    await vi.advanceTimersByTimeAsync(250);
    fake.fetch.mockRejectedValueOnce(new Error('Temporary HTTP failure'));
    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(250);
    expect(getAttentionStoreState().snapshot?.complete).toBe(false);

    fake.fetch.mockResolvedValueOnce(snapshot(context, ['beta']));
    fake.changeListener?.(null, { type: 'task', teamName: 'beta' } as TeamChangeEvent);
    await vi.advanceTimersByTimeAsync(250);
    expect(getAttentionStoreState().snapshot?.complete).toBe(false);
    expect(getAttentionStoreState().error).toBeTruthy();

    fake.fetch.mockResolvedValueOnce(snapshot(context, ['alpha', 'beta']));
    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(250);
    expect(getAttentionStoreState().snapshot?.complete).toBe(true);
    expect(getAttentionStoreState().error).toBeNull();
  });

  it('stops refreshing a server without the route, but not a transient failure', async () => {
    const context = 'attention-unsupported-http';
    fake.fetch.mockRejectedValueOnce(new UserAttentionUnsupportedError());
    setAttentionContext(context, 11);
    unsubscribe = subscribeAttention(() => {});
    await vi.advanceTimersByTimeAsync(250);
    expect(getAttentionStoreState()).toMatchObject({
      supported: false, loading: false, snapshot: null, error: null,
    });

    fake.changeListener?.(null, { type: 'config', teamName: 'alpha' } as TeamChangeEvent);
    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fake.fetch).toHaveBeenCalledTimes(1);

    fake.fetch.mockRejectedValueOnce(new Error('503 unavailable'));
    setAttentionContext('attention-reconnected-http', 12);
    await vi.advanceTimersByTimeAsync(250);
    expect(getAttentionStoreState()).toMatchObject({
      supported: true, error: 'Unable to load attention status',
    });
    fake.fetch.mockResolvedValue(snapshot('attention-reconnected-http', ['alpha']));
    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(250);
    expect(getAttentionStoreState()).toMatchObject({ supported: true, error: null });
    expect(getAttentionStoreState().snapshot?.teams.map((row) => row.teamName)).toEqual(['alpha']);
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
