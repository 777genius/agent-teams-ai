import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { state, getView, launchTeam, openTeamTab, updateTabLabel, selectTeam } = vi.hoisted(() => {
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
    openTeamTab: vi.fn(),
    updateTabLabel: vi.fn(),
    selectTeam: vi.fn(async (_teamName: string) => undefined),
  };
});

vi.mock('@renderer/store', () => ({
  useStore: Object.assign(
    (selector: (store: typeof state) => unknown) => selector(state),
    {
      getState: () => ({
        ...state,
        activeTabId: 'alias-tab',
        getAllPaneTabs: () => [{ id: 'alias-tab', type: 'team', teamName: 'ptc-a' }],
        openTeamTab,
        updateTabLabel,
        selectTeam,
      }),
    }
  ),
}));
vi.mock('@renderer/api', () => ({ api: { teams: { getProjectContextView: getView, launchTeam, onProvisioningProgress: () => () => undefined } } }));
vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('./TeamProvisioningBanner', () => ({
  TeamProvisioningBanner: ({ teamName }: { teamName: string }) =>
    React.createElement('div', { 'data-testid': 'provisioning-banner' },
      state.provisioningErrorByTeam[teamName] ?? 'Launching'),
}));
vi.mock('./TeamDetailView', () => ({
  TeamDetailView: ({ teamName, retainedHistory }: { teamName: string; retainedHistory?: boolean }) =>
    React.createElement(
      'div',
      {
        'data-testid': 'team-detail', 'data-team': teamName,
        'data-retained': String(retainedHistory === true),
      },
      React.createElement('div', { 'data-section-id': 'kanban' })
    ),
}));
vi.mock('./TeamHistoryModePicker', () => ({
  TeamHistoryModePicker: () => React.createElement('div', { 'data-testid': 'mode-picker' }),
}));
vi.mock('./dialogs/LaunchTeamDialog', () => ({
  LaunchTeamDialog: ({
    onLaunch, teamName, defaultProjectPath, projectPermissionTeamName,
  }: {
    onLaunch: (request: { teamName: string; cwd: string; providerId: 'anthropic' }) => Promise<void>;
    teamName: string;
    defaultProjectPath: string;
    projectPermissionTeamName?: string | null;
  }) => React.createElement('button', {
    'data-testid': 'launch-with-provider',
    'data-permission-policy': projectPermissionTeamName === null ? 'manual' : 'inherited',
    onClick: () => { void onLaunch({
      teamName, cwd: defaultProjectPath, providerId: 'anthropic',
    }); },
  }, 'Configure runtime and launch'),
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
    openTeamTab.mockReset();
    updateTabLabel.mockReset();
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
  });

  it('keeps the mounted native project visible for live inbox/task refresh and unregisters it', async () => {
    const visible = () => getVisibleTeamNamesInAnyPane({
      paneLayout: { panes: [] },
    } as never);
    getView.mockImplementation(async (_logical: string, project: string) =>
      project === '/TEST/a' ? native('ptc-a-visible', project) : native('ptc-b-visible', project)
    );
    await act(async () => root.render(
      React.createElement(ProjectScopedTeamDetailView, { teamName: 'builders', isActive: true })
    ));
    await settle();
    expect(visible().has('ptc-a-visible')).toBe(true);

    state.selectedProjectId = 'project-b';
    await act(async () => root.render(
      React.createElement(ProjectScopedTeamDetailView, { teamName: 'builders', isActive: true })
    ));
    await settle();
    expect(visible().has('ptc-a-visible')).toBe(false);
    expect(visible().has('ptc-b-visible')).toBe(true);

    await act(async () => root.render(
      React.createElement(ProjectScopedTeamDetailView, { teamName: 'builders', isActive: false })
    ));
    expect(visible().has('ptc-b-visible')).toBe(false);
  });

  it('renders only the selected project native Tasks/Messages context (A→B→A)', async () => {
    getView.mockImplementation(async (_team: string, path: string) =>
      path === '/TEST/a' ? native('ptc-a', path) : native('ptc-b', path)
    );
    await act(async () => root.render(
      React.createElement(ProjectScopedTeamDetailView, { teamName: 'builders' })
    ));
    await settle();
    expect(host.querySelector('[data-team]')?.getAttribute('data-team')).toBe('ptc-a');

    state.selectedProjectId = 'project-b';
    await act(async () => root.render(
      React.createElement(ProjectScopedTeamDetailView, { teamName: 'builders' })
    ));
    await settle();
    expect(host.querySelector('[data-team]')?.getAttribute('data-team')).toBe('ptc-b');

    state.selectedProjectId = 'project-a';
    await act(async () => root.render(
      React.createElement(ProjectScopedTeamDetailView, { teamName: 'builders' })
    ));
    await settle();
    expect(host.querySelector('[data-team]')?.getAttribute('data-team')).toBe('ptc-a');
    expect(getView).toHaveBeenCalledWith('builders', '/TEST/a');
    expect(getView).toHaveBeenCalledWith('builders', '/TEST/b');
  });


  it('restores physical selection on repeated logical tab activation and preserves section navigation', async () => {
    getView.mockResolvedValue(native('ptc-a', '/TEST/a'));
    await act(async () => root.render(
      React.createElement(ProjectScopedTeamDetailView, { teamName: 'builders' })
    ));
    await settle();

    // The logical tab section menu must reach the physical TeamDetailView sections.
    expect(host.querySelector('[data-team-name="builders"] [data-section-id="kanban"]'))
      .not.toBeNull();
    expect(host.querySelector('[data-team-name="ptc-a"] [data-section-id="kanban"]'))
      .not.toBeNull();

    // Clicking an already-active tab reselects the logical name without remounting.
    state.selectedTeamName = 'builders';
    await act(async () => root.render(
      React.createElement(ProjectScopedTeamDetailView, { teamName: 'builders' })
    ));
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
    await act(async () => root.render(
      React.createElement(ProjectScopedTeamDetailView, { teamName: 'ptc-a' })
    ));
    await settle();
    expect(openTeamTab).toHaveBeenCalledWith('builders', '/TEST/a');
    expect(host.querySelector('[data-team]')).toBeNull();
    expect(host.querySelector('[data-testid="mode-picker"]')).toBeNull();
  });

  it('keeps old shared tasks readable after switching their logical team to per-project mode', async () => {
    getView.mockResolvedValue({
      mode: 'per_project', state: 'ready',
      executionTeamName: 'ptc-current', workContextId: 'current-project',
      projectPath: '/TEST/a',
    });
    await act(async () => root.render(
      React.createElement(ProjectScopedTeamDetailView, {
        teamName: 'builders', retainedSharedHistory: true,
      })
    ));
    await settle();
    expect(host.querySelector('[data-team]')?.getAttribute('data-team')).toBe('builders');
    expect(host.querySelector('[data-team]')?.getAttribute('data-retained')).toBe('true');
    expect(host.querySelector('[data-team-name="ptc-current"]')).toBeNull();
    expect(host.textContent).toContain('projectContextView.retainedHistory');
    const button = host.querySelector('button');
    await act(async () => button?.click());
    expect(openTeamTab).toHaveBeenCalledWith('builders');
  });

  it('keeps a retained native task/chat history open after the logical team switches to shared', async () => {
    getView.mockResolvedValue({
      mode: 'per_project',
      state: 'retained',
      logicalTeamName: 'builders',
      executionTeamName: 'ptc-a',
      workContextId: 'context-ptc-a',
      projectPath: '/TEST/a',
    });
    await act(async () => root.render(
      React.createElement(ProjectScopedTeamDetailView, { teamName: 'ptc-a' })
    ));
    await settle();
    expect(getView).toHaveBeenCalledWith('ptc-a', '/TEST/a');
    expect(host.querySelector('[data-team]')?.getAttribute('data-team')).toBe('ptc-a');
    expect(host.querySelector('[data-team]')?.getAttribute('data-retained')).toBe('true');
    expect(openTeamTab).not.toHaveBeenCalled();
    expect(updateTabLabel).toHaveBeenCalledWith(
      'alias-tab', expect.stringContaining('builders')
    );
    expect(host.textContent).toContain('projectContextView.retainedHistory');
    const button = host.querySelector('button');
    await act(async () => button?.click());
    expect(openTeamTab).toHaveBeenCalledWith('builders');
  });

  it('preserves verified physical task history when its worktree disappeared from discovery', async () => {
    getView.mockResolvedValue({
      mode: 'per_project',
      state: 'redirect',
      logicalTeamName: 'builders',
      projectPath: '/removed/worktree',
    });
    await act(async () => root.render(
      React.createElement(ProjectScopedTeamDetailView, { teamName: 'ptc-removed' })
    ));
    await settle();
    expect(host.querySelector('[data-team]')?.getAttribute('data-team')).toBe('ptc-removed');
    expect(host.textContent).toContain('/removed/worktree');
    expect(host.textContent).not.toContain('projectContextView.empty');
  });

  it('keeps the pre-feature shared team name unchanged', async () => {
    getView.mockResolvedValue({
      mode: 'shared', state: 'ready', executionTeamName: 'builders',
    });
    await act(async () => root.render(
      React.createElement(ProjectScopedTeamDetailView, { teamName: 'builders' })
    ));
    await settle();
    expect(host.querySelector('[data-team]')?.getAttribute('data-team')).toBe('builders');
  });

  it('surfaces Create Team and Team List launch failures without a local launch reference', async () => {
    getView.mockImplementation(async (_team: string, path: string) =>
      ({ mode: 'per_project', state: path === '/TEST/a' ? 'pending' : 'empty' })
    );
    state.provisioningErrorByTeam.builders = 'Project runtime bootstrap failed';
    await act(async () => root.render(
      React.createElement(ProjectScopedTeamDetailView, { teamName: 'builders' })
    ));
    await settle();
    expect(host.querySelector('[data-testid="provisioning-banner"]')?.textContent)
      .toContain('Project runtime bootstrap failed');
    expect(host.textContent).toContain('Project runtime bootstrap failed');
    expect(launchTeam).not.toHaveBeenCalled();

    state.selectedProjectId = 'project-b';
    await act(async () => root.render(
      React.createElement(ProjectScopedTeamDetailView, { teamName: 'builders' })
    ));
    await settle();
    expect(host.querySelector('[data-testid="provisioning-banner"]')).toBeNull();
    expect(host.textContent).toContain('projectContextView.empty');
  });

  it('blocks duplicate launch while Team List is provisioning the selected project', async () => {
    getView.mockResolvedValue({ mode: 'per_project', state: 'pending' });
    state.currentProvisioningRunIdByTeam.builders = 'run-from-team-list';
    state.provisioningRuns['run-from-team-list'] = {
      runId: 'run-from-team-list', teamName: 'builders', state: 'spawning',
    };
    await act(async () => root.render(
      React.createElement(ProjectScopedTeamDetailView, { teamName: 'builders' })
    ));
    await settle();
    expect(host.querySelector('[data-testid="provisioning-banner"]')).not.toBeNull();
    expect(host.textContent).toContain('projectContextView.pending');
    expect(host.querySelector('button')).toBeNull();
  });

  it('does not render another project history when target project is empty', async () => {
    getView.mockImplementation(async (_team: string, path: string) =>
      path === '/TEST/a' ? native('ptc-a', path) : { mode: 'per_project', state: 'empty' }
    );
    await act(async () => root.render(
      React.createElement(ProjectScopedTeamDetailView, { teamName: 'builders' })
    ));
    await settle();
    state.selectedProjectId = 'project-b';
    await act(async () => root.render(
      React.createElement(ProjectScopedTeamDetailView, { teamName: 'builders' })
    ));
    await settle();
    expect(host.querySelector('[data-team]')).toBeNull();
    expect(host.textContent).toContain('projectContextView.empty');
    const button = host.querySelector('button');
    expect(button).not.toBeNull();
    await act(async () => button?.click());
    await vi.waitFor(() => expect(
      host.querySelector('[data-testid="launch-with-provider"]')
    ).not.toBeNull());
    expect(host.querySelector('[data-testid="launch-with-provider"]')?.getAttribute('data-permission-policy'))
      .toBe('manual');
    expect(launchTeam).not.toHaveBeenCalled();
    getView.mockResolvedValue(native('ptc-b', '/TEST/b'));
    launchTeam.mockResolvedValue({ runId: 'b' });
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="launch-with-provider"]')!.click();
    });
    await settle();
    expect(launchTeam).toHaveBeenCalledWith({
      teamName: 'builders', cwd: '/TEST/b', providerId: 'anthropic',
    });
    expect(host.querySelector('[data-team]')?.getAttribute('data-team')).toBe('ptc-b');
  });
});
