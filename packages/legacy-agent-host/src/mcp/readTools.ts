import { z } from "zod";
import { defineTool } from "./toolDefinition.js";
import type { BoundTool } from "./toolDefinition.js";
import type { TeamMcpConnection } from "./contracts.js";

const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);
const name = z.string().min(1).max(128);
export const taskInventorySchema = z.strictObject({
  owner: name.optional(),
  status: z.enum(["pending", "in_progress", "completed"]).optional(),
  reviewState: z.enum(["none", "review", "needsFix", "approved"]).optional(),
  kanbanColumn: z.enum(["review", "approved"]).optional(),
  relatedTo: id.optional(),
  blockedBy: id.optional(),
  limit: z.number().int().min(1).max(200).optional(),
});

/** Current bound Team only. No tool argument selects owner, root, actor or Runtime. */
export function createReadMcpTools(
  reads: NonNullable<TeamMcpConnection["readQueries"]>,
): BoundTool[] {
  const empty = z.strictObject({});
  return [
    ...(reads.memberBriefing
      ? [
          {
            ...defineTool(
              'member_briefing',
              'Read durable member rules and current canonical Task queue as this authenticated actor.',
              z.strictObject({ includeActiveProcesses: z.boolean().optional() }),
              ({ includeActiveProcesses }) =>
                reads.memberBriefing!({ includeActiveProcesses: includeActiveProcesses !== false }),
              false
            ),
            asynchronous: true as const,
          },
        ]
      : []),
    defineTool(
      "team_get",
      "Read a bounded page of this captured Team snapshot. Pass nextCursor as cursor to continue.",
      z.strictObject({
        cursor: z.string().regex(/^[1-9][0-9]{0,8}\.[a-f0-9]{64}$/).optional(),
      }),
      ({ cursor }) => reads.getTeam(cursor),
      false,
    ),
    defineTool(
      "kanban_get",
      "Read canonical board state for this captured Team.",
      empty,
      () => reads.getKanbanState(),
      false,
    ),
    defineTool(
      "kanban_list_reviewers",
      "Read the canonical configured review roster.",
      empty,
      () => reads.listReviewers(),
      false,
    ),
    defineTool(
      "task_get_comment",
      "Read one canonical comment and its Task context.",
      z.strictObject({ taskId: id, commentId: id }),
      ({ taskId, commentId }) => reads.getTaskComment(taskId, commentId),
      false,
    ),
    defineTool(
      "task_list",
      "Read compact canonical active inventory with conjunctive filters; use task_briefing for the working queue.",
      taskInventorySchema,
      (input) =>
        reads.listTaskInventory({
          ...Object.fromEntries(
            Object.entries(input).filter(([, value]) => value !== undefined),
          ),
          limit: input.limit ?? 50,
        }),
      false,
    ),
    {
      ...defineTool(
        "task_briefing",
        "Read the canonical operational Task queue. memberName is a configured read target; omitted uses the captured actor.",
        z.strictObject({ memberName: id.optional() }),
        ({ memberName }) => reads.taskBriefing(memberName),
        false,
      ),
      asynchronous: true,
    },
    {
      ...defineTool(
        "lead_briefing",
        "Read the canonical operational lead queue, not native context or transcript metrics.",
        empty,
        () => reads.leadBriefing(),
        false,
      ),
      asynchronous: true,
    },
  ];
}
