import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { type RecentProjectCardModel,type RecentProjectsCollectionSource, RecentProjectsSectionView } from '@features/recent-projects/renderer/browser';
import { TooltipProvider } from '@renderer/components/ui/tooltip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key === 'recentProjects.selectFolder' ? 'Select Folder' : key === 'recentProjects.selectFolderTitle' ? 'Select a project folder' : key }),
}));

const rows: RecentProjectCardModel[] = Array.from({ length: 21 }, (_, index) => ({
  identity: { scopeKey: 'fixture', readEpoch: 1, targetKey: `row-${index + 1}` },
  name: `project-${index + 1}`,
  activity: { kind: 'unknown', reason: 'not_provided' },
  providers: { kind: 'unknown', reason: 'not_provided' },
  branch: { kind: 'unknown', reason: 'not_provided' },
  taskCounts: { kind: 'unknown', reason: 'not_provided' },
  tasksLoading: false,
  activeTeams: { kind: 'unknown', reason: 'not_provided' },
  open: { support: 'supported', availability: 'available' },
  reveal: { support: 'unsupported', reason: 'native_only' },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('RecentProjectsSectionView', () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const openProject = vi.fn<RecentProjectsCollectionSource['openProject']>();
  const selectFolder = vi.fn<NonNullable<RecentProjectsCollectionSource['extensionAction']>['run']>();
  const source: RecentProjectsCollectionSource = {
    scopeKey: 'fixture', readEpoch: 1, rows, completeness: 'complete', stale: false, openProject,
    extensionAction: { label: 'Select Folder', ariaLabel: 'Select a project folder', icon: 'folder', run: selectFolder },
  };

  const render = (query: string) => act(() => root.render(<TooltipProvider><RecentProjectsSectionView source={source} searchQuery={query} loading={false} error={null} reload={async () => undefined} /></TooltipProvider>));
  const cards = () => host.querySelectorAll('[data-recent-project-cell="project"]');

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    openProject.mockReset().mockResolvedValue({ kind: 'opened' });
    selectFolder.mockReset().mockResolvedValue({ kind: 'cancelled' });
    source.rows = rows;
    source.completeness = 'complete';
    source.stale = false;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

  it('filters all 21 rows before applying 11 + 8 pagination and resets after clear', () => {
    render('');
    expect(cards()).toHaveLength(11);
    const grid = host.querySelector('[data-recent-projects-grid]');
    expect(grid?.classList.contains('gap-px')).toBe(true);
    expect(host.querySelector('[data-recent-project-cell="select-folder"]')).not.toBeNull();
    act(() => [...host.querySelectorAll('button')].find((button) => button.textContent === 'recentProjects.loadMore')?.click());
    expect(cards()).toHaveLength(19);
    act(() => [...host.querySelectorAll('button')].find((button) => button.textContent === 'recentProjects.loadMore')?.click());
    expect(cards()).toHaveLength(21);
    render('project-21');
    expect(cards()).toHaveLength(1);
    expect(cards()[0]?.textContent).toContain('project-21');
    expect(host.querySelector('[data-recent-project-cell="select-folder"]')).toBeNull();
    render('');
    expect(cards()).toHaveLength(11);
  });

  it('allows one pending open effect and treats picker cancellation as quiet', async () => {
    const pending = deferred<{ kind: 'opened' }>();
    openProject.mockReturnValue(pending.promise);
    render('');
    const first = cards()[0]?.querySelector('button');
    await act(async () => { first?.click(); first?.click(); });
    expect(openProject).toHaveBeenCalledTimes(1);
    await act(async () => { pending.resolve({ kind: 'opened' }); await pending.promise; });
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-recent-project-cell="select-folder"]')?.click();
      await Promise.resolve();
    });
    expect(selectFolder).toHaveBeenCalledOnce();
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it('does not claim a complete empty list when the read is partial', () => {
    source.rows = [];
    source.completeness = 'partial';
    render('');
    expect(host.textContent).toContain('tokenUsage.partialData');
    expect(host.textContent).not.toContain('recentProjects.noRecentProjects');
    expect(host.querySelector('[data-recent-project-cell="select-folder"]')).toBeNull();
  });

  it('shows a stale read even when its snapshot is complete', () => {
    source.stale = true;
    render('');
    expect(host.textContent).toContain('Last known projects');
    expect(host.textContent).toContain('project-1');
  });

  it.each(['empty', 'partial', 'populated'] as const)('shows Select Folder failure independently in the %s state', async (state) => {
    source.rows = state === 'populated' ? rows : [];
    source.completeness = state === 'empty' ? 'complete' : 'partial';
    selectFolder.mockResolvedValue({ kind: 'failed', message: 'Folder selection failed.' });
    render('');
    await act(async () => {
      const selector = state === 'populated' ? '[data-recent-project-cell="select-folder"]' : 'button';
      const action = [...host.querySelectorAll<HTMLButtonElement>(selector)]
        .find((button) => button.textContent?.includes('Select Folder'));
      action?.click();
      await Promise.resolve();
    });
    expect(selectFolder).toHaveBeenCalledOnce();
    expect(host.textContent).toContain('Folder selection failed.');
    if (state !== 'empty') expect(host.textContent).toContain('tokenUsage.partialData');
  });
});
