import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { state, getView, launchTeam, launchTeamIpc, openTeamTab, selectTeam } = vi.hoisted(() => {
  const state = {
    repositoryGroups: [],
    projects: [
      { id: 'project-a', path: '/TEST/a', name: 'A' },
      { id: 'project-b', path: '/TEST/b', name: 'B' },
    ],
    selectedRepositoryId: null,
    selectedWorktreeId: null,
    selectedProjectId: 'project-a',
    activeProjectId: 'project-a',
    selectedTeamName: null as string | null,
    teamByName: {
      builders: { displayName: 'Builders' },
    },
    provisioningRuns: {} as Record<string, { runId: string; teamName: string; state: string }>,
    currentProvisioningRunIdByTeam: {} as Record<string, string>,
    provisioningErrorByTeam: {} as Record<string, string | null>,
  };
  return {
    state,
    getView: vi.fn(),
    launchTeam: vi.fn(),
    launchTeamIpc: vi.fn(),
    openTeamTab: vi.fn(),
    selectTeam: vi.fn(async (_teamName: string) => undefined),
  };
});

vi.mock('@renderer/store', () => ({
  useStore: Object.assign((selector: (store: typeof state) => unknown) => selector(state), {
    getState: () => ({
      ...state,
      activeTabId: 'alias-tab',
      getAllPaneTabs: () => [{ id: 'alias-tab', type: 'team', teamName: 'ptc-a' }],
      openTeamTab,
      selectTeam,
      launchTeam,
    }),
  }),
}));
vi.mock('@renderer/api', () => ({
  api: {
    teams: {
      getProjectContextView: getView,
      launchTeam: launchTeamIpc,
      onProvisioningProgress: () => () => undefined,
    },
  },
}));
vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('./TeamProvisioningBanner', () => ({
  TeamProvisioningBanner: ({ teamName }: { teamName: string }) =>
    React.createElement(
      'div',
      { 'data-testid': 'provisioning-banner' },
      state.provisioningErrorByTeam[teamName] ?? 'Launching'
    ),
}));
vi.mock('./TeamDetailView', () => ({
  TeamDetailView: ({
    teamName,
    retainedHistory,
  }: {
    teamName: string;
    retainedHistory?: boolean;
  }) =>
    React.createElement(
      'div',
      {
        'data-testid': 'team-detail',
        'data-team': teamName,
        'data-retained': String(retainedHistory === true),
      },
      React.createElement('div', { 'data-section-id': 'kanban' })
    ),
}));
vi.mock('./definitionEdit/TeamDefinitionEditDialog', () => ({
  TeamDefinitionEditDialog: ({ logicalTeamName }: { logicalTeamName: string }) =>
    React.createElement('div', { 'data-testid': 'definition-edit', 'data-team': logicalTeamName }),
}));
vi.mock('./dialogs/LaunchTeamDialog', () => ({
  LaunchTeamDialog: ({
    onLaunch,
    teamName,
    defaultProjectPath,
    projectPermissionTeamName,
    rosterReadOnly,
  }: {
    onLaunch: (request: {
      teamName: string;
      cwd: string;
      providerId: 'anthropic';
    }) => Promise<void>;
    teamName: string;
    defaultProjectPath: string;
    projectPermissionTeamName?: string | null;
    rosterReadOnly?: boolean;
  }) =>
    React.createElement(
      'button',
      {
        'data-testid': 'launch-with-provider',
        'data-permission-policy': projectPermissionTeamName === null ? 'manual' : 'inherited',
        'data-roster-read-only': String(rosterReadOnly === true),
        onClick: () => {
          void onLaunch({
            teamName,
            cwd: defaultProjectPath,
            providerId: 'anthropic',
          });
        },
      },
      'Configure runtime and launch'
    ),
}));

import { getVisibleTeamNamesInAnyPane } from '@renderer/store/team/teamViewVisibility';

import { ProjectScopedTeamDetailView } from './ProjectScopedTeamDetailView';

function native(name: string, projectPath: string) {
  return {
    mode: 'per_project' as const,
    state: 'ready' as const,
    workContextId: 'context-' + name,
    executionTeamName: name,
    projectPath,
  };
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('ProjectScopedTeamDetailView project switching', () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    getView.mockReset();
    launchTeam.mockReset();
    launchTeamIpc.mockReset();
    openTeamTab.mockReset();
    selectTeam.mockReset();
    state.selectedTeamName = null;
    state.selectedProjectId = 'project-a';
    state.activeProjectId = 'project-a';
    state.provisioningRuns = {};
    state.currentProvisioningRunIdByTeam = {};
    state.provisioningErrorByTeam = {};
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.useRealTimers();
  });

  it.each([
    'host-team:TEST-owner',
    'host-team:TEST-owner:source-archive:legacy-archive%3A' + 'a'.repeat(64),
    'host-team:TEST-owner:source-gap:legacy-gap%3A' + 'b'.repeat(64),
  ])('mounts the captured Host detail without native project lookup (%s)', async (teamName) => {
    getView.mockRejectedValue(new Error('Native context must not own Host'));
    await act(async () => root.render(
      React.createElement(ProjectScopedTeamDetailView, { teamName })
    ));
    expect(host.querySelector('[data-testid="team-detail"]')?.getAttribute('data-team'))
      .toBe(teamName);
    expect(getView).not.toHaveBeenCalled();
    expect(openTeamTab).not.toHaveBeenCalled();
    expect(selectTeam).not.toHaveBeenCalled();
    expect(launchTeam).not.toHaveBeenCalled();
  });

  it('does not let a native lookup navigate after the pane switches to a Host owner', async () => {
    let finishLookup!: (context: unknown) => void;
    getView.mockReturnValue(new Promise((resolve) => { finishLookup = resolve; }));
    await act(async () => root.render(
      React.createElement(ProjectScopedTeamDetailView, { teamName: 'ptc-a' })
    ));
    const hostOwner = 'host-team:TEST-owner';
    await act(async () => root.render(
      React.createElement(ProjectScopedTeamDetailView, { teamName: hostOwner })
    ));
    await act(async () => finishLookup({
      mode: 'per_project', state: 'redirect',
      logicalTeamName: 'builders', projectPath: '/TEST/a',
    }));
    expect(host.querySelector('[data-testid="team-detail"]')?.getAttribute('data-team'))
      .toBe(hostOwner);
    expect(getView).toHaveBeenCalledExactlyOnceWith('ptc-a', '/TEST/a');
    expect(openTeamTab).not.toHaveBeenCalled();
    expect(selectTeam).not.toHaveBeenCalled();
  });

  it('keeps the mounted native project visible for live inbox/task refresh and unregisters it', async () => {
    const visible = () =>
      getVisibleTeamNamesInAnyPane({
        paneLayout: { panes: [] },
      } as never);
    getView.mockImplementation(async (_logical: string, project: string) =>
      project === '/TEST/a' ? native('ptc-a-visible', project) : native('ptc-b-visible', project)
    );
    await act(async () =>
      root.render(
        React.createElement(ProjectScopedTeamDetailView, { teamName: 'builders', isActive: true })
      )
    );
    await settle();
    expect(visible().has('ptc-a-visible')).toBe(true);

    state.selectedProjectId = 'project-b';
    await act(async () =>
      root.render(
        React.createElement(ProjectScopedTeamDetailView, { teamName: 'builders', isActive: true })
      )
    );
    await settle();
    expect(visible().has('ptc-a-visible')).toBe(false);
    expect(visible().has('ptc-b-visible')).toBe(true);

    await act(async () =>
      root.render(
        React.createElement(ProjectScopedTeamDetailView, { teamName: 'builders', isActive: false })
      )
    );
    expect(visible().has('ptc-b-visible')).toBe(false);
  });

  it('renders only the selected project native Tasks/Messages context (A→B→A)', async () => {
    getView.mockImplementation(async (_team: string, path: string) =>
      path === '/TEST/a' ? native('ptc-a', path) : native('ptc-b', path)
    );
    await act(async () =>
      root.render(React.createElement(ProjectScopedTeamDetailView, { teamName: 'builders' }))
    );
    await settle();
    expect(host.querySelector('[data-team]')?.getAttribute('data-team')).toBe('ptc-a');

    state.selectedProjectId = 'project-b';
    await act(async () =>
      root.render(React.createElement(ProjectScopedTeamDetailView, { teamName: 'builders' }))
    );
    await settle();
    expect(host.querySelector('[data-team]')?.getAttribute('data-team')).toBe('ptc-b');

    state.selectedProjectId = 'project-a';
    await act(async () =>
      root.render(React.createElement(ProjectScopedTeamDetailView, { teamName: 'builders' }))
    );
    await settle();
    expect(host.querySelector('[data-team]')?.getAttribute('data-team')).toBe('ptc-a');
    expect(getView).toHaveBeenCalledWith('builders', '/TEST/a');
    expect(getView).toHaveBeenCalledWith('builders', '/TEST/b');
  });

  it('restores physical selection on repeated logical tab activation and preserves section navigation', async () => {
    getView.mockResolvedValue(native('ptc-a', '/TEST/a'));
    await act(async () =>
      root.render(React.createElement(ProjectScopedTeamDetailView, { teamName: 'builders' }))
    );
    await settle();

    // The logical tab section menu must reach the physical TeamDetailView sections.
    expect(
      host.querySelector('[data-team-name="builders"] [data-section-id="kanban"]')
    ).not.toBeNull();
    expect(
      host.querySelector('[data-team-name="ptc-a"] [data-section-id="kanban"]')
    ).not.toBeNull();

    // Clicking an already-active tab reselects the logical name without remounting.
    state.selectedTeamName = 'builders';
    await act(async () =>
      root.render(React.createElement(ProjectScopedTeamDetailView, { teamName: 'builders' }))
    );
    await settle();
    expect(selectTeam).toHaveBeenCalledWith('ptc-a');
  });

  it('redirects physical runtime deep links to the verified logical team and project', async () => {
    getView.mockResolvedValue({
      mode: 'per_project',
      state: 'redirect',
      logicalTeamName: 'builders',
      projectPath: '/TEST/a',
    });
    await act(async () =>
      root.render(React.createElement(ProjectScopedTeamDetailView, { teamName: 'ptc-a' }))
    );
    await settle();
    expect(openTeamTab).toHaveBeenCalledWith('builders', '/TEST/a');
    expect(host.querySelector('[data-team]')).toBeNull();
  });

  it('defers alias navigation until its original pane becomes focused', async () => {
    getView.mockResolvedValue({
      mode: 'per_project',
      state: 'redirect',
      logicalTeamName: 'builders',
      projectPath: '/TEST/a',
    });
    await act(async () =>
      root.render(
        React.createElement(ProjectScopedTeamDetailView, {
          teamName: 'ptc-a',
          isActive: true,
          isPaneFocused: false,
        })
      )
    );
    await settle();
    expect(openTeamTab).not.toHaveBeenCalled();

    await act(async () =>
      root.render(
        React.createElement(ProjectScopedTeamDetailView, {
          teamName: 'ptc-a',
          isActive: true,
          isPaneFocused: true,
        })
      )
    );
    await settle();
    expect(openTeamTab).toHaveBeenCalledWith('builders', '/TEST/a');
  });

  it('preserves verified physical task history when its worktree disappeared from discovery', async () => {
    getView.mockResolvedValue({
      mode: 'per_project',
      state: 'redirect',
      logicalTeamName: 'builders',
      projectPath: '/removed/worktree',
    });
    await act(async () =>
      root.render(React.createElement(ProjectScopedTeamDetailView, { teamName: 'ptc-removed' }))
    );
    await settle();
    expect(host.querySelector('[data-team]')?.getAttribute('data-team')).toBe('ptc-removed');
    expect(host.querySelector('[data-team]')?.getAttribute('data-retained')).toBe('true');
    // One read-only line explains why it is shown; no raw path, no actions of its own.
    expect(host.textContent).toBe('projectContextView.projectMissing');
    expect(host.textContent).not.toContain('/removed/worktree');
    expect(host.querySelector('button')).toBeNull();
  });

  it('adds no chrome of its own around a ready team (no path bar, no mode control)', async () => {
    for (const view of [
      { mode: 'shared', state: 'ready', executionTeamName: 'builders' },
      native('ptc-a', '/TEST/a'),
    ]) {
      getView.mockResolvedValue(view);
      await act(async () =>
        root.render(React.createElement(ProjectScopedTeamDetailView, { teamName: 'builders' }))
      );
      await settle();
      expect(host.querySelector('[data-team]')).not.toBeNull();
      expect(host.textContent).toBe('');
      expect(host.querySelector('button, select, [role="combobox"]')).toBeNull();
      await act(async () => root.unmount());
      root = createRoot(host);
    }
  });

  it('keeps the pre-feature shared team name unchanged', async () => {
    getView.mockResolvedValue({
      mode: 'shared',
      state: 'ready',
      executionTeamName: 'builders',
    });
    await act(async () =>
      root.render(React.createElement(ProjectScopedTeamDetailView, { teamName: 'builders' }))
    );
    await settle();
    expect(host.querySelector('[data-team]')?.getAttribute('data-team')).toBe('builders');
  });

  it('surfaces Create Team and Team List launch failures without a local launch reference', async () => {
    getView.mockImplementation(async (_team: string, path: string) => ({
      mode: 'per_project',
      state: path === '/TEST/a' ? 'pending' : 'empty',
      reason: 'incomplete',
      projectPath: path,
      runId: 'failed-a',
    }));
    state.provisioningErrorByTeam.builders = 'Project runtime bootstrap failed';
    state.currentProvisioningRunIdByTeam.builders = 'failed-a';
    await act(async () =>
      root.render(React.createElement(ProjectScopedTeamDetailView, { teamName: 'builders' }))
    );
    await settle();
    expect(host.querySelector('[data-testid="provisioning-banner"]')?.textContent).toContain(
      'Project runtime bootstrap failed'
    );
    expect(host.textContent).toContain('Project runtime bootstrap failed');
    expect(launchTeam).not.toHaveBeenCalled();

    state.selectedProjectId = 'project-b';
    await act(async () =>
      root.render(React.createElement(ProjectScopedTeamDetailView, { teamName: 'builders' }))
    );
    await settle();
    expect(host.querySelector('[data-testid="provisioning-banner"]')).toBeNull();
    expect(host.textContent).toContain('projectContextView.empty');
  });

  it('offers retry only after main confirms the interrupted launch stopped', async () => {
    getView.mockResolvedValue({
      mode: 'per_project',
      state: 'pending',
      reason: 'incomplete',
      projectPath: '/TEST/a',
      runId: 'failed-run',
    });
    await act(async () =>
      root.render(React.createElement(ProjectScopedTeamDetailView, { teamName: 'builders' }))
    );
    await settle();
    expect(host.textContent).toContain('projectContextView.incomplete');
    expect(host.textContent).not.toContain('projectContextView.pending');
    const retry = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent === 'projectContextView.retryLaunch'
    );
    expect(retry).toBeDefined();
    await act(async () => retry?.click());
    await vi.waitFor(() =>
      expect(host.querySelector('[data-testid="launch-with-provider"]')).not.toBeNull()
    );
    expect(launchTeam).not.toHaveBeenCalled();
  });

  it('does not show a different project failure on an incomplete project screen', async () => {
    getView.mockResolvedValue({
      mode: 'per_project',
      state: 'pending',
      reason: 'incomplete',
      projectPath: '/TEST/a',
      runId: 'failed-a',
    });
    state.currentProvisioningRunIdByTeam.builders = 'failed-b';
    state.provisioningErrorByTeam.builders = 'Failure from project B';
    await act(async () =>
      root.render(React.createElement(ProjectScopedTeamDetailView, { teamName: 'builders' }))
    );
    await settle();
    expect(host.textContent).toContain('projectContextView.incomplete');
    expect(host.textContent).not.toContain('Failure from project B');
    expect(host.querySelector('[data-testid="provisioning-banner"]')).toBeNull();
  });

  it('does not let an older incomplete response replace newer unknown ownership', async () => {
    vi.useFakeTimers();
    const unknown = {
      mode: 'per_project',
      state: 'pending',
      reason: 'unknown',
      projectPath: '/TEST/a',
      runId: null,
    };
    getView.mockResolvedValue(unknown);
    await act(async () =>
      root.render(React.createElement(ProjectScopedTeamDetailView, { teamName: 'builders' }))
    );
    await settle();
    let resolveOlder!: (value: unknown) => void;
    getView.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOlder = resolve;
        })
    );
    await act(async () => {
      vi.advanceTimersByTime(2500);
    });
    const refresh = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent === 'actions.refresh'
    );
    await act(async () => refresh?.click());
    await settle();
    await act(async () => resolveOlder({ ...unknown, reason: 'incomplete' }));
    await settle();
    expect(host.textContent).toContain('projectContextView.unknown');
    expect(host.textContent).not.toContain('projectContextView.retryLaunch');
  });

  it('reaches ready when each context read takes longer than the poll interval', async () => {
    vi.useFakeTimers();
    getView.mockResolvedValue({
      mode: 'per_project',
      state: 'pending',
      reason: 'unknown',
      projectPath: '/TEST/a',
      runId: null,
    });
    await act(async () =>
      root.render(React.createElement(ProjectScopedTeamDetailView, { teamName: 'builders' }))
    );
    await settle();
    getView.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(native('ptc-a', '/TEST/a')), 3000))
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5500);
    });
    await settle();
    expect(host.querySelector('[data-testid="team-detail"]')?.getAttribute('data-team')).toBe(
      'ptc-a'
    );
  });

  it('keeps another project active run out of a launching project banner', async () => {
    getView.mockResolvedValue({
      mode: 'per_project',
      state: 'pending',
      reason: 'launching',
      projectPath: '/TEST/a',
      runId: 'run-a',
    });
    state.currentProvisioningRunIdByTeam.builders = 'run-b';
    state.provisioningRuns['run-b'] = { runId: 'run-b', teamName: 'builders', state: 'spawning' };
    await act(async () =>
      root.render(React.createElement(ProjectScopedTeamDetailView, { teamName: 'builders' }))
    );
    await settle();
    expect(host.querySelector('[data-testid="provisioning-banner"]')).toBeNull();
    expect(host.textContent).toContain('projectContextView.pending');
  });

  it('does not enable launch when process ownership is unknown', async () => {
    getView.mockResolvedValue({
      mode: 'per_project',
      state: 'pending',
      reason: 'unknown',
      projectPath: '/TEST/a',
      runId: 'unresolved-run',
    });
    await act(async () =>
      root.render(React.createElement(ProjectScopedTeamDetailView, { teamName: 'builders' }))
    );
    await settle();
    expect(host.textContent).toContain('projectContextView.unknown');
    expect(host.textContent).not.toContain('projectContextView.retryLaunch');
    expect(Array.from(host.querySelectorAll('button')).map((button) => button.textContent)).toEqual(
      ['actions.refresh']
    );
    expect(launchTeam).not.toHaveBeenCalled();
  });

  it('does not invite to Launch when no Launch button is available', async () => {
    getView.mockResolvedValue({ mode: 'per_project', state: 'empty' });
    state.currentProvisioningRunIdByTeam.builders = 'run-from-team-list';
    state.provisioningRuns['run-from-team-list'] = {
      runId: 'run-from-team-list',
      teamName: 'builders',
      state: 'spawning',
    };
    await act(async () =>
      root.render(React.createElement(ProjectScopedTeamDetailView, { teamName: 'builders' }))
    );
    await settle();
    expect(host.textContent).not.toContain('projectContextView.emptyTitle');
    expect(host.textContent).not.toContain('projectContextView.empty');
    expect(host.textContent).toContain('projectContextView.pending');
    expect(host.querySelector('button')).toBeNull();
  });

  it('edits the logical team from the screen of a project without history', async () => {
    getView.mockResolvedValue({ mode: 'per_project', state: 'empty' });
    await act(async () =>
      root.render(React.createElement(ProjectScopedTeamDetailView, { teamName: 'builders' }))
    );
    await settle();
    expect(host.querySelector('[data-testid="definition-edit"]')).toBeNull();
    const edit = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent === 'detail.tooltips.editTeam'
    );
    await act(async () => edit?.click());
    expect(host.querySelector('[data-testid="definition-edit"]')?.getAttribute('data-team')).toBe(
      'builders'
    );
  });

  it('does not offer Edit team on a still-preparing project screen', async () => {
    getView.mockResolvedValue({
      mode: 'per_project',
      state: 'pending',
      reason: 'launching',
      projectPath: '/TEST/a',
      runId: null,
    });
    await act(async () =>
      root.render(React.createElement(ProjectScopedTeamDetailView, { teamName: 'builders' }))
    );
    await settle();
    expect(host.textContent).not.toContain('detail.tooltips.editTeam');
  });

  it('asks to open a project when none is selected, without a Launch button', async () => {
    getView.mockResolvedValue({ mode: 'per_project', state: 'needs_project' });
    (state as { selectedProjectId: string | null }).selectedProjectId = null;
    (state as { activeProjectId: string | null }).activeProjectId = null;
    await act(async () =>
      root.render(React.createElement(ProjectScopedTeamDetailView, { teamName: 'builders' }))
    );
    await settle();
    expect(host.textContent).toContain('projectContextView.selectProject');
    expect(host.textContent).not.toContain('projectContextView.emptyTitle');
    // No Launch (there is no project), but the team itself stays editable.
    expect(Array.from(host.querySelectorAll('button')).map((b) => b.textContent)).toEqual([
      'detail.tooltips.editTeam',
    ]);
  });

  it('blocks duplicate launch while Team List is provisioning the selected project', async () => {
    getView.mockResolvedValue({
      mode: 'per_project',
      state: 'pending',
      reason: 'launching',
      projectPath: '/TEST/a',
      runId: null,
    });
    state.currentProvisioningRunIdByTeam.builders = 'run-from-team-list';
    state.provisioningRuns['run-from-team-list'] = {
      runId: 'run-from-team-list',
      teamName: 'builders',
      state: 'spawning',
    };
    await act(async () =>
      root.render(React.createElement(ProjectScopedTeamDetailView, { teamName: 'builders' }))
    );
    await settle();
    expect(host.querySelector('[data-testid="provisioning-banner"]')).toBeNull();
    expect(host.textContent).toContain('projectContextView.pending');
    expect(host.querySelector('button')).toBeNull();
  });

  it('does not render another project history when target project is empty', async () => {
    getView.mockImplementation(async (_team: string, path: string) =>
      path === '/TEST/a' ? native('ptc-a', path) : { mode: 'per_project', state: 'empty' }
    );
    await act(async () =>
      root.render(React.createElement(ProjectScopedTeamDetailView, { teamName: 'builders' }))
    );
    await settle();
    state.selectedProjectId = 'project-b';
    await act(async () =>
      root.render(React.createElement(ProjectScopedTeamDetailView, { teamName: 'builders' }))
    );
    await settle();
    expect(host.querySelector('[data-team]')).toBeNull();
    // An empty project reads like any not-yet-launched team: a Launch action and
    // Edit team, no destructive action and no history-mode control.
    expect(host.textContent).toContain('projectContextView.emptyTitle');
    expect(host.textContent).toContain('projectContextView.empty');
    expect(Array.from(host.querySelectorAll('button')).map((b) => b.textContent)).toEqual([
      'detail.actions.launch',
      'detail.tooltips.editTeam',
    ]);
    const button = host.querySelector('button');
    expect(button?.textContent).toBe('detail.actions.launch');
    await act(async () => button?.click());
    await vi.waitFor(() =>
      expect(host.querySelector('[data-testid="launch-with-provider"]')).not.toBeNull()
    );
    expect(
      host
        .querySelector('[data-testid="launch-with-provider"]')
        ?.getAttribute('data-permission-policy')
    ).toBe('manual');
    // The roster of a per-project team belongs to its definition: this dialog never saves it.
    expect(
      host
        .querySelector('[data-testid="launch-with-provider"]')
        ?.getAttribute('data-roster-read-only')
    ).toBe('true');
    expect(launchTeam).not.toHaveBeenCalled();
    getView.mockResolvedValue(native('ptc-b', '/TEST/b'));
    // A previous project may leave a stale logical run. Only the canonical
    // store launch action can reset it and adopt the new project's progress.
    state.currentProvisioningRunIdByTeam.builders = 'stale-project-a-run';
    launchTeam.mockResolvedValue('b');
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="launch-with-provider"]')!.click();
    });
    await settle();
    expect(launchTeam).toHaveBeenCalledWith({
      teamName: 'builders',
      cwd: '/TEST/b',
      providerId: 'anthropic',
    });
    // Never bypass successor-run initialization with a raw API invocation.
    expect(launchTeamIpc).not.toHaveBeenCalled();
    expect(host.querySelector('[data-team]')?.getAttribute('data-team')).toBe('ptc-b');
  });
});
