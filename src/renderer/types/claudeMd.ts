/**
 * Type definitions for CLAUDE.md injection tracking.
 * Tracks system context injections from various sources throughout the session.
 */

// =============================================================================
// Source Types
// =============================================================================

/**
 * Source types for CLAUDE.md injections.
 * - enterprise: Enterprise-level configuration
 * - user-memory: User's global memory settings (~/.claude/CLAUDE.md)
 * - project-memory: Project-level memory
 * - project-rules: Project rules configuration
 * - project-local: Local project CLAUDE.md (checked into codebase)
 * - directory: Directory-specific CLAUDE.md files
 */
export type ClaudeMdSource =
  | 'enterprise'
  | 'user-memory'
  | 'user-rules'
  | 'auto-memory'
  | 'project-memory'
  | 'project-rules'
  | 'project-local'
  | 'directory';

// =============================================================================
// Injection Types
// =============================================================================

/**
 * Represents a single CLAUDE.md injection detected in the session.
 */
export interface ClaudeMdInjection {
  /** Unique identifier for this injection */
  id: string;
  /** File path of the CLAUDE.md source */
  path: string;
  /** Source type categorization */
  source: ClaudeMdSource;
  /** Human-readable display name */
  displayName: string;
  /** Whether this is a global (user-level) injection */
  isGlobal: boolean;
  /** Estimated token count (chars / 4) */
  estimatedTokens: number;
  /** ID of the AI group where this injection was first seen */
  firstSeenInGroup: string;
}

// =============================================================================
// Statistics Types
// =============================================================================

/**
 * Statistics about CLAUDE.md injections for an AI group.
 * Tracks both new injections in the current group and accumulated totals.
 */
export interface ClaudeMdStats {
  /** Injections that are new in THIS group */
  newInjections: ClaudeMdInjection[];
  /** All injections accumulated up to and including this group */
  accumulatedInjections: ClaudeMdInjection[];
  /** Total estimated tokens from all accumulated injections */
  totalEstimatedTokens: number;
  /** Percentage of context window used (vs input tokens) */
  percentageOfContext: number;
  /** Count of new injections in this group */
  newCount: number;
  /** Total count of accumulated injections */
  accumulatedCount: number;
}
