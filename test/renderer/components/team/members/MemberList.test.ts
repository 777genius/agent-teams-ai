import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MemberSpawnStatusEntry, ResolvedTeamMember } from '@shared/types';

vi.mock('@renderer/components/team/members/MemberCard', () => ({
  MemberCard: ({
    member,
    spawnError,
  }: {
    member: ResolvedTeamMember;
    spawnError?: string;
  }) => React.createElement('div', { 'data-testid': `member-${member.name}` }, spawnError ?? ''),
}));

import { MemberList } from '@renderer/components/team/members/MemberList';

const member: ResolvedTeamMember = {
  name: 'bob',
  status: 'unknown',
  taskCount: 0,
  currentTaskId: null,
  lastActiveAt: null,
  messageCount: 0,
  color: 'blue',
  agentType: 'developer',
  role: 'Developer',
  providerId: 'opencode',
  model: 'opencode/minimax-m2.5-free',
  removedAt: undefined,
};

function failedSpawnStatus(reason: string): MemberSpawnStatusEntry {
  return {
    status: 'error',
    launchState: 'failed_to_start',
    updatedAt: '2026-04-23T10:00:00.000Z',
    runtimeAlive: false,
    bootstrapConfirmed: false,
    hardFailure: true,
    hardFailureReason: reason,
    agentToolAccepted: false,
  };
}

describe('MemberList spawn-status memoization', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class ResizeObserver {
        observe(): void {}
        disconnect(): void {}
      }
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('rerenders cards when only the hard failure reason changes', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const members = [member];

    await act(async () => {
      root.render(
        React.createElement(MemberList, {
          members,
          isTeamAlive: true,
          memberSpawnStatuses: new Map([['bob', failedSpawnStatus('initial OpenCode failure')]]),
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('initial OpenCode failure');

    await act(async () => {
      root.render(
        React.createElement(MemberList, {
          members,
          isTeamAlive: true,
          memberSpawnStatuses: new Map([['bob', failedSpawnStatus('updated OpenCode failure')]]),
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('updated OpenCode failure');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});
