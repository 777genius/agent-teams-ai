/**
 * Visualization-specific types for Agent Teams AI.
 *
 * These types are used for waterfall chart visualization
 * and are shared between main and renderer processes.
 */

import type { TokenUsage } from '@main/types';

// =============================================================================
// Waterfall Chart Types
// =============================================================================

/**
 * Waterfall item for visualization.
 */
export interface WaterfallItem {
  /** Unique item identifier */
  id: string;
  /** Display label */
  label: string;
  /** Item start time */
  startTime: Date;
  /** Item end time */
  endTime: Date;
  /** Duration in milliseconds */
  durationMs: number;
  /** Token usage for this item */
  tokenUsage: TokenUsage;
  /** Hierarchy depth (0 = main session) */
  level: number;
  /** Item type */
  type: 'chunk' | 'subagent' | 'tool';
  /** Whether executed in parallel */
  isParallel: boolean;
  /** Parent item ID */
  parentId?: string;
  /** Group ID for parallel items */
  groupId?: string;
  /** Additional metadata for display */
  metadata?: {
    subagentType?: string;
    toolName?: string;
    messageCount?: number;
  };
}

/**
 * Complete waterfall chart data.
 */
export interface WaterfallData {
  /** All waterfall items */
  items: WaterfallItem[];
  /** Earliest timestamp in the session */
  minTime: Date;
  /** Latest timestamp in the session */
  maxTime: Date;
  /** Total session duration in milliseconds */
  totalDurationMs: number;
}
