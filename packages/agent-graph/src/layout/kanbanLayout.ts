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
import { COLORS } from '../constants/colors';
import { resolveActivityLaneSide } from './activityLane';

/** Column header info for rendering */
export interface KanbanColumnHeader {
  label: string;
  x: number;
  y: number;
  color: string;
  /** Number of hidden overflow tasks in this column */
  overflowCount: number;
  /** Y position for the overflow badge */
  overflowY: number;
}

/** Zone info per owner for rendering headers */
export interface KanbanZoneInfo {
  ownerId: string;
  ownerX: number;
  ownerY: number;
  headers: KanbanColumnHeader[];
}

// Column display config — colors from single source of truth (COLORS)
const COLUMN_LABELS: Record<string, { label: string; color: string }> = {
  todo: { label: 'Todo', color: COLORS.taskPending },
  wip: { label: 'In Progress', color: COLORS.taskInProgress },
  done: { label: 'Done', color: COLORS.taskCompleted },
  review: { label: 'Review', color: COLORS.reviewPending },
  approved: { label: 'Approved', color: COLORS.reviewApproved },
};

export function getOwnerKanbanBaseX(args: {
  ownerX: number;
  ownerKind: GraphNode['kind'];
  activeColumnCount: number;
  columnWidth: number;
  leadX?: number | null;
}): number {
  const { ownerX, ownerKind, activeColumnCount, columnWidth, leadX } = args;
  if (activeColumnCount <= 0) {
    return ownerX;
  }

  if (ownerKind !== 'lead' && ownerKind !== 'member') {
    return ownerX - (activeColumnCount * columnWidth) / 2;
  }

  const side = resolveActivityLaneSide({
    nodeKind: ownerKind,
    nodeX: ownerX,
    leadX,
  });

  if (side === 'left') {
    return ownerX;
  }

  return ownerX - (activeColumnCount - 1) * columnWidth;
}

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
    const leadX = nodes.find((node) => node.kind === 'lead')?.x ?? null;

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
      const zoneInfo = KanbanLayoutEngine.#layoutZone(tasks, owner, ownerId, leadX);
      if (zoneInfo) this.zones.push(zoneInfo);
    }

    KanbanLayoutEngine.#layoutUnassigned(unassigned, nodes);
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  static #layoutZone(
    tasks: GraphNode[],
    owner: GraphNode,
    ownerId: string,
    leadX: number | null
  ): KanbanZoneInfo | null {
    const { columnWidth, rowHeight, offsetY, columns } = KANBAN_ZONE;
    const headerHeight = 20; // space for column header label
    const ownerX = owner.x ?? 0;
    const ownerY = owner.y ?? 0;
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

    // Keep kanban columns on the open side of the owner, away from the reserved activity lane.
    // This makes member lanes reserve real visual space instead of only affecting the force layout.
    const baseX = getOwnerKanbanBaseX({
      ownerX,
      ownerKind: owner.kind,
      activeColumnCount: activeColumns.length,
      columnWidth,
      leadX,
    });

    // Build headers + position tasks
    const headers: KanbanColumnHeader[] = [];

    for (const [colIdx, col] of activeColumns.entries()) {
      const colX = baseX + colIdx * columnWidth;
      const config = COLUMN_LABELS[col.name] ?? { label: col.name, color: '#888' };
      const overflow = col.tasks.find((task) => task.isOverflowStack)?.overflowCount ?? 0;
      const visibleCount = col.tasks.length;

      // Column header — centered over pill area (pill center = colX since drawTaskPill translates to x,y)
      headers.push({
        label: config.label,
        x: colX, // pill center = task.x = colX
        y: baseY,
        color: config.color,
        overflowCount: overflow,
        overflowY: baseY + headerHeight + visibleCount * rowHeight,
      });

      // Position tasks below header
      for (const [rowIdx, task] of col.tasks.entries()) {
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

  static #layoutUnassigned(tasks: GraphNode[], allNodes: GraphNode[]): void {
    if (tasks.length === 0) return;

    const { columnWidth, rowHeight } = KANBAN_ZONE;

    // Find the lowest Y of ALL positioned nodes (members + their owned tasks)
    let sumX = 0;
    let maxY = -Infinity;
    let memberCount = 0;
    for (const n of allNodes) {
      if (n.x == null || n.y == null) continue;
      // Skip unassigned tasks themselves (they have no ownerId)
      if (n.kind === 'task' && !n.ownerId) continue;
      if (n.y > maxY) maxY = n.y;
      if (n.kind !== 'task') {
        sumX += n.x;
        memberCount++;
      }
    }

    const centerX = memberCount > 0 ? sumX / memberCount : 0;
    // Place unassigned tasks well below the lowest element
    const baseY = (maxY > -Infinity ? maxY : 0) + 150;
    const cols = Math.min(tasks.length, 4);
    const totalWidth = cols * columnWidth;
    const baseX = centerX - totalWidth / 2;

    // Add zone header for unassigned section
    if (tasks.length > 0) {
      const overflowCount = tasks.reduce((sum, task) => sum + (task.overflowCount ?? 0), 0);
      this.zones.push({
        ownerId: '__unassigned__',
        ownerX: centerX,
        ownerY: baseY - 70,
        headers: [{
          label: 'Unassigned',
          x: centerX,
          y: baseY - 10,
          color: COLORS.taskPending,
          overflowCount,
          overflowY: baseY + KANBAN_ZONE.maxVisibleRows * rowHeight,
        }],
      });
    }

    for (const [idx, task] of tasks.entries()) {
      const col = idx % cols;
      const row = Math.floor(idx / cols);
      const targetX = baseX + col * columnWidth;
      const targetY = baseY + row * rowHeight;
      task.x = task.x != null ? task.x + (targetX - task.x) * 0.15 : targetX;
      task.y = task.y != null ? task.y + (targetY - task.y) * 0.15 : targetY;
      task.fx = task.x;
      task.fy = task.y;
      task.vx = 0;
      task.vy = 0;
    }
  }
}
