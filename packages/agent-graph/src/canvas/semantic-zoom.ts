import type { GraphNode } from '../ports/types';

export type GraphSemanticZoomLevel = 'overview' | 'summary' | 'detail';

export const GRAPH_SEMANTIC_ZOOM = {
  summaryMin: 0.24,
  detailMin: 0.62,
} as const;

export function getGraphSemanticZoomLevel(zoom: number): GraphSemanticZoomLevel {
  if (zoom < GRAPH_SEMANTIC_ZOOM.summaryMin) return 'overview';
  if (zoom < GRAPH_SEMANTIC_ZOOM.detailMin) return 'summary';
  return 'detail';
}

export function shouldRenderOverviewHierarchyNode(
  node: GraphNode,
  zoom: number,
  isEmphasized = false
): boolean {
  if (isEmphasized) return true;
  if (node.visualVariant === 'team') return false;

  const depth = Math.max(0, node.hierarchyDepth ?? 0);
  if (zoom < 0.09) return node.visualVariant === 'organization' && depth === 0;
  if (zoom < 0.17) return node.visualVariant === 'organization' && depth <= 1;
  return node.visualVariant === 'organization' || depth <= 2;
}

export function shouldRenderTaskAtZoom(
  zoom: number,
  isEmphasized = false,
  visibility: NonNullable<GraphNode['taskZoomVisibility']> = 'detail'
): boolean {
  if (isEmphasized || visibility === 'overview') return true;
  const level = getGraphSemanticZoomLevel(zoom);
  return level === 'detail' || (visibility === 'summary' && level === 'summary');
}

export function shouldRenderNodeAtZoom(
  node: GraphNode,
  zoom: number,
  isEmphasized = false
): boolean {
  if (node.layoutOnly || node.taskStatus === 'deleted') return false;
  if (node.kind === 'task') {
    return shouldRenderTaskAtZoom(zoom, isEmphasized, node.taskZoomVisibility);
  }
  if (
    getGraphSemanticZoomLevel(zoom) === 'overview' &&
    (node.visualVariant === 'organization' ||
      node.visualVariant === 'container' ||
      node.visualVariant === 'team')
  ) {
    return shouldRenderOverviewHierarchyNode(node, zoom, isEmphasized);
  }
  return true;
}

export function shouldRenderParticlesAtZoom(zoom: number, animateAtOverview = false): boolean {
  return animateAtOverview || getGraphSemanticZoomLevel(zoom) !== 'overview';
}
