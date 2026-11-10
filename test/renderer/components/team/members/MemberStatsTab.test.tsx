import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { MemberStatsTab } from '@renderer/components/team/members/MemberStatsTab';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MemberFullStats } from '@shared/types';

vi.mock('@renderer/api', () => ({
  api: {
    teams: {
      getMemberStats: vi.fn(),
    },
    tokenUsage: {
      getSnapshot: vi.fn().mockResolvedValue(null),
      refreshSnapshot: vi.fn().mockResolvedValue(null),
      onSnapshotChanged: vi.fn(() => () => {}),
    },
    openExternal: vi.fn().mockResolvedValue(undefined),
  },
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
});
