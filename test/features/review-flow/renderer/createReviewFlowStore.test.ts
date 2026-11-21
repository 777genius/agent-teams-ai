import { describe, expect, it, vi } from 'vitest';

import { createReviewFlowStore } from '../../../../src/features/review-flow/renderer/state/createReviewFlowStore';

import type { ReviewFlowElectronApi } from '../../../../src/features/review-flow/contracts/api';
import type {
  ReviewFlowOverview,
  ReviewFlowSettings,
} from '../../../../src/features/review-flow/contracts/types';

const human: ReviewFlowSettings = { reviewFlow: 'human_approval', reviewFlowPrompt: '' };
const agent: ReviewFlowSettings = { reviewFlow: 'agent_approval', reviewFlowPrompt: '' };

/** Main as the store sees it: what a save writes is what the next read returns. */
function createApi(
  overrides: Partial<ReviewFlowElectronApi> = {},
  saved: ReviewFlowOverview = {
    defaults: agent,
    overrides: { alpha: human },
    unreadableTeams: [],
    projectTeams: {},
  }
): ReviewFlowElectronApi {
  return {
    getOverview: vi.fn(() => Promise.resolve(structuredClone(saved))),
    setDefaults: vi.fn((settings: ReviewFlowSettings) => {
      saved.defaults = settings;
      delete saved.defaultsError;
      return Promise.resolve(settings);
    }),
    setTeamOverride: vi.fn((team: string, settings: ReviewFlowSettings | null) => {
      if (settings) saved.overrides[team] = settings;
      else delete saved.overrides[team];
      saved.unreadableTeams = saved.unreadableTeams.filter((name) => name !== team);
      return Promise.resolve(settings);
    }),
    ...overrides,
  };
}

describe('review flow store', () => {
  it('loads once and serves later calls from memory unless forced', async () => {
    const api = createApi();
    const store = createReviewFlowStore({ getApi: () => api });
    await Promise.all([store.getState().load(), store.getState().load()]);
    expect(api.getOverview).toHaveBeenCalledTimes(1);
    expect(store.getState()).toMatchObject({ status: 'ready', overrides: { alpha: human } });

    await store.getState().load();
    expect(api.getOverview).toHaveBeenCalledTimes(1);
    await store.getState().load({ force: true });
    expect(api.getOverview).toHaveBeenCalledTimes(2);
  });

  it('reports a failed first load and recovers on retry', async () => {
    const getOverview = vi
      .fn<ReviewFlowElectronApi['getOverview']>()
      .mockRejectedValueOnce(new Error('disk unreadable'))
      .mockResolvedValue({ defaults: human, overrides: {}, unreadableTeams: [], projectTeams: {} });
    const store = createReviewFlowStore({ getApi: () => createApi({ getOverview }) });
    await store.getState().load();
    expect(store.getState()).toMatchObject({ status: 'error', error: 'disk unreadable' });
    await store.getState().load();
    expect(store.getState()).toMatchObject({ status: 'ready', defaults: human, error: null });
  });

  it('keeps showing good data when a background refresh fails', async () => {
    const getOverview = vi
      .fn<ReviewFlowElectronApi['getOverview']>()
      .mockResolvedValueOnce({
        defaults: human,
        overrides: {},
        unreadableTeams: [],
        projectTeams: {},
      })
      .mockRejectedValueOnce(new Error('boom'));
    const store = createReviewFlowStore({ getApi: () => createApi({ getOverview }) });
    await store.getState().load();
    await store.getState().load({ force: true });
    expect(store.getState()).toMatchObject({ status: 'ready', defaults: human });
  });

  it('applies saved team overrides and removals, and tells the app which team changed', async () => {
    const onTeamOverrideChanged = vi.fn();
    const api = createApi();
    const store = createReviewFlowStore({ getApi: () => api, onTeamOverrideChanged });
    await store.getState().load();

    await store.getState().saveTeamOverride('beta', human);
    expect(store.getState().overrides).toEqual({ alpha: human, beta: human });
    await store.getState().saveTeamOverride('alpha', null);
    expect(store.getState().overrides).toEqual({ beta: human });
    expect(onTeamOverrideChanged.mock.calls).toEqual([['beta'], ['alpha']]);
  });

  it('keeps a successful project-team save visible when the refresh fails', async () => {
    const projects = [{ executionTeamName: 'ptc-a', projectPath: '/a' }];
    const getOverview = vi.fn<ReviewFlowElectronApi['getOverview']>()
      .mockResolvedValueOnce({ defaults: agent, overrides: {}, unreadableTeams: ['ptc-a'],
        projectTeams: { builders: { saved: true, settings: null, projects } } })
      .mockRejectedValue(new Error('unavailable'));
    const api = createApi({ getOverview, setTeamOverride: vi.fn(async () => human) });
    const store = createReviewFlowStore({ getApi: () => api });
    await store.getState().load();
    await store.getState().saveTeamOverride('builders', human);
    expect(store.getState()).toMatchObject({ overrides: { builders: human, 'ptc-a': human },
      unreadableTeams: [], projectTeams: { builders: { saved: true, settings: human, projects } } });
  });

  it('re-reads main and rethrows when a save is rejected', async () => {
    const api = createApi({
      setTeamOverride: vi.fn(() => Promise.reject(new Error('write failed'))),
    });
    const onTeamOverrideChanged = vi.fn();
    const store = createReviewFlowStore({ getApi: () => api, onTeamOverrideChanged });
    await store.getState().load();

    await expect(store.getState().saveTeamOverride('beta', human)).rejects.toThrow('write failed');
    expect(store.getState().overrides).toEqual({ alpha: human });
    expect(api.getOverview).toHaveBeenCalledTimes(2);
    expect(onTeamOverrideChanged).not.toHaveBeenCalled();
  });

  it('shows what a per-project team saved even when some of its project boards failed', async () => {
    const projects = [
      { executionTeamName: 'ptc-a', projectPath: '/projects/a' },
      { executionTeamName: 'ptc-b', projectPath: '/projects/b' },
    ];
    const main: ReviewFlowOverview = {
      defaults: agent,
      overrides: { 'ptc-a': agent, 'ptc-b': agent },
      unreadableTeams: [],
      projectTeams: { builders: { saved: false, settings: null, projects } },
    };
    const api = createApi(
      {
        // The team and one board are written, the other board is not.
        setTeamOverride: vi.fn(async (team: string, settings: ReviewFlowSettings | null) => {
          main.projectTeams[team] = {
            saved: true,
            settings,
            projects: main.projectTeams[team].projects,
          };
          main.overrides['ptc-a'] = human;
          throw new Error('not applied in /projects/b');
        }),
      },
      main
    );
    const store = createReviewFlowStore({ getApi: () => api });
    await store.getState().load();

    await expect(store.getState().saveTeamOverride('builders', human)).rejects.toThrow(
      'not applied in /projects/b'
    );
    expect(store.getState()).toMatchObject({
      projectTeams: { builders: { saved: true, settings: human, projects } },
      overrides: { 'ptc-a': human, 'ptc-b': agent },
    });
  });

  it('stores the normalized defaults returned by the main process', async () => {
    const api = createApi({
      setDefaults: vi.fn(() =>
        Promise.resolve({ reviewFlow: 'human_approval', reviewFlowPrompt: 'trimmed' } as const)
      ),
    });
    const store = createReviewFlowStore({ getApi: () => api });
    await store
      .getState()
      .saveDefaults({ reviewFlow: 'human_approval', reviewFlowPrompt: '  trimmed  ' });
    expect(store.getState().defaults.reviewFlowPrompt).toBe('trimmed');
  });

  it('never lets a load that started before a save overwrite the saved value', async () => {
    let releaseStale!: (overview: ReviewFlowOverview) => void;
    const stale = new Promise<ReviewFlowOverview>((resolve) => {
      releaseStale = resolve;
    });
    const getOverview = vi
      .fn<ReviewFlowElectronApi['getOverview']>()
      .mockReturnValueOnce(stale)
      // The retry reads the disk after the save, so it already holds the saved value.
      .mockResolvedValue({ defaults: human, overrides: {}, unreadableTeams: [], projectTeams: {} });
    const api = createApi({ getOverview });
    const store = createReviewFlowStore({ getApi: () => api });

    const loading = store.getState().load();
    await store.getState().saveDefaults(human);
    // The old read, taken before the save, finally resolves with the previous default.
    releaseStale({ defaults: agent, overrides: {}, unreadableTeams: [], projectTeams: {} });
    await loading;

    expect(getOverview).toHaveBeenCalledTimes(2);
    expect(store.getState()).toMatchObject({ status: 'ready', defaults: human });
  });

  it('gives up with an error instead of looping when saves keep racing a first load', async () => {
    let calls = 0;
    const store = createReviewFlowStore({
      getApi: () =>
        createApi({
          getOverview: vi.fn(async () => {
            calls += 1;
            await store.getState().saveDefaults(human);
            return { defaults: agent, overrides: {}, unreadableTeams: [], projectTeams: {} };
          }),
        }),
    });
    await store.getState().load();
    expect(calls).toBe(3);
    expect(store.getState().status).toBe('error');
  });

  it('exposes broken saved state and clears it once repaired', async () => {
    const api = createApi(
      {},
      {
        defaults: agent,
        defaultsError: 'defaults file is corrupt',
        overrides: {},
        unreadableTeams: ['alpha', 'beta'],
        projectTeams: {},
      }
    );
    const store = createReviewFlowStore({ getApi: () => api });
    await store.getState().load();
    expect(store.getState()).toMatchObject({
      defaultsError: 'defaults file is corrupt',
      unreadableTeams: ['alpha', 'beta'],
    });

    await store.getState().saveTeamOverride('alpha', null);
    expect(store.getState().unreadableTeams).toEqual(['beta']);
    await store.getState().saveTeamOverride('beta', human);
    expect(store.getState().unreadableTeams).toEqual([]);
    await store.getState().saveDefaults(agent);
    expect(store.getState().defaultsError).toBeNull();
  });
});
