import type { GraphNodeState } from './types';

/**
 * Configuration port — visual theme, filters, animation settings.
 * All fields optional — package provides sensible defaults.
 */
export interface GraphConfigPort {
  // ─── Theme ─────────────────────────────────────────────────────────────
  /** Background color (default: space dark #0a0f1a) */
  backgroundColor?: string;
  /** Whether to show hex grid on background */
  showHexGrid?: boolean;
  /** Whether to show depth star field */
  showStarField?: boolean;
  /** Bloom post-processing intensity (0 = off, 1 = default) */
  bloomIntensity?: number;

  // ─── Node Colors (overrides per state) ─────────────────────────────────
  nodeStateColors?: Partial<Record<GraphNodeState, string>>;
  /** Task status colors */
  taskStatusColors?: {
    pending?: string;
    in_progress?: string;
    completed?: string;
    deleted?: string;
  };
  /** Review state colors */
  reviewStateColors?: {
    review?: string;
    needsFix?: string;
    approved?: string;
  };

  // ─── Filters (show/hide node kinds) ────────────────────────────────────
  showTasks?: boolean;
  showProcesses?: boolean;
  showCompletedTasks?: boolean;
  showEdgeLabels?: boolean;

  // ─── Animation ─────────────────────────────────────────────────────────
  /** Animation enabled (default: true) */
  animationEnabled?: boolean;
  /** Particle speed multiplier (default: 1) */
  particleSpeed?: number;
  /** Breathing animation speed (default: 1) */
  breathingSpeed?: number;

  // ─── Force Layout ──────────────────────────────────────────────────────
  /** Charge strength (repulsion, default: -800) */
  chargeStrength?: number;
  /** Center attraction strength (default: 0.03) */
  centerStrength?: number;
  /** Task orbit radius around owner (default: 150) */
  taskOrbitRadius?: number;
}
