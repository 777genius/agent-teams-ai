import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useGraphSimulation, type UseGraphSimulationResult } from '../../../../packages/agent-graph/src/hooks/useGraphSimulation';
import { getLaunchAnchorTarget } from '../../../../packages/agent-graph/src/layout/launchAnchor';

import type { GraphNode } from '@claude-teams/agent-graph';

let capturedSimulation: UseGraphSimulationResult | null = null;

function SimulationHarness(): React.JSX.Element | null {
  capturedSimulation = useGraphSimulation();
  return null;
}

describe('useGraphSimulation launch anchor', () => {
  afterEach(() => {
    capturedSimulation = null;
    document.body.innerHTML = '';
  });

  it('keeps the launch anchor aligned when the lead is dragged after settling', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(SimulationHarness));
      await Promise.resolve();
    });

    const lead: GraphNode = {
      id: 'lead:team-a',
      kind: 'lead',
      label: 'team-a',
      state: 'active',
      domainRef: { kind: 'lead', teamName: 'team-a', memberName: 'lead' },
    };

    const member: GraphNode = {
      id: 'member:team-a:alice',
      kind: 'member',
      label: 'alice',
      state: 'active',
      domainRef: { kind: 'member', teamName: 'team-a', memberName: 'alice' },
    };

    await act(async () => {
      capturedSimulation?.updateData(
        [lead, member],
        [
          {
            id: 'edge:lead:alice',
            source: lead.id,
            target: member.id,
            type: 'parent-child',
          },
        ],
        []
      );
      capturedSimulation?.tick(0);
      await Promise.resolve();
    });

    expect(capturedSimulation?.getLaunchAnchorWorldPosition(lead.id)).not.toBeNull();
    expect(capturedSimulation?.getExtraWorldBounds()).toHaveLength(3);

    await act(async () => {
      capturedSimulation?.setNodePosition(lead.id, 140, 60);
      capturedSimulation?.tick(0);
      await Promise.resolve();
    });

    expect(capturedSimulation?.getLaunchAnchorWorldPosition(lead.id)).toEqual(
      getLaunchAnchorTarget(140, 60)
    );

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});
