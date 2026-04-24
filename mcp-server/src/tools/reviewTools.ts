import type { FastMCP } from 'fastmcp';
import { z } from 'zod';

import { getController } from '../controller';
import { jsonTextContent, slimTask } from '../utils/format';
import { assertConfiguredTeam } from '../utils/teamConfig';

const toolContextSchema = {
  teamName: z.string().min(1),
  claudeDir: z.string().min(1).optional(),
};

export function registerReviewTools(server: Pick<FastMCP, 'addTool'>) {
  server.addTool({
    name: 'review_request',
    description: 'Move a completed task into review and notify reviewer',
    parameters: z.object({
      ...toolContextSchema,
      taskId: z.string().min(1),
      from: z.string().optional(),
      reviewer: z.string().optional(),
      leadSessionId: z.string().optional(),
    }),
    execute: async ({ teamName, claudeDir, taskId, from, reviewer, leadSessionId }) => {
      assertConfiguredTeam(teamName, claudeDir);
      return await Promise.resolve(
        jsonTextContent(
          slimTask(
            getController(teamName, claudeDir).review.requestReview(taskId, {
              ...(from ? { from } : {}),
              ...(reviewer ? { reviewer } : {}),
              ...(leadSessionId ? { leadSessionId } : {}),
            }) as Record<string, unknown>
          )
        )
      );
    },
  });

  server.addTool({
    name: 'review_start',
    description: 'Signal that reviewer is beginning to review a task (moves to REVIEW column)',
    parameters: z.object({
      ...toolContextSchema,
      taskId: z.string().min(1),
      from: z.string().optional(),
    }),
    execute: async ({ teamName, claudeDir, taskId, from }) => {
      assertConfiguredTeam(teamName, claudeDir);
      return await Promise.resolve(
        jsonTextContent(
          getController(teamName, claudeDir).review.startReview(taskId, {
            ...(from ? { from } : {}),
          }) as Record<string, unknown>
        )
      );
    },
  });

  server.addTool({
    name: 'review_approve',
    description: 'Approve task review and move kanban state accordingly',
    parameters: z.object({
      ...toolContextSchema,
      taskId: z.string().min(1),
      from: z.string().optional(),
      note: z.string().optional(),
      notifyOwner: z.boolean().optional(),
      leadSessionId: z.string().optional(),
    }),
    execute: async ({ teamName, claudeDir, taskId, from, note, notifyOwner, leadSessionId }) => {
      assertConfiguredTeam(teamName, claudeDir);
      return await Promise.resolve(
        jsonTextContent(
          slimTask(
            getController(teamName, claudeDir).review.approveReview(taskId, {
              ...(from ? { from } : {}),
              ...(note ? { note } : {}),
              ...(notifyOwner === true ? { 'notify-owner': true } : {}),
              ...(leadSessionId ? { leadSessionId } : {}),
            }) as Record<string, unknown>
          )
        )
      );
    },
  });

  server.addTool({
    name: 'review_request_changes',
    description: 'Request changes on a task under review',
    parameters: z.object({
      ...toolContextSchema,
      taskId: z.string().min(1),
      from: z.string().optional(),
      comment: z.string().optional(),
      leadSessionId: z.string().optional(),
    }),
    execute: async ({ teamName, claudeDir, taskId, from, comment, leadSessionId }) => {
      assertConfiguredTeam(teamName, claudeDir);
      return await Promise.resolve(
        jsonTextContent(
          slimTask(
            getController(teamName, claudeDir).review.requestChanges(taskId, {
              ...(from ? { from } : {}),
              ...(comment ? { comment } : {}),
              ...(leadSessionId ? { leadSessionId } : {}),
            }) as Record<string, unknown>
          )
        )
      );
    },
  });
}
