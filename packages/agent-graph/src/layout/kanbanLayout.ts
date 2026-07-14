/**
 * KanbanLayoutEngine — positions task nodes in kanban columns relative to their owner.
 *
 * Each member/lead gets a zone below them with columns for non-empty statuses only.
 * Empty columns are skipped — no wasted space. Each column has a header label.
 *
 * Class with ES #private methods, single source of truth from KANBAN_ZONE constants.
 */

import { KANBAN_ZONE, TASK_PILL } from '../constants/canvas-constants';
import { COLORS } from '../constants/colors';

import type { GraphNode } from '../ports/types';
import type { SlotFrame, StableRect } from './stableSlots';

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
  emptyPlaceholder?: {
    label: string;
    x: number;
    y: number;
    color: string;
  };
}

// Column display config — colors from single source of truth (COLORS)
const COLUMN_LABELS: Record<string, { label: string; color: string }> = {
  todo: { label: 'Todo', color: COLORS.taskPending },
  wip: { label: 'In Progress', color: COLORS.taskInProgress },
  done: { label: 'Done', color: COLORS.taskCompleted },
  review: { label: 'Review', color: COLORS.reviewPending },
  approved: { label: 'Approved', color: COLORS.reviewApproved },
};

function getOverflowFooterCenterY(baseY: number): number {
  const overflowGap = KANBAN_ZONE.rowHeight - TASK_PILL.height;
  return (
    baseY +
    KANBAN_ZONE.headerHeight +
    (KANBAN_ZONE.maxVisibleRows - 1) * KANBAN_ZONE.rowHeight +
    TASK_PILL.height / 2 +
    overflowGap +
    KANBAN_ZONE.overflowHeight / 2
  );
}

export function getOwnerKanbanBaseX(args: {
  ownerX: number;
  ownerKind: GraphNode['kind'];
  activeColumnCount: number;
  columnWidth: number;
  leadX?: number | null;
}): number {
  const { ownerX, ownerKind, activeColumnCount, columnWidth } = args;
  if (activeColumnCount <= 0) {
    return ownerX;
  }

  if (ownerKind !== 'lead' && ownerKind !== 'member') {
    return ownerX - (activeColumnCount * columnWidth) / 2;
  }

  return ownerX - ((activeColumnCount - 1) * columnWidth) / 2;
}

export class KanbanLayoutEngine {
  // Reusable collections (cleared each call, never GC'd)
  static readonly #nodeMap = new Map<string, GraphNode>();
  static readonly #tasksByOwner = new Map<string, GraphNode[]>();
  static readonly #unassigned: GraphNode[] = [];
  static readonly #colTasks = new Map<string, GraphNode[]>();

  /** Zone info for rendering column headers — updated each layout() call */
  static readonly zones: KanbanZoneInfo[] = [];

  /**
   * Position all task nodes in kanban columns relative to their owner.
   * Call AFTER d3-force settles member positions, BEFORE drawing.
   */
  static layout(
    nodes: GraphNode[],
    options?: {
      memberSlotFrames?: readonly SlotFrame[];
      leadSlotFrame?: SlotFrame | null;
      unassignedTaskRect?: StableRect | null;
      showEmptyTaskPlaceholders?: boolean;
    }
  ): void {
    const nodeMap = this.#nodeMap;
    nodeMap.clear();
    for (const n of nodes) nodeMap.set(n.id, n);
    const leadX = nodes.find((node) => node.kind === 'lead')?.x ?? null;
    const ownerSlotFrameByOwnerId = new Map(
      (options?.memberSlotFrames ?? []).map((frame) => [frame.ownerId, frame] as const)
    );
    if (options?.leadSlotFrame) {
      ownerSlotFrameByOwnerId.set(options.leadSlotFrame.ownerId, options.leadSlotFrame);
    }

    const tasksByOwner = this.#tasksByOwner;
    tasksByOwner.clear();
    const unassigned = this.#unassigned;
    unassigned.length = 0;
    const hasLayoutOwner = (ownerId: string): boolean => {
      const owner = nodeMap.get(ownerId);
      if (!owner) {
        return false;
      }
      if (owner.kind === 'lead') {
        return ownerSlotFrameByOwnerId.has(ownerId);
      }
      if (owner.kind === 'member') {
        return ownerSlotFrameByOwnerId.has(ownerId);
      }
      return false;
    };

    for (const n of nodes) {
      if (n.kind !== 'task') continue;
      if (n.ownerId && hasLayoutOwner(n.ownerId)) {
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
    this.zones.length = 0;

    for (const [ownerId, tasks] of tasksByOwner) {
      const owner = nodeMap.get(ownerId);
      if (owner?.x == null || owner?.y == null) continue;
      const zoneInfo = KanbanLayoutEngine.#layoutZone(
        tasks,
        owner,
        ownerId,
        leadX,
        ownerSlotFrameByOwnerId.get(ownerId) ?? null
      );
      if (zoneInfo) this.zones.push(zoneInfo);
    }

    if (options?.showEmptyTaskPlaceholders) {
      KanbanLayoutEngine.#layoutEmptyTaskPlaceholders(
        [
          ...(options.memberSlotFrames ?? []),
          ...(options.leadSlotFrame ? [options.leadSlotFrame] : []),
        ],
        tasksByOwner
      );
    }

    KanbanLayoutEngine.#layoutUnassigned(unassigned, nodes, options?.unassignedTaskRect ?? null);
  }

  /** Build headers for task nodes whose positions are supplied by a static layout. */
  static layoutStatic(nodes: GraphNode[]): void {
    const nodeMap = this.#nodeMap;
    nodeMap.clear();
    for (const node of nodes) nodeMap.set(node.id, node);

    const tasksByOwner = this.#tasksByOwner;
    tasksByOwner.clear();
    for (const node of nodes) {
      if (node.kind !== 'task' || !node.ownerId || node.x == null || node.y == null) continue;
      const tasks = tasksByOwner.get(node.ownerId) ?? [];
      tasks.push(node);
      tasksByOwner.set(node.ownerId, tasks);
    }

    this.zones.length = 0;
    for (const [ownerId, tasks] of tasksByOwner) {
      const owner = nodeMap.get(ownerId);
      if (!owner || owner.x == null || owner.y == null) continue;

      const firstTaskByColumn = new Map<string, GraphNode>();
      for (const task of [...tasks].sort((left, right) => (left.y ?? 0) - (right.y ?? 0))) {
        const column = KanbanLayoutEngine.#resolveColumn(task);
        if (!firstTaskByColumn.has(column)) firstTaskByColumn.set(column, task);
      }
      const headers = KANBAN_ZONE.columns.flatMap((column) => {
        const task = firstTaskByColumn.get(column);
        if (!task || task.x == null || task.y == null) return [];
        const config = COLUMN_LABELS[column] ?? { label: column, color: '#888' };
        return [
          {
            label: config.label,
            x: task.x,
            y: task.y - KANBAN_ZONE.headerHeight,
            color: config.color,
          },
        ];
      });
      if (headers.length === 0) continue;
      this.zones.push({
        ownerId,
        ownerX: owner.x,
        ownerY: owner.y,
        headers,
      });
    }
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  static #layoutZone(
    tasks: GraphNode[],
    owner: GraphNode,
    ownerId: string,
    leadX: number | null,
    slotFrame: SlotFrame | null
  ): KanbanZoneInfo | null {
    const { columnWidth, rowHeight, offsetY, columns, headerHeight } = KANBAN_ZONE;
    const ownerX = owner.x ?? 0;
    const ownerY = owner.y ?? 0;

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

    let baseX = getOwnerKanbanBaseX({
      ownerX,
      ownerKind: owner.kind,
      activeColumnCount: activeColumns.length,
      columnWidth,
      leadX,
    });
    let baseY: number;

    if (slotFrame) {
      baseX = slotFrame.kanbanBandRect.left + TASK_PILL.width / 2;
      baseY = slotFrame.kanbanBandRect.top;
    } else {
      baseY = ownerY + offsetY;
    }

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

      // Position tasks below header. Overflow stacks render as a compact footer after
      // the full visible task budget instead of consuming a task-card row.
      for (const [rowIdx, task] of col.tasks.entries()) {
        const targetX = colX;
        const targetY = task.isOverflowStack
          ? getOverflowFooterCenterY(baseY)
          : baseY + headerHeight + rowIdx * rowHeight;
        task.x = slotFrame
          ? targetX
          : task.x != null
            ? task.x + (targetX - task.x) * 0.15
            : targetX;
        task.y = slotFrame
          ? targetY
          : task.y != null
            ? task.y + (targetY - task.y) * 0.15
            : targetY;
        task.fx = task.x;
        task.fy = task.y;
        task.vx = 0;
        task.vy = 0;
      }
    }

    return { ownerId, ownerX, ownerY, headers };
  }

  static #layoutEmptyTaskPlaceholders(
    slotFrames: readonly SlotFrame[],
    tasksByOwner: ReadonlyMap<string, readonly GraphNode[]>
  ): void {
    for (const slotFrame of slotFrames) {
      if (tasksByOwner.has(slotFrame.ownerId) || slotFrame.kanbanBandRect.width <= 0) {
        continue;
      }

      const x = slotFrame.kanbanBandRect.left + TASK_PILL.width / 2;
      const headerY = slotFrame.kanbanBandRect.top;
      this.zones.push({
        ownerId: slotFrame.ownerId,
        ownerX: slotFrame.ownerX,
        ownerY: slotFrame.ownerY,
        headers: [
          {
            label: COLUMN_LABELS.wip.label,
            x,
            y: headerY,
            color: COLUMN_LABELS.wip.color,
          },
        ],
        emptyPlaceholder: {
          label: 'No active tasks',
          x,
          y: headerY + KANBAN_ZONE.headerHeight,
          color: COLORS.textDim,
        },
      });
    }
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

  static #layoutUnassigned(
    tasks: GraphNode[],
    allNodes: GraphNode[],
    unassignedTaskRect: StableRect | null
  ): void {
    if (tasks.length === 0) return;

    const { columnWidth, rowHeight } = KANBAN_ZONE;

    if (unassignedTaskRect) {
      const cols = Math.min(Math.max(tasks.length, 1), 5);
      const baseX = unassignedTaskRect.left + TASK_PILL.width / 2;
      const headerY = unassignedTaskRect.top;
      const baseY = headerY + KANBAN_ZONE.headerHeight;

      this.zones.push({
        ownerId: '__unassigned__',
        ownerX: 0,
        ownerY: headerY - 48,
        headers: [
          {
            label: 'Unassigned',
            x: 0,
            y: headerY,
            color: COLORS.taskPending,
          },
        ],
      });

      for (const [idx, task] of tasks.entries()) {
        const col = idx % cols;
        const row = Math.floor(idx / cols);
        const targetX = baseX + col * columnWidth;
        const targetY = task.isOverflowStack
          ? getOverflowFooterCenterY(headerY)
          : baseY + row * rowHeight;
        task.x = targetX;
        task.y = targetY;
        task.fx = targetX;
        task.fy = targetY;
        task.vx = 0;
        task.vy = 0;
      }
      return;
    }

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
    const headerY = (maxY > -Infinity ? maxY : 0) + 150;
    const baseY = headerY + KANBAN_ZONE.headerHeight;
    const cols = Math.min(tasks.length, 4);
    const totalWidth = cols * columnWidth;
    const baseX = centerX - totalWidth / 2;

    // Add zone header for unassigned section
    if (tasks.length > 0) {
      this.zones.push({
        ownerId: '__unassigned__',
        ownerX: centerX,
        ownerY: headerY - 70,
        headers: [
          {
            label: 'Unassigned',
            x: centerX,
            y: headerY,
            color: COLORS.taskPending,
          },
        ],
      });
    }

    for (const [idx, task] of tasks.entries()) {
      const col = idx % cols;
      const row = Math.floor(idx / cols);
      const targetX = baseX + col * columnWidth;
      const targetY = task.isOverflowStack
        ? getOverflowFooterCenterY(headerY)
        : baseY + row * rowHeight;
      task.x = task.x != null ? task.x + (targetX - task.x) * 0.15 : targetX;
      task.y = task.y != null ? task.y + (targetY - task.y) * 0.15 : targetY;
      task.fx = task.x;
      task.fy = task.y;
      task.vx = 0;
      task.vy = 0;
    }
  }
}
