/**
 * Render strategy for task pill nodes.
 */

import { drawTasks } from '../canvas/draw-tasks';
import { HIT_DETECTION, KANBAN_ZONE, TASK_PILL } from '../constants/canvas-constants';

import type { GraphNode } from '../ports/types';
import type { NodeRenderState, NodeRenderStrategy } from './types';

export class TaskStrategy implements NodeRenderStrategy {
  readonly kind = 'task' as const;

  draw(ctx: CanvasRenderingContext2D, node: GraphNode, state: NodeRenderState): void {
    drawTasks(
      ctx,
      [node],
      state.time,
      state.isSelected ? node.id : null,
      state.isHovered ? node.id : null,
    );
  }

  hitTest(node: GraphNode, wx: number, wy: number): boolean {
    const x = node.x ?? 0;
    const y = node.y ?? 0;
    const halfW = TASK_PILL.width / 2 + HIT_DETECTION.taskPadding;
    const taskHeight = node.isOverflowStack ? KANBAN_ZONE.overflowHeight : TASK_PILL.height;
    const halfH = taskHeight / 2 + HIT_DETECTION.taskPadding;
    return wx >= x - halfW && wx <= x + halfW && wy >= y - halfH && wy <= y + halfH;
  }

  getCollisionRadius(): number {
    return Math.max(TASK_PILL.width, TASK_PILL.height) / 2 + 10;
  }

  getChargeStrength(): number {
    return -300;
  }
}
