import type { FastMCP } from 'fastmcp';
import { z } from 'zod';

import { getController } from '../controller';
import { jsonTextContent } from '../utils/format';
import { assertConfiguredTeam } from '../utils/teamConfig';

const toolContextSchema = {
  teamName: z.string().min(1),
  claudeDir: z.string().min(1).optional(),
  controlUrl: z.string().optional(),
  waitTimeoutMs: z.number().int().min(1000).max(600000).optional(),
};

const runtimeMetadataSchema = z.record(z.string(), z.unknown()).optional();
const runtimeDiagnosticsSchema = z.array(z.string().min(1)).optional();
const runtimeIdentitySchema = {
  ...toolContextSchema,
  runId: z.string().min(1),
  memberName: z.string().min(1),
  runtimeSessionId: z.string().min(1),
};
const runtimeDeliveryTargetSchema = z.union([
  z.literal('user'),
  z.object({
    memberName: z.string().min(1),
    teamName: z.string().min(1).optional(),
  }),
]);

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
    }) => {
      assertConfiguredTeam(teamName, claudeDir);
      return jsonTextContent(
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
      );
    },
  });

  server.addTool({
    name: 'team_stop',
    description: 'Stop a running team via the desktop runtime',
    parameters: z.object({
      ...toolContextSchema,
      waitForStop: z.boolean().optional(),
    }),
    execute: async ({ teamName, claudeDir, controlUrl, waitTimeoutMs, waitForStop }) => {
      assertConfiguredTeam(teamName, claudeDir);
      return jsonTextContent(
        await getController(teamName, claudeDir).runtime.stopTeam({
          ...(controlUrl ? { controlUrl } : {}),
          ...(waitTimeoutMs ? { waitTimeoutMs } : {}),
          ...(waitForStop !== undefined ? { waitForStop } : {}),
        })
      );
    },
  });

  server.addTool({
    name: 'runtime_bootstrap_checkin',
    description: 'Confirm that an OpenCode team member runtime reached the app MCP bootstrap boundary',
    parameters: z.object({
      ...runtimeIdentitySchema,
      observedAt: z.string().min(1).optional(),
      diagnostics: runtimeDiagnosticsSchema,
      metadata: runtimeMetadataSchema,
    }),
    execute: async ({
      teamName,
      claudeDir,
      controlUrl,
      waitTimeoutMs,
      runId,
      memberName,
      runtimeSessionId,
      observedAt,
      diagnostics,
      metadata,
    }) => {
      assertConfiguredTeam(teamName, claudeDir);
      return jsonTextContent(
        await getController(teamName, claudeDir).runtime.runtimeBootstrapCheckin({
          runId,
          memberName,
          runtimeSessionId,
          ...(observedAt ? { observedAt } : {}),
          ...(diagnostics ? { diagnostics } : {}),
          ...(metadata ? { metadata } : {}),
          ...(controlUrl ? { controlUrl } : {}),
          ...(waitTimeoutMs ? { waitTimeoutMs } : {}),
        })
      );
    },
  });

  server.addTool({
    name: 'runtime_deliver_message',
    description:
      'Low-level OpenCode runtime delivery journal tool. Use only when the runtime/app prompt explicitly provides runId, runtimeSessionId, idempotencyKey, and asks for runtime delivery. For normal visible replies, use message_send.',
    parameters: z.object({
      ...toolContextSchema,
      idempotencyKey: z.string().min(1),
      runId: z.string().min(1),
      fromMemberName: z.string().min(1),
      runtimeSessionId: z.string().min(1),
      to: runtimeDeliveryTargetSchema,
      text: z.string().min(1),
      createdAt: z.string().min(1).optional(),
      summary: z.string().optional(),
      taskRefs: z.array(z.unknown()).optional(),
    }),
    execute: async ({
      teamName,
      claudeDir,
      controlUrl,
      waitTimeoutMs,
      idempotencyKey,
      runId,
      fromMemberName,
      runtimeSessionId,
      to,
      text,
      createdAt,
      summary,
      taskRefs,
    }) => {
      assertConfiguredTeam(teamName, claudeDir);
      return jsonTextContent(
        await getController(teamName, claudeDir).runtime.runtimeDeliverMessage({
          idempotencyKey,
          runId,
          fromMemberName,
          runtimeSessionId,
          to,
          text,
          ...(createdAt ? { createdAt } : {}),
          ...(summary ? { summary } : {}),
          ...(taskRefs ? { taskRefs } : {}),
          ...(controlUrl ? { controlUrl } : {}),
          ...(waitTimeoutMs ? { waitTimeoutMs } : {}),
        })
      );
    },
  });

  server.addTool({
    name: 'runtime_task_event',
    description: 'Record an idempotent OpenCode runtime task event for app-side attribution',
    parameters: z.object({
      ...toolContextSchema,
      idempotencyKey: z.string().min(1),
      runId: z.string().min(1),
      memberName: z.string().min(1),
      runtimeSessionId: z.string().min(1).optional(),
      taskId: z.string().min(1),
      event: z.string().min(1),
      createdAt: z.string().min(1).optional(),
      summary: z.string().optional(),
      metadata: runtimeMetadataSchema,
    }),
    execute: async ({
      teamName,
      claudeDir,
      controlUrl,
      waitTimeoutMs,
      idempotencyKey,
      runId,
      memberName,
      runtimeSessionId,
      taskId,
      event,
      createdAt,
      summary,
      metadata,
    }) => {
      assertConfiguredTeam(teamName, claudeDir);
      return jsonTextContent(
        await getController(teamName, claudeDir).runtime.runtimeTaskEvent({
          idempotencyKey,
          runId,
          memberName,
          ...(runtimeSessionId ? { runtimeSessionId } : {}),
          taskId,
          event,
          ...(createdAt ? { createdAt } : {}),
          ...(summary ? { summary } : {}),
          ...(metadata ? { metadata } : {}),
          ...(controlUrl ? { controlUrl } : {}),
          ...(waitTimeoutMs ? { waitTimeoutMs } : {}),
        })
      );
    },
  });

  server.addTool({
    name: 'runtime_heartbeat',
    description: 'Refresh OpenCode member runtime liveness in the app-owned launch state',
    parameters: z.object({
      ...runtimeIdentitySchema,
      observedAt: z.string().min(1).optional(),
      status: z.enum(['alive', 'idle', 'busy']).optional(),
      metadata: runtimeMetadataSchema,
    }),
    execute: async ({
      teamName,
      claudeDir,
      controlUrl,
      waitTimeoutMs,
      runId,
      memberName,
      runtimeSessionId,
      observedAt,
      status,
      metadata,
    }) => {
      assertConfiguredTeam(teamName, claudeDir);
      return jsonTextContent(
        await getController(teamName, claudeDir).runtime.runtimeHeartbeat({
          runId,
          memberName,
          runtimeSessionId,
          ...(observedAt ? { observedAt } : {}),
          ...(status ? { status } : {}),
          ...(metadata ? { metadata } : {}),
          ...(controlUrl ? { controlUrl } : {}),
          ...(waitTimeoutMs ? { waitTimeoutMs } : {}),
        })
      );
    },
  });
}
