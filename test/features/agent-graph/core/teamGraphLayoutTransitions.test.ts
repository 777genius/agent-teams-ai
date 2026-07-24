import {
  assignTeamGraphOwnerSlot,
  changeTeamGraphLayoutMode,
  clearTeamGraphLayout,
  commitTeamGraphOwnerSlotDrop,
  createInitialTeamGraphLayoutState,
  ensureTeamGraphLayoutState,
  resetTeamGraphLayoutToDefaults,
  swapTeamGraphGridOwners,
  swapTeamGraphOwnerSlots,
  type TeamGraphLayoutState,
  type TeamGraphLayoutTransition,
} from '@features/agent-graph';
import { describe, expect, it } from 'vitest';

function applyTransition(
  state: TeamGraphLayoutState,
  transition: TeamGraphLayoutTransition
): TeamGraphLayoutState {
  return transition.kind === 'updated' ? { ...state, ...transition.patch } : state;
}

describe('team graph layout transitions', () => {
  it('creates isolated initial state containers', () => {
    const first = createInitialTeamGraphLayoutState();
    const second = createInitialTeamGraphLayoutState();

    expect(first).toEqual(second);
    expect(first.slotAssignmentsByTeam).not.toBe(second.slotAssignmentsByTeam);
    expect(first.graphLayoutSessionByTeam).not.toBe(second.graphLayoutSessionByTeam);
  });

  it('seeds defaults once and then returns an explicit no-op', () => {
    const initial = createInitialTeamGraphLayoutState();
    const first = ensureTeamGraphLayoutState(initial, 'my-team', [
      { name: 'alice', agentId: 'agent-alice' },
      { name: 'bob', agentId: 'agent-bob' },
    ]);
    const seeded = applyTransition(initial, first);

    expect(first.kind).toBe('updated');
    expect(seeded.slotAssignmentsByTeam['my-team']).toEqual({
      'agent-alice': { ringIndex: 0, sectorIndex: 0 },
      'agent-bob': { ringIndex: 0, sectorIndex: 1 },
    });
    expect(
      ensureTeamGraphLayoutState(seeded, 'my-team', [
        { name: 'alice', agentId: 'agent-alice' },
        { name: 'bob', agentId: 'agent-bob' },
      ])
    ).toEqual({ kind: 'unchanged' });
  });

  it('resets every stale team when the layout version changes', () => {
    const stale: TeamGraphLayoutState = {
      ...createInitialTeamGraphLayoutState(),
      graphLayoutModeByTeam: {
        'my-team': 'radial',
      },
      gridOwnerOrderByTeam: {
        'my-team': ['alice'],
      },
      slotLayoutVersion: 'legacy-layout',
      slotAssignmentsByTeam: {
        'other-team': {
          old: { ringIndex: 9, sectorIndex: 9 },
        },
      },
      graphLayoutSessionByTeam: {
        'other-team': { mode: 'manual', signature: 'old' },
      },
    };

    const transition = ensureTeamGraphLayoutState(stale, 'my-team', [
      { name: 'alice', agentId: 'agent-alice' },
    ]);
    const next = applyTransition(stale, transition);

    expect(next.slotLayoutVersion).toBe('stable-slots-v1');
    expect(next.slotAssignmentsByTeam).toEqual({
      'my-team': {
        'agent-alice': { ringIndex: 0, sectorIndex: 0 },
      },
    });
    expect(next.graphLayoutSessionByTeam).toEqual({
      'my-team': { mode: 'default', signature: 'agent-alice' },
    });
    expect(next.graphLayoutModeByTeam).toBe(stale.graphLayoutModeByTeam);
    expect(next.gridOwnerOrderByTeam).toBe(stale.gridOwnerOrderByTeam);
  });

  it('refuses an occupied direct assignment without producing a patch', () => {
    const state: TeamGraphLayoutState = {
      ...createInitialTeamGraphLayoutState(),
      slotAssignmentsByTeam: {
        'my-team': {
          alice: { ringIndex: 0, sectorIndex: 0 },
          bob: { ringIndex: 0, sectorIndex: 1 },
        },
      },
    };

    expect(
      assignTeamGraphOwnerSlot(state, 'my-team', 'alice', {
        ringIndex: 0,
        sectorIndex: 1,
      })
    ).toEqual({
      kind: 'refused',
      diagnostic: {
        code: 'occupied-slot-assignment',
        teamName: 'my-team',
        stableOwnerId: 'alice',
        assignment: { ringIndex: 0, sectorIndex: 1 },
        conflictingStableOwnerId: 'bob',
      },
    });
  });

  it('refuses an incomplete displaced-owner payload', () => {
    const state: TeamGraphLayoutState = {
      ...createInitialTeamGraphLayoutState(),
      slotAssignmentsByTeam: {
        'my-team': {
          alice: { ringIndex: 0, sectorIndex: 0 },
          bob: { ringIndex: 0, sectorIndex: 1 },
        },
      },
    };

    const transition = commitTeamGraphOwnerSlotDrop(
      state,
      'my-team',
      'alice',
      { ringIndex: 0, sectorIndex: 1 },
      'bob'
    );

    expect(transition).toMatchObject({
      kind: 'refused',
      diagnostic: { code: 'incomplete-slot-drop-displacement' },
    });
    expect(applyTransition(state, transition)).toBe(state);
  });

  it('refuses stale displaced-owner drops without overwriting a newer pane update', () => {
    const initial: TeamGraphLayoutState = {
      ...createInitialTeamGraphLayoutState(),
      slotAssignmentsByTeam: {
        'my-team': {
          alice: { ringIndex: 0, sectorIndex: 0 },
          bob: { ringIndex: 0, sectorIndex: 1 },
        },
      },
    };
    const movedByOtherPane = applyTransition(
      initial,
      assignTeamGraphOwnerSlot(initial, 'my-team', 'bob', {
        ringIndex: 0,
        sectorIndex: 2,
      })
    );

    const staleDrop = commitTeamGraphOwnerSlotDrop(
      movedByOtherPane,
      'my-team',
      'alice',
      { ringIndex: 0, sectorIndex: 1 },
      'bob',
      { ringIndex: 0, sectorIndex: 0 }
    );

    expect(staleDrop).toMatchObject({
      kind: 'refused',
      diagnostic: {
        code: 'inconsistent-slot-drop-displacement',
        reason: 'stale-displaced-assignment',
      },
    });
    expect(applyTransition(movedByOtherPane, staleDrop)).toBe(movedByOtherPane);
  });

  it.each([
    {
      name: 'only displaced assignment',
      displacedStableOwnerId: undefined,
      displacedAssignment: { ringIndex: 0, sectorIndex: 0 },
      expectedReason: 'incomplete-slot-drop-displacement',
    },
    {
      name: 'same source and displaced owner',
      displacedStableOwnerId: 'alice',
      displacedAssignment: { ringIndex: 0, sectorIndex: 0 },
      expectedReason: 'inconsistent-slot-drop-displacement',
    },
    {
      name: 'unknown displaced owner',
      displacedStableOwnerId: 'unknown',
      displacedAssignment: { ringIndex: 0, sectorIndex: 0 },
      expectedReason: 'inconsistent-slot-drop-displacement',
    },
    {
      name: 'unknown source owner',
      stableOwnerId: 'unknown',
      displacedStableOwnerId: 'bob',
      displacedAssignment: { ringIndex: 0, sectorIndex: 0 },
      expectedReason: 'inconsistent-slot-drop-displacement',
    },
    {
      name: 'stale source assignment',
      displacedStableOwnerId: 'bob',
      displacedAssignment: { ringIndex: 4, sectorIndex: 4 },
      expectedReason: 'inconsistent-slot-drop-displacement',
    },
    {
      name: 'same final slot',
      displacedStableOwnerId: 'bob',
      displacedAssignment: { ringIndex: 0, sectorIndex: 1 },
      expectedReason: 'inconsistent-slot-drop-displacement',
    },
  ])('refuses invalid displacement: $name', (input) => {
    const state: TeamGraphLayoutState = {
      ...createInitialTeamGraphLayoutState(),
      slotAssignmentsByTeam: {
        'my-team': {
          alice: { ringIndex: 0, sectorIndex: 0 },
          bob: { ringIndex: 0, sectorIndex: 1 },
        },
      },
    };

    const transition = commitTeamGraphOwnerSlotDrop(
      state,
      'my-team',
      input.stableOwnerId ?? 'alice',
      { ringIndex: 0, sectorIndex: 1 },
      input.displacedStableOwnerId,
      input.displacedAssignment
    );

    expect(transition).toMatchObject({
      kind: 'refused',
      diagnostic: { code: input.expectedReason },
    });
    expect(applyTransition(state, transition)).toBe(state);
  });

  it('refuses an atomic swap when a third owner occupies either final slot', () => {
    const state: TeamGraphLayoutState = {
      ...createInitialTeamGraphLayoutState(),
      slotAssignmentsByTeam: {
        'my-team': {
          alice: { ringIndex: 0, sectorIndex: 0 },
          bob: { ringIndex: 0, sectorIndex: 1 },
          tom: { ringIndex: 0, sectorIndex: 1 },
        },
      },
    };

    const transition = commitTeamGraphOwnerSlotDrop(
      state,
      'my-team',
      'alice',
      { ringIndex: 0, sectorIndex: 1 },
      'bob',
      { ringIndex: 0, sectorIndex: 0 }
    );

    expect(transition).toEqual({
      kind: 'refused',
      diagnostic: {
        code: 'slot-drop-conflict',
        teamName: 'my-team',
        stableOwnerId: 'alice',
        assignment: { ringIndex: 0, sectorIndex: 1 },
        conflictingStableOwnerId: 'tom',
      },
    });
    expect(applyTransition(state, transition)).toBe(state);
  });

  it('refuses invalid displaced slot coordinates', () => {
    const state: TeamGraphLayoutState = {
      ...createInitialTeamGraphLayoutState(),
      slotAssignmentsByTeam: {
        'my-team': {
          alice: { ringIndex: 0, sectorIndex: 0 },
          bob: { ringIndex: 0, sectorIndex: 1 },
        },
      },
    };
    const transition = commitTeamGraphOwnerSlotDrop(
      state,
      'my-team',
      'alice',
      { ringIndex: 0, sectorIndex: 1 },
      'bob',
      { ringIndex: Number.NaN, sectorIndex: 0 }
    );

    expect(transition).toMatchObject({
      kind: 'refused',
      diagnostic: { code: 'invalid-slot-assignment', assignmentRole: 'displaced' },
    });
    expect(applyTransition(state, transition)).toBe(state);
  });

  it.each([
    { ringIndex: Number.NaN, sectorIndex: 0 },
    { ringIndex: Number.POSITIVE_INFINITY, sectorIndex: 0 },
    { ringIndex: -1, sectorIndex: 0 },
    { ringIndex: 0.5, sectorIndex: 0 },
    { ringIndex: 0, sectorIndex: Number.NaN },
    { ringIndex: 0, sectorIndex: -1 },
    { ringIndex: 0, sectorIndex: 1.5 },
  ])('refuses invalid slot coordinates: $ringIndex:$sectorIndex', (assignment) => {
    const state = createInitialTeamGraphLayoutState();

    const direct = assignTeamGraphOwnerSlot(state, 'my-team', 'alice', assignment);
    const drop = commitTeamGraphOwnerSlotDrop(state, 'my-team', 'alice', assignment);

    expect(direct).toMatchObject({
      kind: 'refused',
      diagnostic: { code: 'invalid-slot-assignment', assignmentRole: 'target' },
    });
    expect(drop).toMatchObject({
      kind: 'refused',
      diagnostic: { code: 'invalid-slot-assignment', assignmentRole: 'target' },
    });
    expect(applyTransition(state, direct)).toBe(state);
    expect(applyTransition(state, drop)).toBe(state);
  });

  it('clears every stale team before a direct slot mutation adopts the current version', () => {
    const stale: TeamGraphLayoutState = {
      ...createInitialTeamGraphLayoutState(),
      slotLayoutVersion: 'legacy-layout',
      slotAssignmentsByTeam: {
        'other-team': { old: { ringIndex: 9, sectorIndex: 9 } },
      },
      graphLayoutSessionByTeam: {
        'other-team': { mode: 'manual', signature: 'old' },
      },
    };

    const next = applyTransition(
      stale,
      assignTeamGraphOwnerSlot(stale, 'my-team', 'alice', {
        ringIndex: 0,
        sectorIndex: 0,
      })
    );

    expect(next.slotAssignmentsByTeam).toEqual({
      'my-team': { alice: { ringIndex: 0, sectorIndex: 0 } },
    });
    expect(next.graphLayoutSessionByTeam).toEqual({
      'my-team': { mode: 'manual', signature: null },
    });
  });

  it('commits a displaced-owner swap as one state patch', () => {
    const state: TeamGraphLayoutState = {
      ...createInitialTeamGraphLayoutState(),
      slotAssignmentsByTeam: {
        'my-team': {
          alice: { ringIndex: 0, sectorIndex: 0 },
          bob: { ringIndex: 0, sectorIndex: 1 },
        },
      },
      graphLayoutSessionByTeam: {
        'my-team': { mode: 'default', signature: 'alice|bob' },
      },
    };

    const transition = commitTeamGraphOwnerSlotDrop(
      state,
      'my-team',
      'alice',
      { ringIndex: 0, sectorIndex: 1 },
      'bob',
      { ringIndex: 0, sectorIndex: 0 }
    );
    const next = applyTransition(state, transition);

    expect(transition.kind).toBe('updated');
    expect(next.slotAssignmentsByTeam['my-team']).toEqual({
      alice: { ringIndex: 0, sectorIndex: 1 },
      bob: { ringIndex: 0, sectorIndex: 0 },
    });
    expect(next.graphLayoutSessionByTeam['my-team']).toEqual({
      mode: 'manual',
      signature: 'alice|bob',
    });
  });

  it('materializes a first swap from generated slots for current visible owners', () => {
    const state = createInitialTeamGraphLayoutState();
    const transition = commitTeamGraphOwnerSlotDrop(
      state,
      'my-team',
      'alice',
      { ringIndex: 4, sectorIndex: 1 },
      'bob',
      { ringIndex: 4, sectorIndex: 0 },
      ['alice', 'bob']
    );
    const next = applyTransition(state, transition);

    expect(transition.kind).toBe('updated');
    expect(next.slotAssignmentsByTeam['my-team']).toEqual({
      alice: { ringIndex: 4, sectorIndex: 1 },
      bob: { ringIndex: 4, sectorIndex: 0 },
    });
  });

  it('refuses generated-slot swaps for owners outside the current visible seed', () => {
    const state = createInitialTeamGraphLayoutState();
    const transition = commitTeamGraphOwnerSlotDrop(
      state,
      'my-team',
      'alice',
      { ringIndex: 4, sectorIndex: 1 },
      'unknown',
      { ringIndex: 4, sectorIndex: 0 },
      ['alice', 'bob']
    );

    expect(transition).toMatchObject({
      kind: 'refused',
      diagnostic: {
        code: 'inconsistent-slot-drop-displacement',
        reason: 'missing-displaced-owner',
      },
    });
    expect(applyTransition(state, transition)).toBe(state);
  });

  it('swaps grid order without changing radial assignments', () => {
    const state: TeamGraphLayoutState = {
      ...createInitialTeamGraphLayoutState(),
      gridOwnerOrderByTeam: {
        'my-team': ['alice', 'bob', 'tom'],
      },
      slotAssignmentsByTeam: {
        'my-team': {
          alice: { ringIndex: 0, sectorIndex: 2 },
        },
      },
    };

    const next = applyTransition(
      state,
      swapTeamGraphGridOwners(state, 'my-team', 'alice', 'tom', ['alice', 'bob', 'tom'])
    );

    expect(next.gridOwnerOrderByTeam['my-team']).toEqual(['tom', 'bob', 'alice']);
    expect(next.slotAssignmentsByTeam).toBe(state.slotAssignmentsByTeam);
  });

  it('swaps radial owners without changing grid or mode state', () => {
    const state: TeamGraphLayoutState = {
      ...createInitialTeamGraphLayoutState(),
      graphLayoutModeByTeam: { 'my-team': 'radial' },
      gridOwnerOrderByTeam: { 'my-team': ['alice', 'bob'] },
      slotAssignmentsByTeam: {
        'my-team': {
          alice: { ringIndex: 0, sectorIndex: 0 },
          bob: { ringIndex: 0, sectorIndex: 1 },
        },
      },
    };

    const transition = swapTeamGraphOwnerSlots(state, 'my-team', 'alice', 'bob');
    const next = applyTransition(state, transition);

    expect(next.slotAssignmentsByTeam['my-team']).toEqual({
      alice: { ringIndex: 0, sectorIndex: 1 },
      bob: { ringIndex: 0, sectorIndex: 0 },
    });
    expect(next.graphLayoutModeByTeam).toBe(state.graphLayoutModeByTeam);
    expect(next.gridOwnerOrderByTeam).toBe(state.gridOwnerOrderByTeam);
    expect(swapTeamGraphOwnerSlots(next, 'my-team', 'alice', 'missing')).toEqual({
      kind: 'unchanged',
    });
  });

  it('changes layout mode independently and returns an explicit no-op when repeated', () => {
    const state: TeamGraphLayoutState = {
      ...createInitialTeamGraphLayoutState(),
      slotAssignmentsByTeam: {
        'my-team': { alice: { ringIndex: 0, sectorIndex: 0 } },
      },
    };
    const transition = changeTeamGraphLayoutMode(state, 'my-team', 'radial');
    const next = applyTransition(state, transition);

    expect(next.graphLayoutModeByTeam['my-team']).toBe('radial');
    expect(next.slotAssignmentsByTeam).toBe(state.slotAssignmentsByTeam);
    expect(changeTeamGraphLayoutMode(next, 'my-team', 'radial')).toEqual({
      kind: 'unchanged',
    });
  });

  it('clears one team without changing another team or independent layout state', () => {
    const state: TeamGraphLayoutState = {
      ...createInitialTeamGraphLayoutState(),
      graphLayoutModeByTeam: {
        'my-team': 'grid-under-lead',
      },
      gridOwnerOrderByTeam: {
        'my-team': ['alice'],
      },
      slotAssignmentsByTeam: {
        'my-team': { alice: { ringIndex: 0, sectorIndex: 0 } },
        'other-team': { bob: { ringIndex: 0, sectorIndex: 1 } },
      },
      graphLayoutSessionByTeam: {
        'my-team': { mode: 'manual', signature: 'alice' },
        'other-team': { mode: 'manual', signature: 'bob' },
      },
    };

    const next = applyTransition(state, clearTeamGraphLayout(state, 'my-team'));

    expect(next.slotAssignmentsByTeam).toEqual({
      'other-team': { bob: { ringIndex: 0, sectorIndex: 1 } },
    });
    expect(next.graphLayoutSessionByTeam).toEqual({
      'other-team': { mode: 'manual', signature: 'bob' },
    });
    expect(next.graphLayoutModeByTeam).toBe(state.graphLayoutModeByTeam);
    expect(next.gridOwnerOrderByTeam).toBe(state.gridOwnerOrderByTeam);
  });

  it('resets a manual layout to the supplied deterministic defaults', () => {
    const state: TeamGraphLayoutState = {
      ...createInitialTeamGraphLayoutState(),
      slotAssignmentsByTeam: {
        'my-team': { alice: { ringIndex: 3, sectorIndex: 2 } },
      },
      graphLayoutSessionByTeam: {
        'my-team': { mode: 'manual', signature: 'alice' },
      },
    };
    const defaultSeed = {
      orderedVisibleOwnerIds: ['alice'],
      signature: 'alice',
      assignments: {
        alice: { ringIndex: 0, sectorIndex: 0 },
      },
      duplicateStableOwnerIds: [],
    };

    const next = applyTransition(
      state,
      resetTeamGraphLayoutToDefaults(state, 'my-team', defaultSeed)
    );

    expect(next.slotAssignmentsByTeam['my-team']).toEqual(defaultSeed.assignments);
    expect(next.graphLayoutSessionByTeam['my-team']).toEqual({
      mode: 'default',
      signature: 'alice',
    });
    expect(resetTeamGraphLayoutToDefaults(next, 'my-team', defaultSeed)).toEqual({
      kind: 'unchanged',
    });
  });

  it('refuses a blank team identifier instead of treating it as a global clear', () => {
    const state: TeamGraphLayoutState = {
      ...createInitialTeamGraphLayoutState(),
      slotAssignmentsByTeam: {
        'my-team': { alice: { ringIndex: 0, sectorIndex: 0 } },
      },
    };

    const transition = clearTeamGraphLayout(state, '');

    expect(transition).toEqual({
      kind: 'refused',
      diagnostic: { code: 'invalid-team-name', teamName: '' },
    });
    expect(applyTransition(state, transition)).toBe(state);
  });

  it('globally clears radial layout state without changing grid or mode containers', () => {
    const state: TeamGraphLayoutState = {
      ...createInitialTeamGraphLayoutState(),
      graphLayoutModeByTeam: { 'my-team': 'radial' },
      gridOwnerOrderByTeam: { 'my-team': ['alice'] },
      slotAssignmentsByTeam: {
        'my-team': { alice: { ringIndex: 0, sectorIndex: 0 } },
      },
      graphLayoutSessionByTeam: {
        'my-team': { mode: 'manual', signature: 'alice' },
      },
    };

    const next = applyTransition(state, clearTeamGraphLayout(state));

    expect(next.slotAssignmentsByTeam).toEqual({});
    expect(next.graphLayoutSessionByTeam).toEqual({});
    expect(next.graphLayoutModeByTeam).toBe(state.graphLayoutModeByTeam);
    expect(next.gridOwnerOrderByTeam).toBe(state.gridOwnerOrderByTeam);
  });

  it('refuses duplicate owner identities before changing layout state', () => {
    const state = createInitialTeamGraphLayoutState();
    const transition = ensureTeamGraphLayoutState(state, 'my-team', [
      { name: 'alice', agentId: 'duplicate' },
      { name: 'bob', agentId: 'duplicate' },
    ]);

    expect(transition).toEqual({
      kind: 'refused',
      diagnostic: {
        code: 'duplicate-stable-owner-id',
        teamName: 'my-team',
        duplicateStableOwnerIds: ['duplicate'],
      },
    });
    expect(applyTransition(state, transition)).toBe(state);
  });
});
