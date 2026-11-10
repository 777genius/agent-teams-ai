import { canonicalizeAgentTeamsToolName } from '../../agentTeamsToolNames';

const HISTORICAL_BOARD_LIFECYCLE_TOOL_NAMES = new Set([
  'task_complete',
  'task_set_status',
  'task_start',
  'review_approve',
  'review_request_changes',
  'review_start',
]);

const HISTORICAL_BOARD_ACTION_TOOL_NAMES = new Set([
  'review_request',
  'task_add_comment',
  'task_attach_comment_file',
  'task_attach_file',
  'task_get',
  'task_get_comment',
  'task_link',
  'task_set_clarification',
  'task_set_owner',
  'task_unlink',
]);

const READ_ONLY_BOARD_TOOL_NAMES = new Set(['task_get', 'task_get_comment']);

export function canonicalizeBoardTaskLogToolName(toolName: string | undefined): string | null {
  if (!toolName) return null;
  const normalized = canonicalizeAgentTeamsToolName(toolName).trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

export function isBoardTaskLogMcpToolName(toolName: string | undefined): boolean {
  const canonical = canonicalizeBoardTaskLogToolName(toolName);
  return (
    canonical !== null &&
    (HISTORICAL_BOARD_LIFECYCLE_TOOL_NAMES.has(canonical) ||
      HISTORICAL_BOARD_ACTION_TOOL_NAMES.has(canonical))
  );
}

export function isReadOnlyBoardTaskLogToolName(toolName: string | undefined): boolean {
  const canonical = canonicalizeBoardTaskLogToolName(toolName);
  return canonical !== null && READ_ONLY_BOARD_TOOL_NAMES.has(canonical);
}

export function isRecoverableHistoricalBoardTaskLogToolName(toolName: string | undefined): boolean {
  return isBoardTaskLogMcpToolName(toolName);
}
