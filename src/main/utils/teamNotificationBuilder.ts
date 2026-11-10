/**
 * Team notification builder — creates DetectedError objects from team event payloads.
 *
 * Pure utility with no service dependencies. Used by NotificationManager.addTeamNotification()
 * to convert domain-level team payloads into the unified notification format.
 */

import { stripAgentBlocks } from '@shared/constants/agentBlocks';
import { randomUUID } from 'crypto';

import type { DetectedError } from '../services/error/ErrorMessageBuilder';
import type { TriggerColor } from '@shared/constants/triggerColors';
import type { NotificationTarget, TeamEventType } from '@shared/types/notifications';

// Re-export for callers that import TeamEventType from this module
export type { TeamEventType } from '@shared/types/notifications';

// =============================================================================
// Types
// =============================================================================

/**
 * Domain payload for team notifications.
 * Single source of truth — both storage and native presentation are derived from this.
 */
export interface TeamNotificationPayload {
  teamEventType: TeamEventType;
  teamName: string;
  teamDisplayName: string;
  from: string;
  to?: string;
  /** Optional team roster for resolving the same participant avatar shown in the UI. */
  members?: readonly {
    name: string;
    removedAt?: number | string | null;
    agentType?: string;
  }[];
  summary: string;
  body: string;
  /** Stable key for storage deduplication. REQUIRED — no fallback to Date.now(). */
  dedupeKey: string;
  /** Structured destination used by notification click handling. */
  target?: NotificationTarget;
  projectPath?: string;
  /**
   * When true, the notification is stored in-app but no native OS toast is shown.
   * Used when per-type toggle (e.g. notifyOnLeadInbox) is off — storage is unconditional,
   * but the user opted out of OS interruptions for this event type.
   */
  suppressToast?: boolean;
}

// =============================================================================
// Config mapping
// =============================================================================

interface TeamNotificationConfig {
  triggerName: string;
  triggerColor: TriggerColor;
}

const TEAM_NOTIFICATION_CONFIG: Record<TeamEventType, TeamNotificationConfig> = {
  rate_limit: { triggerName: 'Rate Limit', triggerColor: 'red' },
  api_error: { triggerName: 'API Error', triggerColor: 'red' },
  runtime_recovery: { triggerName: 'Agent Recovery', triggerColor: 'orange' },
  lead_inbox: { triggerName: 'Team Inbox', triggerColor: 'blue' },
  user_inbox: { triggerName: 'User Inbox', triggerColor: 'green' },
  task_clarification: { triggerName: 'Clarification', triggerColor: 'orange' },
  task_status_change: { triggerName: 'Status Change', triggerColor: 'purple' },
  task_comment: { triggerName: 'Task Comment', triggerColor: 'cyan' },
  task_review_requested: { triggerName: 'Review Requested', triggerColor: 'orange' },
  task_blocked: { triggerName: 'Task Blocked', triggerColor: 'red' },
  task_created: { triggerName: 'Task Created', triggerColor: 'green' },
  all_tasks_completed: { triggerName: 'All Done', triggerColor: 'green' },
  cross_team_message: { triggerName: 'Cross-Team', triggerColor: 'cyan' },
  schedule_completed: { triggerName: 'Schedule Done', triggerColor: 'green' },
  schedule_failed: { triggerName: 'Schedule Failed', triggerColor: 'red' },
  team_launched: { triggerName: 'Team Launched', triggerColor: 'green' },
  team_launch_incomplete: { triggerName: 'Launch Incomplete', triggerColor: 'orange' },
  usage_budget_warning: { triggerName: 'Usage Budget', triggerColor: 'orange' },
  usage_budget_exceeded: { triggerName: 'Usage Budget', triggerColor: 'red' },
};

// =============================================================================
// Builder
// =============================================================================

/**
 * Converts a team notification payload into a DetectedError for unified storage.
 * Uses `sessionId: 'team:{teamName}'` convention (established by rate-limit notifications).
 */
export function buildDetectedErrorFromTeam(payload: TeamNotificationPayload): DetectedError {
  const config = TEAM_NOTIFICATION_CONFIG[payload.teamEventType];
  const summary = stripAgentBlocks(payload.summary).replace(/\s+/g, ' ').trim();
  const body = stripAgentBlocks(payload.body).replace(/\s+/g, ' ').trim();
  const preview = summary && body ? `${summary}: ${body}` : summary || body;

  return {
    id: randomUUID(),
    timestamp: Date.now(),
    sessionId: `team:${payload.teamName}`,
    projectId: payload.teamName,
    filePath: '',
    source: payload.teamEventType,
    message: `[${payload.from}] ${preview.slice(0, 300)}`,
    category: 'team',
    teamEventType: payload.teamEventType,
    target: payload.target,
    dedupeKey: payload.dedupeKey,
    triggerColor: config.triggerColor,
    triggerName: config.triggerName,
    context: {
      projectName: payload.teamDisplayName,
      cwd: payload.projectPath,
    },
  };
}
