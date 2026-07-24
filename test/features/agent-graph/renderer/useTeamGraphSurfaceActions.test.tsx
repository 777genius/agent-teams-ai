import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { useTeamGraphSurfaceActions } from '../../../../src/features/agent-graph/renderer/hooks/useTeamGraphSurfaceActions';

const hoisted = vi.hoisted(() => ({
  getState: vi.fn(),
}));

vi.mock('@renderer/store', () => ({
  useStore: {
    getState: hoisted.getState,
  },
}));

type SurfaceActions = ReturnType<typeof useTeamGraphSurfaceActions>;

let surfaceActions: SurfaceActions | null = null;

function Probe(): React.JSX.Element {
  surfaceActions = useTeamGraphSurfaceActions('my-team');
  return <div />;
}

describe('useTeamGraphSurfaceActions', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    surfaceActions = null;
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('routes incomplete and cross-team displacement through the validated commit path', () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const commitTeamGraphOwnerSlotDrop = vi.fn();
    const setTeamGraphOwnerSlotAssignment = vi.fn();
    hoisted.getState.mockReturnValue({
      graphLayoutModeByTeam: { 'my-team': 'radial' },
      commitTeamGraphOwnerSlotDrop,
      setTeamGraphOwnerSlotAssignment,
    });
    const host = document.body.appendChild(document.createElement('div'));
    const root = createRoot(host);
    act(() => root.render(<Probe />));

    const target = { ringIndex: 0, sectorIndex: 1 };
    const displaced = { ringIndex: 0, sectorIndex: 0 };
    surfaceActions!.commitOwnerSlotDrop({
      nodeId: 'member:my-team:alice',
      assignment: target,
      displacedNodeId: 'member:my-team:bob',
    });
    surfaceActions!.commitOwnerSlotDrop({
      nodeId: 'member:my-team:alice',
      assignment: target,
      displacedAssignment: displaced,
    });
    surfaceActions!.commitOwnerSlotDrop({
      nodeId: 'member:my-team:alice',
      assignment: target,
      displacedNodeId: 'member:other-team:bob',
      displacedAssignment: displaced,
    });
    surfaceActions!.commitOwnerSlotDrop({
      nodeId: 'member:my-team:alice',
      assignment: target,
      displacedNodeId: 'member:other-team:bob',
    });

    expect(commitTeamGraphOwnerSlotDrop).toHaveBeenNthCalledWith(
      1,
      'my-team',
      'alice',
      target,
      'bob',
      undefined
    );
    expect(commitTeamGraphOwnerSlotDrop).toHaveBeenNthCalledWith(
      2,
      'my-team',
      'alice',
      target,
      undefined,
      displaced
    );
    expect(commitTeamGraphOwnerSlotDrop).toHaveBeenCalledTimes(2);
    expect(setTeamGraphOwnerSlotAssignment).not.toHaveBeenCalled();

    act(() => root.unmount());
  });
});
