import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MEMBER_LAUNCH_GRACE_TIMEOUT_REASON } from '@shared/utils/teamLaunchFailureReason';

import type { MemberSpawnStatusEntry, ResolvedTeamMember } from '@shared/types';

vi.mock('@renderer/api', () => ({ api: { openExternal: vi.fn() } }));

vi.mock('@renderer/components/ui/badge', () => ({
  Badge: ({
    children,
    className,
    title,
  }: {
    children: React.ReactNode;
    className?: string;
    title?: string;
  }) => React.createElement('span', { className, title }, children),
}));

vi.mock('@renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  TooltipTrigger: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  TooltipContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', null, children),
}));

vi.mock('@renderer/hooks/useTheme', () => ({ useTheme: () => ({ isLight: false }) }));

vi.mock('@renderer/components/team/members/CurrentTaskIndicator', () => ({
  CurrentTaskIndicator: () => null,
}));

import { MemberCard } from '@renderer/components/team/members/MemberCard';

const MEMBER: ResolvedTeamMember = {
  name: 'jack',
  status: 'unknown',
  taskCount: 0,
  currentTaskId: null,
  lastActiveAt: null,
  messageCount: 0,
  color: 'purple',
  agentType: 'developer',
  role: 'Developer',
  providerId: 'anthropic',
  removedAt: undefined,
};

function failedSpawnEntry(hardFailureReason: string): MemberSpawnStatusEntry {
  return {
    status: 'error',
    launchState: 'failed_to_start',
    agentToolAccepted: true,
    runtimeAlive: false,
    bootstrapConfirmed: false,
    hardFailure: true,
    hardFailureReason,
    updatedAt: '2026-05-03T10:00:00.000Z',
  };
}

interface RenderedLaunchFailureReason {
  text: string;
  title: string | null;
}

async function renderLaunchFailureReason(
  spawnEntry: MemberSpawnStatusEntry
): Promise<RenderedLaunchFailureReason> {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);

  await act(async () => {
    root.render(
      React.createElement(MemberCard, {
        member: MEMBER,
        memberColor: 'purple',
        isTeamAlive: true,
        spawnStatus: spawnEntry.status,
        spawnLaunchState: spawnEntry.launchState,
        spawnEntry,
      })
    );
    await Promise.resolve();
  });

  const node = host.querySelector('[data-testid="member-launch-failure-reason"]');
  const rendered = {
    text: node?.textContent ?? '',
    title: node?.getAttribute('title') ?? null,
  };

  await act(async () => {
    root.unmount();
    await Promise.resolve();
  });
  host.remove();
  return rendered;
}

describe('MemberCard launch failure reason', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  // The card prints the failure reason straight onto the member row, so an
  // identifier the main process uses to compare verdicts would be shown to the
  // person reading the card - in the red line and in its hover title.
  it('reads out the launch grace timeout identifier', async () => {
    const rendered = await renderLaunchFailureReason(
      failedSpawnEntry(MEMBER_LAUNCH_GRACE_TIMEOUT_REASON)
    );

    expect(rendered.text).toBe('Teammate did not join within the launch grace window.');
    expect(rendered.title).toBe('Teammate did not join within the launch grace window.');
    expect(rendered.text).not.toContain(MEMBER_LAUNCH_GRACE_TIMEOUT_REASON);
  });

  // The control: a reason that is already prose reaches the card untouched, so
  // the mapping cannot degrade into "replace whatever we were given".
  it('shows an ordinary failure reason exactly as the main process wrote it', async () => {
    const rendered = await renderLaunchFailureReason(
      failedSpawnEntry('CLI process exited (code 1) - team provisioned but not alive')
    );

    expect(rendered.text).toBe('CLI process exited (code 1) - team provisioned but not alive');
    expect(rendered.title).toBe('CLI process exited (code 1) - team provisioned but not alive');
  });
});
