import type {
  ProviderTask,
  ProviderTaskControls,
  ProviderTaskResult,
  RedactorPort,
  RunnerPort,
  SessionArtifact,
  WorkspaceHandle,
} from "@vioxen/subscription-runtime/core";
import {
  validateClaudeSessionArtifact,
} from "../session/session-artifact";
import { registerClaudeSecrets } from "../session/claude-session-driver";
import type {
  ClaudeTaskEngineInput,
  ClaudeTaskExecutionEngine,
} from "./engine-contract";
import { runtimeThreadFromMetadata } from "./runtime-thread-metadata";

export type ClaudeTaskAgentDriverOptions = {
  readonly engine: ClaudeTaskExecutionEngine;
  readonly appendSystemPrompt?: string;
  readonly model?: string;
  readonly maxTurns?: number;
  readonly allowedTools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly mcpConfig?: readonly string[];
  readonly strictMcpConfig?: boolean;
};

export type ClaudeTaskEnginePreparationInput = {
  readonly session: SessionArtifact;
  readonly task: ProviderTask;
  readonly workspace: WorkspaceHandle;
  readonly runner: RunnerPort;
  readonly redactor: RedactorPort;
  readonly abortSignal: AbortSignal;
};

export type PreparedClaudeTaskEngineInput = {
  readonly engineInput: ClaudeTaskEngineInput;
  readonly warnings: readonly ProviderTaskResult["warnings"][number][];
};

export function prepareClaudeTaskEngineInput(
  options: ClaudeTaskAgentDriverOptions,
  defaultModel: string,
  input: ClaudeTaskEnginePreparationInput,
): PreparedClaudeTaskEngineInput {
  const validation = validateClaudeSessionArtifact(input.session);
  registerClaudeSecrets(input.redactor, validation.session.oauthToken);
  let engineInput: ClaudeTaskEngineInput = {
    prompt: input.task.prompt,
    session: validation.session,
    workspacePath: input.workspace.path,
    runner: input.runner,
    redactor: input.redactor,
    model: input.task.controls?.model ?? defaultModel,
    abortSignal: input.abortSignal,
  };
  const maxTurns = input.task.controls?.maxTurns ?? options.maxTurns;
  const allowedTools =
    input.task.controls?.allowedTools ?? options.allowedTools;
  const disallowedTools =
    input.task.controls?.disallowedTools ?? options.disallowedTools;
  const editMode = input.task.controls?.editMode;
  const providerSandboxMode = input.task.controls?.providerSandboxMode;
  const outputSchemaName =
    input.task.controls?.outputSchemaName ?? input.task.outputSchemaName;
  const appendSystemPrompt = mergeSystemPrompts(
    options.appendSystemPrompt,
    input.task.systemPrompt,
  );
  engineInput = withOptionalEngineInputValues(engineInput, {
    appendSystemPrompt,
    maxTurns,
    allowedTools,
    disallowedTools,
    mcpConfig: options.mcpConfig,
    editMode,
    providerSandboxMode,
    strictMcpConfig: options.strictMcpConfig,
    outputSchemaName,
    runtimeThread: runtimeThreadFromMetadata(input.task.metadata),
  });
  return {
    engineInput,
    warnings: validation.warnings,
  };
}

type OptionalEngineInputKey =
  | "appendSystemPrompt"
  | "maxTurns"
  | "allowedTools"
  | "disallowedTools"
  | "mcpConfig"
  | "editMode"
  | "providerSandboxMode"
  | "strictMcpConfig"
  | "outputSchemaName"
  | "runtimeThread";

type OptionalEngineInputValues = {
  readonly [Key in OptionalEngineInputKey]: ClaudeTaskEngineInput[Key] | undefined;
};

function withOptionalEngineInputValues(
  engineInput: ClaudeTaskEngineInput,
  optional: OptionalEngineInputValues,
): ClaudeTaskEngineInput {
  let result = engineInput;
  if (optional.appendSystemPrompt !== undefined) {
    result = { ...result, appendSystemPrompt: optional.appendSystemPrompt };
  }
  if (optional.maxTurns !== undefined) {
    result = { ...result, maxTurns: optional.maxTurns };
  }
  if (optional.allowedTools !== undefined) {
    result = { ...result, allowedTools: optional.allowedTools };
  }
  if (optional.disallowedTools !== undefined) {
    result = { ...result, disallowedTools: optional.disallowedTools };
  }
  if (optional.mcpConfig !== undefined) {
    result = { ...result, mcpConfig: optional.mcpConfig };
  }
  if (optional.editMode !== undefined) {
    result = { ...result, editMode: optional.editMode };
  }
  if (optional.providerSandboxMode !== undefined) {
    result = {
      ...result,
      providerSandboxMode: optional.providerSandboxMode,
    };
  }
  if (optional.strictMcpConfig !== undefined) {
    result = { ...result, strictMcpConfig: optional.strictMcpConfig };
  }
  if (optional.outputSchemaName !== undefined) {
    result = { ...result, outputSchemaName: optional.outputSchemaName };
  }
  if (optional.runtimeThread !== undefined) {
    result = { ...result, runtimeThread: optional.runtimeThread };
  }
  return result;
}

function mergeSystemPrompts(
  base: string | undefined,
  task: string | undefined,
): string | undefined {
  const parts = [base, task]
    .map((value) => value?.trim())
    .filter((value): value is string => !!value);
  if (parts.length === 0) return undefined;
  return parts.join("\n\n");
}
