import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { TeamScheduleSection } from '@renderer/components/team/definitionEdit/TeamScheduleSection';
import { ScheduleSection } from '@renderer/components/team/schedule/ScheduleSection';
import {
  scheduleCwd,
  scheduleScope,
  validateScheduleForm,
} from '@renderer/components/team/schedule/validateScheduleForm';
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
vi.mock('@renderer/components/team/CollapsibleTeamSection', () => ({
  CollapsibleTeamSection: ({ children }: { children?: React.ReactNode }) => <section>{children}</section>,
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

  describe('scheduleScope', () => {
    const perProject = { projectContextMode: 'per_project' as const, projectPath: '/created-in' };

    it('follows the team mode, whatever page the dialog was opened from', () => {
      // The global Schedules page passes no scope at all.
      expect(scheduleScope({ mode: 'schedule' }, perProject)).toEqual({
        projectScope: { projectPath: '/created-in' },
        defaultProjectPath: '/created-in',
      });
    });

    it('prefers the project of the screen the dialog was opened from', () => {
      expect(
        scheduleScope({ mode: 'schedule', projectScope: { projectPath: '/shown' } }, perProject)
      ).toEqual({ projectScope: { projectPath: '/shown' }, defaultProjectPath: '/shown' });
    });

    it('is decided by the screen alone when the team list does not know the team yet', () => {
      // Unloaded store, or metadata the list could not read: no mode, but the screen says so.
      const scope = { mode: 'schedule', projectScope: { projectPath: '/shown' } };
      expect(scheduleScope(scope, undefined).projectScope).toEqual({ projectPath: '/shown' });
      expect(scheduleScope(scope, { projectPath: '/p' }).projectScope).toEqual({
        projectPath: '/shown',
      });
    });

    it('leaves ordinary teams and launches alone', () => {
      expect(scheduleScope({ mode: 'schedule' }, { projectPath: '/p' }).projectScope).toBeUndefined();
      expect(scheduleScope({ mode: 'schedule' }, undefined).projectScope).toBeUndefined();
      expect(scheduleScope({ mode: 'launch', defaultProjectPath: '/p' }, perProject)).toEqual({
        projectScope: undefined,
        defaultProjectPath: '/p',
      });
    });
  });

  it('a schedule of a per-project team can not be saved without a project folder', () => {
    const base = {
      isSchedule: true, mode: 'agent' as const, targetMember: '', teamName: 'builders',
      prompt: 'go', cronExpression: '0 9 * * 1-5', timezone: 'UTC', selectedProjectPathDeleted: false,
      isCustomCwd: false, customFolderBlocksSubmit: false, worktreeGitBlockingMessage: null,
      rosterUnavailable: 'roster', recipientUnavailable: 'recipient',
    };
    // A scoped team is validated like a one-shot schedule: the folder is its own, not the saved one.
    expect(validateScheduleForm({ ...base, usesSavedTeamRuntime: false, cwd: '' })).toContain(
      'Working directory is required'
    );
    expect(validateScheduleForm({ ...base, usesSavedTeamRuntime: false, cwd: '/work/a' })).toEqual([]);
  });

  describe('scheduleCwd: the folder a saved schedule is made for', () => {
    const created = { cwd: '/created-in', projectContextMode: 'per_project' };
    const existing = { launchConfig: { cwd: '/project-b' } };
    const scope = { projectPath: '/chosen' };

    it('uses the folder picked in the dialog for a one-shot schedule (no saved team)', () => {
      expect(scheduleCwd(null, null, '/picked')).toBe('/picked');
    });

    it('keeps the saved folder of an ordinary team', () => {
      expect(scheduleCwd({ cwd: '/team' }, null, '/picked')).toBe('/team');
      expect(scheduleCwd({ cwd: '/team', projectContextMode: 'shared' }, existing, '/x')).toBe('/team');
    });

    it('a per-project team keeps the project of its schedule, never the folder it was created in', () => {
      // Known from the saved team although the dialog could not tell at render time.
      expect(scheduleCwd(created, existing, '/picked')).toBe('/project-b');
      expect(scheduleCwd(created, existing, '/picked', scope)).toBe('/project-b');
    });

    it('a new schedule of a per-project team takes the project chosen in the dialog', () => {
      expect(scheduleCwd(created, null, '/chosen', scope)).toBe('/chosen');
    });

    it('fails closed for a new schedule when the dialog did not know the team keeps history per project', () => {
      expect(() => scheduleCwd(created, null, '/first-in-list')).toThrow(/separate history per project/);
    });
  });
});
