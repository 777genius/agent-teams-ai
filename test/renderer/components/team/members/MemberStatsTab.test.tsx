import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { MemberStatsTab } from '@renderer/components/team/members/MemberStatsTab';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MemberFullStats } from '@shared/types';

const mocks = vi.hoisted(() => ({
  readMemberStats: vi.fn(),
}));

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

vi.mock('@renderer/api', () => ({
  api: {
    tokenUsage: {
      getSnapshot: vi.fn().mockResolvedValue(null),
      refreshSnapshot: vi.fn().mockResolvedValue(null),
      onSnapshotChanged: vi.fn(() => () => {}),
    },
    openExternal: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@renderer/composition/team/createTeamOperationalReadTransport', () => ({
  createTeamOperationalReadTransport: () => ({
    readLeadLogs: vi.fn(),
    readMemberStats: mocks.readMemberStats,
  }),
}));

function createStats(overrides: Partial<MemberFullStats> = {}): MemberFullStats {
  return {
    linesAdded: 0,
    linesRemoved: 0,
    filesTouched: [],
    fileStats: {},
    toolUsage: {},
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    costUsd: 0,
    tasksCompleted: 0,
    messageCount: 0,
    totalDurationMs: 0,
    sessionCount: 1,
    computedAt: '2026-05-09T12:00:00.000Z',
    ...overrides,
  };
}

describe('MemberStatsTab', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('does not render null-device paths as touched files', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(MemberStatsTab, {
          teamName: 'northstar-core',
          memberName: 'alice',
          prefetchedStats: createStats({
            filesTouched: ['/dev/null', '/repo/src/app.ts'],
            fileStats: {
              '/dev/null': { added: 4, removed: 0 },
              '/repo/src/app.ts': { added: 2, removed: 1 },
            },
          }),
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Files Touched (1)');
    expect(host.textContent).toContain('app.ts');
    expect(host.querySelector('[title="/dev/null"]')).toBeNull();
    expect(host.textContent).not.toContain('null');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('loads member stats through the operational read port', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mocks.readMemberStats.mockResolvedValueOnce(
      createStats({
        filesTouched: ['/repo/src/member.ts'],
        fileStats: { '/repo/src/member.ts': { added: 3, removed: 1 } },
      })
    );
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(MemberStatsTab, {
          teamName: 'northstar-core',
          memberName: 'alice',
        })
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.readMemberStats).toHaveBeenCalledWith('northstar-core', 'alice');
    expect(host.textContent).toContain('member.ts');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('preserves the operational read error state', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mocks.readMemberStats.mockRejectedValueOnce(new Error('stats unavailable'));
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(MemberStatsTab, {
          teamName: 'northstar-core',
          memberName: 'alice',
        })
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.textContent).toContain('stats unavailable');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('ignores a cancelled member stats request after the member changes', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const staleRequest = createDeferred<MemberFullStats>();
    mocks.readMemberStats.mockReturnValueOnce(staleRequest.promise).mockResolvedValueOnce(
      createStats({
        filesTouched: ['/repo/src/bob.ts'],
        fileStats: { '/repo/src/bob.ts': { added: 1, removed: 0 } },
      })
    );
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(MemberStatsTab, {
          teamName: 'northstar-core',
          memberName: 'alice',
        })
      );
      await Promise.resolve();
    });

    expect(host.querySelector('.animate-spin')).not.toBeNull();

    await act(async () => {
      root.render(
        React.createElement(MemberStatsTab, {
          teamName: 'northstar-core',
          memberName: 'bob',
        })
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.textContent).toContain('bob.ts');

    await act(async () => {
      staleRequest.resolve(
        createStats({
          filesTouched: ['/repo/src/alice.ts'],
          fileStats: { '/repo/src/alice.ts': { added: 1, removed: 0 } },
        })
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.textContent).toContain('bob.ts');
    expect(host.textContent).not.toContain('alice.ts');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});
