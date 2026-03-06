import { z } from 'zod';
import { UserError } from 'fastmcp';
import type { FastMCP } from 'fastmcp';
import type { ITeamctlRunner } from '../teamctl-runner.js';
import { parseJsonOutput } from '../output-parser.js';
import { teamNameSchema, taskIdSchema, memberNameSchema, filePathSchema, safeFilenameSchema, mimeTypeSchema } from '../schemas.js';

export function register(server: FastMCP, runner: ITeamctlRunner): void {
  server.addTool({
    name: 'task_attach',
    description: `Attach a file to a task. Returns attachment metadata JSON.

Supports copy (default) or hardlink mode. MIME type is auto-detected from file content (PNG, JPEG, GIF, WebP, PDF, ZIP) with fallback to application/octet-stream. Max file size: 20 MB.`,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
    },
    parameters: z.object({
      team: teamNameSchema,
      task_id: taskIdSchema,
      file: filePathSchema.describe('Absolute path to the file to attach'),
      filename: safeFilenameSchema.optional().describe('Override stored filename'),
      mime_type: mimeTypeSchema.optional().describe('Override MIME type (auto-detected by default)'),
      mode: z.enum(['copy', 'link']).optional().describe('Storage mode: copy (default) or hardlink'),
      from: memberNameSchema.optional().describe('Uploader name'),
    }),
    execute: async (args) => {
      const cliArgs = ['--team', args.team, 'task', 'attach', args.task_id, '--file', args.file];

      if (args.filename) cliArgs.push('--filename', args.filename);
      if (args.mime_type) cliArgs.push('--mime-type', args.mime_type);
      if (args.mode) cliArgs.push('--mode', args.mode);
      if (args.from) cliArgs.push('--from', args.from);

      const result = await runner.execute(cliArgs);
      if (result.exitCode !== 0) {
        throw new UserError(`Failed to attach file: ${result.stderr.trim() || result.stdout.trim()}`);
      }
      return parseJsonOutput(result.stdout);
    },
  });
}
