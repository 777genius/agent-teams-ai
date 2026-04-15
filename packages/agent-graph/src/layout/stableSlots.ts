import { KANBAN_ZONE, TASK_PILL } from '../constants/canvas-constants';
import type { GraphLayoutPort, GraphNode, GraphOwnerSlotAssignment } from '../ports/types';
import { ACTIVITY_LANE } from './activityLane';
import { LAUNCH_ANCHOR_LAYOUT, type WorldBounds } from './launchAnchor';
import {
  STABLE_SLOT_GEOMETRY,
  STABLE_SLOT_SECTOR_VECTORS,
} from './stableSlotGeometry';

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
  leadActivityRect: StableRect;
  launchHudRect: StableRect;
  launchAnchor: { x: number; y: number } | null;
  leadCentralReservedBlock: StableRect;
  runtimeCentralExclusion: StableRect;
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
    KANBAN_ZONE.headerHeight +
    STABLE_SLOT_GEOMETRY.taskMaxVisibleRows * KANBAN_ZONE.rowHeight,
  centralPadding: STABLE_SLOT_GEOMETRY.centralSafetyPadding,
} as const;

const PROCESS_RAIL_NODE_GAP = 42;
const PROCESS_RAIL_NODE_FOOTPRINT = 28;

const SECTOR_VECTORS = STABLE_SLOT_SECTOR_VECTORS;

export function buildStableSlotLayoutSnapshot({
  teamName,
  nodes,
  layout,
}: LayoutBuildArgs): StableSlotLayoutSnapshot | null {
  const leadNode = nodes.find((node) => node.kind === 'lead') ?? null;
  if (!leadNode) {
    return null;
  }

  const leadCoreRect = createCenteredRect(0, 0, 200, 168);
  const leadActivityRect = createRect(
    leadCoreRect.left - SLOT_GEOMETRY.centralBlockGap - ACTIVITY_LANE.width,
    -SLOT_GEOMETRY.activityColumnHeight / 2,
    ACTIVITY_LANE.width,
    SLOT_GEOMETRY.activityColumnHeight
  );
  const launchHudRect = createRect(
    leadCoreRect.right + SLOT_GEOMETRY.centralBlockGap,
    -LAUNCH_ANCHOR_LAYOUT.compactHeight / 2,
    LAUNCH_ANCHOR_LAYOUT.compactWidth,
    LAUNCH_ANCHOR_LAYOUT.compactHeight
  );
  const leadCentralReservedBlock = unionRects([leadCoreRect, leadActivityRect, launchHudRect]);

  const ownerFootprints = computeOwnerFootprints(nodes, layout);
  const unassignedTaskRect = buildUnassignedTaskRect(nodes, leadCentralReservedBlock);
  const runtimeCentralExclusion = padRect(
    unionRects(
      unassignedTaskRect
        ? [leadCentralReservedBlock, unassignedTaskRect]
        : [leadCentralReservedBlock]
    ),
    SLOT_GEOMETRY.centralPadding
  );

  const memberSlotFrames = planOwnerSlots(ownerFootprints, runtimeCentralExclusion, layout);
  const memberSlotFrameByOwnerId = new Map(
    memberSlotFrames.map((frame) => [frame.ownerId, frame] as const)
  );
  const fitBounds = unionRects(
    [
      leadCentralReservedBlock,
      leadActivityRect,
      launchHudRect,
      runtimeCentralExclusion,
      ...memberSlotFrames.map((frame) => frame.bounds),
      ...(unassignedTaskRect ? [unassignedTaskRect] : []),
    ].filter(Boolean)
  );

  return {
    version: layout?.version ?? 'stable-slots-v1',
    teamName,
    leadNodeId: leadNode.id,
    leadCoreRect,
    leadActivityRect,
    launchHudRect,
    launchAnchor: {
      x: launchHudRect.left + launchHudRect.width / 2,
      y: launchHudRect.top + launchHudRect.height / 2,
    },
    leadCentralReservedBlock,
    runtimeCentralExclusion,
    memberSlotFrames,
    memberSlotFrameByOwnerId,
    unassignedTaskRect,
    fitBounds,
  };
}

export function computeOwnerFootprints(
  nodes: GraphNode[],
  layout?: GraphLayoutPort
): OwnerFootprint[] {
  const ownerNodes = nodes.filter((node) => node.kind === 'member');
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

    const taskColumnCount = taskColumnsByOwnerId.get(ownerId)?.size ?? 0;
    const kanbanBandWidth =
      taskColumnCount <= 1
        ? TASK_PILL.width
        : TASK_PILL.width + (taskColumnCount - 1) * KANBAN_ZONE.columnWidth;
    const processCount = processCountByOwnerId.get(ownerId) ?? 0;
    const processBandWidth = computeProcessBandWidth(processCount);
    const boardBandWidth =
      SLOT_GEOMETRY.activityColumnWidth +
      SLOT_GEOMETRY.boardColumnGap +
      kanbanBandWidth;
    const boardBandHeight = Math.max(
      SLOT_GEOMETRY.activityColumnHeight,
      SLOT_GEOMETRY.kanbanBandHeight
    );
    const innerContentWidth = Math.max(
      SLOT_GEOMETRY.ownerMinWidth,
      processBandWidth,
      boardBandWidth
    );
    const slotWidth = innerContentWidth + SLOT_GEOMETRY.memberSlotInnerPadding * 2;
    const slotHeight =
      SLOT_GEOMETRY.memberSlotInnerPadding * 2 +
      SLOT_GEOMETRY.ownerBandHeight +
      SLOT_GEOMETRY.ownerToProcessGap +
      SLOT_GEOMETRY.processBandHeight +
      SLOT_GEOMETRY.processToBoardGap +
      boardBandHeight;
    const radialDepth = Math.max(
      SLOT_GEOMETRY.memberSlotInnerPadding +
        SLOT_GEOMETRY.ownerBandHeight / 2,
      SLOT_GEOMETRY.memberSlotInnerPadding +
        SLOT_GEOMETRY.ownerBandHeight / 2 +
        SLOT_GEOMETRY.ownerToProcessGap +
        SLOT_GEOMETRY.processBandHeight +
        SLOT_GEOMETRY.processToBoardGap +
        boardBandHeight
    );

    return [
      {
        ownerId,
        slotWidth,
        slotHeight,
        widthBucket: classifyWidthBucket(slotWidth),
        radialDepth,
        activityColumnWidth: SLOT_GEOMETRY.activityColumnWidth,
        activityColumnHeight: SLOT_GEOMETRY.activityColumnHeight,
        processBandWidth,
        kanbanBandWidth,
        kanbanBandHeight: SLOT_GEOMETRY.kanbanBandHeight,
        boardBandWidth,
        boardBandHeight,
        taskColumnCount,
        processCount,
      } satisfies OwnerFootprint,
    ];
  });
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

  const occupiedWidth =
    (processCount - 1) * PROCESS_RAIL_NODE_GAP + PROCESS_RAIL_NODE_FOOTPRINT;
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
  const allFootprints = computeOwnerFootprints(args.nodes, args.layout);
  const footprintByOwnerId = new Map(
    allFootprints.map((item) => [item.ownerId, item] as const)
  );
  const footprint = footprintByOwnerId.get(args.ownerId);
  if (!footprint) {
    return null;
  }

  const currentFrame = args.snapshot.memberSlotFrameByOwnerId.get(args.ownerId);
  if (!currentFrame) {
    return null;
  }

  const existingFrames = args.snapshot.memberSlotFrames.filter((frame) => frame.ownerId !== args.ownerId);
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
      }
    : null;
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
    const frameValidation = validateMemberSlotFrame(
      frame,
      snapshot,
      seenOwnerIds,
      seenAssignments
    );
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
    ['leadActivityRect', snapshot.leadActivityRect],
    ['launchHudRect', snapshot.launchHudRect],
    ['leadCentralReservedBlock', snapshot.leadCentralReservedBlock],
    ['runtimeCentralExclusion', snapshot.runtimeCentralExclusion],
    ['fitBounds', snapshot.fitBounds],
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
  if (!rectContainsRect(snapshot.leadCentralReservedBlock, snapshot.leadCoreRect)) {
    return { valid: false, reason: 'leadCoreRect must fit inside leadCentralReservedBlock' };
  }
  if (!rectContainsRect(snapshot.leadCentralReservedBlock, snapshot.leadActivityRect)) {
    return { valid: false, reason: 'leadActivityRect must fit inside leadCentralReservedBlock' };
  }
  if (!rectContainsRect(snapshot.leadCentralReservedBlock, snapshot.launchHudRect)) {
    return { valid: false, reason: 'launchHudRect must fit inside leadCentralReservedBlock' };
  }
  if (!rectContainsRect(snapshot.runtimeCentralExclusion, snapshot.leadCentralReservedBlock)) {
    return { valid: false, reason: 'runtimeCentralExclusion must contain leadCentralReservedBlock' };
  }
  if (
    snapshot.unassignedTaskRect &&
    !rectContainsRect(snapshot.runtimeCentralExclusion, snapshot.unassignedTaskRect)
  ) {
    return { valid: false, reason: 'runtimeCentralExclusion must contain unassignedTaskRect' };
  }

  return null;
}

function validateMemberSlotFrame(
  frame: SlotFrame,
  snapshot: StableSlotLayoutSnapshot,
  seenOwnerIds: Set<string>,
  seenAssignments: Set<string>
): StableSlotLayoutValidationResult | null {
  if (!isFiniteRect(frame.bounds)) {
    return { valid: false, reason: `slot frame for ${frame.ownerId} contains non-finite bounds` };
  }
  if (!Number.isFinite(frame.ownerX) || !Number.isFinite(frame.ownerY)) {
    return { valid: false, reason: `slot frame for ${frame.ownerId} contains non-finite anchor` };
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

  if (rectsOverlap(frame.bounds, snapshot.runtimeCentralExclusion)) {
    return { valid: false, reason: `slot frame for ${frame.ownerId} overlaps runtimeCentralExclusion` };
  }
  if (!rectContainsRect(frame.bounds, frame.boardBandRect)) {
    return { valid: false, reason: `boardBandRect escapes slot bounds for ${frame.ownerId}` };
  }
  if (!rectContainsRect(frame.bounds, frame.activityColumnRect)) {
    return { valid: false, reason: `activityColumnRect escapes slot bounds for ${frame.ownerId}` };
  }
  if (!rectContainsRect(frame.bounds, frame.processBandRect)) {
    return { valid: false, reason: `processBandRect escapes slot bounds for ${frame.ownerId}` };
  }
  if (!rectContainsRect(frame.bounds, frame.kanbanBandRect)) {
    return { valid: false, reason: `kanbanBandRect escapes slot bounds for ${frame.ownerId}` };
  }
  if (!rectContainsRect(frame.boardBandRect, frame.activityColumnRect)) {
    return {
      valid: false,
      reason: `activityColumnRect escapes boardBandRect for ${frame.ownerId}`,
    };
  }
  if (!rectContainsRect(frame.boardBandRect, frame.kanbanBandRect)) {
    return {
      valid: false,
      reason: `kanbanBandRect escapes boardBandRect for ${frame.ownerId}`,
    };
  }
  if (rectsOverlap(frame.activityColumnRect, frame.kanbanBandRect)) {
    return {
      valid: false,
      reason: `activityColumnRect overlaps kanbanBandRect for ${frame.ownerId}`,
    };
  }
  if (!pointInRect(frame.ownerX, frame.ownerY, frame.bounds)) {
    return { valid: false, reason: `owner anchor escapes slot bounds for ${frame.ownerId}` };
  }
  if (!rectContainsRect(snapshot.fitBounds, frame.bounds)) {
    return { valid: false, reason: `slot frame for ${frame.ownerId} escapes fitBounds` };
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
    nodes
      .filter((node) => node.kind === 'lead' || node.kind === 'member')
      .map((node) => node.id)
  );
  const unassignedTasks = nodes.filter(
    (node) =>
      node.kind === 'task' && (!node.ownerId || !visibleOwnerIds.has(node.ownerId))
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
  centralExclusion: StableRect,
  layout?: GraphLayoutPort
): SlotFrame[] {
  const placedFrames: SlotFrame[] = [];
  const preferredAssignments = buildPreferredAssignmentsMap(layout?.slotAssignments);
  const usedSlotKeys = new Set<string>();
  const ringStates = new Map<string, RingLayoutState>();
  const maxRingExclusive = computePlannerRingLimit(ownerFootprints, layout?.slotAssignments);

  for (const footprint of ownerFootprints) {
    const resolvedFrame = resolveOwnerSlotFrame({
      footprint,
      centralExclusion,
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
  centralExclusion: StableRect;
  ringStates: RingLayoutStateMap;
  preferredAssignment?: GraphOwnerSlotAssignment;
  usedSlotKeys: Set<string>;
  placedFrames: readonly SlotFrame[];
  maxRingExclusive: number;
}): SlotFrame {
  const {
    footprint,
    centralExclusion,
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
    centralExclusion,
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
    centralExclusion,
    ringStates,
    usedSlotKeys,
    placedFrames,
  });
  if (spilloverMatch) {
    return spilloverMatch;
  }

  return buildEmergencyFallbackSlotFrame({
    footprint,
    centralExclusion,
    ringStates,
    usedSlotKeys,
    placedOwnerCount: placedFrames.length,
    baseRingIndex: maxRingExclusive + ownerFootprintsSpillBudget(placedFrames.length),
  });
}

function buildSlotFrame(
  footprint: OwnerFootprint,
  assignment: GraphOwnerSlotAssignment,
  centralExclusion: StableRect,
  options: { ringStates: RingLayoutStateMap }
): SlotFrame | null {
  const vector = SECTOR_VECTORS[assignment.sectorIndex % SECTOR_VECTORS.length] ?? SECTOR_VECTORS[0];
  const radius = resolveRingRadiusForAssignment({
    assignment,
    footprint,
    centralExclusion,
    ringStates: options.ringStates,
  });
  if (radius == null) {
    return null;
  }
  const ownerX = vector.x * radius;
  const ownerY = vector.y * radius;
  const slotTop =
    ownerY - (SLOT_GEOMETRY.memberSlotInnerPadding + SLOT_GEOMETRY.ownerBandHeight / 2);
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
  const kanbanBandRect = createRect(
    activityColumnRect.right + SLOT_GEOMETRY.boardColumnGap,
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
  return Math.max(
    SLOT_GEOMETRY.maxGeneratedRings,
    maxAssignedRing + ownerFootprints.length + 2
  );
}

function ownerFootprintsSpillBudget(placedOwnerCount: number): number {
  return Math.max(6, placedOwnerCount + 2);
}

function buildEmergencyFallbackSlotFrame(args: {
  footprint: OwnerFootprint;
  centralExclusion: StableRect;
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
  const frame = buildSlotFrame(args.footprint, assignment, args.centralExclusion, {
    ringStates: args.ringStates,
  });
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
    runtimeCentralExclusion,
    ringStates,
    pointerX,
    pointerY,
  } = args;
  const frame = buildSlotFrame(footprint, assignment, runtimeCentralExclusion, {
    ringStates,
  });
  if (!frame) {
    return null;
  }

  if (occupiedFrame) {
    const displacedFrame = buildDisplacedFrameForNearestAssignment({
      occupiedFrame,
      footprintByOwnerId,
      currentFrame,
      runtimeCentralExclusion,
      ringStates,
    });
    if (!displacedFrame) {
      return null;
    }
    const otherFrames = existingFrames.filter((existing) => existing.ownerId !== occupiedFrame.ownerId);
    if (
      !isSlotFramePlacementValid(frame, otherFrames, runtimeCentralExclusion) ||
      !isSlotFramePlacementValid(displacedFrame, otherFrames, runtimeCentralExclusion) ||
      rectsOverlapWithGap(frame.bounds, displacedFrame.bounds, SLOT_GEOMETRY.ringPadding)
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

  if (!isSlotFramePlacementValid(frame, existingFrames, runtimeCentralExclusion)) {
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
    distanceSquared: dx * dx + dy * dy,
  };
}

function findFirstValidSlotFrame(args: {
  candidateAssignments: readonly GraphOwnerSlotAssignment[];
  footprint: OwnerFootprint;
  centralExclusion: StableRect;
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
    centralExclusion: StableRect;
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
  const frame = buildSlotFrame(args.footprint, assignment, args.centralExclusion, {
    ringStates: args.ringStates,
  });
  if (!frame) {
    return null;
  }
  if (!isSlotFramePlacementValid(frame, args.placedFrames, args.centralExclusion)) {
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
  centralExclusion: StableRect;
  ringStates: RingLayoutStateMap;
}): number | null {
  const vector =
    SECTOR_VECTORS[args.assignment.sectorIndex % SECTOR_VECTORS.length] ?? SECTOR_VECTORS[0];
  const minRadius = computeMinimumRingRadius(vector, args.footprint, args.centralExclusion);
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

function computeMinimumRingRadius(
  vector: { x: number; y: number },
  footprint: OwnerFootprint,
  centralExclusion: StableRect
): number {
  const horizontalExtent =
    vector.x >= 0 ? centralExclusion.right : Math.abs(centralExclusion.left);
  const verticalExtent = vector.y >= 0 ? centralExclusion.bottom : Math.abs(centralExclusion.top);
  const requiredX =
    Math.abs(vector.x) > 0.001
      ? (horizontalExtent + footprint.slotWidth / 2 + SLOT_GEOMETRY.ringPadding) / Math.abs(vector.x)
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

function rectsOverlapWithGap(a: StableRect, b: StableRect, gap: number): boolean {
  return (
    a.left - gap < b.right &&
    a.right + gap > b.left &&
    a.top - gap < b.bottom &&
    a.bottom + gap > b.top
  );
}

function rectsOverlap(a: StableRect, b: StableRect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function rectContainsRect(outer: StableRect, inner: StableRect): boolean {
  return (
    inner.left >= outer.left &&
    inner.right <= outer.right &&
    inner.top >= outer.top &&
    inner.bottom <= outer.bottom
  );
}

function pointInRect(x: number, y: number, rect: StableRect): boolean {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
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
  runtimeCentralExclusion: StableRect
): boolean {
  if (!isFiniteRect(frame.bounds)) {
    return false;
  }
  if (rectsOverlap(frame.bounds, runtimeCentralExclusion)) {
    return false;
  }
  return !existingFrames.some((existing) =>
    rectsOverlapWithGap(frame.bounds, existing.bounds, SLOT_GEOMETRY.ringPadding)
  );
}

function buildAssignmentKey(assignment: GraphOwnerSlotAssignment): string {
  return `${assignment.ringIndex}:${assignment.sectorIndex}`;
}

function isSameAssignment(
  left: GraphOwnerSlotAssignment | undefined,
  right: GraphOwnerSlotAssignment
): boolean {
  return (
    left?.ringIndex === right.ringIndex &&
    left?.sectorIndex === right.sectorIndex
  );
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

function createCenteredRect(centerX: number, centerY: number, width: number, height: number): StableRect {
  return createRect(centerX - width / 2, centerY - height / 2, width, height);
}

function padRect(rect: StableRect, padding: number): StableRect {
  return createRect(rect.left - padding, rect.top - padding, rect.width + padding * 2, rect.height + padding * 2);
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
