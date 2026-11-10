/**
 * Strategy registry — maps GraphNodeKind to its render strategy.
 * Open-Closed: add new node kinds by adding new strategies to the registry.
 */

import type { GraphNodeKind } from '../ports/types';
import type { NodeRenderStrategy } from './types';
import { LeadStrategy, MemberStrategy } from './memberStrategy';
import { TaskStrategy } from './taskStrategy';
import { ProcessStrategy } from './processStrategy';

const STRATEGIES: Record<GraphNodeKind, NodeRenderStrategy> = {
  lead: new LeadStrategy(),
  member: new MemberStrategy(),
  task: new TaskStrategy(),
  process: new ProcessStrategy(),
  crossteam: new ProcessStrategy(), // Reuse process strategy (similar small node)
};

export function getNodeStrategy(kind: GraphNodeKind): NodeRenderStrategy {
  return STRATEGIES[kind];
}

export function getAllStrategies(): NodeRenderStrategy[] {
  return Object.values(STRATEGIES);
}

export type { NodeRenderStrategy, NodeRenderState } from './types';
