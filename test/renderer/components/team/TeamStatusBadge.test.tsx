import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TeamStatus } from '@renderer/utils/teamListStatus';
import type { LeadActivityState, TeamProvisioningProgress } from '@shared/types';

const storeState = {
  progress: null as TeamProvisioningProgress | null,
  leadActivityByTeam: {} as Record<string, LeadActivityState>,
  currentRuntimeRunIdByTeam: {} as Record<string, string>,
};

vi.mock('@renderer/store', () => ({
  useStore: (selector: (state: typeof storeState) => unknown) => selector(storeState),
}));
vi.mock('@renderer/store/slices/teamSlice', () => ({
  getCurrentProvisioningProgressForTeam: () => storeState.progress,
  isTeamProvisioningActive: () => storeState.progress?.state === 'finalizing',
}));

import { TeamStatusBadge } from '@renderer/components/team/TeamStatusBadge';

function renderBadge(status: TeamStatus = 'provisioning') {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const render = () => {
    act(() => root.render(<TeamStatusBadge teamName="sandbox-team" status={status} />));
  };
  render();
  return { host, render, root };
}

describe('shared header and team-card status badge', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.progress = {
      runId: 'current-run',
      teamName: 'sandbox-team',
      state: 'finalizing',
      startedAt: '2026-09-06T12:00:00Z',
      updatedAt: '2026-09-06T12:00:05Z',
      message: 'Auditing bootstrap truth',
    };
    storeState.leadActivityByTeam = { 'sandbox-team': 'active' };
    storeState.currentRuntimeRunIdByTeam = { 'sandbox-team': 'current-run' };
  });
  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('keeps observed work as finishing startup across progress updates, never ready/running', () => {
    const { host, render, root } = renderBadge();
    expect(host.textContent).toBe('Finishing startup');
    storeState.progress = { ...storeState.progress!, message: 'Checking teammate readiness' };
    render();
    expect(host.textContent).toBe('Finishing startup');
    expect(host.textContent).not.toMatch(/Running|Ready/);
    act(() => root.unmount());
  });

  it.each([
    'missing-activity',
    'idle',
    'offline',
    'missing-run',
    'stale-run',
    'ready',
    'failed',
    'cancelled',
  ])('does not use %s as observed current startup work', (reason) => {
    if (reason === 'missing-activity') storeState.leadActivityByTeam = {};
    if (reason === 'idle' || reason === 'offline')
      storeState.leadActivityByTeam['sandbox-team'] = reason;
    if (reason === 'missing-run') storeState.currentRuntimeRunIdByTeam = {};
    if (reason === 'stale-run') storeState.currentRuntimeRunIdByTeam['sandbox-team'] = 'older-run';
    if (reason === 'ready' || reason === 'failed' || reason === 'cancelled')
      storeState.progress!.state = reason;
    const { host, root } = renderBadge();
    expect(host.textContent).toBe('Launching...');
    act(() => root.unmount());
  });

  it.each([
    ['partial_failure', 'Launch failed partway'],
    ['partial_skipped', 'Launch skipped member'],
    ['partial_pending', 'Bootstrap pending'],
    ['offline', 'Offline'],
    ['idle', 'Running'],
    ['active', 'Active'],
  ] as const)('does not replace %s with finishing startup', (status, label) => {
    const { host, root } = renderBadge(status);
    expect(host.textContent).toBe(label);
    act(() => root.unmount());
  });
});
