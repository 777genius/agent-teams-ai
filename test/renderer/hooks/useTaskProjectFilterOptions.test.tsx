import { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';

import { useTaskProjectFilterOptions } from '@renderer/hooks/useTaskProjectFilterOptions';
import { useStore } from '@renderer/store';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { panelController } from '../../../src/features/task-folders/renderer/composition';
import { useTaskFoldersHost } from '../../../src/features/task-folders/renderer/hooks/useTaskFoldersHost';

import type { Project, RepositoryGroup } from '@shared/types';

const catalogApi = vi.hoisted(() => ({
  getProjects: vi.fn<() => Promise<Project[]>>(),
  getRepositoryGroups: vi.fn<() => Promise<RepositoryGroup[]>>(),
}));
vi.mock('@renderer/api', () => ({ api: catalogApi, isElectronMode: () => false }));

const project: Project = {
  id: 'sandbox',
  path: '/sandbox/project',
  name: 'Sandbox',
  sessions: [],
  totalSessions: 1,
  createdAt: 0,
};
const repository: RepositoryGroup = {
  id: 'repository',
  identity: null,
  name: 'Repository',
  totalSessions: 1,
  worktrees: [{ ...project, isMainWorktree: true, source: 'git' }],
};
const initialStore = useStore.getState();
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function flushReact(callback: () => void): Promise<void> {
  return act(() => Promise.resolve(callback()));
}
function Probe({ sidebarOpen = false }: { readonly sidebarOpen?: boolean }) {
  const sidebar = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const options = useTaskProjectFilterOptions(sidebarOpen);
  const tree = useTaskFoldersHost('test', sidebar, false, panel);
  return (
    <>
      <output data-sidebar>{JSON.stringify(options)}</output>
      <output data-tree>{JSON.stringify(tree.projectFilterOptions)}</output>
      <button onClick={() => tree.view.setFiltersOpen(!tree.view.filtersOpen)}>Tree filters</button>
    </>
  );
}
function expectOptions(expected: { value: string; label: string; description: string }[]) {
  expect(JSON.parse(host.querySelector('[data-sidebar]')!.textContent)).toEqual(expected);
  expect(JSON.parse(host.querySelector('[data-tree]')!.textContent)).toEqual(expected);
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  catalogApi.getProjects.mockReset().mockResolvedValue([project]);
  catalogApi.getRepositoryGroups.mockReset().mockResolvedValue([repository]);
  useStore.setState({
    globalTasks: [],
    teams: [],
    viewMode: 'flat',
    projects: [],
    projectsLoading: false,
    projectsInitialized: false,
    projectsError: null,
    repositoryGroups: [],
    repositoryGroupsLoading: false,
    repositoryGroupsInitialized: false,
    repositoryGroupsError: null,
  });
  panelController.hold('manual', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await flushReact(() => root.unmount());
  panelController.dispose();
  useStore.setState(initialStore);
  host.remove();
  localStorage.clear();
  vi.unstubAllGlobals();
});

it.each(['flat', 'grouped'] as const)(
  'loads the %s project catalog when tree filters open first and shares it without duplicate requests',
  async (viewMode) => {
    useStore.setState({ viewMode });
    let resolve!: () => void;
    const gate = new Promise<void>((done) => {
      resolve = done;
    });
    catalogApi.getProjects.mockImplementation(() => gate.then(() => [project]));
    catalogApi.getRepositoryGroups.mockImplementation(() => gate.then(() => [repository]));
    await flushReact(() => root.render(<Probe />));
    expect(catalogApi.getProjects).not.toHaveBeenCalled();
    expect(catalogApi.getRepositoryGroups).not.toHaveBeenCalled();
    expectOptions([]);

    await flushReact(() => host.querySelector('button')!.click());
    expect(catalogApi.getProjects).toHaveBeenCalledTimes(viewMode === 'flat' ? 1 : 0);
    expect(catalogApi.getRepositoryGroups).toHaveBeenCalledTimes(viewMode === 'grouped' ? 1 : 0);
    await flushReact(() => root.render(<Probe sidebarOpen />));
    expect(catalogApi.getProjects).toHaveBeenCalledTimes(viewMode === 'flat' ? 1 : 0);
    expect(catalogApi.getRepositoryGroups).toHaveBeenCalledTimes(viewMode === 'grouped' ? 1 : 0);
    await act(async () => {
      resolve();
      await gate;
    });
    expectOptions([
      {
        value: project.path,
        label: viewMode === 'flat' ? project.name : repository.name,
        description: project.path,
      },
    ]);

    await flushReact(() => {
      root.render(<Probe />);
      host.querySelector('button')!.click();
    });
    await flushReact(() => {
      root.render(<Probe sidebarOpen />);
      host.querySelector('button')!.click();
    });
    expect(catalogApi.getProjects).toHaveBeenCalledTimes(viewMode === 'flat' ? 1 : 0);
    expect(catalogApi.getRepositoryGroups).toHaveBeenCalledTimes(viewMode === 'grouped' ? 1 : 0);
  }
);

it.each([
  ['flat', 'loading'],
  ['flat', 'initialized'],
  ['flat', 'error'],
  ['grouped', 'loading'],
  ['grouped', 'initialized'],
  ['grouped', 'error'],
] as const)('keeps the %s catalog %s guard when either view opens', async (viewMode, guard) => {
  useStore.setState({
    viewMode,
    projectsLoading: viewMode === 'flat' && guard === 'loading',
    projectsInitialized: viewMode === 'flat' && guard === 'initialized',
    projectsError: viewMode === 'flat' && guard === 'error' ? 'test catalog failure' : null,
    repositoryGroupsLoading: viewMode === 'grouped' && guard === 'loading',
    repositoryGroupsInitialized: viewMode === 'grouped' && guard === 'initialized',
    repositoryGroupsError:
      viewMode === 'grouped' && guard === 'error' ? 'test catalog failure' : null,
  });
  await flushReact(() => root.render(<Probe sidebarOpen />));
  await flushReact(() => host.querySelector('button')!.click());
  await flushReact(() => host.querySelector('button')!.click());
  await flushReact(() => host.querySelector('button')!.click());
  expectOptions([]);
  expect(catalogApi.getProjects).not.toHaveBeenCalled();
  expect(catalogApi.getRepositoryGroups).not.toHaveBeenCalled();
});
