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
  processBandRect: StableRect;
  kanbanBandRect: StableRect;
  taskColumnCount: number;
}

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

const SLOT_GEOMETRY = {
  ...STABLE_SLOT_GEOMETRY,
  activityColumnHeight:
    ACTIVITY_LANE.headerHeight +
    ACTIVITY_LANE.maxVisibleItems * ACTIVITY_LANE.rowHeight +
    ACTIVITY_LANE.overflowHeight,
  activityColumnWidth: ACTIVITY_LANE.width,
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
const SMALL_TEAM_CARDINAL_RADIUS_STEP = 24;
const SMALL_TEAM_CARDINAL_VERTICAL_PADDING = 77.7;
const GRID_UNDER_LEAD_COLUMN_COUNT = 2;
const GRID_UNDER_LEAD_LEAD_GAP = 77.7;
const GRID_UNDER_LEAD_ROW_GAP = 77.7;

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
];

const SMALL_TEAM_CARDINAL_ASSIGNMENTS: ReadonlyArray<ReadonlyArray<GraphOwnerSlotAssignment>> =
  SMALL_TEAM_CARDINAL_LAYOUTS.map((layout) => layout.map((slot) => slot.assignment));
const SMALL_TEAM_CARDINAL_VECTOR_BY_ASSIGNMENT_KEY = new Map(
  SMALL_TEAM_CARDINAL_LAYOUTS.flatMap((layout) =>
    layout.map((slot) => [buildAssignmentKey(slot.assignment), slot.vector] as const)
  )
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

  const memberSlotFrames =
    (layout?.mode ?? 'radial') === 'grid-under-lead'
      ? planGridUnderLeadOwnerSlots(ownerFootprints, centralCollisionRects)
      : planOwnerSlots(ownerFootprints, centralCollisionRects, runtimeCentralExclusion, layout);
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
  });
}

function buildOwnerFootprint(args: {
  ownerId: string;
  taskColumnCount: number;
  processCount: number;
  showActivity: boolean;
}): OwnerFootprint {
  const activityColumnWidth = args.showActivity ? SLOT_GEOMETRY.activityColumnWidth : 0;
  const activityColumnHeight = args.showActivity ? SLOT_GEOMETRY.activityColumnHeight : 0;
  const activityToKanbanGap = args.showActivity ? SLOT_GEOMETRY.boardColumnGap : 0;
  const kanbanBandWidth =
    args.taskColumnCount <= 1
      ? TASK_PILL.width
      : TASK_PILL.width + (args.taskColumnCount - 1) * KANBAN_ZONE.columnWidth;
  const processBandWidth = computeProcessBandWidth(args.processCount);
  const boardBandWidth = activityColumnWidth + activityToKanbanGap + kanbanBandWidth;
  const boardBandHeight = Math.max(activityColumnHeight, SLOT_GEOMETRY.kanbanBandHeight);
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

  let best: {
    frame: SlotFrame;
    distanceSquared: number;
  } | null = null;
  for (const frame of strictFrames) {
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
  if (frames.length === 0 || frames.length > 4) {
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
): SlotFrame[] {
  const strictSmallTeamFrames = shouldUseStrictSmallTeamCardinalLayout(ownerFootprints, layout)
    ? planStrictSmallTeamOwnerSlots(
        ownerFootprints,
        centralCollisionRects,
        runtimeCentralExclusion,
        layout
      )
    : null;
  if (strictSmallTeamFrames) {
    return strictSmallTeamFrames;
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

  return placedFrames;
}

function planGridUnderLeadOwnerSlots(
  ownerFootprints: readonly OwnerFootprint[],
  centralCollisionRects: readonly StableRect[]
): SlotFrame[] {
  const frames: SlotFrame[] = [];
  const centralBlock = unionRects([...centralCollisionRects]);
  let rowTop = centralBlock.bottom + GRID_UNDER_LEAD_LEAD_GAP;

  for (
    let rowStartIndex = 0;
    rowStartIndex < ownerFootprints.length;
    rowStartIndex += GRID_UNDER_LEAD_COLUMN_COUNT
  ) {
    const rowFootprints = ownerFootprints.slice(
      rowStartIndex,
      rowStartIndex + GRID_UNDER_LEAD_COLUMN_COUNT
    );
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
            ringIndex: Math.floor(rowStartIndex / GRID_UNDER_LEAD_COLUMN_COUNT),
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

function shouldUseStrictSmallTeamCardinalLayout(
  ownerFootprints: readonly OwnerFootprint[],
  layout?: GraphLayoutPort
): boolean {
  if (ownerFootprints.length === 0 || ownerFootprints.length > 4) {
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
  if (ownerFootprints.length === 0 || ownerFootprints.length > 4) {
    return null;
  }

  const preset = SMALL_TEAM_CARDINAL_LAYOUTS[ownerFootprints.length];
  if (!preset || preset.length !== ownerFootprints.length) {
    return null;
  }

  const slotConfigs = ownerFootprints.map((footprint) => {
    const assignment = layout?.slotAssignments?.[footprint.ownerId];
    if (!assignment) {
      return null;
    }
    const vector = SMALL_TEAM_CARDINAL_VECTOR_BY_ASSIGNMENT_KEY.get(buildAssignmentKey(assignment));
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

  const baseRadiusByAxis = resolveStrictSmallTeamRadiusByAxis(
    slotConfigs.map((slot) => slot!),
    centralCollisionRects,
    runtimeCentralExclusion
  );

  for (let iteration = 0; iteration < 48; iteration += 1) {
    const radiusBump = iteration * SMALL_TEAM_CARDINAL_RADIUS_STEP;
    const frames = slotConfigs.map((slot) => {
      const axis = resolveStrictSmallTeamVectorAxis(slot!.vector);
      return buildSlotFrameAtRadiusWithVector(
        slot!.footprint,
        slot!.assignment,
        baseRadiusByAxis[axis] +
          (axis === 'vertical' ? SMALL_TEAM_CARDINAL_VERTICAL_PADDING : 0) +
          radiusBump,
        slot!.vector
      );
    });
    const allValid = frames.every((frame, frameIndex) =>
      isSlotFramePlacementValid(
        frame,
        frames.filter((_, index) => index !== frameIndex),
        centralCollisionRects
      )
    );
    if (allValid) {
      return frames;
    }
  }

  return null;
}

function resolveStrictSmallTeamRadiusByAxis(
  slotConfigs: readonly {
    footprint: OwnerFootprint;
    vector: { x: number; y: number };
  }[],
  centralCollisionRects: readonly StableRect[],
  runtimeCentralExclusion: StableRect
): Record<'horizontal' | 'vertical', number> {
  const radiusByAxis = {
    horizontal: 0,
    vertical: 0,
  };

  for (const slot of slotConfigs) {
    const axis = resolveStrictSmallTeamVectorAxis(slot.vector);
    const radius = resolveMinimumDirectionalRadiusForVector({
      vector: slot.vector,
      footprint: slot.footprint,
      centralCollisionRects,
      runtimeCentralExclusion,
    });
    radiusByAxis[axis] = Math.max(radiusByAxis[axis], radius);
  }

  return radiusByAxis;
}

function resolveStrictSmallTeamVectorAxis(vector: {
  x: number;
  y: number;
}): 'horizontal' | 'vertical' {
  return Math.abs(vector.x) >= Math.abs(vector.y) ? 'horizontal' : 'vertical';
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
  const activityToKanbanGap = footprint.activityColumnWidth > 0 ? SLOT_GEOMETRY.boardColumnGap : 0;
  const kanbanBandRect = createRect(
    activityColumnRect.right + activityToKanbanGap,
    boardBandRect.top,
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
    processBandRect,
    kanbanBandRect,
    taskColumnCount: footprint.taskColumnCount,
  };
}

function getOwnerAnchorTopOffset(): number {
  return SLOT_GEOMETRY.memberSlotInnerPadding + SLOT_GEOMETRY.ownerBandHeight / 2;
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
