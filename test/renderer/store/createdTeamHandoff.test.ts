import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { captureCreatedTeamHandoff } from '../../../src/renderer/components/team/dialogs/createdTeamHandoff';
import {
  invalidateContextScopedRequestEpoch,
  resetContextScopedRequestEpochForTests,
} from '../../../src/renderer/store/utils/contextScopedRequestEpoch';

import { createTestStore } from './storeTestUtils';

import type { AppState } from '../../../src/renderer/store/types';
import type { RepositoryGroup } from '../../../src/renderer/types/data';

const apiMock = vi.hoisted(() => ({
  getRepositoryGroups: vi.fn(),
  teams: { list: vi.fn() },
  config: { addCustomProjectPath: vi.fn() },
}));
vi.mock('@renderer/api', () => ({ api: apiMock, isElectronMode: () => false }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const savedTeam = {
  teamName: 'host-team:TEST-created',
  displayName: 'TEST Created',
  description: '',
  memberCount: 0,
  taskCount: 0,
  lastActivity: null,
  projectContextMode: 'per_project' as const,
  ownerResourceRef: 'TEST-original-owner',
  projectPath: '/TEST/new-project',
};
const group: RepositoryGroup = {
  id: 'TEST-new-project',
  identity: null,
  name: 'TEST new project',
  totalSessions: 0,
  worktrees: [
    {
      id: 'TEST-new-worktree',
      path: '/TEST/new-project',
      name: 'TEST new project',
      isMainWorktree: true,
      source: 'unknown',
      sessions: [],
      totalSessions: 0,
      createdAt: 0,
    },
  ],
};

function fixture(
  options: {
    mode?: 'shared' | 'per_project';
    presentation?: 'page' | 'dialog';
    initial?: Partial<AppState>;
    unmountOnClose?: boolean;
  } = {}
) {
  const store = createTestStore();
  store.setState({
    activeContextId: 'local',
    isContextSwitching: false,
    teams: [savedTeam],
    teamByName: { [savedTeam.teamName]: savedTeam },
    fetchSessionsInitial: vi.fn(async () => undefined),
    selectTeam: vi.fn(async () => undefined),
    ...options.initial,
  });
  store.getState().openTeamsCreationPage();
  const page = store.getState().getActiveTab();
  if (!page) throw new Error('TEST Create page was not opened');
  const tabId = page.id;
  let generation = 0;
  let mounted = true;
  let subscriptions = 0;
  const subscribe: typeof store.subscribe = (listener) => {
    subscriptions++;
    const stop = store.subscribe(listener);
    let subscribed = true;
    return () => {
      if (subscribed) {
        subscribed = false;
        subscriptions--;
        stop();
      }
    };
  };
  const resetForm = vi.fn(async () => {
    generation++;
  });
  const resetDraft = vi.fn(async () => undefined);
  const onClose = vi.fn(() => {
    store.getState().closeTeamsCreationPage(tabId);
    if (options.unmountOnClose) mounted = false;
  });
  const onOpenTeam = vi.fn((name: string, cwd?: string) => store.getState().openTeamTab(name, cwd));
  const finish = captureCreatedTeamHandoff({
    presentation: options.presentation ?? 'page',
    projectContextMode: options.mode ?? 'per_project',
    getGeneration: () => generation,
    isGenerationCurrent: (expected) => generation === expected,
    ownsPage: (expected) => mounted && generation === expected,
    getState: store.getState,
    subscribe,
    resetDraft,
    resetForm,
    onClose,
    onOpenTeam,
  });
  return {
    store,
    finish,
    resetForm,
    resetDraft,
    onClose,
    onOpenTeam,
    tabId,
    advanceGeneration: () => {
      generation++;
    },
    getSubscriptions: () => subscriptions,
  };
}

describe('accepted Create project handoff', () => {
  beforeEach(() => {
    resetContextScopedRequestEpochForTests();
    apiMock.getRepositoryGroups.mockReset().mockResolvedValue([]);
    apiMock.teams.list.mockReset().mockResolvedValue([savedTeam]);
    apiMock.config.addCustomProjectPath.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => {
    resetContextScopedRequestEpochForTests();
    vi.restoreAllMocks();
  });

  it('preserves the accepted Team intent through the real ordinary creation-page close', async () => {
    const f = fixture();
    const catalog = deferred<RepositoryGroup[]>();
    apiMock.getRepositoryGroups.mockReturnValueOnce(catalog.promise);
    await f.finish(savedTeam.teamName, savedTeam.projectPath);
    expect(f.onClose).toHaveBeenCalledTimes(1);
    expect(
      f.store
        .getState()
        .getAllPaneTabs()
        .find((tab) => tab.id === f.tabId)?.teamsCreationPage
    ).toBe(false);
    catalog.resolve([group]);
    await vi.waitFor(() => expect(f.store.getState().repositoryGroupsLoading).toBe(false));
    expect(f.store.getState().getActiveTab()).toMatchObject({
      type: 'team',
      teamName: savedTeam.teamName,
    });
    expect(f.store.getState().selectedProjectId).toBe('TEST-new-worktree');
    expect(f.resetForm).toHaveBeenCalledTimes(1);
    expect(f.onOpenTeam).toHaveBeenCalledTimes(1);
  });

  it('does not reset or navigate a successor context when an earlier accepted result arrives', async () => {
    const f = fixture();
    invalidateContextScopedRequestEpoch();
    f.store.setState({ activeContextId: 'TEST-successor' });
    await f.finish(savedTeam.teamName, savedTeam.projectPath);
    expect(f.resetForm).not.toHaveBeenCalled();
    expect(f.resetDraft).not.toHaveBeenCalled();
    expect(f.onClose).not.toHaveBeenCalled();
    expect(f.onOpenTeam).not.toHaveBeenCalled();
    expect(apiMock.config.addCustomProjectPath).not.toHaveBeenCalled();
    expect(apiMock.teams.list).not.toHaveBeenCalled();
  });

  it('does not mistake a superseded background list for its own fresh accepted-Team read', async () => {
    const f = fixture({
      initial: { repositoryGroups: [group], repositoryGroupsInitialized: true },
    });
    const handoff = deferred<(typeof savedTeam)[]>(),
      successor = deferred<(typeof savedTeam)[]>();
    apiMock.teams.list.mockReturnValueOnce(handoff.promise).mockReturnValueOnce(successor.promise);
    const completion = f.finish(savedTeam.teamName, savedTeam.projectPath);
    expect(apiMock.teams.list).toHaveBeenCalledTimes(1);
    const newer = f.store.getState().fetchTeams();
    expect(f.store.getState().teamsLoading).toBe(false);
    handoff.resolve([savedTeam]);
    await completion;
    expect(f.onOpenTeam).not.toHaveBeenCalled();
    expect(apiMock.config.addCustomProjectPath).not.toHaveBeenCalled();
    expect(f.onClose).toHaveBeenCalledTimes(1);
    successor.resolve([]);
    await newer;
    expect(f.onOpenTeam).not.toHaveBeenCalled();
  });

  it('continues the exact intended close even when closing synchronously unmounts the editor', async () => {
    const f = fixture({
      unmountOnClose: true,
      initial: { repositoryGroups: [group], repositoryGroupsInitialized: true },
    });
    await f.finish(savedTeam.teamName, savedTeam.projectPath);
    expect(f.onOpenTeam).toHaveBeenCalledExactlyOnceWith(savedTeam.teamName, savedTeam.projectPath);
    expect(f.store.getState().getActiveTab()).toMatchObject({
      type: 'team',
      teamName: savedTeam.teamName,
    });
    expect(f.getSubscriptions()).toBe(0);
  });

  it('drains the actual initial Team list before admitting its own fresh list', async () => {
    const f = fixture({
      initial: {
        teams: [],
        teamByName: {},
        repositoryGroups: [group],
        repositoryGroupsInitialized: true,
      },
    });
    const initial = deferred<(typeof savedTeam)[]>(),
      fresh = deferred<(typeof savedTeam)[]>();
    apiMock.teams.list.mockReturnValueOnce(initial.promise).mockReturnValueOnce(fresh.promise);
    const firstRead = f.store.getState().fetchTeams();
    const completion = f.finish(savedTeam.teamName, savedTeam.projectPath);
    expect(apiMock.teams.list).toHaveBeenCalledTimes(1);
    expect(f.onClose).not.toHaveBeenCalled();
    initial.resolve([]);
    await firstRead;
    await vi.waitFor(() => expect(apiMock.teams.list).toHaveBeenCalledTimes(2));
    expect(f.onOpenTeam).not.toHaveBeenCalled();
    fresh.resolve([savedTeam]);
    await completion;
    expect(f.onOpenTeam).toHaveBeenCalledTimes(1);
    expect(f.getSubscriptions()).toBe(0);
  });

  it('does not join a reentrant initial read as if that read were its fresh publication', async () => {
    const f = fixture({
      initial: {
        teams: [],
        teamByName: {},
        repositoryGroups: [group],
        repositoryGroupsInitialized: true,
      },
    });
    const initial = deferred<(typeof savedTeam)[]>(),
      reentrant = deferred<(typeof savedTeam)[]>(),
      fresh = deferred<(typeof savedTeam)[]>();
    apiMock.teams.list
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(reentrant.promise)
      .mockReturnValueOnce(fresh.promise);
    const firstRead = f.store.getState().fetchTeams();
    let reentrantRead: Promise<void> | undefined;
    const stop = f.store.subscribe((state) => {
      if (state.teamsLoading) return;
      stop();
      reentrantRead = state.fetchTeams();
    });
    const completion = f.finish(savedTeam.teamName, savedTeam.projectPath);
    initial.resolve([]);
    await firstRead;
    expect(apiMock.teams.list).toHaveBeenCalledTimes(2);
    expect(f.onClose).not.toHaveBeenCalled();
    reentrant.resolve([]);
    await reentrantRead;
    await vi.waitFor(() => expect(apiMock.teams.list).toHaveBeenCalledTimes(3));
    expect(f.onOpenTeam).not.toHaveBeenCalled();
    fresh.resolve([savedTeam]);
    await completion;
    expect(f.onOpenTeam).toHaveBeenCalledTimes(1);
    expect(f.getSubscriptions()).toBe(0);
  });

  it.each(['missing', 'error', 'unavailable', 'different saved path'] as const)(
    'retires the accepted form without registration or replay when the fresh target is %s',
    async (reason) => {
      const f = fixture();
      const expectedError =
        reason === 'error'
          ? vi.spyOn(console, 'error').mockImplementation(() => undefined)
          : undefined;
      if (reason === 'missing') apiMock.teams.list.mockResolvedValueOnce([]);
      if (reason === 'error')
        apiMock.teams.list.mockRejectedValueOnce(new Error('TEST current list failed'));
      if (reason === 'unavailable')
        apiMock.teams.list.mockResolvedValueOnce({
          items: [savedTeam],
          unavailable: [
            {
              kind: 'owner',
              ownerResourceRef: savedTeam.ownerResourceRef,
              code: 'unavailable',
              outcome: 'unknown',
            },
          ],
        });
      if (reason === 'different saved path')
        apiMock.teams.list.mockResolvedValueOnce([{ ...savedTeam, projectPath: '/TEST/other' }]);
      await expect(f.finish(savedTeam.teamName, savedTeam.projectPath)).resolves.toBeUndefined();
      expect(f.resetForm).toHaveBeenCalledTimes(1);
      expect(f.onClose).toHaveBeenCalledTimes(1);
      expect(f.onOpenTeam).not.toHaveBeenCalled();
      expect(apiMock.config.addCustomProjectPath).not.toHaveBeenCalled();
      expect(apiMock.getRepositoryGroups).not.toHaveBeenCalled();
      expect(apiMock.teams.list).toHaveBeenCalledTimes(1);
      if (expectedError) {
        expect(expectedError).toHaveBeenCalledTimes(1);
        expect(expectedError.mock.calls[0]?.join(' ')).toContain(
          '[team:list] TEST current list failed'
        );
      }
      expect(f.getSubscriptions()).toBe(0);
    }
  );

  it('does not use an unavailable retained notice row as membership in the actual fresh list', async () => {
    const f = fixture({
      initial: {
        teamManagementNoticeByTeam: {
          [savedTeam.teamName]: {
            kind: 'edited',
            operationId: 'TEST-notice',
            committedAt: '2026-11-26T00:00:00Z',
            changedFields: ['description'],
            context: {
              appInstanceId: 'TEST-app',
              dataRootFingerprint: 'TEST-root',
              connectionGeneration: 1,
            },
          },
        },
      },
    });
    apiMock.teams.list.mockResolvedValueOnce({
      items: [],
      unavailable: [
        {
          kind: 'owner',
          ownerResourceRef: savedTeam.ownerResourceRef,
          code: 'unavailable',
          outcome: 'unknown',
        },
      ],
    });
    await f.finish(savedTeam.teamName, savedTeam.projectPath);
    expect(f.store.getState().teamByName[savedTeam.teamName]).toBeDefined();
    expect(f.onClose).toHaveBeenCalledTimes(1);
    expect(f.onOpenTeam).not.toHaveBeenCalled();
    expect(apiMock.config.addCustomProjectPath).not.toHaveBeenCalled();
  });

  it('does not convert an optional witness failure into a Team-list error', async () => {
    const f = fixture();
    const observed = vi.fn(() => {
      throw new Error('TEST witness failure');
    });
    await f.store.getState().fetchTeams({ onCurrentRead: observed });
    expect(observed).toHaveBeenCalledExactlyOnceWith([savedTeam]);
    expect(f.store.getState().teamsError).toBeNull();
    expect(f.store.getState().teamByName[savedTeam.teamName]).toMatchObject(savedTeam);
    f.finish.dispose();
  });

  it('does not attest the source list after a synchronous publication subscriber starts a newer read', async () => {
    const f = fixture({ initial: { teams: [], teamByName: {} } });
    const newer = deferred<(typeof savedTeam)[]>();
    apiMock.teams.list.mockResolvedValueOnce([savedTeam]).mockReturnValueOnce(newer.promise);
    let second: Promise<void> | undefined;
    const stop = f.store.subscribe((state) => {
      if (!state.teamByName[savedTeam.teamName]) return;
      stop();
      second = state.fetchTeams();
    });
    const observed = vi.fn();
    await f.store.getState().fetchTeams({ onCurrentRead: observed });
    expect(apiMock.teams.list).toHaveBeenCalledTimes(2);
    expect(observed).not.toHaveBeenCalled();
    newer.resolve([savedTeam]);
    await second;
    f.finish.dispose();
  });

  it('keeps an accepted result successful when its later path registration rejects', async () => {
    const f = fixture({ initial: { repositoryGroupsInitialized: true } });
    apiMock.config.addCustomProjectPath.mockRejectedValueOnce(new Error('TEST register failed'));
    await expect(f.finish(savedTeam.teamName, savedTeam.projectPath)).resolves.toBeUndefined();
    expect(f.onClose).toHaveBeenCalledTimes(1);
    expect(f.onOpenTeam).toHaveBeenCalledTimes(1);
    expect(apiMock.config.addCustomProjectPath).toHaveBeenCalledTimes(1);
    expect(apiMock.getRepositoryGroups).not.toHaveBeenCalled();
    expect(apiMock.teams.list).toHaveBeenCalledTimes(1);
    expect(f.store.getState().teamByName[savedTeam.teamName]).toMatchObject(savedTeam);
  });

  it('irreversibly retires an A-to-B-to-A context while the accepted list is pending', async () => {
    const f = fixture();
    const read = deferred<(typeof savedTeam)[]>();
    apiMock.teams.list.mockReturnValueOnce(read.promise);
    const completion = f.finish(savedTeam.teamName, savedTeam.projectPath);
    f.store.setState({ activeContextId: 'ssh-TEST' });
    f.store.setState({ activeContextId: 'local' });
    read.resolve([savedTeam]);
    await completion;
    expect(f.resetForm).not.toHaveBeenCalled();
    expect(f.onClose).not.toHaveBeenCalled();
    expect(f.onOpenTeam).not.toHaveBeenCalled();
    expect(apiMock.config.addCustomProjectPath).not.toHaveBeenCalled();
    expect(f.getSubscriptions()).toBe(0);
  });

  it('releases its passive initial-list waiter when disposed before an accepted result', async () => {
    const f = fixture({ initial: { teams: [], teamByName: {} } });
    const initial = deferred<(typeof savedTeam)[]>();
    apiMock.teams.list.mockReturnValueOnce(initial.promise);
    const read = f.store.getState().fetchTeams();
    const completion = f.finish(savedTeam.teamName, savedTeam.projectPath);
    expect(f.getSubscriptions()).toBe(2);
    f.finish.dispose();
    await completion;
    expect(f.getSubscriptions()).toBe(0);
    expect(f.resetForm).not.toHaveBeenCalled();
    initial.resolve([savedTeam]);
    await read;
    expect(apiMock.teams.list).toHaveBeenCalledTimes(1);
    expect(f.onOpenTeam).not.toHaveBeenCalled();
  });

  it('refuses a different owner or target published while resetting the accepted form', async () => {
    const f = fixture();
    f.resetForm.mockImplementation(async () => {
      f.advanceGeneration();
      f.store.setState({
        teamByName: { [savedTeam.teamName]: { ...savedTeam, ownerResourceRef: 'TEST-new-owner' } },
      });
    });
    await f.finish(savedTeam.teamName, savedTeam.projectPath);
    expect(f.resetForm).toHaveBeenCalledTimes(1);
    expect(f.onClose).not.toHaveBeenCalled();
    expect(f.onOpenTeam).not.toHaveBeenCalled();
    expect(f.getSubscriptions()).toBe(0);
  });

  it('does not let the intended close authorize a synchronously selected successor tab', async () => {
    const f = fixture();
    const stop = f.store.subscribe((state) => {
      const page = state.getAllPaneTabs().find((tab) => tab.id === f.tabId);
      if (page?.teamsCreationPage !== false) return;
      stop();
      state.openTeamTab('TEST-successor');
    });
    await f.finish(savedTeam.teamName, savedTeam.projectPath);
    expect(f.onClose).toHaveBeenCalledTimes(1);
    expect(f.onOpenTeam).not.toHaveBeenCalled();
    expect(f.store.getState().getActiveTab()).toMatchObject({
      type: 'team',
      teamName: 'TEST-successor',
    });
    expect(apiMock.config.addCustomProjectPath).not.toHaveBeenCalled();
  });

  it.each(['shared', 'no cwd', 'dialog'] as const)(
    'preserves the original accepted completion for %s',
    async (variant) => {
      const f = fixture({
        mode: variant === 'shared' ? 'shared' : 'per_project',
        presentation: variant === 'dialog' ? 'dialog' : 'page',
      });
      f.onOpenTeam.mockImplementation(() => undefined);
      await f.finish(savedTeam.teamName, variant === 'no cwd' ? undefined : savedTeam.projectPath);
      expect(apiMock.teams.list).not.toHaveBeenCalled();
      expect(f.resetForm).toHaveBeenCalledTimes(1);
      expect(f.onOpenTeam).toHaveBeenCalledTimes(1);
      expect(f.onClose).toHaveBeenCalledTimes(1);
      expect(f.onOpenTeam.mock.invocationCallOrder[0]).toBeLessThan(
        f.onClose.mock.invocationCallOrder[0]
      );
      expect(f.getSubscriptions()).toBe(0);
    }
  );
});
