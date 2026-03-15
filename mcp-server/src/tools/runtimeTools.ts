import type { FastMCP } from 'fastmcp';
import { z } from 'zod';

import { getController } from '../controller';
import { jsonTextContent } from '../utils/format';

const toolContextSchema = {
  teamName: z.string().min(1),
  claudeDir: z.string().min(1).optional(),
  controlUrl: z.string().url().optional(),
  waitTimeoutMs: z.number().int().min(1000).max(600000).optional(),
};

export function registerRuntimeTools(server: Pick<FastMCP, 'addTool'>) {
  server.addTool({
    name: 'team_launch',
    description: 'Launch a provisioned team via the desktop runtime',
    parameters: z.object({
      ...toolContextSchema,
      cwd: z.string().min(1),
      prompt: z.string().min(1).optional(),
      model: z.string().min(1).optional(),
      effort: z.enum(['low', 'medium', 'high']).optional(),
      clearContext: z.boolean().optional(),
      skipPermissions: z.boolean().optional(),
      worktree: z.string().min(1).optional(),
      extraCliArgs: z.string().min(1).optional(),
      waitForReady: z.boolean().optional(),
    }),
    execute: async ({
      teamName,
      claudeDir,
      controlUrl,
      waitTimeoutMs,
      cwd,
      prompt,
      model,
      effort,
      clearContext,
      skipPermissions,
      worktree,
      extraCliArgs,
      waitForReady,
    }) =>
      jsonTextContent(
        await getController(teamName, claudeDir).runtime.launchTeam({
          cwd,
          ...(prompt ? { prompt } : {}),
          ...(model ? { model } : {}),
          ...(effort ? { effort } : {}),
          ...(clearContext !== undefined ? { clearContext } : {}),
          ...(skipPermissions !== undefined ? { skipPermissions } : {}),
          ...(worktree ? { worktree } : {}),
          ...(extraCliArgs ? { extraCliArgs } : {}),
          ...(controlUrl ? { controlUrl } : {}),
          ...(waitTimeoutMs ? { waitTimeoutMs } : {}),
          ...(waitForReady !== undefined ? { waitForReady } : {}),
        })
      ),
  });

  server.addTool({
    name: 'team_stop',
    description: 'Stop a running team via the desktop runtime',
    parameters: z.object({
      ...toolContextSchema,
      waitForStop: z.boolean().optional(),
    }),
    execute: async ({ teamName, claudeDir, controlUrl, waitTimeoutMs, waitForStop }) =>
      jsonTextContent(
        await getController(teamName, claudeDir).runtime.stopTeam({
          ...(controlUrl ? { controlUrl } : {}),
          ...(waitTimeoutMs ? { waitTimeoutMs } : {}),
          ...(waitForStop !== undefined ? { waitForStop } : {}),
        })
      ),
  });
}
