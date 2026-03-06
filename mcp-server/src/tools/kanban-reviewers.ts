import { z } from 'zod';
import { UserError } from 'fastmcp';
import type { FastMCP } from 'fastmcp';
import type { ITeamctlRunner } from '../teamctl-runner.js';
import { parseJsonOutput, parseOkOutput } from '../output-parser.js';
import { teamNameSchema, memberNameSchema, reviewerOperationSchema } from '../schemas.js';

export function register(server: FastMCP, runner: ITeamctlRunner): void {
  server.addTool({
    name: 'kanban_reviewers',
    description: `Manage the kanban board's reviewer list.

Operations:
- "list": returns JSON array of reviewer names
- "add": adds a reviewer (name required)
- "remove": removes a reviewer (name required)`,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
    },
    parameters: z.object({
      team: teamNameSchema,
      operation: reviewerOperationSchema.describe('"list", "add", or "remove"'),
      name: memberNameSchema.optional().describe('Reviewer name (required for add/remove)'),
    }),
    execute: async (args) => {
      if (args.operation !== 'list' && !args.name) {
        throw new UserError(`name is required for "${args.operation}" operation`);
      }

      const cliArgs = ['--team', args.team, 'kanban', 'reviewers', args.operation];
      if (args.name) cliArgs.push(args.name);

      const result = await runner.execute(cliArgs);
      if (result.exitCode !== 0) {
        throw new UserError(`Failed to manage reviewers: ${result.stderr.trim() || result.stdout.trim()}`);
      }

      // "list" returns JSON array, "add"/"remove" return "OK ..." text
      if (args.operation === 'list') {
        return parseJsonOutput(result.stdout);
      }
      return parseOkOutput(result.stdout);
    },
  });
}
