import { z } from 'zod';
import { UserError } from 'fastmcp';
import type { FastMCP } from 'fastmcp';
import type { ITeamctlRunner } from '../teamctl-runner.js';
import { parseJsonOutput } from '../output-parser.js';
import { teamNameSchema, taskIdSchema } from '../schemas.js';

export function register(server: FastMCP, runner: ITeamctlRunner): void {
  server.addTool({
    name: 'task_get',
    description: `Get a single task by its ID. Returns the full task JSON including status, owner, comments, dependencies, work intervals, and status history.`,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
    },
    parameters: z.object({
      team: teamNameSchema,
      task_id: taskIdSchema,
    }),
    execute: async (args) => {
      const cliArgs = ['--team', args.team, 'task', 'get', args.task_id];

      const result = await runner.execute(cliArgs);
      if (result.exitCode !== 0) {
        throw new UserError(`Failed to get task: ${result.stderr.trim() || result.stdout.trim()}`);
      }
      return parseJsonOutput(result.stdout);
    },
  });
}
