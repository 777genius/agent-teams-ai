/**
 * Team notification builder — creates DetectedError objects from team event payloads.
 *
 * Pure utility with no service dependencies. Used by NotificationManager.addTeamNotification()
 * to convert domain-level team payloads into the unified notification format.
 */

import { randomUUID } from 'crypto';

import type { DetectedError } from '../services/error/ErrorMessageBuilder';
import type { TriggerColor } from '@shared/constants/triggerColors';

// =============================================================================
// Types
// =============================================================================

export type TeamEventType =
  | 'rate_limit'
  | 'lead_inbox'
  | 'user_inbox'
  | 'task_clarification'
  | 'task_status_change'
  | 'schedule_completed'
  | 'schedule_failed';

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
  summary: string;
  body: string;
  /** Stable key for storage deduplication. REQUIRED — no fallback to Date.now(). */
  dedupeKey: string;
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
  lead_inbox: { triggerName: 'Team Inbox', triggerColor: 'blue' },
  user_inbox: { triggerName: 'User Inbox', triggerColor: 'green' },
  task_clarification: { triggerName: 'Clarification', triggerColor: 'orange' },
  task_status_change: { triggerName: 'Status Change', triggerColor: 'purple' },
  schedule_completed: { triggerName: 'Schedule Done', triggerColor: 'green' },
  schedule_failed: { triggerName: 'Schedule Failed', triggerColor: 'red' },
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

  return {
    id: randomUUID(),
    timestamp: Date.now(),
    sessionId: `team:${payload.teamName}`,
    projectId: payload.teamName,
    filePath: '',
    source: payload.teamEventType,
    message: `[${payload.from}] ${payload.body.slice(0, 300)}`,
    category: 'team',
    teamEventType: payload.teamEventType,
    dedupeKey: payload.dedupeKey,
    triggerColor: config.triggerColor,
    triggerName: config.triggerName,
    context: {
      projectName: payload.teamDisplayName,
      cwd: payload.projectPath,
    },
  };
}
