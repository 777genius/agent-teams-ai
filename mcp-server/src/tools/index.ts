import type { FastMCP } from 'fastmcp';

import agentTeamsControllerModule from 'agent-teams-controller';

const { AGENT_TEAMS_MCP_TOOL_GROUPS, AGENT_TEAMS_REGISTERED_TOOL_NAMES } =
  agentTeamsControllerModule;

import { registerCrossTeamTools } from './crossTeamTools';
import { registerKanbanTools } from './kanbanTools';
import { registerLeadTools } from './leadTools';
import { registerMessageTools } from './messageTools';
import { registerProcessTools } from './processTools';
import { registerReviewTools } from './reviewTools';
import { registerRuntimeTools } from './runtimeTools';
import { registerTaskTools } from './taskTools';
import { registerTeamTools } from './teamTools';
import { registerWorkSyncTools } from './workSyncTools';
import {
  isHostedAgentToolMode,
  isPersonalHostTrustedProcess,
  type HostedAgentToolAdmissionOptions,
} from './hostedAgentToolAdmission';

const HOSTED_ADMITTED_TOOL_NAMES = new Set([
  'task_get',
  'task_start',
  'task_add_comment',
  'task_complete',
  'message_send',
]);

// These groups call the team control API, which the personal-host deployment does
// not expose to agents. team_get reads the team files there instead.
const CONTROL_API_GROUP_IDS = new Set(['team', 'runtime', 'workSync']);
const PERSONAL_HOST_LOCAL_TOOL_NAMES = new Set(['team_get']);
const PERSONAL_HOST_UNAVAILABLE_TOOL_NAMES = new Set(
  AGENT_TEAMS_MCP_TOOL_GROUPS.filter((group) => CONTROL_API_GROUP_IDS.has(group.id))
    .flatMap((group) => [...group.toolNames])
    .filter((name) => !PERSONAL_HOST_LOCAL_TOOL_NAMES.has(name))
);

const REGISTRATION_BY_GROUP = {
  team: registerTeamTools,
  task: registerTaskTools,
  lead: registerLeadTools,
  kanban: registerKanbanTools,
  review: registerReviewTools,
  message: registerMessageTools,
  process: registerProcessTools,
  runtime: registerRuntimeTools,
  workSync: registerWorkSyncTools,
  crossTeam: registerCrossTeamTools,
} as const;

export const AGENT_TEAMS_MCP_REGISTRATION_GROUPS = AGENT_TEAMS_MCP_TOOL_GROUPS.map((group) => ({
  ...group,
  register: REGISTRATION_BY_GROUP[group.id as keyof typeof REGISTRATION_BY_GROUP],
}));

export { AGENT_TEAMS_REGISTERED_TOOL_NAMES };

export function registerTools(
  server: FastMCP,
  hostedAdmission: HostedAgentToolAdmissionOptions = {}
) {
  // Every tool goes through this registration boundary. Until a particular
  // operation has an authenticated Hosted admission policy, it cannot bypass
  // the member guard through an alternate task, review, kanban or runtime tool.
  const guardedServer = {
    addTool(tool: Parameters<FastMCP['addTool']>[0]) {
      server.addTool({
        ...tool,
        execute: async (args, context) => {
          if (isHostedAgentToolMode(hostedAdmission) && !HOSTED_ADMITTED_TOOL_NAMES.has(tool.name)) {
            throw new Error(`Hosted MCP tool ${tool.name} denied: admission policy unavailable`);
          }
          if (
            PERSONAL_HOST_UNAVAILABLE_TOOL_NAMES.has(tool.name) &&
            isPersonalHostTrustedProcess()
          ) {
            throw new Error(
              `Agent Teams tool ${tool.name} is unavailable here: it needs the team control API, which this deployment does not expose to agents. Use the task board and message tools instead.`
            );
          }
          return tool.execute(args, context);
        },
      });
    },
  } as FastMCP;
  for (const group of AGENT_TEAMS_MCP_REGISTRATION_GROUPS) {
    if (group.id === 'task') {
      registerTaskTools(guardedServer, hostedAdmission);
      continue;
    }
    if (group.id === 'message') {
      registerMessageTools(guardedServer, hostedAdmission);
      continue;
    }
    group.register(guardedServer);
  }
}
