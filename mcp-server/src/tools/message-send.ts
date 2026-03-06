import { z } from 'zod';
import { UserError } from 'fastmcp';
import type { FastMCP } from 'fastmcp';
import type { ITeamctlRunner } from '../teamctl-runner.js';
import { parseJsonOutput } from '../output-parser.js';
import { teamNameSchema, memberNameSchema } from '../schemas.js';

export function register(server: FastMCP, runner: ITeamctlRunner): void {
  server.addTool({
    name: 'message_send',
    description: `Send an inbox message to a team member. Returns delivery confirmation JSON.

Messages appear in the member's inbox and can trigger notifications.
The "source" field is automatically stripped for security — external callers cannot impersonate system notifications.`,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
    },
    parameters: z.object({
      team: teamNameSchema,
      to: memberNameSchema.describe('Recipient member name'),
      text: z.string().min(1).max(10000).describe('Message text'),
      summary: z.string().max(200).optional().describe('Short summary for notification preview'),
      from: memberNameSchema.optional().describe('Sender name'),
    }),
    execute: async (args) => {
      const cliArgs = ['--team', args.team, 'message', 'send', '--to', args.to, '--text', args.text];

      if (args.summary) cliArgs.push('--summary', args.summary);
      if (args.from) cliArgs.push('--from', args.from);

      const result = await runner.execute(cliArgs);
      if (result.exitCode !== 0) {
        throw new UserError(`Failed to send message: ${result.stderr.trim() || result.stdout.trim()}`);
      }
      return parseJsonOutput(result.stdout);
    },
  });
}
