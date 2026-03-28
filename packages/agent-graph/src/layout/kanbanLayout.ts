/**
 * KanbanLayoutEngine — positions task nodes in kanban columns relative to their owner.
 *
 * Each member/lead gets a zone below them with columns for non-empty statuses only.
 * Empty columns are skipped — no wasted space. Each column has a header label.
 *
 * Class with ES #private methods, single source of truth from KANBAN_ZONE constants.
 */

import type { GraphNode } from '../ports/types';
import { KANBAN_ZONE } from '../constants/canvas-constants';

/** Column header info for rendering */
export interface KanbanColumnHeader {
  label: string;
  x: number;
  y: number;
  color: string;
}

/** Zone info per owner for rendering headers */
export interface KanbanZoneInfo {
  ownerId: string;
  ownerX: number;
  ownerY: number;
  headers: KanbanColumnHeader[];
}

// Column display config
const COLUMN_LABELS: Record<string, { label: string; color: string }> = {
  todo: { label: 'Todo', color: '#6b7280' },
  wip: { label: 'In Progress', color: '#3b82f6' },
  done: { label: 'Done', color: '#22c55e' },
  review: { label: 'Review', color: '#f59e0b' },
  approved: { label: 'Approved', color: '#22c55e' },
};

export class KanbanLayoutEngine {
  // Reusable collections (cleared each call, never GC'd)
  static readonly #nodeMap = new Map<string, GraphNode>();
  static readonly #tasksByOwner = new Map<string, GraphNode[]>();
  static readonly #unassigned: GraphNode[] = [];
  static readonly #colTasks = new Map<string, GraphNode[]>();

  /** Zone info for rendering column headers — updated each layout() call */
  static zones: KanbanZoneInfo[] = [];

  /**
   * Position all task nodes in kanban columns relative to their owner.
   * Call AFTER d3-force settles member positions, BEFORE drawing.
   */
  static layout(nodes: GraphNode[]): void {
    const nodeMap = this.#nodeMap;
    nodeMap.clear();
    for (const n of nodes) nodeMap.set(n.id, n);

    const tasksByOwner = this.#tasksByOwner;
    tasksByOwner.clear();
    const unassigned = this.#unassigned;
    unassigned.length = 0;

    for (const n of nodes) {
      if (n.kind !== 'task') continue;
      if (n.ownerId) {
        let group = tasksByOwner.get(n.ownerId);
        if (!group) {
          group = [];
          tasksByOwner.set(n.ownerId, group);
        }
        group.push(n);
      } else {
        unassigned.push(n);
      }
    }

    // Reset zones
    this.zones = [];

    for (const [ownerId, tasks] of tasksByOwner) {
      const owner = nodeMap.get(ownerId);
      if (!owner || owner.x == null || owner.y == null) continue;
      const zoneInfo = KanbanLayoutEngine.#layoutZone(tasks, owner.x, owner.y, ownerId);
      if (zoneInfo) this.zones.push(zoneInfo);
    }

    KanbanLayoutEngine.#layoutUnassigned(unassigned);
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  static #layoutZone(tasks: GraphNode[], ownerX: number, ownerY: number, ownerId: string): KanbanZoneInfo | null {
    const { columnWidth, rowHeight, offsetY, columns, maxVisibleRows } = KANBAN_ZONE;
    const headerHeight = 20; // space for column header label
    const baseY = ownerY + offsetY;

    // Classify tasks into columns
    const colTasks = KanbanLayoutEngine.#colTasks;
    colTasks.clear();
    for (const col of columns) colTasks.set(col, []);

    for (const task of tasks) {
      const col = KanbanLayoutEngine.#resolveColumn(task);
      colTasks.get(col)?.push(task);
    }

    // Collect only NON-EMPTY columns (skip empty — no wasted space)
    const activeColumns: { name: string; tasks: GraphNode[] }[] = [];
    for (const colName of columns) {
      const nodes = colTasks.get(colName) ?? [];
      if (nodes.length > 0) {
        activeColumns.push({ name: colName, tasks: nodes });
      }
    }

    if (activeColumns.length === 0) return null;

    // Center active columns under owner
    const totalWidth = activeColumns.length * columnWidth;
    const baseX = ownerX - totalWidth / 2;

    // Build headers + position tasks
    const headers: KanbanColumnHeader[] = [];

    for (const [colIdx, col] of activeColumns.entries()) {
      const colX = baseX + colIdx * columnWidth;
      const config = COLUMN_LABELS[col.name] ?? { label: col.name, color: '#888' };

      // Column header — centered over pill area (pill center = colX since drawTaskPill translates to x,y)
      headers.push({
        label: config.label,
        x: colX, // pill center = task.x = colX
        y: baseY,
        color: config.color,
      });

      // Position tasks below header
      for (const [rowIdx, task] of col.tasks.entries()) {
        if (rowIdx >= maxVisibleRows) {
          task.x = -99999;
          task.y = -99999;
          task.fx = task.x;
          task.fy = task.y;
          continue;
        }
        const targetX = colX;
        const targetY = baseY + headerHeight + rowIdx * rowHeight;
        task.x = task.x != null ? task.x + (targetX - task.x) * 0.15 : targetX;
        task.y = task.y != null ? task.y + (targetY - task.y) * 0.15 : targetY;
        task.fx = task.x;
        task.fy = task.y;
        task.vx = 0;
        task.vy = 0;
      }
    }

    return { ownerId, ownerX, ownerY, headers };
  }

  static #resolveColumn(task: GraphNode): string {
    if (task.reviewState === 'approved') return 'approved';
    if (task.reviewState === 'review' || task.reviewState === 'needsFix') return 'review';
    switch (task.taskStatus) {
      case 'in_progress':
        return 'wip';
      case 'completed':
        return 'done';
      default:
        return 'todo';
    }
  }

  static #layoutUnassigned(tasks: GraphNode[]): void {
    const { columnWidth, rowHeight } = KANBAN_ZONE;
    for (const [idx, task] of tasks.entries()) {
      const targetX = -400 + (idx % 3) * columnWidth;
      const targetY = 400 + Math.floor(idx / 3) * rowHeight;
      task.x = task.x != null ? task.x + (targetX - task.x) * 0.15 : targetX;
      task.y = task.y != null ? task.y + (targetY - task.y) * 0.15 : targetY;
      task.fx = task.x;
      task.fy = task.y;
      task.vx = 0;
      task.vy = 0;
    }
  }
}
