import { z } from 'zod';
import { UserError } from 'fastmcp';
import type { FastMCP } from 'fastmcp';
import type { ITeamctlRunner } from '../teamctl-runner.js';
import { parseJsonOutput } from '../output-parser.js';
import { teamNameSchema } from '../schemas.js';

export function register(server: FastMCP, runner: ITeamctlRunner): void {
  server.addTool({
    name: 'task_list',
    description: `List all tasks for a team. Returns a JSON array of task objects.

Note: includes internal bookkeeping tasks (metadata._internal). Filter client-side if needed.`,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
    },
    parameters: z.object({
      team: teamNameSchema,
    }),
    execute: async (args) => {
      const cliArgs = ['--team', args.team, 'task', 'list'];

      const result = await runner.execute(cliArgs);
      if (result.exitCode !== 0) {
        throw new UserError(`Failed to list tasks: ${result.stderr.trim() || result.stdout.trim()}`);
      }
      return parseJsonOutput(result.stdout);
    },
  });
}
