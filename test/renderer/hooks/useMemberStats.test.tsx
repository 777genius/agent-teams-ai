import React, { act, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { api } from '@renderer/api';
import { useMemberStats } from '@renderer/hooks/useMemberStats';
import { expect, it, vi } from 'vitest';

import type { MemberStatsResult } from '@shared/types';

vi.mock('@renderer/api', () => ({ api: { teams: { getMemberStats: vi.fn() } } }));

const stats: MemberStatsResult = {
  kind: 'host_activity_stats',
  memberName: 'TEST-member',
  scope: 'retained_runtime_activity',
  generations: 1,
  observedMessages: 0,
  toolUsage: {},
  compactions: 0,
  inputTokens: 1,
  outputTokens: 0,
  costUsd: 0,
  gaps: [],
  computedAt: '2026-11-21T00:00:00.000Z',
};

function View({ name }: { name: string | null }) {
  const state = useMemberStats('TEST-team', name);
  return <output>{`${state.loading}|${state.error}|${state.stats?.inputTokens ?? ''}`}</output>;
}

it('ignores settled prior stats after StrictMode unmount and reopen', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const requests: ReturnType<typeof Promise.withResolvers<MemberStatsResult>>[] = [];
  vi.mocked(api.teams.getMemberStats).mockImplementation(() => {
    const request = Promise.withResolvers<MemberStatsResult>();
    requests.push(request);
    return request.promise;
  });
  const host = document.createElement('div');
  const root = createRoot(host);
  const render = (name: string | null) =>
    root.render(React.createElement(StrictMode, null, React.createElement(View, { name })));
  try {
    await act(async () => render(null));
    expect(requests).toHaveLength(0);
    await act(async () => root.render(null));
    await act(async () => render('TEST-member'));
    const old = requests.slice();
    expect(old.length).toBeGreaterThan(1);
    await act(async () => root.render(null));
    await act(async () => render('TEST-member'));
    const current = requests.slice(old.length);
    expect(current.length).toBeGreaterThan(1);
    await act(async () => {
      old[0].resolve(stats);
      old.slice(1).forEach((request) => request.reject(new Error('old stats failure')));
    });
    expect(host.textContent).toBe('true|null|');
    await act(async () => {
      current.slice(0, -1).forEach((request) => request.reject(new Error('replayed stats failure')));
    });
    expect(host.textContent).toBe('true|null|');
    await act(async () => current[current.length - 1].resolve({ ...stats, inputTokens: 2 }));
    expect(host.textContent).toBe('false|null|2');
  } finally {
    await act(async () => {
      root.unmount();
      requests.forEach((request) => request.resolve(stats));
      await Promise.allSettled(requests.map((request) => request.promise));
    });
    vi.resetAllMocks();
    vi.unstubAllGlobals();
  }
});
