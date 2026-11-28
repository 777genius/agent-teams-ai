import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  state: { activeContextId: 'local', repositoryGroups: [],
    projects: [{ id: 'project-a', path: '/TEST/a', name: 'A' }, { id: 'project-b', path: '/TEST/b', name: 'B' }],
    selectedRepositoryId: null, selectedWorktreeId: null, selectedProjectId: 'project-a',
    activeProjectId: 'project-a', selectedTeamName: null, teamByName: {},
    provisioningRuns: {}, currentProvisioningRunIdByTeam: {}, provisioningErrorByTeam: {} },
  getView: vi.fn(), history: vi.fn(), byIds: vi.fn(), project: vi.fn(),
}));
vi.mock('@renderer/store', () => ({
  useStore: Object.assign((selector: (value: typeof mocks.state) => unknown) => selector(mocks.state), {
    getState: () => mocks.state,
  }),
}));
vi.mock('@renderer/api', () => ({ api: {
  getSessionsByIds: mocks.byIds, getSessionsPaginated: mocks.project,
  teams: { getProjectContextView: mocks.getView, getHostTeamSessions: mocks.history,
    onProvisioningProgress: () => () => undefined },
} }));
vi.mock('@features/localization/renderer', () => ({ useAppTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@renderer/store/slices/teamSlice', () => ({ isTeamProvisioningActive: () => false }));
vi.mock('@renderer/store/team/teamViewVisibility', () => ({
  registerFocusedProjectTeam: () => () => undefined, registerVisiblePhysicalTeam: () => () => undefined,
}));
vi.mock('@renderer/store/team/projectAliasTaskNavigation', () => ({ redirectProjectAliasTaskNavigation: vi.fn() }));
vi.mock('@renderer/components/team/definitionEdit/TeamDefinitionEditDialog', () => ({ TeamDefinitionEditDialog: () => null }));
vi.mock('@renderer/components/team/TeamProvisioningBanner', () => ({ TeamProvisioningBanner: () => null }));
vi.mock('@renderer/components/team/TeamDetailView', async () => {
  const { useTeamSessionHistory } = await import('@renderer/components/team/useTeamSessionHistory');
  return { TeamDetailView: ({ teamName }: { teamName: string }) => {
    const value = useTeamSessionHistory({ teamName, projectId: 'shared-legacy-project',
      leadSessionId: null, isActive: true });
    return React.createElement('div', { 'data-read-team': teamName },
      value.sessionsError ?? value.sessions.map(row => row.id).join(','));
  } };
});

import { hostTeamSelectionKey } from '@features/agent-backend/contracts';
import { ProjectScopedTeamDetailView } from '@renderer/components/team/ProjectScopedTeamDetailView';
import { useTeamSessionHistory } from '@renderer/components/team/useTeamSessionHistory';

import type { BackendTeamSessionHistory } from '@features/agent-backend/contracts';

const session = (letter: string): BackendTeamSessionHistory => ({
  kind: 'team-session-history', revision: letter.repeat(64), sessions: [{
    kind: 'host_session', id: 'host-session-' + letter.repeat(64), startedAt: 1000,
    window: { start: 1000, end: null }, clock: 'qualified', members: 1, generations: 1,
    isOngoing: false, gaps: [],
  }],
});
let node: HTMLDivElement, root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.state.activeContextId = 'local'; mocks.state.selectedProjectId = 'project-a';
  mocks.history.mockReset(); mocks.getView.mockReset(); mocks.byIds.mockReset(); mocks.project.mockReset();
  mocks.project.mockResolvedValue({ sessions: [{ id: 'FOREIGN shared-project session', createdAt: 1000 }] });
  node = document.createElement('div'); document.body.appendChild(node); root = createRoot(node);
});
afterEach(async () => { await act(async () => root.unmount()); node.remove(); vi.unstubAllGlobals(); });
it('logical project Teams read only the chosen execution history and ignore the prior project response', async () => {
  const logical = hostTeamSelectionKey('logical'), a = hostTeamSelectionKey('physical-a'), b = hostTeamSelectionKey('physical-b');
  let finishA!: (value: BackendTeamSessionHistory) => void;
  mocks.getView.mockImplementation(async (_logical: string, path: string) => ({
    mode: 'per_project', state: 'ready', workContextId: 'work-' + path,
    executionTeamName: path === '/TEST/a' ? a : b, projectPath: path,
  }));
  mocks.history.mockImplementation((name: string) => name === a
    ? new Promise<BackendTeamSessionHistory>(resolve => { finishA = resolve; }) : Promise.resolve(session('b')));
  await act(async () => root.render(<ProjectScopedTeamDetailView teamName={logical} />));
  expect(mocks.history).toHaveBeenCalledWith(a);
  expect(mocks.history).not.toHaveBeenCalledWith(logical);
  mocks.state.selectedProjectId = 'project-b';
  await act(async () => root.render(<ProjectScopedTeamDetailView teamName={logical} />));
  expect(mocks.history).toHaveBeenCalledWith(b);
  expect(node.textContent).toContain(session('b').sessions[0]!.id);
  await act(async () => finishA(session('a')));
  expect(node.textContent).not.toContain(session('a').sessions[0]!.id);
  expect(node.textContent).not.toContain('FOREIGN');
  expect(node.querySelector('[data-read-team]')?.getAttribute('data-read-team')).toBe(b);
  expect(mocks.byIds).not.toHaveBeenCalled(); expect(mocks.project).not.toHaveBeenCalled();
});
it('the same Host key in another connection drops the old list and never falls back on errors or emptiness', async () => {
  const teamName = hostTeamSelectionKey('same-physical-team');
  function View() {
    const value = useTeamSessionHistory({ teamName, projectId: 'shared-legacy-project',
      leadSessionId: null, isActive: true });
    return <div>{value.sessionsError ?? value.sessions.map(row => row.id).join(',')}</div>;
  }
  let finishLocal!: (value: BackendTeamSessionHistory) => void;
  mocks.history.mockImplementationOnce(() => new Promise(resolve => { finishLocal = resolve; }))
    .mockResolvedValueOnce(session('c'));
  await act(async () => root.render(<View />));
  mocks.state.activeContextId = 'remote';
  await act(async () => root.render(<View />));
  expect(node.textContent).toContain(session('c').sessions[0]!.id);
  await act(async () => finishLocal(session('a')));
  expect(node.textContent).not.toContain(session('a').sessions[0]!.id);
  mocks.state.activeContextId = 'unavailable';
  mocks.history.mockRejectedValueOnce(new Error('Original owner unavailable'));
  await act(async () => root.render(<View />));
  expect(node.textContent).toContain('Original owner unavailable');
  mocks.state.activeContextId = 'empty';
  mocks.history.mockResolvedValueOnce({ kind: 'team-session-history', revision: 'd'.repeat(64), sessions: [] });
  await act(async () => root.render(<View />));
  expect(node.textContent).toBe('');
  expect(mocks.byIds).not.toHaveBeenCalled(); expect(mocks.project).not.toHaveBeenCalled();
});
