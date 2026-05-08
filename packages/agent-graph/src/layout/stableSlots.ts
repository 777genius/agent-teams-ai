import { KANBAN_ZONE, TASK_PILL } from '../constants/canvas-constants';
import type { GraphLayoutPort, GraphNode, GraphOwnerSlotAssignment } from '../ports/types';
import { ACTIVITY_LANE } from './activityLane';
import type { WorldBounds } from './launchAnchor';
import { STABLE_SLOT_GEOMETRY, STABLE_SLOT_SECTOR_VECTORS } from './stableSlotGeometry';

export type StableSlotWidthBucket = 'S' | 'M' | 'L';

export interface StableRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface OwnerFootprint {
  ownerId: string;
  slotWidth: number;
  slotHeight: number;
  widthBucket: StableSlotWidthBucket;
  radialDepth: number;
  activityColumnWidth: number;
  activityColumnHeight: number;
  logColumnWidth: number;
  logColumnHeight: number;
  processBandWidth: number;
  kanbanBandWidth: number;
  kanbanBandHeight: number;
  boardBandWidth: number;
  boardBandHeight: number;
  taskColumnCount: number;
  processCount: number;
}

export interface SlotFrame {
  ownerId: string;
  ringIndex: number;
  sectorIndex: number;
  widthBucket: StableSlotWidthBucket;
  bounds: StableRect;
  ownerX: number;
  ownerY: number;
  boardBandRect: StableRect;
  activityColumnRect: StableRect;
  logColumnRect: StableRect;
  processBandRect: StableRect;
  kanbanBandRect: StableRect;
  taskColumnCount: number;
}

type OwnerSlotLayoutKind = 'radial-sector' | 'row-orbit' | 'grid-under-lead';

export interface StableSlotLayoutSnapshot {
  version: GraphLayoutPort['version'];
  teamName: string;
  leadNodeId: string | null;
  leadCoreRect: StableRect;
  leadSlotFrame: SlotFrame;
  leadActivityRect: StableRect;
  launchHudRect: StableRect;
  launchAnchor: { x: number; y: number } | null;
  leadCentralReservedBlock: StableRect;
  runtimeCentralExclusion: StableRect;
  ownerSlotLayoutKind: OwnerSlotLayoutKind;
  centralCollisionRects: StableRect[];
  memberSlotFrames: SlotFrame[];
  memberSlotFrameByOwnerId: Map<string, SlotFrame>;
  unassignedTaskRect: StableRect | null;
  fitBounds: StableRect;
}

export interface StableSlotLayoutValidationResult {
  valid: boolean;
  reason?: string;
}

interface NearestSlotAssignmentResult {
  assignment: GraphOwnerSlotAssignment;
  displacedOwnerId?: string;
  displacedAssignment?: GraphOwnerSlotAssignment;
  previewOwnerX: number;
  previewOwnerY: number;
}

interface NearestGridOwnerTargetResult {
  targetOwnerId: string;
  previewOwnerX: number;
  previewOwnerY: number;
}

interface RankedNearestSlotAssignmentResult extends NearestSlotAssignmentResult {
  distanceSquared: number;
}

interface LayoutBuildArgs {
  teamName: string;
  nodes: GraphNode[];
  layout?: GraphLayoutPort;
}

interface RingLayoutState {
  radius: number;
  outwardDepth: number;
}

type RingLayoutStateMap = ReadonlyMap<string, RingLayoutState>;

interface PlannedMemberSlotLayout {
  frames: SlotFrame[];
  kind: OwnerSlotLayoutKind;
}

interface RowOrbitSlotConfig {
  footprint: OwnerFootprint;
  assignment: GraphOwnerSlotAssignment;
  rowIndex: number;
  columnIndex: number;
  columnCount: number;
  band: 'top' | 'middle' | 'bottom';
}

const SLOT_GEOMETRY = {
  ...STABLE_SLOT_GEOMETRY,
  activityColumnHeight:
    ACTIVITY_LANE.headerHeight +
    ACTIVITY_LANE.maxVisibleItems * ACTIVITY_LANE.rowHeight +
    ACTIVITY_LANE.overflowHeight,
  activityColumnWidth: ACTIVITY_LANE.width,
  logColumnHeight:
    ACTIVITY_LANE.headerHeight +
    ACTIVITY_LANE.maxVisibleItems * ACTIVITY_LANE.rowHeight +
    ACTIVITY_LANE.overflowHeight,
  logColumnWidth: 260,
  ownerToProcessGap: STABLE_SLOT_GEOMETRY.slotVerticalGap,
  processToBoardGap: STABLE_SLOT_GEOMETRY.slotVerticalGap,
  boardColumnGap: 24,
  processRailMinWidth: STABLE_SLOT_GEOMETRY.processRailWidth,
  kanbanBandHeight:
    KANBAN_ZONE.headerHeight + STABLE_SLOT_GEOMETRY.taskMaxVisibleRows * KANBAN_ZONE.rowHeight,
  centralPadding: STABLE_SLOT_GEOMETRY.centralSafetyPadding,
} as const;

const PROCESS_RAIL_NODE_GAP = 42;
const PROCESS_RAIL_NODE_FOOTPRINT = 28;
const GEOMETRY_EPSILON = 0.001;
const FEED_HEADER_BOTTOM_GAP = 4;
const STRICT_SMALL_TEAM_MAX_PACKING_ITERATIONS = 96;
const STRICT_SMALL_TEAM_RADIUS_EPSILON = 0.5;
const STRICT_SMALL_TEAM_RADIUS_STEP = 24;
const GRID_UNDER_LEAD_DEFAULT_COLUMN_COUNT = 2;
const GRID_UNDER_LEAD_WIDE_TEAM_COLUMN_COUNT = 3;
const GRID_UNDER_LEAD_WIDE_TEAM_OWNER_COUNT = 6;
const GRID_UNDER_LEAD_LEAD_GAP = 77.7;
const GRID_UNDER_LEAD_ROW_GAP = 77.7;
const ROW_ORBIT_MIN_OWNER_COUNT = 6;
const ROW_ORBIT_MAX_OWNER_COUNT = 12;
const ROW_ORBIT_HORIZONTAL_GAP = Math.max(112, STABLE_SLOT_GEOMETRY.slotHorizontalGap);
const ROW_ORBIT_VERTICAL_GAP = Math.max(144, GRID_UNDER_LEAD_ROW_GAP);
const ROW_ORBIT_CENTRAL_GAP = 160;

const SECTOR_VECTORS = STABLE_SLOT_SECTOR_VECTORS;
const SMALL_TEAM_CARDINAL_LAYOUTS: ReadonlyArray<
  ReadonlyArray<{
    assignment: GraphOwnerSlotAssignment;
    vector: { x: number; y: number };
  }>
> = [
  [],
  [{ assignment: { ringIndex: 0, sectorIndex: 0 }, vector: { x: 0, y: -1 } }],
  [
    { assignment: { ringIndex: 0, sectorIndex: 0 }, vector: { x: -1, y: 0 } },
    { assignment: { ringIndex: 0, sectorIndex: 1 }, vector: { x: 1, y: 0 } },
  ],
  [
    { assignment: { ringIndex: 0, sectorIndex: 0 }, vector: { x: 0, y: -1 } },
    { assignment: { ringIndex: 0, sectorIndex: 1 }, vector: { x: -1, y: 0 } },
    { assignment: { ringIndex: 0, sectorIndex: 2 }, vector: { x: 1, y: 0 } },
  ],
  [
    { assignment: { ringIndex: 0, sectorIndex: 0 }, vector: { x: 0, y: -1 } },
    { assignment: { ringIndex: 0, sectorIndex: 1 }, vector: { x: 1, y: 0 } },
    { assignment: { ringIndex: 0, sectorIndex: 2 }, vector: { x: 0, y: 1 } },
    { assignment: { ringIndex: 0, sectorIndex: 3 }, vector: { x: -1, y: 0 } },
  ],
  [
    { assignment: { ringIndex: 0, sectorIndex: 0 }, vector: SECTOR_VECTORS[0] },
    { assignment: { ringIndex: 0, sectorIndex: 1 }, vector: SECTOR_VECTORS[1] },
    { assignment: { ringIndex: 0, sectorIndex: 2 }, vector: SECTOR_VECTORS[2] },
    { assignment: { ringIndex: 0, sectorIndex: 4 }, vector: SECTOR_VECTORS[4] },
    { assignment: { ringIndex: 0, sectorIndex: 5 }, vector: SECTOR_VECTORS[5] },
  ],
  [
    { assignment: { ringIndex: 0, sectorIndex: 0 }, vector: SECTOR_VECTORS[0] },
    { assignment: { ringIndex: 0, sectorIndex: 1 }, vector: SECTOR_VECTORS[1] },
    { assignment: { ringIndex: 0, sectorIndex: 2 }, vector: SECTOR_VECTORS[2] },
    { assignment: { ringIndex: 0, sectorIndex: 3 }, vector: SECTOR_VECTORS[3] },
    { assignment: { ringIndex: 0, sectorIndex: 4 }, vector: SECTOR_VECTORS[4] },
    { assignment: { ringIndex: 0, sectorIndex: 5 }, vector: SECTOR_VECTORS[5] },
  ],
];

const SMALL_TEAM_CARDINAL_ASSIGNMENTS: ReadonlyArray<ReadonlyArray<GraphOwnerSlotAssignment>> =
  SMALL_TEAM_CARDINAL_LAYOUTS.map((layout) => layout.map((slot) => slot.assignment));

const ROW_ORBIT_ROW_COUNTS_BY_OWNER_COUNT: Readonly<Record<number, readonly number[]>> = {
  6: [3, 2, 3],
  7: [3, 2, 2],
  8: [3, 2, 3],
  9: [3, 2, 2, 2],
  10: [3, 2, 2, 3],
  11: [3, 3, 2, 3],
  12: [3, 3, 3, 3],
};

const ROW_ORBIT_ASSIGNMENTS_BY_OWNER_COUNT: Readonly<
  Record<number, readonly GraphOwnerSlotAssignment[]>
> = Object.fromEntries(
  Object.entries(ROW_ORBIT_ROW_COUNTS_BY_OWNER_COUNT).map(([ownerCount, rowCounts]) => [
    Number(ownerCount),
    rowCounts.flatMap((columnCount, rowIndex) =>
      Array.from({ length: columnCount }, (_, columnIndex) => ({
        ringIndex: rowIndex,
        sectorIndex: columnIndex,
      }))
    ),
  ])
);

export function buildStableSlotLayoutSnapshot({
  teamName,
  nodes,
  layout,
}: LayoutBuildArgs): StableSlotLayoutSnapshot | null {
  const leadNode = nodes.find((node) => node.kind === 'lead') ?? null;
  if (!leadNode) {
    return null;
  }

  const leadCoreRect = createCenteredRect(0, 0, 200, 96);
  const leadFootprint = computeOwnerFootprintForOwnerId(nodes, leadNode.id, layout);
  const leadSlotFrame = buildSlotFrameAtRadius(leadFootprint, { ringIndex: 0, sectorIndex: 0 }, 0);
  const leadActivityRect = leadSlotFrame.activityColumnRect;
  const launchHudRect = createRect(leadCoreRect.right, leadCoreRect.top, 0, 0);
  const leadCentralReservedBlock = buildLeadCentralReservedBlock({
    leadCoreRect,
    leadSlotFrame,
  });

  const ownerFootprints = computeOwnerFootprints(nodes, layout);
  const unassignedTaskRect = buildUnassignedTaskRect(nodes, leadCentralReservedBlock);
  const centralCollisionRects = buildCentralCollisionRects({
    leadCoreRect,
    leadSlotFrame,
    unassignedTaskRect,
  });
  const runtimeCentralExclusion = padRect(
    unionRects(centralCollisionRects),
    SLOT_GEOMETRY.centralPadding
  );

  const memberSlotLayout =
    (layout?.mode ?? 'radial') === 'grid-under-lead'
      ? {
          frames: planGridUnderLeadOwnerSlots(ownerFootprints, centralCollisionRects),
          kind: 'grid-under-lead' as const,
        }
      : planOwnerSlots(ownerFootprints, centralCollisionRects, runtimeCentralExclusion, layout);
  const memberSlotFrames = memberSlotLayout.frames;
  const memberSlotFrameByOwnerId = new Map(
    memberSlotFrames.map((frame) => [frame.ownerId, frame] as const)
  );
  const fitBounds = unionRects(
    [runtimeCentralExclusion, ...memberSlotFrames.map((frame) => frame.bounds)].filter(Boolean)
  );

  return {
    version: layout?.version ?? 'stable-slots-v1',
    teamName,
    leadNodeId: leadNode.id,
    leadCoreRect,
    leadSlotFrame,
    leadActivityRect,
    launchHudRect,
    launchAnchor: null,
    leadCentralReservedBlock,
    runtimeCentralExclusion,
    ownerSlotLayoutKind: memberSlotLayout.kind,
    centralCollisionRects,
    memberSlotFrames,
    memberSlotFrameByOwnerId,
    unassignedTaskRect,
    fitBounds,
  };
}

function buildCentralCollisionRects(args: {
  leadCoreRect: StableRect;
  leadSlotFrame: SlotFrame;
  unassignedTaskRect: StableRect | null;
}): StableRect[] {
  const rects = [
    args.leadCoreRect,
    args.leadSlotFrame.processBandRect,
    args.leadSlotFrame.activityColumnRect,
    args.leadSlotFrame.logColumnRect,
    args.leadSlotFrame.kanbanBandRect,
  ];
  if (args.unassignedTaskRect) {
    rects.push(args.unassignedTaskRect);
  }
  return rects;
}

function buildLeadCentralReservedBlock(args: {
  leadCoreRect: StableRect;
  leadSlotFrame: SlotFrame;
}): StableRect {
  return unionRects([
    args.leadCoreRect,
    args.leadSlotFrame.processBandRect,
    args.leadSlotFrame.activityColumnRect,
    args.leadSlotFrame.logColumnRect,
    args.leadSlotFrame.kanbanBandRect,
  ]);
}

function padCentralCollisionRects(rects: readonly StableRect[], padding: number): StableRect[] {
  return rects.map((rect) => padRect(rect, padding));
}

function rectOverlapsAnyCentralRect(
  rect: StableRect,
  centralCollisionRects: readonly StableRect[]
): boolean {
  return centralCollisionRects.some((centralRect) =>
    rectsOverlapWithAxisGap(rect, centralRect, SLOT_GEOMETRY.centralHorizontalGap, 0)
  );
}

export function computeOwnerFootprints(
  nodes: GraphNode[],
  layout?: GraphLayoutPort
): OwnerFootprint[] {
  const ownerNodes = nodes.filter((node) => node.kind === 'member');
  const showActivity = layout?.showActivity ?? true;
  const showLogs = layout?.showLogs ?? showActivity;
  const ownerNodeById = new Map(ownerNodes.map((node) => [node.id, node] as const));
  const taskColumnsByOwnerId = new Map<string, Set<string>>();
  const processCountByOwnerId = new Map<string, number>();

  for (const node of nodes) {
    if (node.kind === 'task' && node.ownerId) {
      const existing = taskColumnsByOwnerId.get(node.ownerId) ?? new Set<string>();
      existing.add(resolveTaskColumnKey(node));
      taskColumnsByOwnerId.set(node.ownerId, existing);
    }
    if (node.kind === 'process' && node.ownerId) {
      processCountByOwnerId.set(node.ownerId, (processCountByOwnerId.get(node.ownerId) ?? 0) + 1);
    }
  }

  const orderedOwnerIds = [
    ...(layout?.ownerOrder ?? ownerNodes.map((node) => node.id)),
    ...ownerNodes
      .map((node) => node.id)
      .filter((ownerId) => !(layout?.ownerOrder ?? []).includes(ownerId)),
  ].filter((ownerId, index, array) => array.indexOf(ownerId) === index);

  return orderedOwnerIds.flatMap((ownerId) => {
    const ownerNode = ownerNodeById.get(ownerId);
    if (!ownerNode) {
      return [];
    }

    return [
      buildOwnerFootprint({
        ownerId,
        taskColumnCount: taskColumnsByOwnerId.get(ownerId)?.size ?? 0,
        processCount: processCountByOwnerId.get(ownerId) ?? 0,
        showActivity,
        showLogs,
      }),
    ];
  });
}

function computeOwnerFootprintForOwnerId(
  nodes: readonly GraphNode[],
  ownerId: string,
  layout?: GraphLayoutPort
): OwnerFootprint {
  const taskColumns = new Set<string>();
  let processCount = 0;

  for (const node of nodes) {
    if (node.kind === 'task' && node.ownerId === ownerId) {
      taskColumns.add(resolveTaskColumnKey(node));
    }
    if (node.kind === 'process' && node.ownerId === ownerId) {
      processCount += 1;
    }
  }

  return buildOwnerFootprint({
    ownerId,
    taskColumnCount: taskColumns.size,
    processCount,
    showActivity: layout?.showActivity ?? true,
    showLogs: layout?.showLogs ?? layout?.showActivity ?? true,
  });
}

function buildOwnerFootprint(args: {
  ownerId: string;
  taskColumnCount: number;
  processCount: number;
  showActivity: boolean;
  showLogs: boolean;
}): OwnerFootprint {
  const activityColumnWidth = args.showActivity ? SLOT_GEOMETRY.activityColumnWidth : 0;
  const activityColumnHeight = args.showActivity ? SLOT_GEOMETRY.activityColumnHeight : 0;
  const logColumnWidth = args.showLogs ? SLOT_GEOMETRY.logColumnWidth : 0;
  const logColumnHeight = args.showLogs ? SLOT_GEOMETRY.logColumnHeight : 0;
  const activityToLogGap =
    activityColumnWidth > 0 && logColumnWidth > 0 ? SLOT_GEOMETRY.boardColumnGap : 0;
  const feedToKanbanGap =
    activityColumnWidth > 0 || logColumnWidth > 0 ? SLOT_GEOMETRY.boardColumnGap : 0;
  const kanbanBandWidth =
    args.taskColumnCount <= 1
      ? TASK_PILL.width
      : TASK_PILL.width + (args.taskColumnCount - 1) * KANBAN_ZONE.columnWidth;
  const processBandWidth = computeProcessBandWidth(args.processCount);
  const boardBandWidth =
    activityColumnWidth + activityToLogGap + logColumnWidth + feedToKanbanGap + kanbanBandWidth;
  const boardBandHeight = Math.max(
    activityColumnHeight,
    logColumnHeight,
    SLOT_GEOMETRY.kanbanBandHeight + getKanbanBandTopInset({ activityColumnWidth, logColumnWidth })
  );
  const innerContentWidth = Math.max(SLOT_GEOMETRY.ownerMinWidth, processBandWidth, boardBandWidth);
  const slotWidth = innerContentWidth + SLOT_GEOMETRY.memberSlotInnerPadding * 2;
  const slotHeight =
    SLOT_GEOMETRY.memberSlotInnerPadding * 2 +
    SLOT_GEOMETRY.ownerBandHeight +
    SLOT_GEOMETRY.ownerToProcessGap +
    SLOT_GEOMETRY.processBandHeight +
    SLOT_GEOMETRY.processToBoardGap +
    boardBandHeight;
  const radialDepth = Math.max(
    SLOT_GEOMETRY.memberSlotInnerPadding + SLOT_GEOMETRY.ownerBandHeight / 2,
    SLOT_GEOMETRY.memberSlotInnerPadding +
      SLOT_GEOMETRY.ownerBandHeight / 2 +
      SLOT_GEOMETRY.ownerToProcessGap +
      SLOT_GEOMETRY.processBandHeight +
      SLOT_GEOMETRY.processToBoardGap +
      boardBandHeight
  );

  return {
    ownerId: args.ownerId,
    slotWidth,
    slotHeight,
    widthBucket: classifyWidthBucket(slotWidth),
    radialDepth,
    activityColumnWidth,
    activityColumnHeight,
    logColumnWidth,
    logColumnHeight,
    processBandWidth,
    kanbanBandWidth,
    kanbanBandHeight: SLOT_GEOMETRY.kanbanBandHeight,
    boardBandWidth,
    boardBandHeight,
    taskColumnCount: args.taskColumnCount,
    processCount: args.processCount,
  } satisfies OwnerFootprint;
}

export function classifyWidthBucket(width: number): StableSlotWidthBucket {
  if (width <= 340) {
    return 'S';
  }
  if (width <= 560) {
    return 'M';
  }
  return 'L';
}

export function computeProcessBandWidth(processCount: number): number {
  if (processCount <= 1) {
    return SLOT_GEOMETRY.processRailMinWidth;
  }

  const occupiedWidth = (processCount - 1) * PROCESS_RAIL_NODE_GAP + PROCESS_RAIL_NODE_FOOTPRINT;
  return Math.max(SLOT_GEOMETRY.processRailMinWidth, occupiedWidth);
}

export function resolveNearestSlotAssignment(args: {
  ownerId: string;
  ownerX: number;
  ownerY: number;
  nodes: GraphNode[];
  snapshot: StableSlotLayoutSnapshot;
  layout?: GraphLayoutPort;
}): NearestSlotAssignmentResult | null {
  if ((args.layout?.mode ?? 'radial') === 'grid-under-lead') {
    return null;
  }

  const allFootprints = computeOwnerFootprints(args.nodes, args.layout);
  const footprintByOwnerId = new Map(allFootprints.map((item) => [item.ownerId, item] as const));
  const footprint = footprintByOwnerId.get(args.ownerId);
  if (!footprint) {
    return null;
  }

  const currentFrame = args.snapshot.memberSlotFrameByOwnerId.get(args.ownerId);
  if (!currentFrame) {
    return null;
  }

  if (args.snapshot.ownerSlotLayoutKind === 'row-orbit') {
    const rowOrbitCandidate = resolveNearestRowOrbitSlotAssignment({
      ownerId: args.ownerId,
      ownerX: args.ownerX,
      ownerY: args.ownerY,
      currentFrame,
      ownerFootprints: allFootprints,
      snapshot: args.snapshot,
      layout: args.layout,
    });
    if (rowOrbitCandidate) {
      return rowOrbitCandidate;
    }
  }

  const strictSmallTeamCandidate = resolveStrictSmallTeamNearestSlotAssignment({
    ownerId: args.ownerId,
    ownerX: args.ownerX,
    ownerY: args.ownerY,
    currentFrame,
    snapshot: args.snapshot,
  });
  if (strictSmallTeamCandidate) {
    return strictSmallTeamCandidate;
  }

  const existingFrames = args.snapshot.memberSlotFrames.filter(
    (frame) => frame.ownerId !== args.ownerId
  );
  const maxOccupiedRing = existingFrames.reduce((max, frame) => Math.max(max, frame.ringIndex), 0);
  const candidateAssignments = buildCandidateAssignments(
    Math.max(SLOT_GEOMETRY.maxGeneratedRings, maxOccupiedRing + allFootprints.length + 2)
  );
  const ringStates = buildRingStatesFromFrames(
    [...existingFrames, currentFrame],
    footprintByOwnerId
  );
  let best: RankedNearestSlotAssignmentResult | null = null;

  for (const assignment of candidateAssignments) {
    const occupiedFrame = args.snapshot.memberSlotFrames.find(
      (existing) =>
        existing.ownerId !== args.ownerId &&
        existing.ringIndex === assignment.ringIndex &&
        existing.sectorIndex === assignment.sectorIndex
    );
    const rankedCandidate = rankNearestSlotAssignmentResult({
      assignment,
      occupiedFrame,
      footprint,
      footprintByOwnerId,
      currentFrame,
      existingFrames,
      centralCollisionRects: args.snapshot.centralCollisionRects,
      runtimeCentralExclusion: args.snapshot.runtimeCentralExclusion,
      ringStates,
      pointerX: args.ownerX,
      pointerY: args.ownerY,
    });
    if (!rankedCandidate) {
      continue;
    }

    if (!best || rankedCandidate.distanceSquared < best.distanceSquared) {
      best = rankedCandidate;
    }
  }

  return best
    ? {
        assignment: best.assignment,
        displacedOwnerId: best.displacedOwnerId,
        displacedAssignment: best.displacedAssignment,
        previewOwnerX: best.previewOwnerX,
        previewOwnerY: best.previewOwnerY,
      }
    : null;
}

export function resolveNearestGridOwnerTarget(args: {
  ownerId: string;
  ownerX: number;
  ownerY: number;
  snapshot: StableSlotLayoutSnapshot;
}): NearestGridOwnerTargetResult | null {
  if (!args.snapshot.memberSlotFrameByOwnerId.has(args.ownerId)) {
    return null;
  }

  let best: {
    frame: SlotFrame;
    distanceSquared: number;
  } | null = null;

  for (const frame of args.snapshot.memberSlotFrames) {
    const dx = frame.ownerX - args.ownerX;
    const dy = frame.ownerY - args.ownerY;
    const distanceSquared = dx * dx + dy * dy;
    if (!best || distanceSquared < best.distanceSquared) {
      best = { frame, distanceSquared };
    }
  }

  if (!best) {
    return null;
  }

  return {
    targetOwnerId: best.frame.ownerId,
    previewOwnerX: best.frame.ownerX,
    previewOwnerY: best.frame.ownerY,
  };
}

function resolveStrictSmallTeamNearestSlotAssignment(args: {
  ownerId: string;
  ownerX: number;
  ownerY: number;
  currentFrame: SlotFrame;
  snapshot: StableSlotLayoutSnapshot;
}): NearestSlotAssignmentResult | null {
  const strictFrames = getStrictSmallTeamFrames(args.snapshot.memberSlotFrames);
  if (!strictFrames) {
    return null;
  }

  return resolveNearestExistingFrameSlotAssignment({
    ownerId: args.ownerId,
    ownerX: args.ownerX,
    ownerY: args.ownerY,
    currentFrame: args.currentFrame,
    frames: strictFrames,
  });
}

function resolveNearestRowOrbitSlotAssignment(args: {
  ownerId: string;
  ownerX: number;
  ownerY: number;
  currentFrame: SlotFrame;
  ownerFootprints: readonly OwnerFootprint[];
  snapshot: StableSlotLayoutSnapshot;
  layout?: GraphLayoutPort;
}): NearestSlotAssignmentResult | null {
  const allowedAssignments = ROW_ORBIT_ASSIGNMENTS_BY_OWNER_COUNT[args.ownerFootprints.length];
  if (!allowedAssignments || allowedAssignments.length < args.ownerFootprints.length) {
    return null;
  }

  const baseAssignments = Object.fromEntries(
    args.snapshot.memberSlotFrames.map((frame) => [
      frame.ownerId,
      {
        ringIndex: frame.ringIndex,
        sectorIndex: frame.sectorIndex,
      },
    ])
  );
  let best: RankedNearestSlotAssignmentResult | null = null;

  for (const assignment of allowedAssignments) {
    const occupiedFrame = args.snapshot.memberSlotFrames.find(
      (frame) =>
        frame.ownerId !== args.ownerId &&
        frame.ringIndex === assignment.ringIndex &&
        frame.sectorIndex === assignment.sectorIndex
    );
    const simulatedAssignments: Record<string, GraphOwnerSlotAssignment> = {
      ...baseAssignments,
      [args.ownerId]: assignment,
    };
    if (occupiedFrame) {
      simulatedAssignments[occupiedFrame.ownerId] = {
        ringIndex: args.currentFrame.ringIndex,
        sectorIndex: args.currentFrame.sectorIndex,
      };
    }

    const frames = planRowOrbitOwnerSlots(
      args.ownerFootprints,
      args.snapshot.centralCollisionRects,
      args.snapshot.runtimeCentralExclusion,
      {
        version: args.layout?.version ?? 'stable-slots-v1',
        mode: args.layout?.mode ?? 'radial',
        ownerOrder:
          args.layout?.ownerOrder ?? args.ownerFootprints.map((footprint) => footprint.ownerId),
        slotAssignments: simulatedAssignments,
      }
    );
    const previewFrame = frames?.find((frame) => frame.ownerId === args.ownerId);
    if (!previewFrame) {
      continue;
    }

    const dx = previewFrame.ownerX - args.ownerX;
    const dy = previewFrame.ownerY - args.ownerY;
    const candidate: RankedNearestSlotAssignmentResult = {
      assignment,
      displacedOwnerId: occupiedFrame?.ownerId,
      displacedAssignment: occupiedFrame
        ? {
            ringIndex: args.currentFrame.ringIndex,
            sectorIndex: args.currentFrame.sectorIndex,
          }
        : undefined,
      previewOwnerX: previewFrame.ownerX,
      previewOwnerY: previewFrame.ownerY,
      distanceSquared: dx * dx + dy * dy,
    };

    if (!best || candidate.distanceSquared < best.distanceSquared) {
      best = candidate;
    }
  }

  return best
    ? {
        assignment: best.assignment,
        displacedOwnerId: best.displacedOwnerId,
        displacedAssignment: best.displacedAssignment,
        previewOwnerX: best.previewOwnerX,
        previewOwnerY: best.previewOwnerY,
      }
    : null;
}

function resolveNearestExistingFrameSlotAssignment(args: {
  ownerId: string;
  ownerX: number;
  ownerY: number;
  currentFrame: SlotFrame;
  frames: readonly SlotFrame[];
}): NearestSlotAssignmentResult | null {
  let best: {
    frame: SlotFrame;
    distanceSquared: number;
  } | null = null;
  for (const frame of args.frames) {
    const dx = frame.ownerX - args.ownerX;
    const dy = frame.ownerY - args.ownerY;
    const distanceSquared = dx * dx + dy * dy;
    if (!best || distanceSquared < best.distanceSquared) {
      best = { frame, distanceSquared };
    }
  }

  if (!best) {
    return null;
  }

  const targetFrame = best.frame;
  if (targetFrame.ownerId === args.ownerId) {
    return {
      assignment: {
        ringIndex: targetFrame.ringIndex,
        sectorIndex: targetFrame.sectorIndex,
      },
      previewOwnerX: targetFrame.ownerX,
      previewOwnerY: targetFrame.ownerY,
    };
  }

  return {
    assignment: {
      ringIndex: targetFrame.ringIndex,
      sectorIndex: targetFrame.sectorIndex,
    },
    displacedOwnerId: targetFrame.ownerId,
    displacedAssignment: {
      ringIndex: args.currentFrame.ringIndex,
      sectorIndex: args.currentFrame.sectorIndex,
    },
    previewOwnerX: targetFrame.ownerX,
    previewOwnerY: targetFrame.ownerY,
  };
}

function getStrictSmallTeamFrames(frames: readonly SlotFrame[]): readonly SlotFrame[] | null {
  if (frames.length === 0 || frames.length > 6) {
    return null;
  }
  const preset = SMALL_TEAM_CARDINAL_ASSIGNMENTS[frames.length];
  if (!preset || preset.length !== frames.length) {
    return null;
  }

  const actualAssignmentKeys = frames
    .map((frame) =>
      buildAssignmentKey({ ringIndex: frame.ringIndex, sectorIndex: frame.sectorIndex })
    )
    .sort();
  const presetAssignmentKeys = preset.map((assignment) => buildAssignmentKey(assignment)).sort();

  for (let index = 0; index < presetAssignmentKeys.length; index += 1) {
    if (actualAssignmentKeys[index] !== presetAssignmentKeys[index]) {
      return null;
    }
  }

  return frames;
}

export function validateStableSlotLayout(
  snapshot: StableSlotLayoutSnapshot
): StableSlotLayoutValidationResult {
  if (!snapshot.leadNodeId) {
    return { valid: false, reason: 'missing leadNodeId' };
  }
  const staticRectValidation = validateStaticSnapshotRects(snapshot);
  if (staticRectValidation) {
    return staticRectValidation;
  }

  const leadRectValidation = validateLeadSnapshotRects(snapshot);
  if (leadRectValidation) {
    return leadRectValidation;
  }

  const seenOwnerIds = new Set<string>();
  const seenAssignments = new Set<string>();
  for (const frame of snapshot.memberSlotFrames) {
    const frameValidation = validateMemberSlotFrame(frame, snapshot, seenOwnerIds, seenAssignments);
    if (frameValidation) {
      return frameValidation;
    }
  }

  const overlapValidation = validateMemberFrameOverlaps(snapshot.memberSlotFrames);
  if (overlapValidation) {
    return overlapValidation;
  }

  return { valid: true };
}

function validateStaticSnapshotRects(
  snapshot: StableSlotLayoutSnapshot
): StableSlotLayoutValidationResult | null {
  const staticRects: [string, StableRect][] = [
    ['leadCoreRect', snapshot.leadCoreRect],
    ['leadSlotFrame.bounds', snapshot.leadSlotFrame.bounds],
    ['leadSlotFrame.boardBandRect', snapshot.leadSlotFrame.boardBandRect],
    ['leadSlotFrame.activityColumnRect', snapshot.leadSlotFrame.activityColumnRect],
    ['leadSlotFrame.logColumnRect', snapshot.leadSlotFrame.logColumnRect],
    ['leadSlotFrame.processBandRect', snapshot.leadSlotFrame.processBandRect],
    ['leadSlotFrame.kanbanBandRect', snapshot.leadSlotFrame.kanbanBandRect],
    ['leadActivityRect', snapshot.leadActivityRect],
    ['launchHudRect', snapshot.launchHudRect],
    ['leadCentralReservedBlock', snapshot.leadCentralReservedBlock],
    ['runtimeCentralExclusion', snapshot.runtimeCentralExclusion],
    ['fitBounds', snapshot.fitBounds],
    ...snapshot.centralCollisionRects.map(
      (rect, index) => [`centralCollisionRects[${index}]`, rect] as [string, StableRect]
    ),
  ];

  if (snapshot.unassignedTaskRect) {
    staticRects.push(['unassignedTaskRect', snapshot.unassignedTaskRect]);
  }

  for (const [name, rect] of staticRects) {
    if (!isFiniteRect(rect)) {
      return { valid: false, reason: `${name} contains non-finite geometry` };
    }
  }

  if (snapshot.fitBounds.width <= 0 || snapshot.fitBounds.height <= 0) {
    return { valid: false, reason: 'fitBounds must be non-zero' };
  }

  return null;
}

function validateLeadSnapshotRects(
  snapshot: StableSlotLayoutSnapshot
): StableSlotLayoutValidationResult | null {
  const leadFrameValidation = validateSlotFrameGeometry(
    snapshot.leadSlotFrame,
    snapshot.fitBounds,
    `leadSlotFrame(${snapshot.leadSlotFrame.ownerId})`
  );
  if (leadFrameValidation) {
    return leadFrameValidation;
  }
  if (!rectContainsRect(snapshot.leadCentralReservedBlock, snapshot.leadCoreRect)) {
    return { valid: false, reason: 'leadCoreRect must fit inside leadCentralReservedBlock' };
  }
  if (!rectContainsRect(snapshot.leadCentralReservedBlock, snapshot.leadActivityRect)) {
    return { valid: false, reason: 'leadActivityRect must fit inside leadCentralReservedBlock' };
  }
  if (!rectContainsRect(snapshot.leadCentralReservedBlock, snapshot.leadSlotFrame.logColumnRect)) {
    return { valid: false, reason: 'lead logColumnRect must fit inside leadCentralReservedBlock' };
  }
  if (
    !rectContainsRect(snapshot.leadCentralReservedBlock, snapshot.leadSlotFrame.processBandRect)
  ) {
    return {
      valid: false,
      reason: 'lead processBandRect must fit inside leadCentralReservedBlock',
    };
  }
  if (!rectContainsRect(snapshot.leadCentralReservedBlock, snapshot.leadSlotFrame.kanbanBandRect)) {
    return { valid: false, reason: 'lead kanbanBandRect must fit inside leadCentralReservedBlock' };
  }
  if (snapshot.leadActivityRect.left !== snapshot.leadSlotFrame.activityColumnRect.left) {
    return {
      valid: false,
      reason: 'leadActivityRect must mirror leadSlotFrame.activityColumnRect',
    };
  }
  if (snapshot.leadActivityRect.top !== snapshot.leadSlotFrame.activityColumnRect.top) {
    return {
      valid: false,
      reason: 'leadActivityRect must mirror leadSlotFrame.activityColumnRect',
    };
  }
  if (!rectContainsRect(snapshot.runtimeCentralExclusion, snapshot.leadCentralReservedBlock)) {
    return {
      valid: false,
      reason: 'runtimeCentralExclusion must contain leadCentralReservedBlock',
    };
  }
  const paddedCentralCollisionRects = padCentralCollisionRects(
    snapshot.centralCollisionRects,
    SLOT_GEOMETRY.centralPadding
  );
  if (
    paddedCentralCollisionRects.some(
      (rect) => !rectContainsRect(snapshot.runtimeCentralExclusion, rect)
    )
  ) {
    return {
      valid: false,
      reason: 'runtimeCentralExclusion must contain all centralCollisionRects',
    };
  }

  return null;
}

function validateMemberSlotFrame(
  frame: SlotFrame,
  snapshot: StableSlotLayoutSnapshot,
  seenOwnerIds: Set<string>,
  seenAssignments: Set<string>
): StableSlotLayoutValidationResult | null {
  const geometryValidation = validateSlotFrameGeometry(
    frame,
    snapshot.fitBounds,
    `slot frame for ${frame.ownerId}`
  );
  if (geometryValidation) {
    return geometryValidation;
  }
  if (seenOwnerIds.has(frame.ownerId)) {
    return { valid: false, reason: `duplicate owner frame for ${frame.ownerId}` };
  }
  seenOwnerIds.add(frame.ownerId);

  const assignmentKey = `${frame.ringIndex}:${frame.sectorIndex}`;
  if (seenAssignments.has(assignmentKey)) {
    return { valid: false, reason: `duplicate slot assignment ${assignmentKey}` };
  }
  seenAssignments.add(assignmentKey);

  if (rectOverlapsAnyCentralRect(frame.bounds, snapshot.centralCollisionRects)) {
    return {
      valid: false,
      reason: `slot frame for ${frame.ownerId} overlaps centralCollisionRects`,
    };
  }
  return null;
}

function validateSlotFrameGeometry(
  frame: SlotFrame,
  fitBounds: StableRect,
  label: string
): StableSlotLayoutValidationResult | null {
  if (!isFiniteRect(frame.bounds)) {
    return { valid: false, reason: `${label} contains non-finite bounds` };
  }
  if (!Number.isFinite(frame.ownerX) || !Number.isFinite(frame.ownerY)) {
    return { valid: false, reason: `${label} contains non-finite anchor` };
  }
  if (!rectContainsRect(frame.bounds, frame.boardBandRect)) {
    return { valid: false, reason: `boardBandRect escapes ${label}` };
  }
  if (!rectContainsRect(frame.bounds, frame.activityColumnRect)) {
    return { valid: false, reason: `activityColumnRect escapes ${label}` };
  }
  if (!rectContainsRect(frame.bounds, frame.logColumnRect)) {
    return { valid: false, reason: `logColumnRect escapes ${label}` };
  }
  if (!rectContainsRect(frame.bounds, frame.processBandRect)) {
    return { valid: false, reason: `processBandRect escapes ${label}` };
  }
  if (!rectContainsRect(frame.bounds, frame.kanbanBandRect)) {
    return { valid: false, reason: `kanbanBandRect escapes ${label}` };
  }
  if (!rectContainsRect(frame.boardBandRect, frame.activityColumnRect)) {
    return {
      valid: false,
      reason: `activityColumnRect escapes boardBandRect in ${label}`,
    };
  }
  if (!rectContainsRect(frame.boardBandRect, frame.logColumnRect)) {
    return {
      valid: false,
      reason: `logColumnRect escapes boardBandRect in ${label}`,
    };
  }
  if (!rectContainsRect(frame.boardBandRect, frame.kanbanBandRect)) {
    return {
      valid: false,
      reason: `kanbanBandRect escapes boardBandRect in ${label}`,
    };
  }
  if (rectsOverlap(frame.activityColumnRect, frame.kanbanBandRect)) {
    return {
      valid: false,
      reason: `activityColumnRect overlaps kanbanBandRect in ${label}`,
    };
  }
  if (rectsOverlap(frame.activityColumnRect, frame.logColumnRect)) {
    return {
      valid: false,
      reason: `activityColumnRect overlaps logColumnRect in ${label}`,
    };
  }
  if (rectsOverlap(frame.logColumnRect, frame.kanbanBandRect)) {
    return {
      valid: false,
      reason: `logColumnRect overlaps kanbanBandRect in ${label}`,
    };
  }
  if (!pointInRect(frame.ownerX, frame.ownerY, frame.bounds)) {
    return { valid: false, reason: `owner anchor escapes ${label}` };
  }
  if (!rectContainsRect(fitBounds, frame.bounds)) {
    return { valid: false, reason: `${label} escapes fitBounds` };
  }

  return null;
}

function validateMemberFrameOverlaps(
  frames: readonly SlotFrame[]
): StableSlotLayoutValidationResult | null {
  for (const [index, left] of frames.entries()) {
    for (const right of frames.slice(index + 1)) {
      if (rectsOverlap(left.bounds, right.bounds)) {
        return {
          valid: false,
          reason: `slot frames overlap: ${left.ownerId} <-> ${right.ownerId}`,
        };
      }
    }
  }
  return null;
}

export function translateSlotFrame(frame: SlotFrame, dx: number, dy: number): SlotFrame {
  return {
    ...frame,
    bounds: translateRect(frame.bounds, dx, dy),
    ownerX: frame.ownerX + dx,
    ownerY: frame.ownerY + dy,
    boardBandRect: translateRect(frame.boardBandRect, dx, dy),
    activityColumnRect: translateRect(frame.activityColumnRect, dx, dy),
    logColumnRect: translateRect(frame.logColumnRect, dx, dy),
    processBandRect: translateRect(frame.processBandRect, dx, dy),
    kanbanBandRect: translateRect(frame.kanbanBandRect, dx, dy),
  };
}

export function snapshotToWorldBounds(snapshot: StableSlotLayoutSnapshot): WorldBounds[] {
  const bounds: WorldBounds[] = [
    snapshot.fitBounds,
    snapshot.leadCentralReservedBlock,
    ...snapshot.memberSlotFrames.map((frame) => frame.bounds),
  ].map((rect) => ({
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
  }));

  if (snapshot.unassignedTaskRect) {
    bounds.push({
      left: snapshot.unassignedTaskRect.left,
      top: snapshot.unassignedTaskRect.top,
      right: snapshot.unassignedTaskRect.right,
      bottom: snapshot.unassignedTaskRect.bottom,
    });
  }

  return bounds;
}

function buildUnassignedTaskRect(
  nodes: GraphNode[],
  leadCentralReservedBlock: StableRect
): StableRect | null {
  const visibleOwnerIds = new Set(
    nodes.filter((node) => node.kind === 'lead' || node.kind === 'member').map((node) => node.id)
  );
  const unassignedTasks = nodes.filter(
    (node) => node.kind === 'task' && (!node.ownerId || !visibleOwnerIds.has(node.ownerId))
  );
  if (unassignedTasks.length === 0) {
    return null;
  }

  const columnCount = new Set(unassignedTasks.map((node) => resolveTaskColumnKey(node))).size;
  const width =
    columnCount <= 1
      ? TASK_PILL.width
      : TASK_PILL.width + (columnCount - 1) * KANBAN_ZONE.columnWidth;
  const height = SLOT_GEOMETRY.kanbanBandHeight;
  return createRect(
    -width / 2,
    leadCentralReservedBlock.bottom + SLOT_GEOMETRY.unassignedGap,
    width,
    height
  );
}

function planOwnerSlots(
  ownerFootprints: OwnerFootprint[],
  centralCollisionRects: readonly StableRect[],
  runtimeCentralExclusion: StableRect,
  layout?: GraphLayoutPort
): PlannedMemberSlotLayout {
  const rowOrbitFrames = shouldUseRowOrbitLayout(ownerFootprints, layout)
    ? planRowOrbitOwnerSlots(
        ownerFootprints,
        centralCollisionRects,
        runtimeCentralExclusion,
        layout
      )
    : null;
  if (rowOrbitFrames) {
    return {
      frames: rowOrbitFrames,
      kind: 'row-orbit',
    };
  }

  const strictSmallTeamFrames = shouldUseStrictSmallTeamCardinalLayout(ownerFootprints, layout)
    ? planStrictSmallTeamOwnerSlots(
        ownerFootprints,
        centralCollisionRects,
        runtimeCentralExclusion,
        layout
      )
    : null;
  if (strictSmallTeamFrames) {
    return {
      frames: strictSmallTeamFrames,
      kind: 'radial-sector',
    };
  }

  const placedFrames: SlotFrame[] = [];
  const preferredAssignments = buildPreferredAssignmentsMap(layout?.slotAssignments);
  const usedSlotKeys = new Set<string>();
  const ringStates = new Map<string, RingLayoutState>();
  const maxRingExclusive = computePlannerRingLimit(ownerFootprints, layout?.slotAssignments);

  for (const footprint of ownerFootprints) {
    const resolvedFrame = resolveOwnerSlotFrame({
      footprint,
      centralCollisionRects,
      runtimeCentralExclusion,
      ringStates,
      preferredAssignment: preferredAssignments.get(footprint.ownerId),
      usedSlotKeys,
      placedFrames,
      maxRingExclusive,
    });
    placedFrames.push(resolvedFrame);
    commitRingPlacement(ringStates, resolvedFrame, footprint);
  }

  return {
    frames: placedFrames,
    kind: 'radial-sector',
  };
}

function shouldUseRowOrbitLayout(
  ownerFootprints: readonly OwnerFootprint[],
  layout?: GraphLayoutPort
): boolean {
  if (
    ownerFootprints.length < ROW_ORBIT_MIN_OWNER_COUNT ||
    ownerFootprints.length > ROW_ORBIT_MAX_OWNER_COUNT
  ) {
    return false;
  }

  const preset = ROW_ORBIT_ASSIGNMENTS_BY_OWNER_COUNT[ownerFootprints.length];
  if (!preset || preset.length < ownerFootprints.length) {
    return false;
  }
  const rowCounts = ROW_ORBIT_ROW_COUNTS_BY_OWNER_COUNT[ownerFootprints.length];
  if (!rowCounts) {
    return false;
  }
  const actualAssignments = ownerFootprints
    .map((footprint) => layout?.slotAssignments?.[footprint.ownerId])
    .filter((assignment): assignment is GraphOwnerSlotAssignment => assignment != null);
  const useLegacySixTwoRowAssignments = shouldNormalizeLegacySixTwoRowAssignments(
    ownerFootprints.length,
    actualAssignments
  );

  const actualAssignmentKeys = actualAssignments
    .map((assignment) =>
      normalizeRowOrbitAssignment(assignment, ownerFootprints.length, rowCounts, {
        useLegacySixTwoRowAssignments,
      })
    )
    .filter((assignment): assignment is GraphOwnerSlotAssignment => assignment != null)
    .map((assignment) => buildAssignmentKey(assignment))
    .sort();
  const allowedAssignmentKeys = new Set(preset.map((assignment) => buildAssignmentKey(assignment)));

  if (actualAssignmentKeys.length !== ownerFootprints.length) {
    return false;
  }

  const uniqueAssignmentKeys = new Set(actualAssignmentKeys);
  if (uniqueAssignmentKeys.size !== actualAssignmentKeys.length) {
    return false;
  }

  for (const assignmentKey of actualAssignmentKeys) {
    if (!allowedAssignmentKeys.has(assignmentKey)) {
      return false;
    }
  }

  return true;
}

function planRowOrbitOwnerSlots(
  ownerFootprints: readonly OwnerFootprint[],
  centralCollisionRects: readonly StableRect[],
  runtimeCentralExclusion: StableRect,
  layout?: GraphLayoutPort
): SlotFrame[] | null {
  const rowCounts = ROW_ORBIT_ROW_COUNTS_BY_OWNER_COUNT[ownerFootprints.length];
  if (!rowCounts) {
    return null;
  }

  const slotConfigs = buildRowOrbitSlotConfigs(ownerFootprints, rowCounts, layout);
  if (!slotConfigs) {
    return null;
  }

  const frames = buildRowOrbitSlotFrames(slotConfigs, rowCounts, runtimeCentralExclusion);
  const allValid = frames.every((frame, frameIndex) =>
    isSlotFramePlacementValid(
      frame,
      frames.filter((_, index) => index !== frameIndex),
      centralCollisionRects
    )
  );
  return allValid ? frames : null;
}

function buildRowOrbitSlotConfigs(
  ownerFootprints: readonly OwnerFootprint[],
  rowCounts: readonly number[],
  layout?: GraphLayoutPort
): RowOrbitSlotConfig[] | null {
  const rowCount = rowCounts.length;
  const middleRowIndex = rowCount === 3 ? 1 : -1;
  const configs: RowOrbitSlotConfig[] = [];
  const actualAssignments = ownerFootprints
    .map((footprint) => layout?.slotAssignments?.[footprint.ownerId])
    .filter((assignment): assignment is GraphOwnerSlotAssignment => assignment != null);
  const useLegacySixTwoRowAssignments = shouldNormalizeLegacySixTwoRowAssignments(
    ownerFootprints.length,
    actualAssignments
  );

  for (const footprint of ownerFootprints) {
    const assignment = layout?.slotAssignments?.[footprint.ownerId];
    if (!assignment) {
      return null;
    }

    const rowOrbitAssignment = normalizeRowOrbitAssignment(
      assignment,
      ownerFootprints.length,
      rowCounts,
      {
        useLegacySixTwoRowAssignments,
      }
    );
    if (!rowOrbitAssignment) {
      return null;
    }

    const columnCount = rowCounts[rowOrbitAssignment.ringIndex];
    if (
      columnCount == null ||
      rowOrbitAssignment.sectorIndex < 0 ||
      rowOrbitAssignment.sectorIndex >= columnCount
    ) {
      return null;
    }

    configs.push({
      footprint,
      assignment: rowOrbitAssignment,
      rowIndex: rowOrbitAssignment.ringIndex,
      columnIndex: rowOrbitAssignment.sectorIndex,
      columnCount,
      band: resolveRowOrbitBand(rowOrbitAssignment.ringIndex, rowCount, middleRowIndex),
    });
  }

  return configs;
}

function normalizeRowOrbitAssignment(
  assignment: GraphOwnerSlotAssignment,
  ownerCount: number,
  rowCounts: readonly number[],
  options: { useLegacySixTwoRowAssignments?: boolean } = {}
): GraphOwnerSlotAssignment | null {
  if (
    options.useLegacySixTwoRowAssignments === true &&
    ownerCount === 6 &&
    assignment.ringIndex === 1 &&
    assignment.sectorIndex >= 0 &&
    assignment.sectorIndex < 3
  ) {
    return {
      ringIndex: 2,
      sectorIndex: assignment.sectorIndex,
    };
  }

  const directColumnCount = rowCounts[assignment.ringIndex];
  if (
    directColumnCount != null &&
    assignment.sectorIndex >= 0 &&
    assignment.sectorIndex < directColumnCount
  ) {
    return assignment;
  }

  if (
    ownerCount === 6 &&
    assignment.ringIndex === 0 &&
    assignment.sectorIndex >= 0 &&
    assignment.sectorIndex < 6
  ) {
    return {
      ringIndex: assignment.sectorIndex < 3 ? 0 : 2,
      sectorIndex: assignment.sectorIndex % 3,
    };
  }

  return null;
}

function shouldNormalizeLegacySixTwoRowAssignments(
  ownerCount: number,
  assignments: readonly GraphOwnerSlotAssignment[]
): boolean {
  if (ownerCount !== 6 || assignments.length !== ownerCount) {
    return false;
  }

  return assignments.some(
    (assignment) => assignment.ringIndex === 1 && assignment.sectorIndex === 2
  );
}

function resolveRowOrbitBand(
  rowIndex: number,
  rowCount: number,
  middleRowIndex: number
): RowOrbitSlotConfig['band'] {
  if (middleRowIndex >= 0) {
    if (rowIndex < middleRowIndex) {
      return 'top';
    }
    return rowIndex === middleRowIndex ? 'middle' : 'bottom';
  }
  return rowIndex < rowCount / 2 ? 'top' : 'bottom';
}

function buildRowOrbitSlotFrames(
  slotConfigs: readonly RowOrbitSlotConfig[],
  rowCounts: readonly number[],
  runtimeCentralExclusion: StableRect
): SlotFrame[] {
  const rowConfigs = groupRowOrbitSlotConfigs(slotConfigs, rowCounts.length);
  const middleRowIndex = rowCounts.length === 3 ? 1 : -1;
  const rowTopByIndex = resolveRowOrbitRowTops(rowConfigs, middleRowIndex, runtimeCentralExclusion);
  const framesByOwnerId = new Map<string, SlotFrame>();
  const fallbackColumnWidth = Math.max(...slotConfigs.map((config) => config.footprint.slotWidth));

  for (const row of rowConfigs) {
    if (row.length === 0) {
      continue;
    }

    if (row[0]?.band === 'middle') {
      for (const config of row) {
        const ownerX =
          config.columnIndex === 0
            ? runtimeCentralExclusion.left - ROW_ORBIT_CENTRAL_GAP - config.footprint.slotWidth / 2
            : runtimeCentralExclusion.right +
              ROW_ORBIT_CENTRAL_GAP +
              config.footprint.slotWidth / 2;
        framesByOwnerId.set(
          config.footprint.ownerId,
          buildSlotFrameAtOwnerAnchor(config.footprint, config.assignment, ownerX, 0)
        );
      }
      continue;
    }

    const rowTop = rowTopByIndex.get(row[0]!.rowIndex) ?? 0;
    const columnCount = rowCounts[row[0]!.rowIndex] ?? row.length;
    const columnWidths = resolveRowOrbitColumnWidths(row, columnCount, fallbackColumnWidth);
    let nextLeft = -getRowOrbitRowWidth(columnWidths) / 2;
    for (const config of row) {
      const ownerX =
        nextLeft +
        columnWidths.slice(0, config.columnIndex).reduce((sum, width) => sum + width, 0) +
        config.columnIndex * ROW_ORBIT_HORIZONTAL_GAP +
        columnWidths[config.columnIndex]! / 2;
      const ownerY = rowTop + getOwnerAnchorTopOffset();
      framesByOwnerId.set(
        config.footprint.ownerId,
        buildSlotFrameAtOwnerAnchor(config.footprint, config.assignment, ownerX, ownerY)
      );
    }
  }

  return slotConfigs.flatMap((config) => {
    const frame = framesByOwnerId.get(config.footprint.ownerId);
    return frame ? [frame] : [];
  });
}

function groupRowOrbitSlotConfigs(
  slotConfigs: readonly RowOrbitSlotConfig[],
  rowCount: number
): RowOrbitSlotConfig[][] {
  const rows: RowOrbitSlotConfig[][] = Array.from({ length: rowCount }, () => []);
  for (const config of slotConfigs) {
    rows[config.rowIndex]!.push(config);
  }
  for (const row of rows) {
    row.sort((left, right) => left.columnIndex - right.columnIndex);
  }
  return rows;
}

function resolveRowOrbitRowTops(
  rowConfigs: readonly (readonly RowOrbitSlotConfig[])[],
  middleRowIndex: number,
  runtimeCentralExclusion: StableRect
): Map<number, number> {
  const topByRowIndex = new Map<number, number>();
  let nextTopRowBottom = runtimeCentralExclusion.top - ROW_ORBIT_CENTRAL_GAP;
  for (
    let rowIndex = middleRowIndex >= 0 ? middleRowIndex - 1 : rowConfigs.length / 2 - 1;
    rowIndex >= 0;
    rowIndex -= 1
  ) {
    const row = rowConfigs[rowIndex] ?? [];
    if (row.length === 0) {
      continue;
    }
    const rowHeight = getRowOrbitRowHeight(row);
    const rowTop = nextTopRowBottom - rowHeight;
    topByRowIndex.set(rowIndex, rowTop);
    nextTopRowBottom = rowTop - ROW_ORBIT_VERTICAL_GAP;
  }

  let nextBottomRowTop = runtimeCentralExclusion.bottom + ROW_ORBIT_CENTRAL_GAP;
  for (
    let rowIndex = middleRowIndex >= 0 ? middleRowIndex + 1 : Math.ceil(rowConfigs.length / 2);
    rowIndex < rowConfigs.length;
    rowIndex += 1
  ) {
    const row = rowConfigs[rowIndex] ?? [];
    if (row.length === 0) {
      continue;
    }
    topByRowIndex.set(rowIndex, nextBottomRowTop);
    nextBottomRowTop += getRowOrbitRowHeight(row) + ROW_ORBIT_VERTICAL_GAP;
  }

  return topByRowIndex;
}

function resolveRowOrbitColumnWidths(
  row: readonly RowOrbitSlotConfig[],
  columnCount: number,
  fallbackColumnWidth: number
): number[] {
  const columnWidths = Array.from({ length: columnCount }, () => fallbackColumnWidth);
  for (const config of row) {
    columnWidths[config.columnIndex] = Math.max(
      columnWidths[config.columnIndex] ?? fallbackColumnWidth,
      config.footprint.slotWidth
    );
  }
  return columnWidths;
}

function getRowOrbitRowWidth(columnWidths: readonly number[]): number {
  return (
    columnWidths.reduce((sum, width) => sum + width, 0) +
    Math.max(0, columnWidths.length - 1) * ROW_ORBIT_HORIZONTAL_GAP
  );
}

function getRowOrbitRowHeight(row: readonly RowOrbitSlotConfig[]): number {
  return Math.max(...row.map((config) => config.footprint.slotHeight));
}

function planGridUnderLeadOwnerSlots(
  ownerFootprints: readonly OwnerFootprint[],
  centralCollisionRects: readonly StableRect[]
): SlotFrame[] {
  const frames: SlotFrame[] = [];
  const centralBlock = unionRects([...centralCollisionRects]);
  let rowTop = centralBlock.bottom + GRID_UNDER_LEAD_LEAD_GAP;
  const columnCount = getGridUnderLeadColumnCount(ownerFootprints.length);

  for (
    let rowStartIndex = 0;
    rowStartIndex < ownerFootprints.length;
    rowStartIndex += columnCount
  ) {
    const rowFootprints = ownerFootprints.slice(rowStartIndex, rowStartIndex + columnCount);
    const rowWidth =
      rowFootprints.reduce((sum, footprint) => sum + footprint.slotWidth, 0) +
      Math.max(0, rowFootprints.length - 1) * SLOT_GEOMETRY.slotHorizontalGap;
    const rowHeight = Math.max(...rowFootprints.map((footprint) => footprint.slotHeight));
    const ownerY = rowTop + getOwnerAnchorTopOffset();
    let nextLeft = -rowWidth / 2;

    rowFootprints.forEach((footprint, columnIndex) => {
      const ownerX = nextLeft + footprint.slotWidth / 2;
      frames.push(
        buildSlotFrameAtOwnerAnchor(
          footprint,
          {
            ringIndex: Math.floor(rowStartIndex / columnCount),
            sectorIndex: columnIndex,
          },
          ownerX,
          ownerY
        )
      );
      nextLeft += footprint.slotWidth + SLOT_GEOMETRY.slotHorizontalGap;
    });

    rowTop += rowHeight + GRID_UNDER_LEAD_ROW_GAP;
  }

  return frames;
}

function getGridUnderLeadColumnCount(ownerCount: number): number {
  return ownerCount === GRID_UNDER_LEAD_WIDE_TEAM_OWNER_COUNT
    ? GRID_UNDER_LEAD_WIDE_TEAM_COLUMN_COUNT
    : GRID_UNDER_LEAD_DEFAULT_COLUMN_COUNT;
}

function shouldUseStrictSmallTeamCardinalLayout(
  ownerFootprints: readonly OwnerFootprint[],
  layout?: GraphLayoutPort
): boolean {
  if (ownerFootprints.length === 0 || ownerFootprints.length > 6) {
    return false;
  }

  const preset = SMALL_TEAM_CARDINAL_ASSIGNMENTS[ownerFootprints.length];
  if (!preset || preset.length !== ownerFootprints.length) {
    return false;
  }

  const actualAssignmentKeys = ownerFootprints
    .map((footprint) => layout?.slotAssignments?.[footprint.ownerId])
    .filter((assignment): assignment is GraphOwnerSlotAssignment => assignment != null)
    .map((assignment) => buildAssignmentKey(assignment))
    .sort();
  const presetAssignmentKeys = preset.map((assignment) => buildAssignmentKey(assignment)).sort();

  if (actualAssignmentKeys.length !== presetAssignmentKeys.length) {
    return false;
  }

  for (let index = 0; index < presetAssignmentKeys.length; index += 1) {
    if (actualAssignmentKeys[index] !== presetAssignmentKeys[index]) {
      return false;
    }
  }

  return true;
}

function planStrictSmallTeamOwnerSlots(
  ownerFootprints: readonly OwnerFootprint[],
  centralCollisionRects: readonly StableRect[],
  runtimeCentralExclusion: StableRect,
  layout?: GraphLayoutPort
): SlotFrame[] | null {
  if (ownerFootprints.length === 0 || ownerFootprints.length > 6) {
    return null;
  }

  const preset = SMALL_TEAM_CARDINAL_LAYOUTS[ownerFootprints.length];
  if (!preset || preset.length !== ownerFootprints.length) {
    return null;
  }
  const vectorByAssignmentKey = new Map(
    preset.map((slot) => [buildAssignmentKey(slot.assignment), slot.vector] as const)
  );

  const slotConfigs = ownerFootprints.map((footprint) => {
    const assignment = layout?.slotAssignments?.[footprint.ownerId];
    if (!assignment) {
      return null;
    }
    const vector = vectorByAssignmentKey.get(buildAssignmentKey(assignment));
    if (!vector) {
      return null;
    }
    return {
      footprint,
      assignment,
      vector,
    };
  });

  if (slotConfigs.some((slot) => slot == null)) {
    return null;
  }

  return packStrictSmallTeamOwnerSlots(
    slotConfigs.map((slot) => slot!),
    centralCollisionRects,
    runtimeCentralExclusion
  );
}

function packStrictSmallTeamOwnerSlots(
  slotConfigs: readonly {
    footprint: OwnerFootprint;
    assignment: GraphOwnerSlotAssignment;
    vector: { x: number; y: number };
  }[],
  centralCollisionRects: readonly StableRect[],
  runtimeCentralExclusion: StableRect
): SlotFrame[] | null {
  const radii = slotConfigs.map((slot) =>
    resolveMinimumDirectionalRadiusForVector({
      vector: slot.vector,
      footprint: slot.footprint,
      centralCollisionRects,
      runtimeCentralExclusion,
    })
  );

  for (let iteration = 0; iteration < STRICT_SMALL_TEAM_MAX_PACKING_ITERATIONS; iteration += 1) {
    const frames = buildStrictSmallTeamFrames(slotConfigs, radii);
    const invalidCentralIndex = frames.findIndex((frame) =>
      rectOverlapsAnyCentralRect(frame.bounds, centralCollisionRects)
    );
    if (invalidCentralIndex >= 0) {
      radii[invalidCentralIndex] += STRICT_SMALL_TEAM_RADIUS_STEP;
      continue;
    }

    const conflict = findFirstOwnerSlotFrameConflict(frames);
    if (!conflict) {
      return frames;
    }

    const nextLeftRadius = resolveMinimumRadiusAvoidingFrame({
      slotConfig: slotConfigs[conflict.leftIndex]!,
      currentRadius: radii[conflict.leftIndex]!,
      otherFrame: frames[conflict.rightIndex]!,
      centralCollisionRects,
    });
    const nextRightRadius = resolveMinimumRadiusAvoidingFrame({
      slotConfig: slotConfigs[conflict.rightIndex]!,
      currentRadius: radii[conflict.rightIndex]!,
      otherFrame: frames[conflict.leftIndex]!,
      centralCollisionRects,
    });

    if (nextLeftRadius == null && nextRightRadius == null) {
      return null;
    }

    const leftIncrease =
      nextLeftRadius == null
        ? Number.POSITIVE_INFINITY
        : nextLeftRadius - radii[conflict.leftIndex]!;
    const rightIncrease =
      nextRightRadius == null
        ? Number.POSITIVE_INFINITY
        : nextRightRadius - radii[conflict.rightIndex]!;

    if (leftIncrease <= rightIncrease) {
      radii[conflict.leftIndex] = nextLeftRadius!;
    } else {
      radii[conflict.rightIndex] = nextRightRadius!;
    }
  }

  return null;
}

function buildStrictSmallTeamFrames(
  slotConfigs: readonly {
    footprint: OwnerFootprint;
    assignment: GraphOwnerSlotAssignment;
    vector: { x: number; y: number };
  }[],
  radii: readonly number[]
): SlotFrame[] {
  return slotConfigs.map((slot, index) =>
    buildSlotFrameAtRadiusWithVector(
      slot.footprint,
      slot.assignment,
      radii[index] ?? 0,
      slot.vector
    )
  );
}

function findFirstOwnerSlotFrameConflict(
  frames: readonly SlotFrame[]
): { leftIndex: number; rightIndex: number } | null {
  for (const [leftIndex, left] of frames.entries()) {
    for (let rightIndex = leftIndex + 1; rightIndex < frames.length; rightIndex += 1) {
      const right = frames[rightIndex]!;
      if (ownerSlotFramesOverlap(left.bounds, right.bounds)) {
        return { leftIndex, rightIndex };
      }
    }
  }
  return null;
}

function resolveMinimumRadiusAvoidingFrame(args: {
  slotConfig: {
    footprint: OwnerFootprint;
    assignment: GraphOwnerSlotAssignment;
    vector: { x: number; y: number };
  };
  currentRadius: number;
  otherFrame: SlotFrame;
  centralCollisionRects: readonly StableRect[];
}): number | null {
  const canPlaceAtRadius = (radius: number): boolean => {
    const frame = buildSlotFrameAtRadiusWithVector(
      args.slotConfig.footprint,
      args.slotConfig.assignment,
      radius,
      args.slotConfig.vector
    );
    return (
      !rectOverlapsAnyCentralRect(frame.bounds, args.centralCollisionRects) &&
      !ownerSlotFramesOverlap(frame.bounds, args.otherFrame.bounds)
    );
  };

  if (canPlaceAtRadius(args.currentRadius)) {
    return args.currentRadius;
  }

  let low = args.currentRadius;
  let high = Math.max(args.currentRadius + STRICT_SMALL_TEAM_RADIUS_STEP, args.currentRadius * 1.1);
  let expansionCount = 0;
  while (!canPlaceAtRadius(high) && expansionCount < 24) {
    low = high;
    high = Math.max(high + STRICT_SMALL_TEAM_RADIUS_STEP, high * 1.25);
    expansionCount += 1;
  }

  if (!canPlaceAtRadius(high)) {
    return null;
  }

  for (let iteration = 0; iteration < 24; iteration += 1) {
    const mid = (low + high) / 2;
    if (canPlaceAtRadius(mid)) {
      high = mid;
    } else {
      low = mid;
    }
  }

  return Math.ceil(high + STRICT_SMALL_TEAM_RADIUS_EPSILON);
}

function buildPreferredAssignmentsMap(
  assignments?: Record<string, GraphOwnerSlotAssignment>
): Map<string, GraphOwnerSlotAssignment> {
  const preferredAssignments = new Map<string, GraphOwnerSlotAssignment>();
  const assignmentOwnersBySlotKey = new Map<string, string[]>();

  for (const [ownerId, assignment] of Object.entries(assignments ?? {})) {
    preferredAssignments.set(ownerId, assignment);
    const slotKey = buildAssignmentKey(assignment);
    const existingOwners = assignmentOwnersBySlotKey.get(slotKey) ?? [];
    existingOwners.push(ownerId);
    assignmentOwnersBySlotKey.set(slotKey, existingOwners);
  }

  for (const [slotKey, owners] of assignmentOwnersBySlotKey) {
    if (owners.length > 1) {
      console.warn(
        `[agent-graph] duplicate saved slot assignment ${slotKey} for owners: ${owners.join(', ')}`
      );
    }
  }

  return preferredAssignments;
}

function resolveOwnerSlotFrame(args: {
  footprint: OwnerFootprint;
  centralCollisionRects: readonly StableRect[];
  runtimeCentralExclusion: StableRect;
  ringStates: RingLayoutStateMap;
  preferredAssignment?: GraphOwnerSlotAssignment;
  usedSlotKeys: Set<string>;
  placedFrames: readonly SlotFrame[];
  maxRingExclusive: number;
}): SlotFrame {
  const {
    footprint,
    centralCollisionRects,
    runtimeCentralExclusion,
    ringStates,
    preferredAssignment,
    usedSlotKeys,
    placedFrames,
    maxRingExclusive,
  } = args;

  const candidates = preferredAssignment
    ? buildPreferredCandidateAssignments(preferredAssignment, maxRingExclusive)
    : buildCandidateAssignments(maxRingExclusive);
  const directMatch = findFirstValidSlotFrame({
    candidateAssignments: candidates,
    footprint,
    centralCollisionRects,
    runtimeCentralExclusion,
    ringStates,
    usedSlotKeys,
    placedFrames,
    preferredAssignment,
  });
  if (directMatch) {
    return directMatch;
  }

  const spilloverCandidates = buildCandidateAssignments(
    maxRingExclusive + ownerFootprintsSpillBudget(placedFrames.length)
  ).filter((assignment) => assignment.ringIndex >= maxRingExclusive);
  const spilloverMatch = findFirstValidSlotFrame({
    candidateAssignments: spilloverCandidates,
    footprint,
    centralCollisionRects,
    runtimeCentralExclusion,
    ringStates,
    usedSlotKeys,
    placedFrames,
  });
  if (spilloverMatch) {
    return spilloverMatch;
  }

  return buildEmergencyFallbackSlotFrame({
    footprint,
    centralCollisionRects,
    runtimeCentralExclusion,
    ringStates,
    usedSlotKeys,
    placedOwnerCount: placedFrames.length,
    baseRingIndex: maxRingExclusive + ownerFootprintsSpillBudget(placedFrames.length),
  });
}

function buildSlotFrame(
  footprint: OwnerFootprint,
  assignment: GraphOwnerSlotAssignment,
  centralCollisionRects: readonly StableRect[],
  runtimeCentralExclusion: StableRect,
  options: { ringStates: RingLayoutStateMap }
): SlotFrame | null {
  const radius = resolveRingRadiusForAssignment({
    assignment,
    footprint,
    centralCollisionRects,
    runtimeCentralExclusion,
    ringStates: options.ringStates,
  });
  if (radius == null) {
    return null;
  }
  return buildSlotFrameAtRadius(footprint, assignment, radius);
}

function buildSlotFrameAtRadius(
  footprint: OwnerFootprint,
  assignment: GraphOwnerSlotAssignment,
  radius: number
): SlotFrame {
  const vector =
    SECTOR_VECTORS[assignment.sectorIndex % SECTOR_VECTORS.length] ?? SECTOR_VECTORS[0];
  return buildSlotFrameAtRadiusWithVector(footprint, assignment, radius, vector);
}

function buildSlotFrameAtRadiusWithVector(
  footprint: OwnerFootprint,
  assignment: GraphOwnerSlotAssignment,
  radius: number,
  vector: { x: number; y: number }
): SlotFrame {
  const ownerX = vector.x * radius;
  const ownerY = vector.y * radius;
  return buildSlotFrameAtOwnerAnchor(footprint, assignment, ownerX, ownerY);
}

function buildSlotFrameAtOwnerAnchor(
  footprint: OwnerFootprint,
  assignment: GraphOwnerSlotAssignment,
  ownerX: number,
  ownerY: number
): SlotFrame {
  const slotTop = ownerY - getOwnerAnchorTopOffset();
  const bounds = createRect(
    ownerX - footprint.slotWidth / 2,
    slotTop,
    footprint.slotWidth,
    footprint.slotHeight
  );
  const processBandRect = createRect(
    bounds.left + (bounds.width - footprint.processBandWidth) / 2,
    ownerY + SLOT_GEOMETRY.ownerBandHeight / 2 + SLOT_GEOMETRY.ownerToProcessGap,
    footprint.processBandWidth,
    SLOT_GEOMETRY.processBandHeight
  );
  const boardBandRect = createRect(
    bounds.left + (bounds.width - footprint.boardBandWidth) / 2,
    processBandRect.bottom + SLOT_GEOMETRY.processToBoardGap,
    footprint.boardBandWidth,
    footprint.boardBandHeight
  );
  const activityColumnRect = createRect(
    boardBandRect.left,
    boardBandRect.top,
    footprint.activityColumnWidth,
    footprint.activityColumnHeight
  );
  const activityToLogGap =
    footprint.activityColumnWidth > 0 && footprint.logColumnWidth > 0
      ? SLOT_GEOMETRY.boardColumnGap
      : 0;
  const logColumnRect = createRect(
    activityColumnRect.right + activityToLogGap,
    boardBandRect.top,
    footprint.logColumnWidth,
    footprint.logColumnHeight
  );
  const feedToKanbanGap =
    footprint.activityColumnWidth > 0 || footprint.logColumnWidth > 0
      ? SLOT_GEOMETRY.boardColumnGap
      : 0;
  const kanbanBandTopInset = getKanbanBandTopInset(footprint);
  const kanbanBandRect = createRect(
    logColumnRect.right + feedToKanbanGap,
    boardBandRect.top + kanbanBandTopInset,
    footprint.kanbanBandWidth,
    footprint.kanbanBandHeight
  );

  return {
    ownerId: footprint.ownerId,
    ringIndex: assignment.ringIndex,
    sectorIndex: assignment.sectorIndex,
    widthBucket: footprint.widthBucket,
    bounds,
    ownerX,
    ownerY,
    boardBandRect,
    activityColumnRect,
    logColumnRect,
    processBandRect,
    kanbanBandRect,
    taskColumnCount: footprint.taskColumnCount,
  };
}

function getOwnerAnchorTopOffset(): number {
  return SLOT_GEOMETRY.memberSlotInnerPadding + SLOT_GEOMETRY.ownerBandHeight / 2;
}

function getKanbanBandTopInset(args: {
  activityColumnWidth: number;
  logColumnWidth: number;
}): number {
  if (args.activityColumnWidth <= 0 && args.logColumnWidth <= 0) {
    return 0;
  }

  const feedCardTopInset = ACTIVITY_LANE.headerHeight + FEED_HEADER_BOTTOM_GAP;
  const taskPillTopInset = KANBAN_ZONE.headerHeight - TASK_PILL.height / 2;
  return Math.max(0, feedCardTopInset - taskPillTopInset);
}

function buildCandidateAssignments(maxRingExclusive: number): GraphOwnerSlotAssignment[] {
  const candidates: GraphOwnerSlotAssignment[] = [];
  for (let ringIndex = 0; ringIndex < maxRingExclusive; ringIndex += 1) {
    for (let sectorIndex = 0; sectorIndex < SECTOR_VECTORS.length; sectorIndex += 1) {
      candidates.push({ ringIndex, sectorIndex });
    }
  }
  return candidates;
}

function buildPreferredCandidateAssignments(
  preferred: GraphOwnerSlotAssignment,
  maxRingExclusive: number
): GraphOwnerSlotAssignment[] {
  const ordered: GraphOwnerSlotAssignment[] = [preferred];
  const seen = new Set([`${preferred.ringIndex}:${preferred.sectorIndex}`]);
  const sectorOrder = buildSectorPreferenceOrder(preferred.sectorIndex);

  appendSameSectorOuterRingCandidates(ordered, seen, preferred, maxRingExclusive);
  appendRingSectorCandidates(ordered, seen, preferred.ringIndex, sectorOrder);

  for (let ringIndex = preferred.ringIndex + 1; ringIndex < maxRingExclusive; ringIndex += 1) {
    appendRingSectorCandidates(ordered, seen, ringIndex, sectorOrder);
  }

  for (let ringIndex = 0; ringIndex < preferred.ringIndex; ringIndex += 1) {
    appendRingSectorCandidates(ordered, seen, ringIndex, sectorOrder);
  }

  return ordered;
}

function computePlannerRingLimit(
  ownerFootprints: readonly OwnerFootprint[],
  assignments?: Record<string, GraphOwnerSlotAssignment>
): number {
  const maxAssignedRing = Object.values(assignments ?? {}).reduce(
    (max, assignment) => Math.max(max, assignment.ringIndex),
    0
  );
  return Math.max(SLOT_GEOMETRY.maxGeneratedRings, maxAssignedRing + ownerFootprints.length + 2);
}

function ownerFootprintsSpillBudget(placedOwnerCount: number): number {
  return Math.max(6, placedOwnerCount + 2);
}

function buildEmergencyFallbackSlotFrame(args: {
  footprint: OwnerFootprint;
  centralCollisionRects: readonly StableRect[];
  runtimeCentralExclusion: StableRect;
  ringStates: RingLayoutStateMap;
  usedSlotKeys: Set<string>;
  placedOwnerCount: number;
  baseRingIndex: number;
}): SlotFrame {
  const assignment = {
    ringIndex: args.baseRingIndex + args.placedOwnerCount,
    sectorIndex: 0,
  };
  args.usedSlotKeys.add(buildAssignmentKey(assignment));
  const frame = buildSlotFrame(
    args.footprint,
    assignment,
    args.centralCollisionRects,
    args.runtimeCentralExclusion,
    {
      ringStates: args.ringStates,
    }
  );
  if (!frame) {
    throw new Error(`failed to build emergency fallback slot frame for ${args.footprint.ownerId}`);
  }
  return frame;
}

function rankNearestSlotAssignmentResult(args: {
  assignment: GraphOwnerSlotAssignment;
  occupiedFrame: SlotFrame | undefined;
  footprint: OwnerFootprint;
  footprintByOwnerId: ReadonlyMap<string, OwnerFootprint>;
  currentFrame: SlotFrame;
  existingFrames: readonly SlotFrame[];
  centralCollisionRects: readonly StableRect[];
  runtimeCentralExclusion: StableRect;
  ringStates: RingLayoutStateMap;
  pointerX: number;
  pointerY: number;
}): RankedNearestSlotAssignmentResult | null {
  const {
    assignment,
    occupiedFrame,
    footprint,
    footprintByOwnerId,
    currentFrame,
    existingFrames,
    centralCollisionRects,
    runtimeCentralExclusion,
    ringStates,
    pointerX,
    pointerY,
  } = args;
  const frame = buildSlotFrame(
    footprint,
    assignment,
    centralCollisionRects,
    runtimeCentralExclusion,
    {
      ringStates,
    }
  );
  if (!frame) {
    return null;
  }

  if (occupiedFrame) {
    const displacedFrame = buildDisplacedFrameForNearestAssignment({
      occupiedFrame,
      footprintByOwnerId,
      currentFrame,
      centralCollisionRects,
      runtimeCentralExclusion,
      ringStates,
    });
    if (!displacedFrame) {
      return null;
    }
    const otherFrames = existingFrames.filter(
      (existing) => existing.ownerId !== occupiedFrame.ownerId
    );
    if (
      !isSlotFramePlacementValid(frame, otherFrames, centralCollisionRects) ||
      !isSlotFramePlacementValid(displacedFrame, otherFrames, centralCollisionRects) ||
      ownerSlotFramesOverlap(frame.bounds, displacedFrame.bounds)
    ) {
      return null;
    }
    return buildRankedNearestSlotAssignmentResult({
      assignment,
      frame,
      pointerX,
      pointerY,
      displacedOwnerId: occupiedFrame.ownerId,
      displacedAssignment: {
        ringIndex: currentFrame.ringIndex,
        sectorIndex: currentFrame.sectorIndex,
      },
    });
  }

  if (!isSlotFramePlacementValid(frame, existingFrames, centralCollisionRects)) {
    return null;
  }

  return buildRankedNearestSlotAssignmentResult({
    assignment,
    frame,
    pointerX,
    pointerY,
  });
}

function buildDisplacedFrameForNearestAssignment(args: {
  occupiedFrame: SlotFrame;
  footprintByOwnerId: ReadonlyMap<string, OwnerFootprint>;
  currentFrame: SlotFrame;
  centralCollisionRects: readonly StableRect[];
  runtimeCentralExclusion: StableRect;
  ringStates: RingLayoutStateMap;
}): SlotFrame | null {
  const displacedFootprint = args.footprintByOwnerId.get(args.occupiedFrame.ownerId);
  if (!displacedFootprint) {
    return null;
  }
  return buildSlotFrame(
    displacedFootprint,
    {
      ringIndex: args.currentFrame.ringIndex,
      sectorIndex: args.currentFrame.sectorIndex,
    },
    args.centralCollisionRects,
    args.runtimeCentralExclusion,
    { ringStates: args.ringStates }
  );
}

function buildRankedNearestSlotAssignmentResult(args: {
  assignment: GraphOwnerSlotAssignment;
  frame: SlotFrame;
  pointerX: number;
  pointerY: number;
  displacedOwnerId?: string;
  displacedAssignment?: GraphOwnerSlotAssignment;
}): RankedNearestSlotAssignmentResult {
  const dx = args.frame.ownerX - args.pointerX;
  const dy = args.frame.ownerY - args.pointerY;
  return {
    assignment: args.assignment,
    displacedOwnerId: args.displacedOwnerId,
    displacedAssignment: args.displacedAssignment,
    previewOwnerX: args.frame.ownerX,
    previewOwnerY: args.frame.ownerY,
    distanceSquared: dx * dx + dy * dy,
  };
}

function findFirstValidSlotFrame(args: {
  candidateAssignments: readonly GraphOwnerSlotAssignment[];
  footprint: OwnerFootprint;
  centralCollisionRects: readonly StableRect[];
  runtimeCentralExclusion: StableRect;
  ringStates: RingLayoutStateMap;
  usedSlotKeys: Set<string>;
  placedFrames: readonly SlotFrame[];
  preferredAssignment?: GraphOwnerSlotAssignment;
}): SlotFrame | null {
  for (const assignment of args.candidateAssignments) {
    const frame = tryBuildValidSlotFrame(args, assignment);
    if (frame) {
      return frame;
    }
  }
  return null;
}

function tryBuildValidSlotFrame(
  args: {
    footprint: OwnerFootprint;
    centralCollisionRects: readonly StableRect[];
    runtimeCentralExclusion: StableRect;
    ringStates: RingLayoutStateMap;
    usedSlotKeys: Set<string>;
    placedFrames: readonly SlotFrame[];
    preferredAssignment?: GraphOwnerSlotAssignment;
  },
  assignment: GraphOwnerSlotAssignment
): SlotFrame | null {
  const slotKey = buildAssignmentKey(assignment);
  if (args.usedSlotKeys.has(slotKey) && !isSameAssignment(args.preferredAssignment, assignment)) {
    return null;
  }
  const frame = buildSlotFrame(
    args.footprint,
    assignment,
    args.centralCollisionRects,
    args.runtimeCentralExclusion,
    {
      ringStates: args.ringStates,
    }
  );
  if (!frame) {
    return null;
  }
  if (!isSlotFramePlacementValid(frame, args.placedFrames, args.centralCollisionRects)) {
    return null;
  }
  args.usedSlotKeys.add(slotKey);
  return frame;
}

function appendSameSectorOuterRingCandidates(
  ordered: GraphOwnerSlotAssignment[],
  seen: Set<string>,
  preferred: GraphOwnerSlotAssignment,
  maxRingExclusive: number
): void {
  for (let ringIndex = preferred.ringIndex + 1; ringIndex < maxRingExclusive; ringIndex += 1) {
    appendUniqueCandidate(ordered, seen, { ringIndex, sectorIndex: preferred.sectorIndex });
  }
}

function appendRingSectorCandidates(
  ordered: GraphOwnerSlotAssignment[],
  seen: Set<string>,
  ringIndex: number,
  sectorOrder: readonly number[]
): void {
  for (const sectorIndex of sectorOrder) {
    appendUniqueCandidate(ordered, seen, { ringIndex, sectorIndex });
  }
}

function appendUniqueCandidate(
  ordered: GraphOwnerSlotAssignment[],
  seen: Set<string>,
  assignment: GraphOwnerSlotAssignment
): void {
  const key = `${assignment.ringIndex}:${assignment.sectorIndex}`;
  if (seen.has(key)) {
    return;
  }
  ordered.push(assignment);
  seen.add(key);
}

function buildSectorPreferenceOrder(preferredSectorIndex: number): number[] {
  const ordered = [preferredSectorIndex];
  for (let distance = 1; distance < SECTOR_VECTORS.length; distance += 1) {
    const left = (preferredSectorIndex - distance + SECTOR_VECTORS.length) % SECTOR_VECTORS.length;
    const right = (preferredSectorIndex + distance) % SECTOR_VECTORS.length;
    if (!ordered.includes(left)) {
      ordered.push(left);
    }
    if (!ordered.includes(right)) {
      ordered.push(right);
    }
  }
  return ordered;
}

function buildRingStatesFromFrames(
  frames: readonly SlotFrame[],
  footprintByOwnerId: ReadonlyMap<string, OwnerFootprint>
): Map<string, RingLayoutState> {
  const ringStates = new Map<string, RingLayoutState>();
  for (const frame of frames) {
    const footprint = footprintByOwnerId.get(frame.ownerId);
    if (!footprint) {
      continue;
    }
    commitRingPlacement(ringStates, frame, footprint);
  }
  return ringStates;
}

function commitRingPlacement(
  ringStates: Map<string, RingLayoutState>,
  frame: SlotFrame,
  footprint: OwnerFootprint
): void {
  const radius = resolveFrameRingRadius(frame);
  const vector = SECTOR_VECTORS[frame.sectorIndex % SECTOR_VECTORS.length] ?? SECTOR_VECTORS[0];
  const { outwardDepth } = computeSlotDirectionalDepths(footprint, vector);
  const key = buildSectorRingStateKey(frame.sectorIndex, frame.ringIndex);
  const existing = ringStates.get(key);
  if (!existing) {
    ringStates.set(key, {
      radius,
      outwardDepth,
    });
    return;
  }

  ringStates.set(key, {
    radius: Math.max(existing.radius, radius),
    outwardDepth: Math.max(existing.outwardDepth, outwardDepth),
  });
}

function resolveFrameRingRadius(frame: SlotFrame): number {
  const vector = SECTOR_VECTORS[frame.sectorIndex % SECTOR_VECTORS.length] ?? SECTOR_VECTORS[0];
  if (Math.abs(vector.x) >= Math.abs(vector.y) && Math.abs(vector.x) > 0.001) {
    return Math.abs(frame.ownerX / vector.x);
  }
  if (Math.abs(vector.y) > 0.001) {
    return Math.abs(frame.ownerY / vector.y);
  }
  return Math.hypot(frame.ownerX, frame.ownerY);
}

function computeSlotDirectionalDepths(
  footprint: OwnerFootprint,
  vector: { x: number; y: number }
): { outwardDepth: number; inwardDepth: number } {
  const ownerLocalY = SLOT_GEOMETRY.memberSlotInnerPadding + SLOT_GEOMETRY.ownerBandHeight / 2;
  const topOffset = -ownerLocalY;
  const bottomOffset = footprint.slotHeight - ownerLocalY;
  const halfWidth = footprint.slotWidth / 2;
  const vectorLength = Math.hypot(vector.x, vector.y) || 1;
  const unitX = vector.x / vectorLength;
  const unitY = vector.y / vectorLength;
  const cornerProjections = [
    { x: -halfWidth, y: topOffset },
    { x: halfWidth, y: topOffset },
    { x: halfWidth, y: bottomOffset },
    { x: -halfWidth, y: bottomOffset },
  ].map((corner) => corner.x * unitX + corner.y * unitY);

  return {
    outwardDepth: Math.max(...cornerProjections),
    inwardDepth: Math.max(...cornerProjections.map((projection) => -projection)),
  };
}

function resolveRingRadiusForAssignment(args: {
  assignment: GraphOwnerSlotAssignment;
  footprint: OwnerFootprint;
  centralCollisionRects: readonly StableRect[];
  runtimeCentralExclusion: StableRect;
  ringStates: RingLayoutStateMap;
}): number | null {
  const vector =
    SECTOR_VECTORS[args.assignment.sectorIndex % SECTOR_VECTORS.length] ?? SECTOR_VECTORS[0];
  const minRadius = resolveMinimumDirectionalRadius({
    assignment: args.assignment,
    footprint: args.footprint,
    centralCollisionRects: args.centralCollisionRects,
    runtimeCentralExclusion: args.runtimeCentralExclusion,
  });
  const directionalDepths = computeSlotDirectionalDepths(args.footprint, vector);
  const ringState = resolveVirtualRingState(
    args.assignment.sectorIndex,
    args.assignment.ringIndex,
    minRadius,
    directionalDepths,
    args.ringStates
  );

  return minRadius <= ringState.radius + 0.001 ? ringState.radius : null;
}

function resolveVirtualRingState(
  sectorIndex: number,
  ringIndex: number,
  minRadius: number,
  directionalDepths: { outwardDepth: number; inwardDepth: number },
  ringStates: RingLayoutStateMap
): RingLayoutState {
  const existing = ringStates.get(buildSectorRingStateKey(sectorIndex, ringIndex));
  if (existing) {
    return existing;
  }
  if (ringIndex === 0) {
    return {
      radius: minRadius,
      outwardDepth: directionalDepths.outwardDepth,
    };
  }

  const previous = resolveVirtualRingState(
    sectorIndex,
    ringIndex - 1,
    minRadius,
    directionalDepths,
    ringStates
  );
  return {
    radius: Math.max(
      minRadius,
      previous.radius +
        previous.outwardDepth +
        directionalDepths.inwardDepth +
        SLOT_GEOMETRY.ringGap
    ),
    outwardDepth: directionalDepths.outwardDepth,
  };
}

function buildSectorRingStateKey(sectorIndex: number, ringIndex: number): string {
  return `${sectorIndex}:${ringIndex}`;
}

function resolveMinimumDirectionalRadius(args: {
  assignment: GraphOwnerSlotAssignment;
  footprint: OwnerFootprint;
  centralCollisionRects: readonly StableRect[];
  runtimeCentralExclusion: StableRect;
}): number {
  return resolveMinimumDirectionalRadiusForVector({
    vector:
      SECTOR_VECTORS[args.assignment.sectorIndex % SECTOR_VECTORS.length] ?? SECTOR_VECTORS[0],
    footprint: args.footprint,
    centralCollisionRects: args.centralCollisionRects,
    runtimeCentralExclusion: args.runtimeCentralExclusion,
  });
}

function resolveMinimumDirectionalRadiusForVector(args: {
  vector: { x: number; y: number };
  footprint: OwnerFootprint;
  centralCollisionRects: readonly StableRect[];
  runtimeCentralExclusion: StableRect;
}): number {
  const legacyRadiusHint = computeLegacyMinimumRingRadius(
    args.vector,
    args.footprint,
    args.runtimeCentralExclusion
  );
  const overlapsCentralCollision = (radius: number): boolean => {
    const frame = buildSlotFrameAtRadiusWithVector(
      args.footprint,
      { ringIndex: 0, sectorIndex: 0 },
      radius,
      args.vector
    );
    return rectOverlapsAnyCentralRect(frame.bounds, args.centralCollisionRects);
  };

  if (!overlapsCentralCollision(0)) {
    return 0;
  }

  let low = 0;
  let high = Math.max(legacyRadiusHint, SLOT_GEOMETRY.ringGap);
  let expansionCount = 0;
  while (overlapsCentralCollision(high) && expansionCount < 24) {
    low = high;
    high = Math.max(high * 2, high + SLOT_GEOMETRY.ringGap);
    expansionCount += 1;
  }

  for (let iteration = 0; iteration < 24; iteration += 1) {
    const mid = (low + high) / 2;
    if (overlapsCentralCollision(mid)) {
      low = mid;
    } else {
      high = mid;
    }
  }

  return Math.ceil(high);
}

function computeLegacyMinimumRingRadius(
  vector: { x: number; y: number },
  footprint: OwnerFootprint,
  centralExclusion: StableRect
): number {
  const horizontalExtent = vector.x >= 0 ? centralExclusion.right : Math.abs(centralExclusion.left);
  const verticalExtent = vector.y >= 0 ? centralExclusion.bottom : Math.abs(centralExclusion.top);
  const requiredX =
    Math.abs(vector.x) > 0.001
      ? (horizontalExtent + footprint.slotWidth / 2 + SLOT_GEOMETRY.ringPadding) /
        Math.abs(vector.x)
      : 0;
  const requiredY =
    Math.abs(vector.y) > 0.001
      ? (verticalExtent + footprint.slotHeight / 2 + SLOT_GEOMETRY.ringPadding) / Math.abs(vector.y)
      : 0;
  return Math.max(requiredX, requiredY, 0);
}

function resolveTaskColumnKey(task: GraphNode): string {
  if (task.reviewState === 'approved') return 'approved';
  if (task.reviewState === 'review' || task.reviewState === 'needsFix') return 'review';
  if (task.taskStatus === 'completed') return 'done';
  if (task.taskStatus === 'in_progress') return 'wip';
  return 'todo';
}

function rectsOverlapWithAxisGap(
  a: StableRect,
  b: StableRect,
  horizontalGap: number,
  verticalGap: number
): boolean {
  return (
    a.left - horizontalGap < b.right &&
    a.right + horizontalGap > b.left &&
    a.top - verticalGap < b.bottom &&
    a.bottom + verticalGap > b.top
  );
}

function rectsOverlap(a: StableRect, b: StableRect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function ownerSlotFramesOverlap(a: StableRect, b: StableRect): boolean {
  return rectsOverlapWithAxisGap(a, b, SLOT_GEOMETRY.slotHorizontalGap, SLOT_GEOMETRY.ringPadding);
}

function rectContainsRect(outer: StableRect, inner: StableRect): boolean {
  return (
    inner.left >= outer.left - GEOMETRY_EPSILON &&
    inner.right <= outer.right + GEOMETRY_EPSILON &&
    inner.top >= outer.top - GEOMETRY_EPSILON &&
    inner.bottom <= outer.bottom + GEOMETRY_EPSILON
  );
}

function pointInRect(x: number, y: number, rect: StableRect): boolean {
  return (
    x >= rect.left - GEOMETRY_EPSILON &&
    x <= rect.right + GEOMETRY_EPSILON &&
    y >= rect.top - GEOMETRY_EPSILON &&
    y <= rect.bottom + GEOMETRY_EPSILON
  );
}

function isFiniteRect(rect: StableRect): boolean {
  return (
    Number.isFinite(rect.left) &&
    Number.isFinite(rect.top) &&
    Number.isFinite(rect.right) &&
    Number.isFinite(rect.bottom) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height)
  );
}

function isSlotFramePlacementValid(
  frame: SlotFrame,
  existingFrames: readonly SlotFrame[],
  centralCollisionRects: readonly StableRect[]
): boolean {
  if (!isFiniteRect(frame.bounds)) {
    return false;
  }
  if (rectOverlapsAnyCentralRect(frame.bounds, centralCollisionRects)) {
    return false;
  }
  return !existingFrames.some((existing) => ownerSlotFramesOverlap(frame.bounds, existing.bounds));
}

function buildAssignmentKey(assignment: GraphOwnerSlotAssignment): string {
  return `${assignment.ringIndex}:${assignment.sectorIndex}`;
}

function isSameAssignment(
  left: GraphOwnerSlotAssignment | undefined,
  right: GraphOwnerSlotAssignment
): boolean {
  return left?.ringIndex === right.ringIndex && left?.sectorIndex === right.sectorIndex;
}

function createRect(left: number, top: number, width: number, height: number): StableRect {
  return {
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
  };
}

function createCenteredRect(
  centerX: number,
  centerY: number,
  width: number,
  height: number
): StableRect {
  return createRect(centerX - width / 2, centerY - height / 2, width, height);
}

function padRect(rect: StableRect, padding: number): StableRect {
  return createRect(
    rect.left - padding,
    rect.top - padding,
    rect.width + padding * 2,
    rect.height + padding * 2
  );
}

function translateRect(rect: StableRect, dx: number, dy: number): StableRect {
  return createRect(rect.left + dx, rect.top + dy, rect.width, rect.height);
}

function unionRects(rects: StableRect[]): StableRect {
  const left = Math.min(...rects.map((rect) => rect.left));
  const top = Math.min(...rects.map((rect) => rect.top));
  const right = Math.max(...rects.map((rect) => rect.right));
  const bottom = Math.max(...rects.map((rect) => rect.bottom));
  return createRect(left, top, right - left, bottom - top);
}
