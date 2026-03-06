import { z } from 'zod';
import { UserError } from 'fastmcp';
import type { FastMCP } from 'fastmcp';
import type { ITeamctlRunner } from '../teamctl-runner.js';
import { parseOkOutput } from '../output-parser.js';
import {
  teamNameSchema,
  taskIdSchema,
  linkTypeSchema,
  linkOperationSchema,
} from '../schemas.js';

export function register(server: FastMCP, runner: ITeamctlRunner): void {
  server.addTool({
    name: 'task_link',
    description: `Link or unlink task dependencies.

Relationship types:
- "blocked-by": this task is blocked by the target
- "blocks": this task blocks the target
- "related": non-blocking relationship

Links are bidirectional: linking A blocked-by B also sets B blocks A.
Circular dependencies are detected and rejected.`,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
    },
    parameters: z.object({
      team: teamNameSchema,
      task_id: taskIdSchema,
      operation: linkOperationSchema.describe('"link" to add, "unlink" to remove'),
      relationship: linkTypeSchema,
      target_id: taskIdSchema.describe('The other task ID to link/unlink'),
    }),
    execute: async (args) => {
      const cliArgs = [
        '--team', args.team,
        'task', args.operation,
        args.task_id,
        `--${args.relationship}`, args.target_id,
      ];

      const result = await runner.execute(cliArgs);
      if (result.exitCode !== 0) {
        throw new UserError(`Failed to ${args.operation} tasks: ${result.stderr.trim() || result.stdout.trim()}`);
      }
      return parseOkOutput(result.stdout);
    },
  });
}
