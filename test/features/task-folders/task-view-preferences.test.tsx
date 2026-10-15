import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  normalizeTaskViewState,
  useTaskViewState,
} from '../../../src/features/task-folders/renderer/hooks/useTaskViewState';
import { defaultTaskFiltersState } from '../../../src/renderer/components/sidebar/taskFiltersState';

interface ProbeApi {
  setTeam(teamName: string): void;
  setSort(sortMode: 'time' | 'project' | 'team' | 'unread' | 'manual'): void;
  openSort(): void;
  openFilters(): void;
  closePopovers(): void;
}

describe('independent task view preferences', () => {
  const probes = new Map<string, ProbeApi>();

  beforeEach(() => {
    localStorage.clear();
    probes.clear();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  function Probe({ namespace }: { namespace: string }) {
    const view = useTaskViewState(namespace);
    probes.set(namespace, {
      setTeam: (teamName) => {
        const next = defaultTaskFiltersState();
        next.teamName = teamName;
        view.setFilters(next);
      },
      setSort: view.setSortMode,
      openSort: () => view.setSortOpen(true),
      openFilters: () => view.setFiltersOpen(true),
      closePopovers: view.closePopovers,
    });
    return (
      <output
        data-namespace={namespace}
        data-sort={view.sortMode}
        data-team={view.filters.teamName ?? ''}
        data-sort-open={view.sortOpen ? 'true' : 'false'}
        data-filters-open={view.filtersOpen ? 'true' : 'false'}
      />
    );
  }

  it('persists each container independently and restores without a shared mutable filter object', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () =>
      root.render(
        <>
          <Probe namespace="tree" />
          <Probe namespace="sidebar" />
        </>
      )
    );

    await act(async () => {
      probes.get('tree')!.setTeam('tree-team');
      probes.get('tree')!.setSort('unread');
      probes.get('sidebar')!.setTeam('sidebar-team');
      probes.get('sidebar')!.setSort('project');
    });

    expect(
      JSON.parse(localStorage.getItem('taskFolders:taskView:v1:tree')!)
    ).toMatchObject({
      filters: { teamName: 'tree-team' },
      sortMode: 'unread',
    });
    expect(
      JSON.parse(localStorage.getItem('taskFolders:taskView:v1:sidebar')!)
    ).toMatchObject({
      filters: { teamName: 'sidebar-team' },
      sortMode: 'project',
    });

    const treeFilters = JSON.parse(
      localStorage.getItem('taskFolders:taskView:v1:tree')!
    ).filters.statusIds;
    treeFilters.push('done');
    await act(async () => root.render(null));
    await act(async () =>
      root.render(
        <>
          <Probe namespace="tree" />
          <Probe namespace="sidebar" />
        </>
      )
    );
    expect(
      host.querySelector('[data-namespace="tree"]')!.getAttribute('data-team')
    ).toBe('tree-team');
    expect(
      host.querySelector('[data-namespace="sidebar"]')!.getAttribute('data-team')
    ).toBe('sidebar-team');
  });

  it('rejects malformed persisted values and closes both view popovers together', async () => {
    expect(
      normalizeTaskViewState(
        {
          filters: {
            statusIds: ['todo', 'not-a-status'],
            teamName: 7,
            projectPath: false,
            readFilter: 'unread',
          },
          sortMode: 'not-a-sort',
          searchQuery: ['not-a-query'],
        },
        'manual'
      )
    ).toEqual({
      filters: {
        ...defaultTaskFiltersState(),
        statusIds: new Set(['todo']),
        readFilter: 'unread',
        unreadOnly: true,
      },
      sortMode: 'manual',
      searchQuery: '',
    });

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(<Probe namespace="tree" />));
    await act(async () => {
      probes.get('tree')!.openSort();
      probes.get('tree')!.openFilters();
    });
    expect(
      host.querySelector('[data-namespace="tree"]')!.getAttribute('data-sort-open')
    ).toBe('true');
    expect(
      host.querySelector('[data-namespace="tree"]')!.getAttribute('data-filters-open')
    ).toBe('true');

    await act(async () => probes.get('tree')!.closePopovers());

    expect(
      host.querySelector('[data-namespace="tree"]')!.getAttribute('data-sort-open')
    ).toBe('false');
    expect(
      host.querySelector('[data-namespace="tree"]')!.getAttribute('data-filters-open')
    ).toBe('false');
    await act(async () => root.unmount());
  });
});
