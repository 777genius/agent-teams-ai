import type { FastMCP } from 'fastmcp';

import { registerCrossTeamTools } from './crossTeamTools';
import { registerKanbanTools } from './kanbanTools';
import { registerMessageTools } from './messageTools';
import { registerProcessTools } from './processTools';
import { registerReviewTools } from './reviewTools';
import { registerRuntimeTools } from './runtimeTools';
import { registerTaskTools } from './taskTools';

export function registerTools(server: FastMCP) {
  registerTaskTools(server);
  registerKanbanTools(server);
  registerReviewTools(server);
  registerMessageTools(server);
  registerProcessTools(server);
  registerRuntimeTools(server);
  registerCrossTeamTools(server);
}
