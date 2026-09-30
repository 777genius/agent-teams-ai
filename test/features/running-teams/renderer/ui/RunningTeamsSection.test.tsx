import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { RunningTeamsSection } from '@features/running-teams/renderer';
import { TooltipProvider } from '@renderer/components/ui/tooltip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hookState = vi.hoisted(() => ({
  rows: [{
    id: 'team-alpha',
    teamName: 'team-alpha',
    displayName: 'Alpha',
    projectPath: '/workspace/project',
    projectLabel: 'project',
    status: 'idle' as const,
    statusLabel: 'Running',
    iconColor: '#f00',
  }],
  hidden: false,
  readStatus: { phase: 'ready' as const, stale: false },
  retryAliveRead: vi.fn(),
  openRunningTeam: vi.fn(),
}));

vi.mock('@features/running-teams/renderer/hooks/useRunningTeamsSection', () => ({
  useRunningTeamsSection: () => hookState,
}));

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));

describe('RunningTeamsSection Desktop wrapper', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    hookState.openRunningTeam.mockClear();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('preserves opening the original Desktop row with its project path', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    act(() => {
      root.render(
        <TooltipProvider>
          <RunningTeamsSection searchQuery="" />
        </TooltipProvider>
      );
    });

    const row = host.querySelector<HTMLButtonElement>('.grid button');
    expect(row?.getAttribute('aria-label')).toBe('Alpha - /workspace/project');
    act(() => row?.click());
    expect(hookState.openRunningTeam).toHaveBeenCalledExactlyOnceWith(hookState.rows[0]);

    act(() => root.unmount());
  });
});
