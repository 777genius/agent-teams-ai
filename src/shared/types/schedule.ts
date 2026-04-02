/**
 * Schedule types — shared between main and renderer processes.
 *
 * Supports automatic cron-based execution of Claude tasks (one-shot `claude -p` mode).
 * Repository Pattern abstraction allows swapping storage backend (JSON → sql.js/Drizzle).
 */

import type { EffortLevel, TeamProviderId } from './team';

// =============================================================================
// Schedule Status Types
// =============================================================================

export type ScheduleStatus = 'active' | 'paused' | 'disabled';

export type ScheduleRunStatus =
  | 'pending'
  | 'warming_up'
  | 'warm'
  | 'running'
  | 'completed'
  | 'failed'
  | 'failed_interrupted'
  | 'cancelled';

// =============================================================================
// Core Entities
// =============================================================================

export interface Schedule {
  id: string;
  teamName: string;
  label?: string;
  cronExpression: string;
  timezone: string;
  status: ScheduleStatus;
  warmUpMinutes: number;
  maxConsecutiveFailures: number;
  consecutiveFailures: number;
  maxTurns: number;
  maxBudgetUsd?: number;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  nextRunAt?: string;
  launchConfig: ScheduleLaunchConfig;
}

export interface ScheduleLaunchConfig {
  cwd: string;
  prompt: string;
  providerId?: TeamProviderId;
  model?: string;
  effort?: EffortLevel;
  skipPermissions?: boolean;
  allowedTools?: string[];
  disallowedTools?: string[];
}

export interface ScheduleRun {
  id: string;
  scheduleId: string;
  teamName: string;
  status: ScheduleRunStatus;
  scheduledFor: string;
  startedAt: string;
  warmUpCompletedAt?: string;
  executionStartedAt?: string;
  completedAt?: string;
  durationMs?: number;
  exitCode?: number | null;
  error?: string;
  retryCount: number;
  /** First ~500 chars of stdout for quick UI display */
  summary?: string;
}

// =============================================================================
// Events
// =============================================================================

export type ScheduleChangeType =
  | 'schedule-updated'
  | 'run-started'
  | 'run-completed'
  | 'run-failed'
  | 'schedule-paused';

export interface ScheduleChangeEvent {
  type: ScheduleChangeType;
  scheduleId: string;
  teamName: string;
  detail?: string;
}

// =============================================================================
// API Input/Patch Types
// =============================================================================

export interface CreateScheduleInput {
  teamName: string;
  label?: string;
  cronExpression: string;
  timezone: string;
  warmUpMinutes?: number;
  maxTurns?: number;
  maxBudgetUsd?: number;
  launchConfig: ScheduleLaunchConfig;
}

export interface UpdateSchedulePatch {
  label?: string;
  cronExpression?: string;
  timezone?: string;
  warmUpMinutes?: number;
  maxTurns?: number;
  maxBudgetUsd?: number;
  launchConfig?: Partial<ScheduleLaunchConfig>;
}
