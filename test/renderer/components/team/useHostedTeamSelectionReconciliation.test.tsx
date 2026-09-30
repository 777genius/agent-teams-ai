import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { useHostedTeamSelectionReconciliation } from '@renderer/components/team/useHostedTeamSelectionReconciliation';
import { parseRevision, parseTeamId, parseWorkspaceId } from '@shared/contracts/hosted';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { HostedTeamDirectoryReadState } from '@features/team-lifecycle/renderer';

const workspaceId = parseWorkspaceId(`workspace_${'a'.repeat(32)}`);
const teamId = parseTeamId(`team_${'b'.repeat(32)}`);
const revision = parseRevision('revision_selection-bootstrap');

function readState(
  readEpoch: number,
  watermark: number,
  freshness: HostedTeamDirectoryReadState['freshness'],
  readStartedAtWatermark: number
): HostedTeamDirectoryReadState {
  return {
    scopeKey: workspaceId,
    freshness,
    snapshot: { revision, items: [], readEpoch, readStartedAtWatermark },
    failure: null,
    watermark,
    runtime: { phase: 'complete', byTeamId: new Map() },
  };
}

beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

it('confirms a created team through bootstrap without treating the first lagging list as deletion', () => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const clearSelection = vi.fn();
  let selection!: ReturnType<typeof useHostedTeamSelectionReconciliation>;
  const Harness = ({ state, ready }: { state: HostedTeamDirectoryReadState; ready: boolean }) => {
    selection = useHostedTeamSelectionReconciliation(state, teamId, ready, clearSelection);
    return null;
  };

  act(() => root.render(<Harness state={readState(1, 0, 'fresh', 0)} ready={false} />));
  act(() => selection.recordCreated(teamId));
  act(() => root.render(<Harness state={readState(1, 1, 'stale', 0)} ready={true} />));
  act(() => root.render(<Harness state={readState(2, 1, 'fresh', 1)} ready={true} />));
  expect(clearSelection).not.toHaveBeenCalled();

  act(() => root.render(<Harness state={readState(3, 1, 'fresh', 1)} ready={true} />));
  expect(clearSelection).toHaveBeenCalledOnce();
  act(() => root.unmount());
});
