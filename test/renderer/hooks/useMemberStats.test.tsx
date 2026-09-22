import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { useMemberStats } from '@renderer/hooks/useMemberStats';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MemberFullStats } from '@shared/types';

const mocks = vi.hoisted(() => ({
  readMemberStats: vi.fn(),
}));

vi.mock('@renderer/composition/team/createTeamOperationalReadTransport', () => ({
  createTeamOperationalReadTransport: () => ({
    readLeadLogs: vi.fn(),
    readMemberStats: mocks.readMemberStats,
  }),
}));

function deferred<T>(): {
  promise: Promise<T>;
  reject: (error: unknown) => void;
  resolve: (value: T) => void;
} {
  let reject!: (error: unknown) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    reject = promiseReject;
    resolve = promiseResolve;
  });
  return { promise, reject, resolve };
}

function stats(filePath: string): MemberFullStats {
  return {
    linesAdded: 1,
    linesRemoved: 0,
    filesTouched: [filePath],
    fileStats: { [filePath]: { added: 1, removed: 0 } },
    toolUsage: { Read: 1 },
    inputTokens: 2,
    outputTokens: 1,
    cacheReadTokens: 0,
    costUsd: 0,
    tasksCompleted: 0,
    messageCount: 1,
    totalDurationMs: 100,
    sessionCount: 1,
    computedAt: '2026-07-31T12:00:00.000Z',
  };
}

type HookState = ReturnType<typeof useMemberStats>;

describe('useMemberStats', () => {
  let host: HTMLDivElement;
  let root: Root;
  let latest: HookState | null;

  function Harness({
    memberName,
    teamName,
  }: Readonly<{
    memberName: string | null;
    teamName: string;
  }>): React.JSX.Element | null {
    latest = useMemberStats(teamName, memberName);
    return null;
  }

  async function render(teamName: string, memberName: string | null): Promise<void> {
    await act(async () => {
      root.render(<Harness teamName={teamName} memberName={memberName} />);
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  function state(): HookState {
    if (!latest) {
      throw new Error('Hook state was not captured');
    }
    return latest;
  }

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mocks.readMemberStats.mockReset();
    latest = null;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    host.remove();
    vi.unstubAllGlobals();
  });

  it('keeps an empty member selection idle and preserves loading and success state', async () => {
    await render('sandbox-team', null);

    expect(mocks.readMemberStats).not.toHaveBeenCalled();
    expect(state()).toEqual({ stats: null, loading: false, error: null });

    const pending = deferred<MemberFullStats>();
    mocks.readMemberStats.mockReturnValueOnce(pending.promise);
    await render('sandbox-team', 'alice');

    expect(mocks.readMemberStats).toHaveBeenCalledWith('sandbox-team', 'alice');
    expect(state()).toEqual({ stats: null, loading: true, error: null });

    const result = stats('/sandbox/alice.ts');
    await act(async () => {
      pending.resolve(result);
      await pending.promise;
      await Promise.resolve();
    });

    expect(state()).toEqual({ stats: result, loading: false, error: null });
  });

  it('preserves transport failures in the hook error state', async () => {
    mocks.readMemberStats.mockRejectedValueOnce(new Error('stats unavailable'));

    await render('sandbox-team', 'alice');

    expect(state()).toEqual({
      stats: null,
      loading: false,
      error: 'stats unavailable',
    });
  });

  it('keeps the latest member result when an earlier request resolves last', async () => {
    const staleRequest = deferred<MemberFullStats>();
    mocks.readMemberStats
      .mockReturnValueOnce(staleRequest.promise)
      .mockResolvedValueOnce(stats('/sandbox/bob.ts'));

    await render('sandbox-team', 'alice');
    expect(state().loading).toBe(true);

    await render('sandbox-team', 'bob');
    expect(state()).toEqual({
      stats: stats('/sandbox/bob.ts'),
      loading: false,
      error: null,
    });

    await act(async () => {
      staleRequest.resolve(stats('/sandbox/alice.ts'));
      await staleRequest.promise;
      await Promise.resolve();
    });

    expect(state()).toEqual({
      stats: stats('/sandbox/bob.ts'),
      loading: false,
      error: null,
    });
  });
});
