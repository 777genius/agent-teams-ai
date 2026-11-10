/**
 * Session state detection utilities for determining if sessions are ongoing.
 */

import { type ParsedMessage } from '../types';

/** Activity types for tracking session state */
type ActivityType =
  | 'text_output'
  | 'thinking'
  | 'tool_use'
  | 'tool_result'
  | 'interruption'
  | 'exit_plan_mode';

/** Activity entry with type and order index */
interface Activity {
  type: ActivityType;
  index: number;
}

/** Check if a toolUseResult value indicates a user-rejected tool use */
function isToolUseRejection(toolUseResult: unknown): boolean {
  return toolUseResult === 'User rejected tool use';
}

/** Check if a tool_use block is a SendMessage shutdown_response with approve: true */
function isShutdownResponse(block: { name?: string; input?: Record<string, unknown> }): boolean {
  return (
    block.name === 'SendMessage' &&
    block.input?.type === 'shutdown_response' &&
    block.input?.approve === true
  );
}

/**
 * Check if activities indicate an ongoing session.
 * Shared logic used by checkMessagesOngoing.
 *
 * @param activities - Array of tracked activities in order
 * @returns boolean - true if ongoing
 */
function isOngoingFromActivities(activities: Activity[]): boolean {
  if (activities.length === 0) {
    return false;
  }

  // Find the index of the last "ending" event (text_output, interruption, or exit_plan_mode)
  let lastEndingIndex = -1;
  for (let i = activities.length - 1; i >= 0; i--) {
    const actType = activities[i].type;
    if (actType === 'text_output' || actType === 'interruption' || actType === 'exit_plan_mode') {
      lastEndingIndex = activities[i].index;
      break;
    }
  }

  // If no ending event found, check if there's any AI activity at all
  if (lastEndingIndex === -1) {
    return activities.some(
      (a) => a.type === 'thinking' || a.type === 'tool_use' || a.type === 'tool_result'
    );
  }

  // Check if there are any AI activities AFTER the last ending event
  for (const activity of activities) {
    if (
      activity.index > lastEndingIndex &&
      (activity.type === 'thinking' ||
        activity.type === 'tool_use' ||
        activity.type === 'tool_result')
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Check if messages indicate an ongoing session (AI response in progress).
 *
 * A session is considered "ongoing" if there are AI-related activities
 * (thinking, tool_use, tool_result) AFTER the last "ending" event (text output or interruption).
 *
 * Special case: ExitPlanMode tool_use is treated as an ending event, not a continuation.
 * This is because ExitPlanMode signals the end of plan mode and contains the final plan content.
 *
 * This is the core logic shared between session files and subagent messages.
 *
 * @param messages - Array of ParsedMessage to check
 * @returns boolean - true if ongoing
 */
export function checkMessagesOngoing(messages: ParsedMessage[]): boolean {
  const activities: Activity[] = [];
  let activityIndex = 0;
  // Track tool_use IDs that are shutdown responses so their tool_results are also ending events
  const shutdownToolIds = new Set<string>();

  for (const msg of messages) {
    if (msg.type === 'assistant' && Array.isArray(msg.content)) {
      // Process assistant message content blocks
      for (const block of msg.content) {
        if (block.type === 'thinking' && block.thinking) {
          activities.push({ type: 'thinking', index: activityIndex++ });
        } else if (block.type === 'tool_use' && block.id) {
          // ExitPlanMode is a special ending tool - treat it like an ending event
          if (block.name === 'ExitPlanMode') {
            activities.push({ type: 'exit_plan_mode', index: activityIndex++ });
          } else if (isShutdownResponse(block)) {
            // SendMessage shutdown_response = agent is shutting down (ending event)
            shutdownToolIds.add(block.id);
            activities.push({ type: 'interruption', index: activityIndex++ });
          } else {
            activities.push({ type: 'tool_use', index: activityIndex++ });
          }
        } else if (block.type === 'text' && block.text && String(block.text).trim().length > 0) {
          activities.push({ type: 'text_output', index: activityIndex++ });
        }
      }
    } else if (msg.type === 'user' && Array.isArray(msg.content)) {
      // Check if this is a user-rejected tool use (ending event, not ongoing activity)
      const isRejection = isToolUseRejection(msg.toolUseResult);

      // Check for tool results and interruptions in internal user messages
      for (const block of msg.content) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          if (shutdownToolIds.has(block.tool_use_id)) {
            // Shutdown tool result = ending event
            activities.push({ type: 'interruption', index: activityIndex++ });
          } else if (isRejection) {
            // User rejection = ending event (like interruption)
            activities.push({ type: 'interruption', index: activityIndex++ });
          } else {
            activities.push({ type: 'tool_result', index: activityIndex++ });
          }
        }
        // Check for interruption message - this ends the session
        if (
          block.type === 'text' &&
          typeof block.text === 'string' &&
          block.text.startsWith('[Request interrupted by user')
        ) {
          activities.push({ type: 'interruption', index: activityIndex++ });
        }
      }
    }
  }

  return isOngoingFromActivities(activities);
}
