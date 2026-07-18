import { describe, expect, it } from 'vitest';

import {
  advanceGraphLayoutTransition,
  createGraphLayoutTransition,
  easeGraphLayoutTransition,
  resolveGraphLayoutTargetNodes,
} from '../../../../packages/agent-graph/src/layout/layoutTransition';

import type { GraphEdge, GraphNode } from '@claude-teams/agent-graph';

function node(
  id: string,
  x: number,
  y: number,
  visualVariant: GraphNode['visualVariant']
): GraphNode {
  return {
    id,
    kind: visualVariant === 'organization' ? 'lead' : 'member',
    label: id,
    state: 'active',
    visualVariant,
    x,
    y,
    domainRef: { kind: 'member', teamName: id, memberName: id },
  };
}

describe('layout transitions', () => {
  it('uses eased interpolation and lands exactly on target coordinates', () => {
    const team = node('team:alpha', 100, 200, 'team');
    const transition = createGraphLayoutTransition({
      nodes: [team],
      edges: [],
      previousPositions: new Map([['team:alpha', { x: 0, y: 0 }]]),
      duration: 1,
    });

    expect(transition).not.toBeNull();
    expect(team).toMatchObject({ x: 0, y: 0 });
    expect(easeGraphLayoutTransition(0.5)).toBe(0.5);
    expect(advanceGraphLayoutTransition([team], transition!, 0.5)).toBe(false);
    expect(team).toMatchObject({ x: 50, y: 100, fx: 50, fy: 100 });
    expect(advanceGraphLayoutTransition([team], transition!, 0.5)).toBe(true);
    expect(team).toMatchObject({ x: 100, y: 200, fx: 100, fy: 200 });
  });

  it('starts newly revealed hierarchy containers from their nearest existing descendants', () => {
    const organization = node('org:product', 0, 0, 'organization');
    const container = node('unit:platform', 200, 160, 'container');
    const team = node('team:alpha', 240, 320, 'team');
    const edges: GraphEdge[] = [
      { id: 'org-unit', source: organization.id, target: container.id, type: 'parent-child' },
      { id: 'unit-team', source: container.id, target: team.id, type: 'parent-child' },
    ];

    createGraphLayoutTransition({
      nodes: [organization, container, team],
      edges,
      previousPositions: new Map([['team:alpha', { x: 40, y: 60 }]]),
      duration: 1,
    });

    expect(container).toMatchObject({ x: 40, y: 60 });
    expect(organization).toMatchObject({ x: 40, y: 60 });
    expect(team).toMatchObject({ x: 40, y: 60 });
  });

  it('projects final coordinates for camera fitting without advancing the transition', () => {
    const team = node('team:alpha', 100, 200, 'team');
    const transition = createGraphLayoutTransition({
      nodes: [team],
      edges: [],
      previousPositions: new Map([['team:alpha', { x: 0, y: 0 }]]),
      duration: 1,
    });

    const targetNodes = resolveGraphLayoutTargetNodes([team], transition);

    expect(team).toMatchObject({ x: 0, y: 0 });
    expect(targetNodes[0]).not.toBe(team);
    expect(targetNodes[0]).toMatchObject({ x: 100, y: 200 });
  });
});
