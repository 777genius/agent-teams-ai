import { z } from 'zod';
import { UserError } from 'fastmcp';
import type { FastMCP } from 'fastmcp';
import type { ITeamctlRunner } from '../teamctl-runner.js';
import { parseOkOutput } from '../output-parser.js';
import { teamNameSchema, taskIdSchema, taskStatusSchema } from '../schemas.js';

export function register(server: FastMCP, runner: ITeamctlRunner): void {
  server.addTool({
    name: 'task_set_status',
    description: `Change the status of a task.

Valid transitions: pending → in_progress → completed → deleted (and back).
Shortcuts: status "in_progress" is equivalent to "task start", "completed" to "task complete".
Records status history and tracks work intervals (time spent in_progress).`,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
    },
    parameters: z.object({
      team: teamNameSchema,
      task_id: taskIdSchema,
      status: taskStatusSchema.describe('New status for the task'),
    }),
    execute: async (args) => {
      const cliArgs = ['--team', args.team, 'task', 'set-status', args.task_id, args.status];

      const result = await runner.execute(cliArgs);
      if (result.exitCode !== 0) {
        throw new UserError(`Failed to set status: ${result.stderr.trim() || result.stdout.trim()}`);
      }
      return parseOkOutput(result.stdout);
    },
  });
}
