import { z } from 'zod';
import { UserError } from 'fastmcp';
import type { FastMCP } from 'fastmcp';
import type { ITeamctlRunner } from '../teamctl-runner.js';
import { parseOkOutput } from '../output-parser.js';
import { teamNameSchema, taskIdSchema, memberNameSchema } from '../schemas.js';

export function register(server: FastMCP, runner: ITeamctlRunner): void {
  server.addTool({
    name: 'task_comment',
    description: `Add a comment to a task. Sends an inbox notification to the task owner (unless the commenter is the owner).`,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
    },
    parameters: z.object({
      team: teamNameSchema,
      task_id: taskIdSchema,
      text: z.string().min(1).max(10000).describe('Comment text'),
      from: memberNameSchema.optional().describe('Author name (skips self-notification)'),
    }),
    execute: async (args) => {
      const cliArgs = ['--team', args.team, 'task', 'comment', args.task_id, '--text', args.text];

      if (args.from) cliArgs.push('--from', args.from);

      const result = await runner.execute(cliArgs);
      if (result.exitCode !== 0) {
        throw new UserError(`Failed to add comment: ${result.stderr.trim() || result.stdout.trim()}`);
      }
      return parseOkOutput(result.stdout);
    },
  });
}
