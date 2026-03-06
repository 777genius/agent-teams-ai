import { z } from 'zod';
import { UserError } from 'fastmcp';
import type { FastMCP } from 'fastmcp';
import type { ITeamctlRunner } from '../teamctl-runner.js';
import { parseOkOutput } from '../output-parser.js';
import { teamNameSchema, taskIdSchema, memberNameSchema } from '../schemas.js';

export function register(server: FastMCP, runner: ITeamctlRunner): void {
  server.addTool({
    name: 'task_set_owner',
    description: `Assign a task to a team member or clear the assignment.

Pass owner="clear" to unassign. Optionally sends an inbox notification to the new owner.`,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
    },
    parameters: z.object({
      team: teamNameSchema,
      task_id: taskIdSchema,
      owner: z.union([memberNameSchema, z.literal('clear')]).describe('Member name to assign, or "clear" to unassign'),
      notify: z.boolean().optional().describe('Send inbox notification to new owner'),
      from: memberNameSchema.optional().describe('Author name for notification'),
    }),
    execute: async (args) => {
      const cliArgs = ['--team', args.team, 'task', 'set-owner', args.task_id, args.owner];

      if (args.notify) cliArgs.push('--notify');
      if (args.from) cliArgs.push('--from', args.from);

      const result = await runner.execute(cliArgs);
      if (result.exitCode !== 0) {
        throw new UserError(`Failed to set owner: ${result.stderr.trim() || result.stdout.trim()}`);
      }
      return parseOkOutput(result.stdout);
    },
  });
}
