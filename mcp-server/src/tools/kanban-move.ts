import { z } from 'zod';
import { UserError } from 'fastmcp';
import type { FastMCP } from 'fastmcp';
import type { ITeamctlRunner } from '../teamctl-runner.js';
import { parseOkOutput } from '../output-parser.js';
import { teamNameSchema, taskIdSchema, kanbanColumnSchema } from '../schemas.js';

export function register(server: FastMCP, runner: ITeamctlRunner): void {
  server.addTool({
    name: 'kanban_move',
    description: `Move a task to a kanban column or clear it from the kanban board.

Columns: "review" (awaiting code review) or "approved" (review passed).
Use operation "clear" to remove a task from the kanban board (returns to status-based display).
Moving to a kanban column also sets the task status to "completed".`,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
    },
    parameters: z.object({
      team: teamNameSchema,
      task_id: taskIdSchema,
      operation: z.enum(['set-column', 'clear']).describe('"set-column" to move, "clear" to remove from kanban'),
      column: kanbanColumnSchema.optional().describe('Target column (required for set-column)'),
    }),
    execute: async (args) => {
      let cliArgs: string[];

      if (args.operation === 'set-column') {
        if (!args.column) {
          throw new UserError('column is required when operation is "set-column"');
        }
        cliArgs = ['--team', args.team, 'kanban', 'set-column', args.task_id, args.column];
      } else {
        cliArgs = ['--team', args.team, 'kanban', 'clear', args.task_id];
      }

      const result = await runner.execute(cliArgs);
      if (result.exitCode !== 0) {
        throw new UserError(`Failed to update kanban: ${result.stderr.trim() || result.stdout.trim()}`);
      }
      return parseOkOutput(result.stdout);
    },
  });
}
