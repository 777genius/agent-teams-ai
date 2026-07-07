import { randomUUID } from "node:crypto";
import {
  assertClaudeReadOnlyToolPolicy,
  mapClaudePermissionMode,
} from "../protocol/claude-permission-policy";
import type { ClaudeTaskEngineInput } from "../task/engine-contract";
import type {
  AgentCommandLike,
  AgentRuntimeProviderLike,
  AgentRuntimeThreadLike,
  ClaudeRuntimeModule,
} from "./claude-bg-runtime-types";

export type ClaudeRuntimeCommandOptions = {
  readonly pluginDirs?: readonly string[];
  readonly settingsPath?: string;
};

export function buildClaudeRuntimeCommand(input: {
  readonly task: ClaudeTaskEngineInput;
  readonly runtime: ClaudeRuntimeModule;
  readonly requestedAt: string;
  readonly threadId: string;
  readonly options: ClaudeRuntimeCommandOptions;
}): AgentCommandLike {
  const task = input.task;
  assertClaudeReadOnlyToolPolicy(task.editMode, task.allowedTools);
  return {
    ...(task.allowedTools === undefined ? {} : { allowedTools: task.allowedTools }),
    ...(task.disallowedTools === undefined
      ? {}
      : { disallowedTools: task.disallowedTools }),
    ...(task.appendSystemPrompt === undefined
      ? {}
      : { appendSystemPrompt: task.appendSystemPrompt }),
    createdAt: input.requestedAt,
    cwd: task.workspacePath,
    id: input.runtime.asCommandId(`subscription-runtime-${randomUUID()}`),
    ...(task.maxTurns === undefined ? {} : { maxTurns: task.maxTurns }),
    ...(task.mcpConfig === undefined ? {} : { mcpConfig: task.mcpConfig }),
    mode:
      task.runtimeThread?.resumeSessionId === undefined
        ? "initial"
        : "followup",
    model: task.model,
    permissionMode: mapClaudePermissionMode(
      task.editMode,
      task.providerSandboxMode,
    ),
    ...(input.options.pluginDirs === undefined
      ? {}
      : { pluginDirs: input.options.pluginDirs }),
    prompt: task.prompt,
    ...(input.options.settingsPath === undefined
      ? {}
      : { settings: input.options.settingsPath }),
    ...(task.strictMcpConfig === undefined
      ? {}
      : { strictMcpConfig: task.strictMcpConfig }),
    threadId: input.threadId,
  };
}

export async function sendClaudeRuntimeFollowup(input: {
  readonly command: AgentCommandLike;
  readonly cwd: string;
  readonly provider: Pick<AgentRuntimeProviderLike, "id" | "send">;
  readonly requestedAt: string;
  readonly resumeSessionId: string;
  readonly threadId: string;
}): Promise<{ readonly runId: string; readonly providerSessionId?: string }> {
  if (!input.provider.send) {
    throw new Error("claude_runtime_provider_send_required");
  }
  return input.provider.send({
    command: input.command,
    previousProviderSessionId: input.resumeSessionId,
    requestedAt: input.requestedAt,
    thread: runtimeThreadForFollowup(input),
  });
}

function runtimeThreadForFollowup(input: {
  readonly cwd: string;
  readonly provider: Pick<AgentRuntimeProviderLike, "id">;
  readonly requestedAt: string;
  readonly resumeSessionId: string;
  readonly threadId: string;
}): AgentRuntimeThreadLike {
  return {
    id: input.threadId,
    status: "done",
    createdAt: input.requestedAt,
    updatedAt: input.requestedAt,
    cwd: input.cwd,
    providerId: input.provider.id,
    latestProviderSessionId: input.resumeSessionId,
  };
}
