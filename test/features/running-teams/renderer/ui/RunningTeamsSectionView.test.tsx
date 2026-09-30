import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { RunningTeamsSectionView } from '@features/running-teams/renderer/hosted';
import { TooltipProvider } from '@renderer/components/ui/tooltip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  RunningTeamsSectionReadState,
  RunningTeamViewRow,
} from '@features/running-teams/renderer/hosted';

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));

const knownRow: RunningTeamViewRow = {
  targetKey: 'desktop:alpha',
  displayName: 'Alpha',
  projectLabel: 'project',
  detail: '/workspace/project',
  status: 'idle',
  statusLabel: 'Running',
  iconColor: '#f00',
  taskCounts: { pending: 1, inProgress: 2, completed: 0 },
};

const unknownRow: RunningTeamViewRow = {
  targetKey: 'hosted:beta',
  displayName: 'Beta',
  status: 'running_unknown',
  statusLabel: 'Running',
};

describe('RunningTeamsSectionView', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it('opens the opaque target and never presents unknown runtime facts as a pulse or task count', () => {
    const onOpen = vi.fn();
    act(() => {
      root.render(
        <TooltipProvider>
          <RunningTeamsSectionView
            title="Running teams"
            rows={[knownRow, unknownRow]}
            onOpen={onOpen}
          />
        </TooltipProvider>
      );
    });

    const rows = host.querySelectorAll<HTMLButtonElement>('.grid > button, .grid button');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.getAttribute('aria-label')).toBe('Alpha - /workspace/project');
    expect(rows[0]?.querySelector('.animate-ping')).not.toBeNull();
    expect(rows[1]?.getAttribute('aria-label')).toBe('Beta');
    expect(rows[1]?.querySelector('.animate-ping')).toBeNull();
    expect(rows[1]?.textContent).toContain('Running');
    expect(rows[1]?.textContent).not.toContain('tasks.statusSummary');

    act(() => rows[1]?.click());
    expect(onOpen).toHaveBeenCalledExactlyOnceWith('hosted:beta');
  });

  it.each([
    [{ phase: 'loading', message: 'Loading teams' }, 'Loading teams'],
    [{ phase: 'error', message: 'Could not load teams' }, 'Could not load teams'],
    [{ phase: 'ready', stale: true, message: 'Outdated teams' }, 'Outdated teams'],
    [{ phase: 'ready', incomplete: true, message: 'Some teams are unknown' }, 'Some teams are unknown'],
  ] as const)('does not show success-empty for %s', (readState, message) => {
    act(() => {
      root.render(
        <RunningTeamsSectionView
          title="Running teams"
          rows={[]}
          onOpen={vi.fn()}
          readState={readState as RunningTeamsSectionReadState}
          emptyMessage="No running teams"
        />
      );
    });

    expect(host.textContent).toContain(message);
    expect(host.textContent).not.toContain('No running teams');
  });

  it('shows complete empty and offers an explicit retry for a failed read', () => {
    const onRetry = vi.fn();
    act(() => {
      root.render(
        <RunningTeamsSectionView
          title="Running teams"
          rows={[]}
          onOpen={vi.fn()}
          emptyMessage="No running teams"
          readState={{ phase: 'ready' }}
        />
      );
    });
    expect(host.textContent).toContain('No running teams');

    act(() => {
      root.render(
        <RunningTeamsSectionView
          title="Running teams"
          rows={[]}
          onOpen={vi.fn()}
          readState={{
            phase: 'error',
            message: 'Could not load teams',
            retryLabel: 'Retry',
            onRetry,
          }}
        />
      );
    });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Could not load teams');
    act(() => host.querySelector<HTMLButtonElement>('[role="alert"] button')?.click());
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
