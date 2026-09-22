import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  useGraphSimulation,
  type UseGraphSimulationResult,
} from '../../../../packages/agent-graph/src/hooks/useGraphSimulation';

import type { GraphLayoutPort, GraphNode } from '@claude-teams/agent-graph';

let firstSimulation: UseGraphSimulationResult | null = null;
let secondSimulation: UseGraphSimulationResult | null = null;

function SimulationHarness({ pass }: { pass: number }): React.JSX.Element | null {
  const simulation = useGraphSimulation();
  if (pass === 1) {
    firstSimulation = simulation;
  } else {
    secondSimulation = simulation;
  }
  return null;
}

function buildNodes(): GraphNode[] {
  return [
    {
      id: 'lead:demo-team',
      kind: 'lead',
      label: 'lead',
      state: 'active',
      domainRef: { kind: 'lead', teamName: 'demo-team', memberName: 'lead' },
    },
    {
      id: 'member:alice',
      kind: 'member',
      label: 'alice',
      state: 'idle',
      domainRef: { kind: 'member', teamName: 'demo-team', memberName: 'alice' },
    },
  ];
}

function positionsById(
  nodes: GraphNode[]
): Record<string, { x: number | undefined; y: number | undefined }> {
  return Object.fromEntries(nodes.map((node) => [node.id, { x: node.x, y: node.y }]));
}

describe('useGraphSimulation', () => {
  afterEach(() => {
    firstSimulation = null;
    secondSimulation = null;
    document.body.innerHTML = '';
  });

  it('returns a referentially stable result across rerenders', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(SimulationHarness, { pass: 1 }));
      await Promise.resolve();
    });

    await act(async () => {
      root.render(React.createElement(SimulationHarness, { pass: 2 }));
      await Promise.resolve();
    });

    expect(firstSimulation).toBeTruthy();
    expect(secondSimulation).toBe(firstSimulation);

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('exposes final layout coordinates while nodes are transitioning from the previous layout', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(SimulationHarness, { pass: 1 }));
      await Promise.resolve();
    });

    const simulation = firstSimulation!;
    const initialNodes = buildNodes();
    const gridLayout: GraphLayoutPort = {
      version: 'stable-slots-v1',
      mode: 'grid-under-lead',
      ownerOrder: ['member:alice'],
      slotAssignments: {},
    };
    simulation.updateData(initialNodes, [], [], 'demo-team', gridLayout);
    const initialPositions = positionsById(simulation.stateRef.current.nodes);

    const targetPositions = {
      'lead:demo-team': { x: 0, y: -800 },
      'member:alice': { x: 1200, y: 900 },
    };
    const hierarchicalLayout: GraphLayoutPort = {
      version: 'stable-slots-v1',
      mode: 'hierarchical',
      ownerOrder: ['member:alice'],
      slotAssignments: {},
      nodePositions: targetPositions,
    };
    simulation.updateData(buildNodes(), [], [], 'demo-team', hierarchicalLayout);

    expect(positionsById(simulation.stateRef.current.nodes)).toEqual(initialPositions);
    expect(positionsById(simulation.getLayoutTargetNodes())).toEqual(targetPositions);
    expect(positionsById(simulation.stateRef.current.nodes)).not.toEqual(targetPositions);

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});
