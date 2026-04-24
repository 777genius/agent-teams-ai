import type { FastMCP } from 'fastmcp';
import { z } from 'zod';

import { getController } from '../controller';
import { jsonTextContent } from '../utils/format';
import { assertConfiguredTeam } from '../utils/teamConfig';

const toolContextSchema = {
  teamName: z.string().min(1),
  claudeDir: z.string().min(1).optional(),
};

export function registerKanbanTools(server: Pick<FastMCP, 'addTool'>) {
  server.addTool({
    name: 'kanban_get',
    description: 'Get current kanban state',
    parameters: z.object({
      ...toolContextSchema,
    }),
    execute: async ({ teamName, claudeDir }) => {
      assertConfiguredTeam(teamName, claudeDir);
      return await Promise.resolve(jsonTextContent(getController(teamName, claudeDir).kanban.getKanbanState()));
    },
  });

  server.addTool({
    name: 'kanban_set_column',
    description:
      'Repair the kanban overlay for a task that is already in review or approved. Use review_request/review_approve for lifecycle transitions.',
    parameters: z.object({
      ...toolContextSchema,
      taskId: z.string().min(1),
      column: z.enum(['review', 'approved']),
    }),
    execute: async ({ teamName, claudeDir, taskId, column }) => {
      assertConfiguredTeam(teamName, claudeDir);
      return await Promise.resolve(
        jsonTextContent(getController(teamName, claudeDir).kanban.setKanbanColumn(taskId, column))
      );
    },
  });

  server.addTool({
    name: 'kanban_clear',
    description:
      'Repair-clear a stale non-review kanban overlay. Use review_request_changes, review_approve, task_start, or task_set_status for lifecycle transitions.',
    parameters: z.object({
      ...toolContextSchema,
      taskId: z.string().min(1),
    }),
    execute: async ({ teamName, claudeDir, taskId }) => {
      assertConfiguredTeam(teamName, claudeDir);
      return await Promise.resolve(jsonTextContent(getController(teamName, claudeDir).kanban.clearKanban(taskId)));
    },
  });

  server.addTool({
    name: 'kanban_list_reviewers',
    description: 'List configured review participants',
    parameters: z.object({
      ...toolContextSchema,
    }),
    execute: async ({ teamName, claudeDir }) => {
      assertConfiguredTeam(teamName, claudeDir);
      return await Promise.resolve(jsonTextContent(getController(teamName, claudeDir).kanban.listReviewers()));
    },
  });

  server.addTool({
    name: 'kanban_add_reviewer',
    description: 'Add a reviewer to kanban configuration',
    parameters: z.object({
      ...toolContextSchema,
      reviewer: z.string().min(1),
    }),
    execute: async ({ teamName, claudeDir, reviewer }) => {
      assertConfiguredTeam(teamName, claudeDir);
      return await Promise.resolve(jsonTextContent(getController(teamName, claudeDir).kanban.addReviewer(reviewer)));
    },
  });

  server.addTool({
    name: 'kanban_remove_reviewer',
    description: 'Remove reviewer from kanban configuration',
    parameters: z.object({
      ...toolContextSchema,
      reviewer: z.string().min(1),
    }),
    execute: async ({ teamName, claudeDir, reviewer }) => {
      assertConfiguredTeam(teamName, claudeDir);
      return await Promise.resolve(
        jsonTextContent(getController(teamName, claudeDir).kanban.removeReviewer(reviewer))
      );
    },
  });
}
