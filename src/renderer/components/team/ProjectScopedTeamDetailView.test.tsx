import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { state, getView, launchTeam, openTeamTab } = vi.hoisted(() => {
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
    teamByName: {
      builders: { displayName: 'Builders' },
    },
  };
  return { state, getView: vi.fn(), launchTeam: vi.fn(), openTeamTab: vi.fn() };
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
      }),
    }
  ),
}));
vi.mock('@renderer/api', () => ({ api: { teams: { getProjectContextView: getView, launchTeam, onProvisioningProgress: () => () => undefined } } }));
vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('./TeamDetailView', () => ({
  TeamDetailView: ({ teamName }: { teamName: string }) =>
    React.createElement('div', { 'data-testid': 'team-detail', 'data-team': teamName }),
}));
vi.mock('./TeamHistoryModePicker', () => ({
  TeamHistoryModePicker: () => React.createElement('div', { 'data-testid': 'mode-picker' }),
}));

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
    state.selectedProjectId = 'project-a';
    state.activeProjectId = 'project-a';
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
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
    getView.mockResolvedValue(native('ptc-b', '/TEST/b'));
    launchTeam.mockResolvedValue({ runId: 'b' });
    await act(async () => button?.click());
    await settle();
    expect(launchTeam).toHaveBeenCalledWith({
      teamName: 'builders', cwd: '/TEST/b',
    });
    expect(host.querySelector('[data-team]')?.getAttribute('data-team')).toBe('ptc-b');
  });
});
