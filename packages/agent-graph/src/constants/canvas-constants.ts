/**
 * Canvas rendering constants for the agent graph visualization.
 * Adapted from agent-flow's canvas-constants.ts (Apache 2.0).
 * Stripped of unused features (tool cards, discoveries, cost overlays, bubbles).
 */

// ─── Visibility threshold ───────────────────────────────────────────────────

export const MIN_VISIBLE_OPACITY = 0.05;

// ─── Animation speed multipliers (× deltaTime) ─────────────────────────────

export const ANIM_SPEED = {
  agentFadeIn: 3,
  agentScaleIn: 4,
  agentFadeOut: 0.4,
  agentScaleOut: 0.05,
  edgeFadeIn: 4,
  particleSpeed: 1.2,
  maxDeltaTime: 0.1,
  defaultDeltaTime: 0.016,
  /** Task pill fade in/out */
  taskFadeIn: 3,
  taskFadeOut: 0.6,
} as const;

// ─── Camera / interaction ───────────────────────────────────────────────────

export const CAMERA = {
  zoomStepDown: 0.92,
  zoomStepUp: 1.08,
  minZoom: 0.15,
  maxZoom: 5,
  velocityScale: 0.016,
} as const;

// ─── Force simulation ───────────────────────────────────────────────────────

export const FORCE = {
  chargeStrength: -800,
  centerStrength: 0.03,
  collideRadius: 100,
  linkDistance: {
    'parent-child': 500,
    ownership: 150,
    blocking: 200,
    related: 200,
    message: 300,
  },
  linkStrength: 0.4,
  alphaDecay: 0.02,
  velocityDecay: 0.4,
} as const;

// ─── Node sizes ─────────────────────────────────────────────────────────────

export const NODE = {
  /** Lead agent radius */
  radiusLead: 32,
  /** Team member radius */
  radiusMember: 24,
  /** Process node radius */
  radiusProcess: 14,
  /** Cross-team ghost node radius */
  radiusCrossTeam: 20,
} as const;

// ─── Task pill dimensions ───────────────────────────────────────────────────

export const TASK_PILL = {
  width: 160,
  height: 36,
  borderRadius: 6,
  statusDotRadius: 4,
  statusDotX: 12,
  /** Font size for display ID */
  idFontSize: 9,
  /** Font size for subject text */
  subjectFontSize: 7,
  /** Max chars for subject before truncation */
  subjectMaxChars: 18,
  /** X offset for text content */
  textOffsetX: 20,
} as const;

// ─── Agent drawing constants ────────────────────────────────────────────────

export const AGENT_DRAW = {
  glowPadding: 20,
  outerRingOffset: 3,
  shadowBlur: 15,
  shadowOffsetX: 3,
  shadowOffsetY: 5,
  labelYOffset: 8,
  labelWidthMultiplier: 3,
  scanlineHalfH: 4,
  waitingDashSpeed: 25,
  orbitParticleOffset: 12,
  orbitParticleSize: 1.5,
  rippleInnerOffset: 5,
  rippleMaxExpand: 45,
  rippleMaxAlpha: 0.4,
  waitingOrbitOffset: 14,
  waitingOrbitParticleSize: 2,
  waitingOrbitSpeed: 0.8,
  waitingBreatheSpeed: 1.2,
  waitingBreatheAmp: 0.08,
  sparkScale: 0.45,
  sparkViewBox: 256,
  subIconScale: 0.45,
} as const;

// ─── Context ring (lead node only) ─────────────────────────────────────────

export const CONTEXT_RING = {
  ringOffset: 8,
  ringWidth: 4,
  warningThreshold: 0.8,
  criticalThreshold: 0.9,
  percentLabelThreshold: 0.7,
  glowPadding: 4,
  glowLineWidth: 2,
  glowBlur: 12,
  percentYOffset: 10,
} as const;

// ─── Edge/beam drawing ──────────────────────────────────────────────────────

export const BEAM = {
  curvature: 0.15,
  cp1: 0.33,
  cp2: 0.66,
  segments: 16,
  parentChild: { startW: 3, endW: 1 },
  ownership: { startW: 2, endW: 0.8 },
  blocking: { startW: 2, endW: 1.5 },
  related: { startW: 1, endW: 0.5 },
  message: { startW: 1.5, endW: 0.5 },
  glowExtra: { startW: 3, endW: 1, alpha: 0.08 },
  idleAlpha: 0.08,
  activeAlpha: 0.3,
  wobble: { amp: 3, freq: 10, timeFreq: 3, trailOffset: 0.15 },
} as const;

// ─── Animation constants ────────────────────────────────────────────────────

export const ANIM = {
  inertiaDecay: 0.94,
  inertiaThreshold: 0.5,
  dragLerp: 0.25,
  autoFitLerp: 0.06,
  dragThresholdPx: 5,
  viewportPadding: 120,
  breathe: {
    activeSpeed: 2,
    activeAmp: 0.03,
    idleSpeed: 0.7,
    idleAmp: 0.015,
  },
  scanline: { active: 40, normal: 15 },
  orbitSpeed: 1.5,
  pulseSpeed: 4,
} as const;

// ─── Visual effects ─────────────────────────────────────────────────────────

export const FX = {
  spawnDuration: 0.8,
  completeDuration: 1.0,
  shatterDuration: 0.8,
  shatterCount: 12,
  shatterSpeed: { min: 30, range: 60 },
  shatterSize: { min: 1, range: 2 },
  trailSegments: 8,
} as const;

export const SPAWN_FX = {
  ringStart: 10,
  ringExpand: 60,
  maxAlpha: 0.7,
  flashThreshold: 0.3,
  flashAlpha: 0.6,
  flashBaseRadius: 20,
  flashMinRadius: 5,
  particleCount: 8,
  particleSize: 1.5,
} as const;

export const COMPLETE_FX = {
  ringStart: 20,
  ringExpand: 80,
  maxAlpha: 0.6,
  flashThreshold: 0.2,
  flashAlpha: 0.8,
  flashRadius: 30,
  lineWidthMax: 3,
  glowInner: 5,
  glowOuter: 10,
} as const;

// ─── Particle drawing ───────────────────────────────────────────────────────

export const PARTICLE_DRAW = {
  glowRadius: 15,
  coreHighlightScale: 0.4,
  labelMinT: 0.2,
  labelMaxT: 0.8,
  labelFontSize: 8,
  labelYOffset: -12,
  /** Seconds a particle lives before fading */
  lifetime: 2.0,
} as const;

export const HANDOFF_CARD = {
  triggerProgress: 0.58,
  lingerSeconds: 3.2,
  fadeInSeconds: 0.14,
  fadeOutSeconds: 0.35,
  width: 196,
  maxVisible: 6,
  maxPerDestination: 2,
  baseHeight: 42,
  previewLineHeight: 10,
  previewMaxLines: 2,
  previewMaxWidth: 176,
  badgeGap: 8,
  stackGap: 10,
  viewportPadding: 12,
  anchorGap: 14,
} as const;

// ─── Hit detection ──────────────────────────────────────────────────────────

export const HIT_DETECTION = {
  /** Extra padding around nodes for easier clicking */
  agentPadding: 8,
  /** Task pill hit area padding */
  taskPadding: 4,
  /** Extra padding around curved edges for easier inspection */
  edgePadding: 6,
} as const;

// ─── Background ─────────────────────────────────────────────────────────────

export const BACKGROUND = {
  /** Number of depth particles (stars) */
  starCount: 320,
  /** Hex grid cell size */
  hexSize: 30,
  /** Hex grid max alpha */
  hexAlpha: 0.08,
  /** Hex grid pulse speed */
  hexPulseSpeed: 0.3,
} as const;

// ─── Kanban zone layout ─────────────────────────────────────────────────────

export const KANBAN_ZONE = {
  /** Column width: pill (160) + gap (20) */
  columnWidth: 180,
  /** Row height: pill (36) + gap (10) */
  rowHeight: 46,
  /** Zone starts this far below member node center */
  offsetY: 70,
  /** Column order: todo → wip → done → review → approved */
  columns: ['todo', 'wip', 'done', 'review', 'approved'] as const,
  /** Max tasks shown per column (overflow hidden) */
  maxVisibleRows: 6,
} as const;
