import { z } from 'zod';
import { UserError } from 'fastmcp';
import type { FastMCP } from 'fastmcp';
import type { ITeamctlRunner } from '../teamctl-runner.js';
import { parseJsonOutput } from '../output-parser.js';
import { teamNameSchema, memberNameSchema, taskIdsArraySchema } from '../schemas.js';

export function register(server: FastMCP, runner: ITeamctlRunner): void {
  server.addTool({
    name: 'task_create',
    description: `Create a new task in a team's task board. Returns the created task JSON.

Behavior:
- If owner is set and no blockers → status defaults to "in_progress"
- If blocked_by specified → status defaults to "pending" (even with owner)
- If notify is true, sends an inbox notification to the assigned owner`,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
    },
    parameters: z.object({
      team: teamNameSchema,
      subject: z.string().min(1).max(500).describe('Task title'),
      description: z.string().max(5000).optional().describe('Detailed task description'),
      owner: memberNameSchema.optional().describe('Assign to a team member'),
      blocked_by: taskIdsArraySchema.optional().describe('Task IDs that block this task'),
      related: taskIdsArraySchema.optional().describe('Related (non-blocking) task IDs'),
      status: z.enum(['pending', 'in_progress']).optional().describe('Initial status override'),
      active_form: z.string().max(200).optional().describe('Active form hint for CLI display'),
      notify: z.boolean().optional().describe('Send inbox notification to owner'),
      from: memberNameSchema.optional().describe('Author name for notifications'),
    }),
    execute: async (args) => {
      const cliArgs = ['--team', args.team, 'task', 'create', '--subject', args.subject];

      if (args.description) cliArgs.push('--description', args.description);
      if (args.owner) cliArgs.push('--owner', args.owner);
      if (args.blocked_by?.length) cliArgs.push('--blocked-by', args.blocked_by.join(','));
      if (args.related?.length) cliArgs.push('--related', args.related.join(','));
      if (args.status) cliArgs.push('--status', args.status);
      if (args.active_form) cliArgs.push('--activeForm', args.active_form);
      if (args.notify) cliArgs.push('--notify');
      if (args.from) cliArgs.push('--from', args.from);

      const result = await runner.execute(cliArgs);
      if (result.exitCode !== 0) {
        throw new UserError(`Failed to create task: ${result.stderr.trim() || result.stdout.trim()}`);
      }
      return parseJsonOutput(result.stdout);
    },
  });
}
