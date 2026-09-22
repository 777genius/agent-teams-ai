const AGENT_TEAMS_TEAM_TOOL_NAMES = ['team_list', 'team_get', 'team_create'];

const AGENT_TEAMS_TASK_TOOL_NAMES = [
  'member_briefing',
  'task_add_comment',
  'task_attach_comment_file',
  'task_attach_file',
  'task_briefing',
  'task_complete',
  'task_create',
  'task_create_from_message',
  'task_get',
  'task_get_comment',
  'task_link',
  'task_list',
  'task_restore',
  'task_set_clarification',
  'task_set_owner',
  'task_set_status',
  'task_start',
  'task_unlink',
];

const AGENT_TEAMS_LEAD_TOOL_NAMES = ['lead_briefing'];

const AGENT_TEAMS_REVIEW_TOOL_NAMES = [
  'review_approve',
  'review_request',
  'review_request_changes',
  'review_start',
];

const AGENT_TEAMS_MESSAGE_TOOL_NAMES = ['message_send'];

const AGENT_TEAMS_CROSS_TEAM_TOOL_NAMES = [
  'cross_team_get_outbox',
  'cross_team_list_targets',
  'cross_team_send',
];

const AGENT_TEAMS_PROCESS_TOOL_NAMES = [
  'process_list',
  'process_register',
  'process_stop',
  'process_unregister',
];

const AGENT_TEAMS_KANBAN_TOOL_NAMES = [
  'kanban_add_reviewer',
  'kanban_clear',
  'kanban_get',
  'kanban_list_reviewers',
  'kanban_remove_reviewer',
  'kanban_set_column',
];

const AGENT_TEAMS_RUNTIME_TOOL_NAMES = [
  'team_launch',
  'team_stop',
  'runtime_bootstrap_checkin',
  'runtime_deliver_message',
  'runtime_task_event',
  'runtime_heartbeat',
];

const AGENT_TEAMS_WORK_SYNC_TOOL_NAMES = ['member_work_sync_status', 'member_work_sync_report'];

const AGENT_TEAMS_MCP_TOOL_GROUPS = [
  {
    id: 'team',
    teammateOperational: false,
    toolNames: AGENT_TEAMS_TEAM_TOOL_NAMES,
  },
  {
    id: 'task',
    teammateOperational: true,
    toolNames: AGENT_TEAMS_TASK_TOOL_NAMES,
  },
  {
    id: 'lead',
    teammateOperational: false,
    toolNames: AGENT_TEAMS_LEAD_TOOL_NAMES,
  },
  {
    id: 'kanban',
    teammateOperational: false,
    toolNames: AGENT_TEAMS_KANBAN_TOOL_NAMES,
  },
  {
    id: 'review',
    teammateOperational: true,
    toolNames: AGENT_TEAMS_REVIEW_TOOL_NAMES,
  },
  {
    id: 'message',
    teammateOperational: true,
    toolNames: AGENT_TEAMS_MESSAGE_TOOL_NAMES,
  },
  {
    id: 'process',
    teammateOperational: true,
    toolNames: AGENT_TEAMS_PROCESS_TOOL_NAMES,
  },
  {
    id: 'runtime',
    teammateOperational: false,
    toolNames: AGENT_TEAMS_RUNTIME_TOOL_NAMES,
  },
  {
    id: 'workSync',
    teammateOperational: true,
    toolNames: AGENT_TEAMS_WORK_SYNC_TOOL_NAMES,
  },
  {
    id: 'crossTeam',
    teammateOperational: true,
    toolNames: AGENT_TEAMS_CROSS_TEAM_TOOL_NAMES,
  },
];

const AGENT_TEAMS_REGISTERED_TOOL_NAMES = AGENT_TEAMS_MCP_TOOL_GROUPS.flatMap((group) => [
  ...group.toolNames,
]);

const AGENT_TEAMS_TEAMMATE_OPERATIONAL_TOOL_NAMES = AGENT_TEAMS_MCP_TOOL_GROUPS.filter(
  (group) => group.teammateOperational
).flatMap((group) => [...group.toolNames]);

const AGENT_TEAMS_NAMESPACED_TEAMMATE_OPERATIONAL_TOOL_NAMES =
  AGENT_TEAMS_TEAMMATE_OPERATIONAL_TOOL_NAMES.map((toolName) => `mcp__agent-teams__${toolName}`);

const AGENT_TEAMS_LEAD_BOOTSTRAP_TOOL_NAMES = [
  ...AGENT_TEAMS_TEAMMATE_OPERATIONAL_TOOL_NAMES,
  ...AGENT_TEAMS_LEAD_TOOL_NAMES,
];

const AGENT_TEAMS_NAMESPACED_LEAD_BOOTSTRAP_TOOL_NAMES = AGENT_TEAMS_LEAD_BOOTSTRAP_TOOL_NAMES.map(
  (toolName) => `mcp__agent-teams__${toolName}`
);

module.exports = {
  AGENT_TEAMS_TEAM_TOOL_NAMES,
  AGENT_TEAMS_TASK_TOOL_NAMES,
  AGENT_TEAMS_LEAD_TOOL_NAMES,
  AGENT_TEAMS_REVIEW_TOOL_NAMES,
  AGENT_TEAMS_MESSAGE_TOOL_NAMES,
  AGENT_TEAMS_CROSS_TEAM_TOOL_NAMES,
  AGENT_TEAMS_PROCESS_TOOL_NAMES,
  AGENT_TEAMS_KANBAN_TOOL_NAMES,
  AGENT_TEAMS_RUNTIME_TOOL_NAMES,
  AGENT_TEAMS_WORK_SYNC_TOOL_NAMES,
  AGENT_TEAMS_MCP_TOOL_GROUPS,
  AGENT_TEAMS_REGISTERED_TOOL_NAMES,
  AGENT_TEAMS_TEAMMATE_OPERATIONAL_TOOL_NAMES,
  AGENT_TEAMS_NAMESPACED_TEAMMATE_OPERATIONAL_TOOL_NAMES,
  AGENT_TEAMS_LEAD_BOOTSTRAP_TOOL_NAMES,
  AGENT_TEAMS_NAMESPACED_LEAD_BOOTSTRAP_TOOL_NAMES,
};
