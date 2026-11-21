import { create, type StoreApi, type UseBoundStore } from 'zustand';

import { BUILT_IN_REVIEW_FLOW_SETTINGS } from '../../core/domain/reviewFlowPolicy';

import type { ReviewFlowElectronApi } from '../../contracts/api';
import type {
  ReviewFlowOverview,
  ReviewFlowSettings,
  TeamReviewFlowOverrides,
} from '../../contracts/types';

export type ReviewFlowLoadStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface ReviewFlowStoreState {
  status: ReviewFlowLoadStatus;
  /** Built-in values until the first successful load. */
  defaults: ReviewFlowSettings;
  overrides: TeamReviewFlowOverrides;
  /** Set while the saved default cannot be read; saving a new default repairs it. */
  defaultsError: string | null;
  /** Teams whose saved settings are invalid; resetting them to the default repairs them. */
  unreadableTeams: string[];
  /** The setting saved with each team that keeps separate history per project. */
  projectTeams: ReviewFlowOverview['projectTeams'];
  /** Readable message of the last failed load; saves report through their rejection instead. */
  error: string | null;
  /** Loads once and then serves from memory; `force` revalidates without dropping the shown data. */
  load: (options?: { force?: boolean }) => Promise<void>;
  saveDefaults: (settings: ReviewFlowSettings) => Promise<void>;
  /** `null` removes the override so the team follows the default again. */
  saveTeamOverride: (teamName: string, settings: ReviewFlowSettings | null) => Promise<void>;
}

export interface ReviewFlowStoreDeps {
  /** Resolved on every call so tests and late-installed bridges are respected. */
  getApi: () => ReviewFlowElectronApi;
  /** Told after a team override changed, so open team data can pick it up. */
  onTeamOverrideChanged?: (teamName: string) => void;
}

export function toReadableMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

/** A load that keeps losing the race against saves gives up instead of looping forever. */
const MAX_LOAD_ATTEMPTS = 3;

/** The state after a team's override was saved (or removed); either outcome repairs unreadable settings. */
function withTeamOverride(
  state: ReviewFlowStoreState,
  teamName: string,
  saved: ReviewFlowSettings | null
): Pick<ReviewFlowStoreState, 'overrides' | 'unreadableTeams'> {
  const overrides = { ...state.overrides };
  if (saved) overrides[teamName] = saved;
  else delete overrides[teamName];
  return {
    overrides,
    unreadableTeams: state.unreadableTeams.filter((name) => name !== teamName),
  };
}

export function createReviewFlowStore(
  deps: ReviewFlowStoreDeps
): UseBoundStore<StoreApi<ReviewFlowStoreState>> {
  let inFlight: Promise<void> | null = null;
  /** Bumped by every successful save, so a load that started earlier can be recognised as stale. */
  let revision = 0;

  /** Reads the overview, retrying when a save landed meanwhile so old disk state never wins. */
  const readFreshOverview = async (): Promise<ReviewFlowOverview> => {
    for (let attempt = 0; attempt < MAX_LOAD_ATTEMPTS; attempt += 1) {
      const startedAt = revision;
      const overview = await deps.getApi().getOverview();
      if (revision === startedAt) return overview;
    }
    throw new Error('Review flow settings kept changing while loading');
  };

  return create<ReviewFlowStoreState>((set, get) => ({
    status: 'idle',
    defaults: { ...BUILT_IN_REVIEW_FLOW_SETTINGS },
    overrides: {},
    defaultsError: null,
    unreadableTeams: [],
    projectTeams: {},
    error: null,

    load: (options) => {
      if (inFlight) return inFlight;
      const { status } = get();
      if (status === 'ready' && !options?.force) return Promise.resolve();
      if (status !== 'ready') set({ status: 'loading', error: null });
      inFlight = readFreshOverview()
        .then(({ defaults, defaultsError, overrides, unreadableTeams, projectTeams }) =>
          set({
            status: 'ready',
            defaults,
            defaultsError: defaultsError ?? null,
            overrides,
            unreadableTeams,
            projectTeams,
            error: null,
          })
        )
        .catch((error: unknown) => {
          // A failed refresh keeps showing the last good data; only a first load becomes an error.
          if (get().status !== 'ready') set({ status: 'error', error: toReadableMessage(error) });
        })
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },

    saveDefaults: async (settings) => {
      const saved = await deps.getApi().setDefaults(settings);
      revision += 1;
      set({ defaults: saved, defaultsError: null });
    },

    saveTeamOverride: async (teamName, settings) => {
      try {
        const saved = await deps.getApi().setTeamOverride(teamName, settings);
        revision += 1;
        set((state) => withTeamOverride(state, teamName, saved));
        deps.onTeamOverrideChanged?.(teamName);
      } finally {
        // Main may have changed more than this entry: a team with separate history per project
        // also writes the board of each project, and keeps what it saved when one of them fails.
        revision += 1;
        await get().load({ force: true });
      }
    },
  }));
}
