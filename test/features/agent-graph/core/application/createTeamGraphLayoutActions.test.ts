import {
  createInitialTeamGraphLayoutState,
  createTeamGraphLayoutActions,
  type TeamGraphLayoutActions,
  type TeamGraphLayoutState,
  type TeamGraphLayoutStatePatch,
} from '@features/agent-graph';
import { describe, expect, it, vi } from 'vitest';
import { create } from 'zustand';

import type { StoreApi, UseBoundStore } from 'zustand';

type TeamGraphLayoutStore = TeamGraphLayoutState & TeamGraphLayoutActions;

function createLayoutStore(
  initialState: Partial<TeamGraphLayoutState> = {},
  warn = vi.fn()
): UseBoundStore<StoreApi<TeamGraphLayoutStore>> {
  return create<TeamGraphLayoutStore>()((set) => ({
    ...createInitialTeamGraphLayoutState(),
    ...initialState,
    ...createTeamGraphLayoutActions<TeamGraphLayoutStore>({
      setState: (updater) => set((state) => updater(state) ?? state),
      selectDefaultLayoutSeed: (_state, teamName) =>
        teamName === 'my-team'
          ? {
              orderedVisibleOwnerIds: ['alice', 'bob'],
              signature: 'alice|bob',
              assignments: {
                alice: { ringIndex: 0, sectorIndex: 0 },
                bob: { ringIndex: 0, sectorIndex: 1 },
              },
              duplicateStableOwnerIds: [],
            }
          : null,
      warn,
    }),
  }));
}

describe('createTeamGraphLayoutActions', () => {
  it('maps a refused domain transition to a diagnostic without mutating state', () => {
    let state: TeamGraphLayoutState = {
      ...createInitialTeamGraphLayoutState(),
      slotAssignmentsByTeam: {
        'my-team': {
          alice: { ringIndex: 0, sectorIndex: 0 },
          bob: { ringIndex: 0, sectorIndex: 1 },
        },
      },
    };
    const warn = vi.fn();
    const actions = createTeamGraphLayoutActions<TeamGraphLayoutState>({
      setState: (updater) => {
        const patch = updater(state);
        if (patch) {
          state = { ...state, ...patch };
        }
      },
      selectDefaultLayoutSeed: () => null,
      warn,
    });

    actions.setTeamGraphOwnerSlotAssignment('my-team', 'alice', {
      ringIndex: 0,
      sectorIndex: 1,
    });

    expect(state.slotAssignmentsByTeam['my-team']).toEqual({
      alice: { ringIndex: 0, sectorIndex: 0 },
      bob: { ringIndex: 0, sectorIndex: 1 },
    });
    expect(warn).toHaveBeenCalledWith(
      '[graph-layout] refusing occupied slot assignment team=my-team owner=alice target=0:1 occupiedBy=bob'
    );
  });

  it('returns null for unchanged and refused transitions so adapters can preserve identity', () => {
    const state: TeamGraphLayoutState = {
      ...createInitialTeamGraphLayoutState(),
      slotAssignmentsByTeam: {
        'my-team': {
          alice: { ringIndex: 0, sectorIndex: 0 },
          bob: { ringIndex: 0, sectorIndex: 1 },
        },
      },
    };
    const updates: (TeamGraphLayoutStatePatch | null)[] = [];
    const warn = vi.fn();
    const actions = createTeamGraphLayoutActions<TeamGraphLayoutState>({
      setState: (updater) => {
        updates.push(updater(state));
      },
      selectDefaultLayoutSeed: () => null,
      warn,
    });

    actions.setTeamGraphOwnerSlotAssignment('my-team', 'alice', {
      ringIndex: 0,
      sectorIndex: 0,
    });
    actions.setTeamGraphOwnerSlotAssignment('my-team', 'alice', {
      ringIndex: 0,
      sectorIndex: 1,
    });

    expect(updates).toEqual([null, null]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('warns once for an incomplete displacement without producing a patch', () => {
    const state: TeamGraphLayoutState = {
      ...createInitialTeamGraphLayoutState(),
      slotAssignmentsByTeam: {
        'my-team': {
          alice: { ringIndex: 0, sectorIndex: 0 },
          bob: { ringIndex: 0, sectorIndex: 1 },
        },
      },
    };
    const setState = vi.fn();
    const warn = vi.fn();
    const actions = createTeamGraphLayoutActions<TeamGraphLayoutState>({
      setState: (updater) => setState(updater(state)),
      selectDefaultLayoutSeed: () => null,
      warn,
    });

    actions.commitTeamGraphOwnerSlotDrop(
      'my-team',
      'alice',
      { ringIndex: 0, sectorIndex: 1 },
      'bob'
    );

    expect(setState).toHaveBeenCalledWith(null);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      '[graph-layout] refusing incomplete slot drop team=my-team owner=alice target=0:1'
    );
  });

  it('uses the latest visible-owner seed to materialize a generated-slot swap', () => {
    const store = createLayoutStore();

    store
      .getState()
      .commitTeamGraphOwnerSlotDrop('my-team', 'alice', { ringIndex: 4, sectorIndex: 1 }, 'bob', {
        ringIndex: 4,
        sectorIndex: 0,
      });

    expect(store.getState().slotAssignmentsByTeam['my-team']).toEqual({
      alice: { ringIndex: 4, sectorIndex: 1 },
      bob: { ringIndex: 4, sectorIndex: 0 },
    });
  });

  it('does not publish Zustand state for unchanged or refused transitions', () => {
    const warn = vi.fn();
    const store = createLayoutStore(
      {
        slotAssignmentsByTeam: {
          'my-team': {
            alice: { ringIndex: 0, sectorIndex: 0 },
            bob: { ringIndex: 0, sectorIndex: 1 },
          },
        },
        graphLayoutSessionByTeam: {
          'my-team': { mode: 'default', signature: 'alice|bob' },
        },
      },
      warn
    );
    const members = [
      { name: 'alice', agentId: 'alice' },
      { name: 'bob', agentId: 'bob' },
    ];
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    const expectNoPublication = (action: () => void): void => {
      const before = store.getState();
      listener.mockClear();
      action();
      expect(store.getState()).toBe(before);
      expect(listener).not.toHaveBeenCalled();
    };

    expectNoPublication(() => store.getState().ensureTeamGraphSlotAssignments('my-team', members));
    expectNoPublication(() =>
      store.getState().setTeamGraphOwnerSlotAssignment('my-team', 'alice', {
        ringIndex: 0,
        sectorIndex: 0,
      })
    );
    expectNoPublication(() =>
      store.getState().setTeamGraphLayoutMode('my-team', 'grid-under-lead')
    );
    expectNoPublication(() =>
      store.getState().swapTeamGraphOwnerSlots('my-team', 'alice', 'missing-owner')
    );
    expectNoPublication(() => store.getState().clearTeamGraphSlotAssignments('missing-team'));
    expectNoPublication(() => store.getState().resetTeamGraphSlotAssignmentsToDefaults('my-team'));
    expectNoPublication(() =>
      store.getState().setTeamGraphOwnerSlotAssignment('my-team', 'alice', {
        ringIndex: 0,
        sectorIndex: 1,
      })
    );

    expect(warn).toHaveBeenCalledOnce();
    unsubscribe();
  });

  it('composes interleaved action references against the latest Zustand state', () => {
    const store = createLayoutStore({
      gridOwnerOrderByTeam: {
        'my-team': ['alice', 'bob'],
      },
      slotAssignmentsByTeam: {
        'other-team': {
          tom: { ringIndex: 2, sectorIndex: 2 },
        },
      },
    });
    const paneA = store.getState();
    const paneB = store.getState();
    const otherTeamAssignments = store.getState().slotAssignmentsByTeam['other-team'];

    paneA.setTeamGraphOwnerSlotAssignment('my-team', 'alice', {
      ringIndex: 0,
      sectorIndex: 0,
    });
    paneB.setTeamGraphOwnerSlotAssignment('my-team', 'bob', {
      ringIndex: 0,
      sectorIndex: 1,
    });
    paneA.swapTeamGraphGridOwners('my-team', 'alice', 'bob');
    paneB.setTeamGraphOwnerSlotAssignment('my-team', 'alice', {
      ringIndex: 1,
      sectorIndex: 0,
    });
    paneA.setTeamGraphLayoutMode('my-team', 'radial');

    expect(store.getState().slotAssignmentsByTeam['my-team']).toEqual({
      alice: { ringIndex: 1, sectorIndex: 0 },
      bob: { ringIndex: 0, sectorIndex: 1 },
    });
    expect(store.getState().gridOwnerOrderByTeam['my-team']).toEqual(['bob', 'alice']);
    expect(store.getState().graphLayoutModeByTeam['my-team']).toBe('radial');
    expect(store.getState().slotAssignmentsByTeam['other-team']).toBe(otherTeamAssignments);
  });
});
