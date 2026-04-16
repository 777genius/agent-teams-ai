export const STABLE_SLOT_GEOMETRY = {
  slotVerticalGap: 24,
  slotHorizontalGap: 32,
  ringGap: 140,
  centralSafetyPadding: 48,
  memberSlotInnerPadding: 16,
  centralBlockGap: 56,
  ringPadding: 32,
  unassignedGap: 72,
  maxGeneratedRings: 12,
  ownerCollisionPadding: 28,
  ownerBandHeight: 96,
  ownerMinWidth: 200,
  processBandHeight: 32,
  processRailWidth: 220,
  taskMaxVisibleRows: 5,
} as const;

export const STABLE_SLOT_SECTOR_VECTORS = [
  { x: 0, y: -1 },
  { x: 0.82, y: -0.57 },
  { x: 0.82, y: 0.57 },
  { x: 0, y: 1 },
  { x: -0.82, y: 0.57 },
  { x: -0.82, y: -0.57 },
] as const;

export interface StableSlotNodeMetrics {
  radiusLead: number;
  radiusMember: number;
}

export interface StableSlotZoomRange {
  minZoom: number;
  maxZoom: number;
}

export interface StableSlotActivityLane {
  width: number;
  itemHeight: number;
  rowHeight: number;
  maxVisibleItems: number;
  headerHeight: number;
  overflowHeight: number;
  horizontalGapLead: number;
  horizontalGapMember: number;
  ownerClearanceLead: number;
  ownerClearanceMember: number;
  viewportPadding: number;
  visiblePadding: number;
  minScale: number;
  maxScale: number;
}

export interface StableSlotActivityAnchorLayout {
  reservedWidth: number;
  reservedHeight: number;
  memberOffsetX: number;
  memberOffsetY: number;
  leadOffsetX: number;
  leadOffsetY: number;
  collisionRadius: number;
}

export interface StableSlotLaunchAnchorLayout {
  compactWidth: number;
  compactHeight: number;
  anchorCenterOffsetX: number;
  anchorCenterOffsetY: number;
  collisionRadius: number;
  viewportPadding: number;
  visiblePadding: number;
  minScale: number;
  maxScale: number;
}

const ACTIVITY_LANE_BASE = {
  width: 296,
  itemHeight: 72,
  rowHeight: 80,
  maxVisibleItems: 3,
  headerHeight: 20,
  overflowHeight: 32,
  horizontalGapLead: 76,
  horizontalGapMember: 84,
  ownerClearanceLead: 92,
  ownerClearanceMember: 104,
  viewportPadding: 12,
  visiblePadding: 80,
} as const;

const LAUNCH_HUD_BASE = {
  compactWidth: 336,
  compactHeight: 132,
  horizontalGap: 40,
  verticalClearance: 36,
  viewportPadding: 12,
  visiblePadding: 80,
  minScale: 0,
  maxScale: 1,
} as const;

export function createStableSlotActivityLane(args: {
  nodeMetrics: StableSlotNodeMetrics;
  zoomRange: StableSlotZoomRange;
}): {
  lane: StableSlotActivityLane;
  anchor: StableSlotActivityAnchorLayout;
} {
  const { nodeMetrics, zoomRange } = args;
  const lane: StableSlotActivityLane = {
    ...ACTIVITY_LANE_BASE,
    minScale: zoomRange.minZoom,
    maxScale: zoomRange.maxZoom,
  };
  const reservedHeight =
    lane.headerHeight +
    lane.maxVisibleItems * lane.rowHeight +
    lane.overflowHeight;

  return {
    lane,
    anchor: {
      reservedWidth: lane.width,
      reservedHeight,
      memberOffsetX: lane.width / 2 + nodeMetrics.radiusMember + lane.horizontalGapMember,
      memberOffsetY: -(reservedHeight + nodeMetrics.radiusMember + lane.ownerClearanceMember),
      leadOffsetX: -(lane.width / 2 + nodeMetrics.radiusLead + lane.horizontalGapLead),
      leadOffsetY: -(reservedHeight + nodeMetrics.radiusLead + lane.ownerClearanceLead),
      collisionRadius: Math.ceil(Math.hypot(lane.width / 2, reservedHeight / 2)) + 56,
    },
  };
}

export function createStableSlotLaunchAnchorLayout(
  nodeMetrics: Pick<StableSlotNodeMetrics, 'radiusLead'>
): StableSlotLaunchAnchorLayout {
  const { radiusLead } = nodeMetrics;
  return {
    compactWidth: LAUNCH_HUD_BASE.compactWidth,
    compactHeight: LAUNCH_HUD_BASE.compactHeight,
    anchorCenterOffsetX:
      LAUNCH_HUD_BASE.compactWidth / 2 + radiusLead + LAUNCH_HUD_BASE.horizontalGap,
    anchorCenterOffsetY:
      -(LAUNCH_HUD_BASE.compactHeight / 2 + radiusLead + LAUNCH_HUD_BASE.verticalClearance),
    collisionRadius:
      Math.ceil(
        Math.hypot(
          LAUNCH_HUD_BASE.compactWidth / 2,
          LAUNCH_HUD_BASE.compactHeight / 2
        )
      ) + 14,
    viewportPadding: LAUNCH_HUD_BASE.viewportPadding,
    visiblePadding: LAUNCH_HUD_BASE.visiblePadding,
    minScale: LAUNCH_HUD_BASE.minScale,
    maxScale: LAUNCH_HUD_BASE.maxScale,
  };
}
