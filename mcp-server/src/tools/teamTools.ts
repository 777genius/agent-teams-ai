import type { FastMCP } from 'fastmcp';
import { z } from 'zod';

import { getController } from '../controller';
import { jsonTextContent } from '../utils/format';
import { teamMemberMcpPolicySchema } from '../utils/schemas';

const controlContextSchema = {
  claudeDir: z.string().min(1).optional(),
  controlUrl: z.string().optional(),
  waitTimeoutMs: z.number().int().min(1000).max(600000).optional(),
};

const teamContextSchema = {
  ...controlContextSchema,
  teamName: z.string().min(1),
};

const providerIdSchema = z.enum(['anthropic', 'codex', 'gemini', 'opencode']);
const effortSchema = z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const fastModeSchema = z.enum(['inherit', 'on', 'off']);

const memberSchema = z.object({
  name: z.string().min(1),
  role: z.string().optional(),
  workflow: z.string().optional(),
  isolation: z.literal('worktree').optional(),
  providerId: providerIdSchema.optional(),
  providerBackendId: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  effort: effortSchema.optional(),
  fastMode: fastModeSchema.optional(),
  mcpPolicy: teamMemberMcpPolicySchema.optional(),
});

function controlFlags(args: {
  controlUrl?: string;
  waitTimeoutMs?: number;
}): Record<string, unknown> {
  return {
    ...(args.controlUrl ? { controlUrl: args.controlUrl } : {}),
    ...(args.waitTimeoutMs ? { waitTimeoutMs: args.waitTimeoutMs } : {}),
  };
}

export function registerTeamTools(server: Pick<FastMCP, 'addTool'>) {
  server.addTool({
    name: 'team_list',
    description: 'List teams through the local Agent Teams control API',
    parameters: z.object({
      ...controlContextSchema,
    }),
    execute: async ({ claudeDir, controlUrl, waitTimeoutMs }) => {
      return jsonTextContent(
        await getController('agent-teams-control', claudeDir).runtime.listTeams(
          controlFlags({ controlUrl, waitTimeoutMs })
        )
      );
    },
  });

  server.addTool({
    name: 'team_get',
    description: 'Get a team snapshot through the local Agent Teams control API',
    parameters: z.object({
      ...teamContextSchema,
    }),
    execute: async ({ teamName, claudeDir, controlUrl, waitTimeoutMs }) => {
      return jsonTextContent(
        await getController(teamName, claudeDir).runtime.getTeam(
          controlFlags({ controlUrl, waitTimeoutMs })
        )
      );
    },
  });

  server.addTool({
    name: 'team_create',
    description:
      'Create a draft team configuration through the local Agent Teams control API. This does not launch the team.',
    parameters: z.object({
      ...teamContextSchema,
      displayName: z.string().min(1).optional(),
      description: z.string().optional(),
      color: z.string().min(1).optional(),
      members: z.array(memberSchema).optional(),
      cwd: z.string().min(1).optional(),
      prompt: z.string().min(1).optional(),
      providerId: providerIdSchema.optional(),
      providerBackendId: z.string().min(1).optional(),
      model: z.string().min(1).optional(),
      effort: effortSchema.optional(),
      fastMode: fastModeSchema.optional(),
      limitContext: z.boolean().optional(),
      skipPermissions: z.boolean().optional(),
      worktree: z.string().min(1).optional(),
      extraCliArgs: z.string().min(1).optional(),
    }),
    execute: async ({
      teamName,
      claudeDir,
      controlUrl,
      waitTimeoutMs,
      displayName,
      description,
      color,
      members,
      cwd,
      prompt,
      providerId,
      providerBackendId,
      model,
      effort,
      fastMode,
      limitContext,
      skipPermissions,
      worktree,
      extraCliArgs,
    }) => {
      return jsonTextContent(
        await getController(teamName, claudeDir).runtime.createTeam({
          ...controlFlags({ controlUrl, waitTimeoutMs }),
          ...(displayName ? { displayName } : {}),
          ...(description ? { description } : {}),
          ...(color ? { color } : {}),
          ...(members ? { members } : {}),
          ...(cwd ? { cwd } : {}),
          ...(prompt ? { prompt } : {}),
          ...(providerId ? { providerId } : {}),
          ...(providerBackendId ? { providerBackendId } : {}),
          ...(model ? { model } : {}),
          ...(effort ? { effort } : {}),
          ...(fastMode ? { fastMode } : {}),
          ...(limitContext !== undefined ? { limitContext } : {}),
          ...(skipPermissions !== undefined ? { skipPermissions } : {}),
          ...(worktree ? { worktree } : {}),
          ...(extraCliArgs ? { extraCliArgs } : {}),
        })
      );
    },
  });
}
