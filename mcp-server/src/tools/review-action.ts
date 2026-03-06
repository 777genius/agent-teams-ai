import { z } from 'zod';
import { UserError } from 'fastmcp';
import type { FastMCP } from 'fastmcp';
import type { ITeamctlRunner } from '../teamctl-runner.js';
import { parseOkOutput } from '../output-parser.js';
import { teamNameSchema, taskIdSchema, memberNameSchema, reviewDecisionSchema } from '../schemas.js';

export function register(server: FastMCP, runner: ITeamctlRunner): void {
  server.addTool({
    name: 'review_action',
    description: `Approve a task or request changes.

- "approve": marks the task as approved in kanban, optionally posts a review comment
- "request-changes": removes from kanban, resets status to "in_progress", notifies the task owner with the change request comment`,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
    },
    parameters: z.object({
      team: teamNameSchema,
      task_id: taskIdSchema,
      decision: reviewDecisionSchema.describe('"approve" or "request-changes"'),
      comment: z.string().max(5000).optional().describe('Review comment (required for request-changes)'),
      from: memberNameSchema.optional().describe('Reviewer name'),
      notify_owner: z.boolean().optional().describe('Notify the task owner (for approve)'),
    }),
    execute: async (args) => {
      if (args.decision === 'request-changes' && !args.comment) {
        throw new UserError('comment is required when requesting changes');
      }

      const cliArgs = ['--team', args.team, 'review', args.decision, args.task_id];

      // approve uses --note for optional comment; request-changes uses --comment
      if (args.decision === 'request-changes' && args.comment) {
        cliArgs.push('--comment', args.comment);
      } else if (args.decision === 'approve' && args.comment) {
        cliArgs.push('--note', args.comment);
      }
      if (args.from) cliArgs.push('--from', args.from);
      if (args.notify_owner) cliArgs.push('--notify-owner');

      const result = await runner.execute(cliArgs);
      if (result.exitCode !== 0) {
        throw new UserError(`Failed to ${args.decision}: ${result.stderr.trim() || result.stdout.trim()}`);
      }
      return parseOkOutput(result.stdout);
    },
  });
}
