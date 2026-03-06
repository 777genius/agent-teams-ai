import { z } from 'zod';
import { UserError } from 'fastmcp';
import type { FastMCP } from 'fastmcp';
import type { ITeamctlRunner } from '../teamctl-runner.js';
import { parseTextOutput } from '../output-parser.js';
import { teamNameSchema, memberNameSchema } from '../schemas.js';

export function register(server: FastMCP, runner: ITeamctlRunner): void {
  server.addTool({
    name: 'task_briefing',
    description: `Generate a text briefing for a team member showing their assigned tasks vs the team board.

Returns a human-readable multi-line report. Automatically filters out internal bookkeeping tasks.`,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
    },
    parameters: z.object({
      team: teamNameSchema,
      member: memberNameSchema.describe('Member name to generate briefing for'),
    }),
    execute: async (args) => {
      const cliArgs = ['--team', args.team, 'task', 'briefing', '--for', args.member];

      const result = await runner.execute(cliArgs);
      if (result.exitCode !== 0) {
        throw new UserError(`Failed to get briefing: ${result.stderr.trim() || result.stdout.trim()}`);
      }
      return parseTextOutput(result.stdout);
    },
  });
}
