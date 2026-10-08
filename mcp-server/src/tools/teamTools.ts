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
    ...(args.controlUrl !== undefined ? { controlUrl: args.controlUrl } : {}),
    ...(args.waitTimeoutMs ? { waitTimeoutMs: args.waitTimeoutMs } : {}),
  };
}

export function registerTeamTools(server: Pick<FastMCP, 'addTool'>) {
  server.addTool({
    name: 'app_get_connection_info',
    description: 'Discover the current desktop app connection and immutable context.',
    parameters: z.object({}).strict(),
    execute: async () =>
      jsonTextContent(await getController('agent-teams-control').runtime.getConnectionInfo()),
  });
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
    description:
      'Get a team snapshot. Set configuration=true for a coherent saved configurationRevision before team_update or team_trash; ordinary reads remain available during provisioning.',
    parameters: z.object({
      ...teamContextSchema,
      configuration: z.boolean().optional(),
    }),
    execute: async ({ teamName, claudeDir, controlUrl, waitTimeoutMs, configuration }) => {
      return jsonTextContent(
        await getController(teamName, claudeDir).runtime.getTeam({
          ...controlFlags({ controlUrl, waitTimeoutMs }),
          ...(configuration !== undefined ? { configuration } : {}),
        })
      );
    },
  });

  const managementContextSchema = z
    .object({
      appInstanceId: z.string().min(1),
      dataRootFingerprint: z.string().min(1),
      connectionGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    })
    .strict();
  const managementTargetSchema = {
    ...teamContextSchema,
    teamName: z.string().regex(/^[a-z0-9][a-z0-9-]{0,127}$/),
    expectedContext: managementContextSchema,
    expectedRevision: z.string().min(1),
  };
  server.addTool({
    name: 'team_update',
    description:
      'Edit exactly one configuration group of a stopped or draft team. Get its current configurationRevision first. Does not launch or stop agents.',
    parameters: z
      .object({
        ...managementTargetSchema,
        metadata: z
          .object({
            displayName: z.string().trim().min(1).optional(),
            description: z.string().optional(),
            color: z.string().optional(),
          })
          .strict()
          .refine((value) => Object.keys(value).length > 0, 'Specify at least one metadata field')
          .optional(),
        leadInstructions: z.string().optional(),
        members: z
          .array(
            z
              .object({
                name: z.string().min(1),
                role: z.string().optional(),
                workflow: z.string().optional(),
              })
              .strict()
          )
          .max(100)
          .optional(),
      })
      .strict()
      .refine(
        (value) =>
          ['metadata', 'leadInstructions', 'members'].filter(
            (key) => value[key as keyof typeof value] !== undefined
          ).length === 1,
        'Specify exactly one configuration group'
      ),
    execute: async ({ teamName, claudeDir, controlUrl, waitTimeoutMs, ...payload }) =>
      jsonTextContent(
        await getController(teamName, claudeDir).runtime.updateTeam({
          ...controlFlags({ controlUrl, waitTimeoutMs }),
          ...payload,
        })
      ),
  });
  server.addTool({
    name: 'team_trash',
    description:
      'Move a stopped or draft team to reversible Trash using a fresh configurationRevision. Never permanently deletes files or stops agents.',
    parameters: z.object(managementTargetSchema).strict(),
    execute: async ({ teamName, claudeDir, controlUrl, waitTimeoutMs, ...payload }) =>
      jsonTextContent(
        await getController(teamName, claudeDir).runtime.trashTeam({
          ...controlFlags({ controlUrl, waitTimeoutMs }),
          ...payload,
        })
      ),
  });

  server.addTool({
    name: 'team_create',
    description:
      'Create a draft team configuration through the local Agent Teams control API. This does not launch the team.',
    parameters: z
      .object({
        ...teamContextSchema,
        runtimeSelectionVersion: z.literal(1).optional(),
        expectedContext: z
          .object({
            appInstanceId: z.string().min(1),
            dataRootFingerprint: z.string().min(1),
            connectionGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
          })
          .strict()
          .optional(),
        syncModelsWithLead: z.boolean().optional(),
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
      })
      .refine(
        (value) => value.runtimeSelectionVersion !== 1 || value.expectedContext !== undefined,
        {
          message: 'expectedContext is required for runtimeSelectionVersion 1',
          path: ['expectedContext'],
        }
      ),
    execute: async ({
      teamName,
      claudeDir,
      controlUrl,
      waitTimeoutMs,
      runtimeSelectionVersion,
      expectedContext,
      syncModelsWithLead,
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
          ...(runtimeSelectionVersion !== undefined ? { runtimeSelectionVersion } : {}),
          ...(expectedContext ? { expectedContext } : {}),
          ...(syncModelsWithLead !== undefined ? { syncModelsWithLead } : {}),
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
