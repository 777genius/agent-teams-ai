import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { RecentProjectsSection } from '@features/recent-projects/renderer/ui/RecentProjectsSection';
import { TooltipProvider } from '@renderer/components/ui/tooltip';
import { resetContextScopedRequestEpochForTests } from '@renderer/store/utils/contextScopedRequestEpoch';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  openRecentProject: vi.fn(),
  openProjectPath: vi.fn(),
  selectProjectFolder: vi.fn(),
}));

vi.mock('@features/recent-projects/renderer/hooks/useRecentProjectsSection', () => ({
  useRecentProjectsSection: () => ({
    cards: [{
      id: 'fixture-id',
      name: 'Fixture Project',
      formattedPath: '~/fixture',
      lastActivityLabel: 'today',
      providerIds: ['codex'],
      primaryBranch: 'main',
      taskCounts: { pending: 1, inProgress: 1, completed: 2 },
      tasksLoading: false,
      activeTeams: [{ teamName: 'fixture-team', displayName: 'Fixture Team' }],
      pathSummary: undefined,
      project: {
        id: 'fixture-id', name: 'Fixture Project', primaryPath: '/tmp/h1-fixture',
        associatedPaths: ['/tmp/h1-fixture'], mostRecentActivity: Date.now(),
        providerIds: ['codex'], source: 'codex',
        openTarget: { type: 'synthetic-path', path: '/tmp/h1-fixture' },
      },
    }],
    loading: false, error: null, isElectron: true, tasksKnown: true,
    aliveTeamsKnown: true, degraded: false, stale: false,
    scopeKey: 'local', readEpoch: 0,
    isCurrentIntent: () => true,
    reload: async () => undefined,
    openRecentProject: fixture.openRecentProject,
    openProjectPath: fixture.openProjectPath,
    selectProjectFolder: fixture.selectProjectFolder,
  }),
}));
vi.mock('@renderer/store', () => ({ useStore: { getState: () => ({ activeContextId: 'local' }) } }));
vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key === 'recentProjects.selectFolder' ? 'Select Folder' : key === 'recentProjects.selectFolderTitle' ? 'Select a project folder' : key }),
}));

describe('Desktop Recent Projects connector', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    resetContextScopedRequestEpochForTests();
    fixture.openRecentProject.mockReset().mockResolvedValue({ kind: 'opened' });
    fixture.openProjectPath.mockReset().mockResolvedValue({ kind: 'opened' });
    fixture.selectProjectFolder.mockReset().mockResolvedValue({ kind: 'cancelled' });
  });
  afterEach(() => { document.body.innerHTML = ''; vi.unstubAllGlobals(); });

  it('renders rich Desktop facts through the shared view and keeps native actions separate', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(<TooltipProvider><RecentProjectsSection searchQuery="" /></TooltipProvider>));

    const cell = host.querySelector<HTMLElement>('[data-recent-project-cell="project"]');
    expect(cell?.textContent).toContain('Fixture Project');
    expect(cell?.textContent).toContain('~/fixture');
    expect(cell?.textContent).toContain('main');
    expect(cell?.textContent).toContain('Fixture Team');
    expect(cell?.querySelector('[role="progressbar"]')).not.toBeNull();
    expect(cell?.querySelector('button button')).toBeNull();
    expect(host.querySelector('[data-recent-project-cell="select-folder"]')).not.toBeNull();

    await act(async () => { cell?.querySelectorAll('button')[1]?.click(); await Promise.resolve(); });
    expect(fixture.openProjectPath).toHaveBeenCalledWith('/tmp/h1-fixture');
    expect(fixture.openRecentProject).not.toHaveBeenCalled();
    await act(async () => { cell?.querySelectorAll('button')[0]?.click(); await Promise.resolve(); });
    expect(fixture.openRecentProject).toHaveBeenCalledOnce();
    act(() => root.unmount());
  });
});
