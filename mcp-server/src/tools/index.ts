import type { FastMCP } from 'fastmcp';
import type { ITeamctlRunner } from '../teamctl-runner.js';

import { register as taskCreate } from './task-create.js';
import { register as taskSetStatus } from './task-set-status.js';
import { register as taskSetOwner } from './task-set-owner.js';
import { register as taskGet } from './task-get.js';
import { register as taskList } from './task-list.js';
import { register as taskComment } from './task-comment.js';
import { register as taskLink } from './task-link.js';
import { register as taskBriefing } from './task-briefing.js';
import { register as taskAttach } from './task-attach.js';
import { register as kanbanMove } from './kanban-move.js';
import { register as kanbanReviewers } from './kanban-reviewers.js';
import { register as reviewAction } from './review-action.js';
import { register as messageSend } from './message-send.js';

const ALL_TOOLS = [
  taskCreate,
  taskSetStatus,
  taskSetOwner,
  taskGet,
  taskList,
  taskComment,
  taskLink,
  taskBriefing,
  taskAttach,
  kanbanMove,
  kanbanReviewers,
  reviewAction,
  messageSend,
] as const;

/**
 * Register all 13 MCP tools with the server.
 * Each tool wraps a teamctl CLI command via the runner.
 */
export function registerAllTools(server: FastMCP, runner: ITeamctlRunner): void {
  for (const register of ALL_TOOLS) {
    register(server, runner);
  }
}
