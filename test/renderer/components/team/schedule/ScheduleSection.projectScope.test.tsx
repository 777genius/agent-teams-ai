import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { TeamScheduleSection } from '@renderer/components/team/definitionEdit/TeamScheduleSection';
import { ScheduleSection } from '@renderer/components/team/schedule/ScheduleSection';
import { projectScopeOf } from '@renderer/components/team/schedule/validateScheduleForm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Schedule } from '@shared/types';

const mocks = vi.hoisted(() => ({ schedules: [] as Schedule[] }));

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key, resolvedLanguage: 'en' }),
}));
vi.mock('@renderer/store', () => ({
  useStore: (select: (state: unknown) => unknown) =>
    select({
      schedules: mocks.schedules,
      fetchSchedules: vi.fn(),
      scheduleRuns: {},
      scheduleRunsLoading: {},
      fetchRunHistory: vi.fn(),
    }),
}));
vi.mock('zustand/react/shallow', () => ({ useShallow: (selector: unknown) => selector }));
vi.mock('@renderer/utils/scheduleFormatters', () => ({
  formatNextRun: () => 'soon',
  getCronDescription: () => 'every hour',
}));
vi.mock('@renderer/components/team/schedule/useScheduleActions', () => ({
  useScheduleActions: () => ({ feedback: null, act: vi.fn() }),
}));
vi.mock('@renderer/components/team/schedule/ScheduleRunLogDialog', () => ({
  ScheduleRunLogDialog: () => null,
}));
vi.mock('@renderer/components/ui/tooltip', () => {
  const Slot = ({ children }: { children?: React.ReactNode }) => <>{children}</>;
  return { Tooltip: Slot, TooltipTrigger: Slot, TooltipContent: () => null };
});
vi.mock('@renderer/components/ui/popover', () => {
  const Slot = ({ children }: { children?: React.ReactNode }) => <>{children}</>;
  return { Popover: Slot, PopoverTrigger: Slot, PopoverContent: () => null };
});
vi.mock('@renderer/components/team/dialogs/LaunchTeamDialog', () => ({
  LaunchTeamDialog: (props: { teamName?: string; projectScope?: unknown }) => (
    <div data-testid="dialog" data-team={props.teamName} data-scope={JSON.stringify(props.projectScope ?? null)} />
  ),
}));
vi.mock('@renderer/components/team/dialogs/LaunchTeamDialogLoadingFallback', () => ({
  LaunchTeamDialogLoadingFallback: () => null,
}));

function schedule(id: string, teamName: string, cwd: string): Schedule {
  return {
    id,
    teamName,
    executionMode: 'agent',
    cronExpression: '0 * * * *',
    timezone: 'UTC',
    status: 'active',
    warmUpMinutes: 0,
    maxConsecutiveFailures: 3,
    consecutiveFailures: 0,
    maxTurns: 5,
    createdAt: '2026-11-20T00:00:00.000Z',
    updatedAt: '2026-11-20T00:00:00.000Z',
    launchConfig: { cwd, prompt: 'go' },
  };
}

describe('schedules of a team with separate history per project', () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mocks.schedules = [
      schedule('s1', 'builders', '/work/project-a'),
      schedule('s2', 'builders', '/work/project-b/'),
      schedule('s3', 'other-team', '/work/project-a'),
    ];
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it('lists one list under the team and names the project of every schedule', async () => {
    await act(async () => {
      root.render(<ScheduleSection teamName="builders" projectScope={{ projectPath: '/work/project-a' }} />);
    });
    expect(host.textContent).toContain('project-a');
    expect(host.textContent).toContain('project-b');
    expect(host.querySelectorAll('[title^="/work/"]')).toHaveLength(2);
    expect(host.textContent).not.toContain('other-team');
  });

  it('does not add a project line to the schedules of an ordinary team', async () => {
    await act(async () => {
      root.render(<ScheduleSection teamName="other-team" />);
    });
    expect(host.querySelectorAll('[title^="/work/"]')).toHaveLength(0);
  });

  it('hands the shown project to the schedule dialog as the default', async () => {
    await act(async () => {
      root.render(<ScheduleSection teamName="builders" projectScope={{ projectPath: '/work/project-a' }} />);
    });
    const add = [...host.querySelectorAll('button')].find(
      (button) => button.textContent?.includes('schedule.actions.addSchedule')
    );
    await act(async () => add?.click());
    await vi.waitFor(() => expect(host.querySelector('[data-testid="dialog"]')).not.toBeNull());
    const dialog = host.querySelector('[data-testid="dialog"]');
    expect(dialog?.getAttribute('data-team')).toBe('builders');
    expect(JSON.parse(dialog?.getAttribute('data-scope') ?? 'null')).toEqual({ projectPath: '/work/project-a' });
  });

  it('shows the schedules of the logical team, not of the project copy shown on screen', async () => {
    await act(async () => {
      root.render(
        <TeamScheduleSection teamName="ptc-token-a" logicalTeamName="builders" projectPath="/work/project-a" />
      );
    });
    expect(host.textContent).toContain('project-a');
    expect(host.textContent).not.toContain('other-team');
    expect(host.textContent).not.toContain('perProjectUnavailable');
  });

  it('keeps ordinary teams on their own name without a project scope', async () => {
    await act(async () => {
      root.render(<TeamScheduleSection teamName="other-team" />);
    });
    expect(host.querySelectorAll('[title^="/work/"]')).toHaveLength(0);
  });

  it('projectScopeOf only applies to the schedule mode of a scoped dialog', () => {
    expect(projectScopeOf({ mode: 'schedule', projectScope: { projectPath: '/p' } })).toEqual({ projectPath: '/p' });
    expect(projectScopeOf({ mode: 'schedule' })).toBeUndefined();
    expect(projectScopeOf({ mode: 'launch', projectScope: { projectPath: '/p' } })).toBeUndefined();
  });
});
