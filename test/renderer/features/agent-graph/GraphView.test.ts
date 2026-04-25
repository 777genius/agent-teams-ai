import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GraphEdge, GraphNode } from '@claude-teams/agent-graph';

import { getEdgeMidpoint } from '../../../../packages/agent-graph/src/canvas/hit-detection';

const hoisted = vi.hoisted(() => ({
  handlePanStart: vi.fn(),
  handlePanMove: vi.fn(),
  handlePanEnd: vi.fn(),
  zoomToFit: vi.fn(),
  zoomIn: vi.fn(),
  zoomOut: vi.fn(),
  updateInertia: vi.fn(),
  interaction: {
    hoveredNodeId: { current: null as string | null },
    dragNodeId: { current: null as string | null },
    isDragging: { current: false },
    handleMouseDown: vi.fn(),
    handleMouseMove: vi.fn(),
    handleMouseUp: vi.fn(() => null),
    handleDoubleClick: vi.fn(() => null),
  },
  simulationState: {
    nodes: [] as GraphNode[],
    edges: [] as GraphEdge[],
    particles: [],
    effects: [],
    time: 0,
  },
  setNodePosition: vi.fn(),
  clearNodePosition: vi.fn(),
  clearTransientOwnerPositions: vi.fn(),
  resolveNearestOwnerSlot: vi.fn<
    (
      nodeId: string,
      x: number,
      y: number
    ) => {
      assignment: { ringIndex: number; sectorIndex: number };
      displacedOwnerId?: string;
      displacedAssignment?: { ringIndex: number; sectorIndex: number };
      previewOwnerX: number;
      previewOwnerY: number;
    } | null
  >(() => null),
  resolveNearestOwnerGridTarget: vi.fn<
    (
      nodeId: string,
      x: number,
      y: number
    ) => {
      targetOwnerId: string;
      previewOwnerX: number;
      previewOwnerY: number;
    } | null
  >(() => null),
  graphControlsProps: null as null | Record<string, unknown>,
}));

vi.mock('../../../../packages/agent-graph/src/hooks/useGraphCamera', () => ({
  useGraphCamera: () => ({
    transformRef: { current: { x: 0, y: 0, zoom: 1 } },
    screenToWorld: (sx: number, sy: number) => ({ x: sx, y: sy }),
    worldToScreen: (wx: number, wy: number) => ({ x: wx, y: wy }),
    handleWheel: vi.fn(),
    handlePanStart: hoisted.handlePanStart,
    handlePanMove: hoisted.handlePanMove,
    handlePanEnd: hoisted.handlePanEnd,
    zoomToFit: hoisted.zoomToFit,
    zoomIn: hoisted.zoomIn,
    zoomOut: hoisted.zoomOut,
    updateInertia: hoisted.updateInertia,
  }),
}));

vi.mock('../../../../packages/agent-graph/src/hooks/useGraphInteraction', () => ({
  useGraphInteraction: () => hoisted.interaction,
}));

vi.mock('../../../../packages/agent-graph/src/hooks/useGraphSimulation', () => ({
  useGraphSimulation: () => ({
    stateRef: { current: hoisted.simulationState },
    updateData: vi.fn(),
    tick: vi.fn(),
    getExtraWorldBounds: vi.fn(() => []),
    getLaunchAnchorWorldPosition: vi.fn(() => null),
    getActivityWorldRect: vi.fn(() => null),
    resolveNearestOwnerSlot: hoisted.resolveNearestOwnerSlot,
    resolveNearestOwnerGridTarget: hoisted.resolveNearestOwnerGridTarget,
    clearNodePosition: hoisted.clearNodePosition,
    clearTransientOwnerPositions: hoisted.clearTransientOwnerPositions,
    setNodePosition: hoisted.setNodePosition,
  }),
}));

vi.mock('../../../../packages/agent-graph/src/ui/GraphControls', () => ({
  GraphControls: (props: Record<string, unknown>) => {
    hoisted.graphControlsProps = props;
    return null;
  },
}));

vi.mock('../../../../packages/agent-graph/src/ui/GraphOverlay', () => ({
  GraphOverlay: () => null,
}));

vi.mock('../../../../packages/agent-graph/src/ui/GraphEdgeOverlay', () => ({
  GraphEdgeOverlay: () => null,
}));

import { GraphView } from '../../../../packages/agent-graph/src/ui/GraphView';

describe('GraphView pan interactions', () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalGetBoundingClientRect: typeof HTMLCanvasElement.prototype.getBoundingClientRect;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    hoisted.interaction.hoveredNodeId.current = null;
    hoisted.interaction.dragNodeId.current = null;
    hoisted.interaction.isDragging.current = false;
    hoisted.simulationState.nodes = [];
    hoisted.simulationState.edges = [];
    hoisted.interaction.handleMouseDown.mockImplementation(() => undefined);
    hoisted.interaction.handleMouseMove.mockImplementation(() => undefined);
    hoisted.interaction.handleMouseUp.mockImplementation(() => null);
    hoisted.interaction.handleDoubleClick.mockImplementation(() => null);
    hoisted.resolveNearestOwnerSlot.mockImplementation(() => null);
    hoisted.resolveNearestOwnerGridTarget.mockImplementation(() => null);
    hoisted.graphControlsProps = null;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        disconnect(): void {}
      }
    );
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 1)
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    originalGetBoundingClientRect = HTMLCanvasElement.prototype.getBoundingClientRect;
    HTMLCanvasElement.prototype.getBoundingClientRect = function getBoundingClientRect(): DOMRect {
      return DOMRect.fromRect({ x: 0, y: 0, width: 800, height: 600 });
    };
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    HTMLCanvasElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
    vi.unstubAllGlobals();
  });

  it('starts panning when dragging from a hit-tested edge instead of getting stuck on edge selection', async () => {
    const source: GraphNode = {
      id: 'member:alice',
      kind: 'member',
      label: 'alice',
      state: 'idle',
      x: 0,
      y: 0,
      domainRef: { kind: 'member', teamName: 'demo-team', memberName: 'alice' },
    };
    const target: GraphNode = {
      id: 'task:1',
      kind: 'task',
      label: 'Task 1',
      state: 'idle',
      x: 160,
      y: 90,
      domainRef: { kind: 'task', teamName: 'demo-team', taskId: 'task:1' },
    };
    const edge: GraphEdge = {
      id: 'edge:blocking',
      source: source.id,
      target: target.id,
      type: 'blocking',
    };
    hoisted.simulationState.nodes = [source, target];
    hoisted.simulationState.edges = [edge];

    const midpoint = getEdgeMidpoint(
      edge,
      new Map([
        [source.id, source],
        [target.id, target],
      ])
    );
    expect(midpoint).not.toBeNull();

    await act(async () => {
      root.render(
        React.createElement(GraphView, {
          data: {
            teamName: 'demo-team',
            nodes: [source, target],
            edges: [edge],
            particles: [],
          },
          config: { animationEnabled: false },
        })
      );
    });

    const canvas = container.querySelector('canvas');
    expect(canvas).not.toBeNull();

    await act(async () => {
      canvas!.dispatchEvent(
        new MouseEvent('mousedown', {
          bubbles: true,
          button: 0,
          clientX: midpoint!.x,
          clientY: midpoint!.y,
        })
      );
      canvas!.dispatchEvent(
        new MouseEvent('mousemove', {
          bubbles: true,
          buttons: 1,
          clientX: midpoint!.x + 24,
          clientY: midpoint!.y + 4,
        })
      );
    });

    expect(hoisted.handlePanStart).toHaveBeenCalledWith(midpoint!.x, midpoint!.y);
    expect(hoisted.handlePanMove).toHaveBeenCalledWith(midpoint!.x + 24, midpoint!.y + 4);
  });

  it('does not clear pan state on the rerender triggered by interaction lock', async () => {
    const source: GraphNode = {
      id: 'member:alice',
      kind: 'member',
      label: 'alice',
      state: 'idle',
      x: 0,
      y: 0,
      domainRef: { kind: 'member', teamName: 'demo-team', memberName: 'alice' },
    };
    hoisted.simulationState.nodes = [source];
    hoisted.simulationState.edges = [];

    await act(async () => {
      root.render(
        React.createElement(GraphView, {
          data: {
            teamName: 'demo-team',
            nodes: [source],
            edges: [],
            particles: [],
          },
          config: { animationEnabled: false },
        })
      );
    });

    const canvas = container.querySelector('canvas');
    expect(canvas).not.toBeNull();

    await act(async () => {
      canvas!.dispatchEvent(
        new MouseEvent('mousedown', {
          bubbles: true,
          button: 0,
          clientX: 320,
          clientY: 220,
        })
      );
      await Promise.resolve();
    });

    await act(async () => {
      canvas!.dispatchEvent(
        new MouseEvent('mousemove', {
          bubbles: true,
          buttons: 1,
          clientX: 352,
          clientY: 248,
        })
      );
    });

    expect(hoisted.handlePanStart).toHaveBeenCalledWith(320, 220);
    expect(hoisted.handlePanMove).toHaveBeenCalledWith(352, 248);
  });

  it('does not force-handleMouseUp when props rerender during an active member drag', async () => {
    const source: GraphNode = {
      id: 'member:demo-team:alice',
      kind: 'member',
      label: 'alice',
      state: 'idle',
      x: 80,
      y: 80,
      domainRef: { kind: 'member', teamName: 'demo-team', memberName: 'alice' },
    };
    hoisted.simulationState.nodes = [source];
    hoisted.simulationState.edges = [];
    hoisted.interaction.handleMouseDown.mockImplementation(() => {
      hoisted.interaction.dragNodeId.current = source.id;
    });
    hoisted.interaction.handleMouseMove.mockImplementation(() => {
      hoisted.interaction.isDragging.current = true;
    });

    const firstEvents = {};
    const secondEvents = {};

    await act(async () => {
      root.render(
        React.createElement(GraphView, {
          data: {
            teamName: 'demo-team',
            nodes: [source],
            edges: [],
            particles: [],
          },
          events: firstEvents,
          config: { animationEnabled: false },
        })
      );
    });

    const canvas = container.querySelector('canvas');
    expect(canvas).not.toBeNull();

    await act(async () => {
      canvas!.dispatchEvent(
        new MouseEvent('mousedown', {
          bubbles: true,
          button: 0,
          clientX: 80,
          clientY: 80,
        })
      );
      canvas!.dispatchEvent(
        new MouseEvent('mousemove', {
          bubbles: true,
          buttons: 1,
          clientX: 95,
          clientY: 95,
        })
      );
    });

    expect(hoisted.interaction.isDragging.current).toBe(true);

    await act(async () => {
      root.render(
        React.createElement(GraphView, {
          data: {
            teamName: 'demo-team',
            nodes: [source],
            edges: [],
            particles: [],
          },
          events: secondEvents,
          config: { animationEnabled: false },
        })
      );
    });

    expect(hoisted.interaction.handleMouseUp).not.toHaveBeenCalled();

    await act(async () => {
      window.dispatchEvent(
        new MouseEvent('mousemove', {
          bubbles: true,
          buttons: 1,
          clientX: 112,
          clientY: 112,
        })
      );
    });

    expect(hoisted.interaction.handleMouseMove).toHaveBeenCalled();
    expect(hoisted.interaction.isDragging.current).toBe(true);
  });

  it('clears drag state when the graph surface becomes inactive', async () => {
    const source: GraphNode = {
      id: 'member:demo-team:alice',
      kind: 'member',
      label: 'alice',
      state: 'idle',
      x: 80,
      y: 80,
      domainRef: { kind: 'member', teamName: 'demo-team', memberName: 'alice' },
    };
    hoisted.simulationState.nodes = [source];
    hoisted.simulationState.edges = [];
    hoisted.interaction.dragNodeId.current = source.id;
    hoisted.interaction.isDragging.current = true;

    await act(async () => {
      root.render(
        React.createElement(GraphView, {
          data: {
            teamName: 'demo-team',
            nodes: [source],
            edges: [],
            particles: [],
          },
          config: { animationEnabled: false },
          isSurfaceActive: true,
        })
      );
    });

    expect(hoisted.interaction.handleMouseUp).not.toHaveBeenCalled();
    expect(hoisted.clearTransientOwnerPositions).not.toHaveBeenCalled();

    await act(async () => {
      root.render(
        React.createElement(GraphView, {
          data: {
            teamName: 'demo-team',
            nodes: [source],
            edges: [],
            particles: [],
          },
          config: { animationEnabled: false },
          isSurfaceActive: false,
        })
      );
    });

    expect(hoisted.interaction.handleMouseUp).toHaveBeenCalledTimes(1);
    expect(hoisted.clearTransientOwnerPositions).toHaveBeenCalledTimes(1);
  });

  it('commits grid owner order drops without using radial slot drops', async () => {
    const source: GraphNode = {
      id: 'member:demo-team:alice',
      kind: 'member',
      label: 'alice',
      state: 'idle',
      x: 80,
      y: 80,
      domainRef: { kind: 'member', teamName: 'demo-team', memberName: 'alice' },
    };
    const target: GraphNode = {
      id: 'member:demo-team:bob',
      kind: 'member',
      label: 'bob',
      state: 'idle',
      x: 160,
      y: 80,
      domainRef: { kind: 'member', teamName: 'demo-team', memberName: 'bob' },
    };
    const onOwnerSlotDrop = vi.fn();
    const onOwnerGridOrderDrop = vi.fn();
    hoisted.simulationState.nodes = [source, target];
    hoisted.simulationState.edges = [];
    hoisted.interaction.dragNodeId.current = source.id;
    hoisted.interaction.isDragging.current = true;
    hoisted.resolveNearestOwnerGridTarget.mockReturnValue({
      targetOwnerId: target.id,
      previewOwnerX: target.x!,
      previewOwnerY: target.y!,
    });

    await act(async () => {
      root.render(
        React.createElement(GraphView, {
          data: {
            teamName: 'demo-team',
            nodes: [source, target],
            edges: [],
            particles: [],
            layout: {
              version: 'stable-slots-v1',
              mode: 'grid-under-lead',
              ownerOrder: [source.id, target.id],
              slotAssignments: {},
            },
          },
          config: { animationEnabled: false },
          onOwnerSlotDrop,
          onOwnerGridOrderDrop,
        })
      );
    });

    await act(async () => {
      window.dispatchEvent(
        new MouseEvent('mouseup', {
          bubbles: true,
          button: 0,
          clientX: 160,
          clientY: 80,
        })
      );
    });

    expect(onOwnerGridOrderDrop).toHaveBeenCalledWith({
      nodeId: source.id,
      targetNodeId: target.id,
    });
    expect(onOwnerSlotDrop).not.toHaveBeenCalled();
  });

  it('passes activity filter state to renderHud and updates it through graph controls', async () => {
    const renderHud = vi.fn(() => null);

    await act(async () => {
      root.render(
        React.createElement(GraphView, {
          data: {
            teamName: 'demo-team',
            nodes: [],
            edges: [],
            particles: [],
          },
          config: {
            animationEnabled: false,
            showActivity: false,
          },
          renderHud,
        })
      );
      await Promise.resolve();
    });

    expect(renderHud).toHaveBeenLastCalledWith(
      expect.objectContaining({
        filters: expect.objectContaining({
          showActivity: false,
        }),
      })
    );

    const controlsProps = hoisted.graphControlsProps as {
      filters: {
        showActivity: boolean;
        showTasks: boolean;
        showProcesses: boolean;
        showEdges: boolean;
        paused: boolean;
      };
      onFiltersChange: (filters: {
        showActivity: boolean;
        showTasks: boolean;
        showProcesses: boolean;
        showEdges: boolean;
        paused: boolean;
      }) => void;
    } | null;
    expect(controlsProps).not.toBeNull();

    await act(async () => {
      controlsProps?.onFiltersChange({
        ...controlsProps!.filters,
        showActivity: true,
      });
      await Promise.resolve();
    });

    expect(renderHud).toHaveBeenLastCalledWith(
      expect.objectContaining({
        filters: expect.objectContaining({
          showActivity: true,
        }),
      })
    );
  });
});
