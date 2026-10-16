import { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';

import { useTaskTeamStatus } from '@renderer/hooks/useTaskTeamStatus';
import { useStore } from '@renderer/store';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { useTaskFoldersHost } from '../../../src/features/task-folders/renderer/hooks/useTaskFoldersHost';

import type { GlobalTask, TeamProvisioningProgress, TeamSummary } from '@shared/types';

const aliveList = vi.hoisted(() => vi.fn<() => Promise<string[]>>());
vi.mock('@renderer/api', () => ({
  api: { teams: { aliveList } },
  isElectronMode: () => true,
}));

const task: GlobalTask = {
  id: '1',
  teamName: 'test-team',
  teamDisplayName: 'Test team',
  subject: 'Test task',
  status: 'in_progress',
};
const team: TeamSummary = {
  teamName: task.teamName,
  displayName: task.teamDisplayName,
  description: '',
  memberCount: 0,
  taskCount: 1,
  lastActivity: null,
};
const initialStore = useStore.getState();
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function Probe() {
  const sidebar = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const isTeamOffline = useTaskTeamStatus();
  const tree = useTaskFoldersHost('test', sidebar, true, panel);
  return (
    <div
      data-sidebar-offline={isTeamOffline(task.teamName)}
      data-tree-offline={tree.isTeamOffline(task.teamName)}
      data-sidebar-forced={isTeamOffline('forced-offline')}
      data-tree-forced={tree.isTeamOffline('forced-offline')}
    />
  );
}
function expectOffline(value: boolean) {
  expect(host.firstElementChild!.getAttribute('data-sidebar-offline')).toBe(String(value));
  expect(host.firstElementChild!.getAttribute('data-tree-offline')).toBe(String(value));
}
function progress(state: TeamProvisioningProgress['state']): TeamProvisioningProgress {
  return {
    runId: 'run',
    teamName: task.teamName,
    state,
    message: state,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  aliveList.mockReset().mockResolvedValue([]);
  useStore.setState({
    globalTasks: [task],
    teams: [],
    leadActivityByTeam: {},
    provisioningRuns: {},
    currentProvisioningRunIdByTeam: {},
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  useStore.setState(initialStore);
  localStorage.clear();
  vi.unstubAllGlobals();
});

it('keeps startup unknown until an authoritative list and uses task-team fallbacks in both views', async () => {
  let resolve!: (teams: string[]) => void;
  aliveList.mockReturnValue(
    new Promise<string[]>((done) => {
      resolve = done;
    })
  );
  useStore.setState({ leadActivityByTeam: { 'forced-offline': 'offline' } });
  await act(async () => root.render(<Probe />));
  expectOffline(false);
  expect(host.firstElementChild!.getAttribute('data-sidebar-forced')).toBe('true');
  expect(host.firstElementChild!.getAttribute('data-tree-forced')).toBe('true');

  await act(async () => resolve([]));
  expectOffline(true);
});

it.each(['cancelled', 'disconnected'] as const)(
  'marks a %s team offline in both views despite a stale alive list and no offline lead flag',
  async (state) => {
    aliveList.mockResolvedValue([task.teamName]);
    await act(async () => root.render(<Probe />));
    expectOffline(false);
    await act(async () =>
      useStore.setState({
        currentProvisioningRunIdByTeam: { [task.teamName]: 'run' },
        provisioningRuns: { run: progress(state) },
      })
    );
    expectOffline(true);
  }
);

it('refreshes live status on team identity and ready progress while preserving provisioning grace', async () => {
  await act(async () => root.render(<Probe />));
  expectOffline(true);
  expect(aliveList).toHaveBeenCalledTimes(2);

  await act(async () =>
    useStore.setState({
      currentProvisioningRunIdByTeam: { [task.teamName]: 'run' },
      provisioningRuns: { run: progress('verifying') },
    })
  );
  expectOffline(false);
  expect(aliveList).toHaveBeenCalledTimes(2);

  await act(async () => useStore.setState({ provisioningRuns: { run: progress('ready') } }));
  expect(aliveList).toHaveBeenCalledTimes(4);
  expectOffline(false);
  const oldReady = { ...progress('ready'), updatedAt: new Date(Date.now() - 60_000).toISOString() };
  await act(async () => useStore.setState({ provisioningRuns: { run: oldReady } }));
  expect(aliveList).toHaveBeenCalledTimes(6);
  expectOffline(true);

  aliveList.mockResolvedValue([task.teamName]);
  await act(async () => useStore.setState({ teams: [team] }));
  expectOffline(false);
  expect(aliveList).toHaveBeenCalledTimes(8);
  await act(async () => useStore.setState({ teams: [{ ...team }] }));
  expect(aliveList).toHaveBeenCalledTimes(8);
});
