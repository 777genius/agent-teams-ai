import {
  isProviderFailureCode,
  providerTaskSystemPromptValidationError,
  type AgentCost,
  type AgentToolCall,
  type AgentUsage,
  type ManagedRunInputRequest,
  type ManagedRunResumeHandle,
  type ProviderFailure,
  type ProviderFailureCode,
  type ProviderTask,
  type ProviderTaskControls,
  type ProviderTaskEvent,
  type ProviderTaskKind,
  type ProviderTaskResult,
  type ProviderTaskTelemetry,
  type RuntimeWarning,
} from "@vioxen/subscription-runtime/core";
import {
  agentTaskProtocolVersion,
  AgentTaskProtocolError,
  makeAgentTaskFailure,
  type AgentTaskContext,
  type AgentTaskControls,
  type AgentTaskEvent,
  type AgentTaskPayload,
  type AgentTaskRequest,
  type AgentTaskResult,
  type AgentTaskRoundContext,
  type AgentTaskRoundMemberIdentity,
  type JsonObject,
  type JsonValue,
} from "../domain/agent-task-contracts";

const providerTaskKinds = new Set<ProviderTaskKind>([
  "review",
  "structured-prompt",
  "health-check",
]);
const editModes = new Set<NonNullable<ProviderTaskControls["editMode"]>>([
  "read-only",
  "allow-edits",
]);
const providerSandboxModes = new Set<
  NonNullable<ProviderTaskControls["providerSandboxMode"]>
>([
  "workspace-write",
  "danger-full-access",
]);
const responseFormats = new Set<NonNullable<ProviderTaskControls["responseFormat"]>>([
  "text",
  "json",
]);
const toolCallStatuses = new Set<NonNullable<AgentToolCall["status"]>>([
  "started",
  "completed",
  "failed",
  "denied",
]);
const finishReasons = new Set<
  NonNullable<ProviderTaskTelemetry["finishReason"]>
>([
  "completed",
  "waiting_for_input",
  "max_turns",
  "cancelled",
  "timeout",
  "provider_error",
]);
export function createAgentTaskRequest(
  input: Omit<AgentTaskRequest, "protocolVersion">,
): AgentTaskRequest {
  return parseAgentTaskRequest({
    protocolVersion: agentTaskProtocolVersion,
    ...input,
  });
}

export function parseAgentTaskRequest(value: unknown): AgentTaskRequest {
  const input = objectAt(value, "request");
  assertProtocolVersion(input.protocolVersion, "request.protocolVersion");
  return {
    protocolVersion: agentTaskProtocolVersion,
    ...optionalStringField(input, "runId", "request.runId"),
    ...optionalStringField(
      input,
      "providerInstanceId",
      "request.providerInstanceId",
    ),
    ...optionalStringField(input, "cwd", "request.cwd"),
    ...optionalPositiveIntegerField(input, "timeoutMs", "request.timeoutMs"),
    task: parseAgentTaskPayload(input.task, "request.task"),
    ...optionalContextField(input, "context", "request.context"),
  };
}

export function agentTaskRequestToProviderTask(
  request: AgentTaskRequest,
): ProviderTask {
  return {
    kind: request.task.kind,
    prompt: request.task.prompt,
    ...(request.task.systemPrompt !== undefined
      ? { systemPrompt: request.task.systemPrompt }
      : {}),
    ...(request.task.outputSchemaName
      ? { outputSchemaName: request.task.outputSchemaName }
      : {}),
    ...(request.task.controls
      ? { controls: providerTaskControls(request.task.controls) }
      : {}),
    ...(request.task.metadata ? { metadata: request.task.metadata } : {}),
  };
}

export function providerTaskResultToAgentTaskResult(
  result: ProviderTaskResult,
): AgentTaskResult {
  if (result.status === "completed") {
    return {
      protocolVersion: agentTaskProtocolVersion,
      status: "completed",
      outputText: result.outputText,
      ...(result.structuredOutput === undefined
        ? {}
        : {
            structuredOutput: parseJsonValue(
              result.structuredOutput,
              "result.structuredOutput",
            ),
          }),
      ...(result.telemetry ? { telemetry: parseTelemetry(result.telemetry) } : {}),
      warnings: result.warnings.map((warning, index) =>
        parseWarning(warning, `result.warnings[${index}]`),
      ),
    };
  }
  if (result.status === "waiting_for_input") {
    return {
      protocolVersion: agentTaskProtocolVersion,
      status: "waiting_for_input",
      runId: result.runId,
      outputText: result.outputText,
      ...(result.structuredOutput === undefined
        ? {}
        : {
            structuredOutput: parseJsonValue(
              result.structuredOutput,
              "result.structuredOutput",
            ),
          }),
      request: result.request,
      resumeHandle: result.resumeHandle,
      ...(result.telemetry ? { telemetry: parseTelemetry(result.telemetry) } : {}),
      warnings: result.warnings.map((warning, index) =>
        parseWarning(warning, `result.warnings[${index}]`),
      ),
    };
  }
  return {
    protocolVersion: agentTaskProtocolVersion,
    status: "failed",
    failure: parseFailure(result.failure, "result.failure"),
    ...(result.telemetry ? { telemetry: parseTelemetry(result.telemetry) } : {}),
    warnings: result.warnings.map((warning, index) =>
      parseWarning(warning, `result.warnings[${index}]`),
    ),
  };
}

export function agentTaskResultToProviderTaskResult(
  result: AgentTaskResult,
): ProviderTaskResult {
  const parsed = parseAgentTaskResult(result);
  if (parsed.status === "completed") {
    return {
      status: "completed",
      outputText: parsed.outputText,
      ...(parsed.structuredOutput === undefined
        ? {}
        : { structuredOutput: parsed.structuredOutput }),
      ...(parsed.telemetry ? { telemetry: parsed.telemetry } : {}),
      warnings: parsed.warnings,
    };
  }
  if (parsed.status === "waiting_for_input") {
    return {
      status: "waiting_for_input",
      runId: parsed.runId,
      outputText: parsed.outputText,
      ...(parsed.structuredOutput === undefined
        ? {}
        : { structuredOutput: parsed.structuredOutput }),
      request: parsed.request,
      resumeHandle: parsed.resumeHandle,
      ...(parsed.telemetry ? { telemetry: parsed.telemetry } : {}),
      warnings: parsed.warnings,
    };
  }
  return {
    status: "failed",
    failure: parsed.failure,
    ...(parsed.telemetry ? { telemetry: parsed.telemetry } : {}),
    warnings: parsed.warnings,
  };
}

export function parseAgentTaskResult(value: unknown): AgentTaskResult {
  const input = objectAt(value, "result");
  assertProtocolVersion(input.protocolVersion, "result.protocolVersion");
  const status = stringAt(input.status, "result.status");
  if (status === "completed") {
    return {
      protocolVersion: agentTaskProtocolVersion,
      status,
      outputText: stringAt(input.outputText, "result.outputText"),
      ...(input.structuredOutput === undefined
        ? {}
        : {
            structuredOutput: parseJsonValue(
              input.structuredOutput,
              "result.structuredOutput",
            ),
          }),
      ...optionalTelemetryField(input, "telemetry", "result.telemetry"),
      warnings: parseWarnings(input.warnings, "result.warnings"),
    };
  }
  if (status === "failed") {
    return {
      protocolVersion: agentTaskProtocolVersion,
      status,
      failure: parseFailure(input.failure, "result.failure"),
      ...optionalTelemetryField(input, "telemetry", "result.telemetry"),
      warnings: parseWarnings(input.warnings, "result.warnings"),
    };
  }
  if (status === "waiting_for_input") {
    return {
      protocolVersion: agentTaskProtocolVersion,
      status,
      runId: nonEmptyStringAt(input.runId, "result.runId"),
      outputText: stringAt(input.outputText, "result.outputText"),
      ...(input.structuredOutput === undefined
        ? {}
        : {
            structuredOutput: parseJsonValue(
              input.structuredOutput,
              "result.structuredOutput",
            ),
          }),
      request: parseManagedRunInputRequest(
        input.request,
        "result.request",
      ),
      resumeHandle: parseManagedRunResumeHandle(
        input.resumeHandle,
        "result.resumeHandle",
      ),
      ...optionalTelemetryField(input, "telemetry", "result.telemetry"),
      warnings: parseWarnings(input.warnings, "result.warnings"),
    };
  }
  throw protocolError(
    "agent_task_result_invalid",
    `result.status must be completed, waiting_for_input or failed at result.status`,
  );
}

export function providerTaskEventToAgentTaskEvent(
  event: ProviderTaskEvent,
): AgentTaskEvent {
  const base = {
    protocolVersion: agentTaskProtocolVersion,
    occurredAt: event.occurredAt.toISOString(),
    ...(event.telemetry ? { telemetry: parseTelemetry(event.telemetry) } : {}),
  };
  switch (event.type) {
    case "started":
      return { ...base, type: event.type };
    case "text_delta":
      return { ...base, type: event.type, text: event.text };
    case "tool_call":
      return {
        ...base,
        type: event.type,
        toolCall: parseToolCall(event.toolCall, "event.toolCall"),
      };
    case "usage":
      return {
        ...base,
        type: event.type,
        usage: parseUsage(event.usage, "event.usage"),
      };
    case "warning":
      return {
        ...base,
        type: event.type,
        warning: parseWarning(event.warning, "event.warning"),
      };
    case "completed":
      return {
        ...base,
        type: event.type,
        result: providerTaskResultToAgentTaskResult(event.result),
      };
  }
}

export function parseAgentTaskEvent(value: unknown): AgentTaskEvent {
  const input = objectAt(value, "event");
  assertProtocolVersion(input.protocolVersion, "event.protocolVersion");
  const type = stringAt(input.type, "event.type");
  const base = {
    protocolVersion: agentTaskProtocolVersion,
    occurredAt: isoStringAt(input.occurredAt, "event.occurredAt"),
    ...optionalTelemetryField(input, "telemetry", "event.telemetry"),
  };
  if (type === "started") return { ...base, type };
  if (type === "text_delta") {
    return { ...base, type, text: stringAt(input.text, "event.text") };
  }
  if (type === "tool_call") {
    return {
      ...base,
      type,
      toolCall: parseToolCall(input.toolCall, "event.toolCall"),
    };
  }
  if (type === "usage") {
    return { ...base, type, usage: parseUsage(input.usage, "event.usage") };
  }
  if (type === "warning") {
    return {
      ...base,
      type,
      warning: parseWarning(input.warning, "event.warning"),
    };
  }
  if (type === "completed") {
    return {
      ...base,
      type,
      result: parseAgentTaskResult(input.result),
    };
  }
  throw protocolError(
    "agent_task_event_invalid",
    `event.type is unsupported at event.type`,
  );
}

export function makeFailedAgentTaskResult(input: {
  readonly code: ProviderFailureCode;
  readonly safeMessage: string;
  readonly retryable?: boolean;
  readonly reconnectRequired?: boolean;
  readonly causeCategory?: string;
  readonly details?: Readonly<Record<string, string>>;
  readonly warnings?: readonly RuntimeWarning[];
  readonly telemetry?: ProviderTaskTelemetry;
}): AgentTaskResult {
  return {
    protocolVersion: agentTaskProtocolVersion,
    status: "failed",
    failure: makeAgentTaskFailure(input.code, input.safeMessage, input),
    ...(input.telemetry ? { telemetry: parseTelemetry(input.telemetry) } : {}),
    warnings: (input.warnings ?? []).map((warning, index) =>
      parseWarning(warning, `warnings[${index}]`),
    ),
  };
}

export function parseJsonValue(value: unknown, path = "json"): JsonValue {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw protocolError(
        "agent_task_json_invalid",
        `${path} must be a finite JSON number`,
      );
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => parseJsonValue(item, `${path}[${index}]`));
  }
  if (isPlainObject(value)) {
    const parsed: Record<string, JsonValue> = {};
    for (const [key, nested] of Object.entries(value)) {
      if (nested === undefined) continue;
      parsed[key] = parseJsonValue(nested, `${path}.${key}`);
    }
    return parsed;
  }
  throw protocolError(
    "agent_task_json_invalid",
    `${path} must be JSON serializable`,
  );
}

function parseAgentTaskPayload(value: unknown, path: string): AgentTaskPayload {
  const input = objectAt(value, path);
  const kind = stringAt(input.kind, `${path}.kind`);
  if (!providerTaskKinds.has(kind as ProviderTaskKind)) {
    throw protocolError(
      "agent_task_request_invalid",
      `${path}.kind is unsupported`,
    );
  }
  const prompt = stringAt(input.prompt, `${path}.prompt`);
  if (prompt.length === 0) {
    throw protocolError(
      "agent_task_request_invalid",
      `${path}.prompt must not be empty`,
    );
  }
  const parsedSystemPrompt = optionalStringField(
    input,
    "systemPrompt",
    `${path}.systemPrompt`,
  );
  const systemPrompt = parsedSystemPrompt.systemPrompt;
  const systemPromptError = providerTaskSystemPromptValidationError(
    systemPrompt,
    `${path}.systemPrompt`,
  );
  if (systemPromptError !== null) {
    throw protocolError(
      "agent_task_request_invalid",
      systemPromptError,
    );
  }
  return {
    kind: kind as ProviderTaskKind,
    prompt,
    ...parsedSystemPrompt,
    ...optionalStringField(input, "outputSchemaName", `${path}.outputSchemaName`),
    ...optionalControlsField(input, "controls", `${path}.controls`),
    ...optionalMetadataField(input, "metadata", `${path}.metadata`),
  };
}

function providerTaskControls(controls: AgentTaskControls): ProviderTaskControls {
  return {
    ...(controls.model ? { model: controls.model } : {}),
    ...(controls.maxTurns === undefined ? {} : { maxTurns: controls.maxTurns }),
    ...(controls.allowedTools ? { allowedTools: controls.allowedTools } : {}),
    ...(controls.editMode ? { editMode: controls.editMode } : {}),
    ...(controls.providerSandboxMode
      ? { providerSandboxMode: controls.providerSandboxMode }
      : {}),
    ...(controls.responseFormat
      ? { responseFormat: controls.responseFormat }
      : {}),
    ...(controls.outputSchemaName
      ? { outputSchemaName: controls.outputSchemaName }
      : {}),
  };
}

function parseControls(value: unknown, path: string): AgentTaskControls {
  const input = objectAt(value, path);
  const controls: AgentTaskControls = {
    ...optionalStringField(input, "model", `${path}.model`),
    ...optionalPositiveIntegerField(input, "maxTurns", `${path}.maxTurns`),
    ...optionalStringArrayField(input, "allowedTools", `${path}.allowedTools`),
    ...optionalEnumField(
      input,
      "editMode",
      `${path}.editMode`,
      editModes,
    ),
    ...optionalEnumField(
      input,
      "providerSandboxMode",
      `${path}.providerSandboxMode`,
      providerSandboxModes,
    ),
    ...optionalEnumField(
      input,
      "responseFormat",
      `${path}.responseFormat`,
      responseFormats,
    ),
    ...optionalStringField(input, "outputSchemaName", `${path}.outputSchemaName`),
    ...optionalJsonObjectField(input, "outputSchema", `${path}.outputSchema`),
  };
  assertProviderSandboxModeAllowed(controls, path);
  return controls;
}

function assertProviderSandboxModeAllowed(
  controls: AgentTaskControls,
  path: string,
): void {
  if (
    controls.providerSandboxMode === undefined ||
    controls.editMode === "allow-edits"
  ) {
    return;
  }
  throw protocolError(
    "agent_task_request_invalid",
    `${path}.providerSandboxMode requires ${path}.editMode to be "allow-edits"`,
  );
}

function parseContext(value: unknown, path: string): AgentTaskContext {
  const input = objectAt(value, path);
  return {
    ...optionalStringField(input, "application", `${path}.application`),
    ...optionalStringField(input, "purpose", `${path}.purpose`),
    ...optionalStringField(input, "correlationId", `${path}.correlationId`),
    ...optionalMetadataField(input, "metadata", `${path}.metadata`),
    ...optionalRoundContextField(input, "round", `${path}.round`),
  };
}

function parseRoundContext(value: unknown, path: string): AgentTaskRoundContext {
  const input = objectAt(value, path);
  return {
    ...optionalStringField(input, "roundId", `${path}.roundId`),
    ...optionalPositiveIntegerField(input, "roundIndex", `${path}.roundIndex`),
    ...optionalPositiveIntegerField(input, "totalRounds", `${path}.totalRounds`),
    member: parseRoundMemberIdentity(input.member, `${path}.member`),
    ...optionalRoundMemberIdentityField(
      input,
      "adversaryOf",
      `${path}.adversaryOf`,
    ),
  };
}

function parseRoundMemberIdentity(
  value: unknown,
  path: string,
): AgentTaskRoundMemberIdentity {
  const input = objectAt(value, path);
  return {
    id: nonEmptyStringAt(input.id, `${path}.id`),
    adapterId: nonEmptyStringAt(input.adapterId, `${path}.adapterId`),
    agentType: nonEmptyStringAt(input.agentType, `${path}.agentType`),
    provider: nonEmptyStringAt(input.provider, `${path}.provider`),
    model: nonEmptyStringAt(input.model, `${path}.model`),
    independenceGroup: nonEmptyStringAt(
      input.independenceGroup,
      `${path}.independenceGroup`,
    ),
    ...optionalStringField(input, "label", `${path}.label`),
  };
}

function parseWarnings(value: unknown, path: string): readonly RuntimeWarning[] {
  if (!Array.isArray(value)) {
    throw protocolError(
      "agent_task_result_invalid",
      `${path} must be an array`,
    );
  }
  return value.map((warning, index) =>
    parseWarning(warning, `${path}[${index}]`),
  );
}

function parseManagedRunInputRequest(
  value: unknown,
  path: string,
): ManagedRunInputRequest {
  const input = objectAt(value, path);
  const kind = stringAt(input.kind, `${path}.kind`);
  if (
    kind !== "missing_context" &&
    kind !== "decision_required" &&
    kind !== "permission_required"
  ) {
    throw protocolError(
      "agent_task_result_invalid",
      `${path}.kind is unsupported`,
    );
  }
  const audience = stringAt(input.audience, `${path}.audience`);
  if (audience !== "orchestrator" && audience !== "user") {
    throw protocolError(
      "agent_task_result_invalid",
      `${path}.audience is unsupported`,
    );
  }
  return {
    id: nonEmptyStringAt(input.id, `${path}.id`),
    kind,
    question: nonEmptyStringAt(input.question, `${path}.question`),
    ...optionalStringField(input, "contextSummary", `${path}.contextSummary`),
    ...optionalStringArrayField(
      input,
      "suggestedAnswers",
      `${path}.suggestedAnswers`,
    ),
    audience,
  };
}

function parseManagedRunResumeHandle(
  value: unknown,
  path: string,
): ManagedRunResumeHandle {
  const input = objectAt(value, path);
  return {
    runId: nonEmptyStringAt(input.runId, `${path}.runId`),
    providerId: nonEmptyStringAt(input.providerId, `${path}.providerId`),
    ...optionalStringField(
      input,
      "providerInstanceId",
      `${path}.providerInstanceId`,
    ),
    ...optionalStringField(input, "agentId", `${path}.agentId`),
    ...optionalStringField(input, "workerId", `${path}.workerId`),
    workspacePath: nonEmptyStringAt(input.workspacePath, `${path}.workspacePath`),
    ...optionalStringField(input, "threadId", `${path}.threadId`),
    ...optionalStringRecordField(
      input,
      "providerState",
      `${path}.providerState`,
    ),
  };
}

function parseWarning(value: unknown, path: string): RuntimeWarning {
  const input = objectAt(value, path);
  return {
    code: stringAt(input.code, `${path}.code`),
    safeMessage: stringAt(input.safeMessage, `${path}.safeMessage`),
    ...optionalMetadataField(input, "details", `${path}.details`),
  };
}

function parseFailure(value: unknown, path: string): ProviderFailure {
  const input = objectAt(value, path);
  const code = stringAt(input.code, `${path}.code`);
  if (!isProviderFailureCode(code)) {
    throw protocolError(
      "agent_task_result_invalid",
      `${path}.code is unsupported`,
    );
  }
  return {
    code,
    retryable: booleanAt(input.retryable, `${path}.retryable`),
    reconnectRequired: booleanAt(
      input.reconnectRequired,
      `${path}.reconnectRequired`,
    ),
    safeMessage: stringAt(input.safeMessage, `${path}.safeMessage`),
    ...optionalStringField(input, "causeCategory", `${path}.causeCategory`),
    ...optionalMetadataField(input, "details", `${path}.details`),
  };
}

function parseTelemetry(value: unknown): ProviderTaskTelemetry {
  const input = objectAt(value, "telemetry");
  return {
    ...optionalStringField(input, "providerRunId", "telemetry.providerRunId"),
    ...optionalStringField(
      input,
      "providerSessionId",
      "telemetry.providerSessionId",
    ),
    ...optionalNonNegativeNumberField(
      input,
      "durationMs",
      "telemetry.durationMs",
    ),
    ...optionalPositiveIntegerField(input, "turns", "telemetry.turns"),
    ...optionalUsageField(input, "usage", "telemetry.usage"),
    ...optionalCostField(input, "cost", "telemetry.cost"),
    ...optionalToolCallsField(input, "toolCalls", "telemetry.toolCalls"),
    ...optionalResultEnumField(
      input,
      "finishReason",
      "telemetry.finishReason",
      finishReasons,
    ),
  } as ProviderTaskTelemetry;
}

function parseUsage(value: unknown, path: string): AgentUsage {
  const input = objectAt(value, path);
  return {
    ...optionalPositiveIntegerField(input, "inputTokens", `${path}.inputTokens`),
    ...optionalPositiveIntegerField(
      input,
      "outputTokens",
      `${path}.outputTokens`,
    ),
    ...optionalPositiveIntegerField(input, "totalTokens", `${path}.totalTokens`),
  };
}

function parseCost(value: unknown, path: string): AgentCost {
  const input = objectAt(value, path);
  const currency = stringAt(input.currency, `${path}.currency`);
  if (currency !== "USD") {
    throw protocolError(
      "agent_task_result_invalid",
      `${path}.currency must be USD`,
    );
  }
  return {
    amount: nonNegativeNumberAt(input.amount, `${path}.amount`),
    currency,
  };
}

function parseToolCall(value: unknown, path: string): AgentToolCall {
  const input = objectAt(value, path);
  return {
    ...optionalStringField(input, "id", `${path}.id`),
    name: stringAt(input.name, `${path}.name`),
    ...optionalResultEnumField(input, "status", `${path}.status`, toolCallStatuses),
    ...optionalJsonObjectField(input, "safeInput", `${path}.safeInput`),
    ...optionalStringField(input, "safeInputPreview", `${path}.safeInputPreview`),
    ...optionalStringField(input, "safeOutputPreview", `${path}.safeOutputPreview`),
  } as AgentToolCall;
}

function optionalContextField(
  input: Record<string, unknown>,
  key: string,
  path: string,
): { readonly context?: AgentTaskContext } {
  return input[key] === undefined ? {} : { context: parseContext(input[key], path) };
}

function optionalControlsField(
  input: Record<string, unknown>,
  key: string,
  path: string,
): { readonly controls?: AgentTaskControls } {
  return input[key] === undefined ? {} : { controls: parseControls(input[key], path) };
}

function optionalRoundContextField(
  input: Record<string, unknown>,
  key: string,
  path: string,
): { readonly round?: AgentTaskRoundContext } {
  return input[key] === undefined ? {} : { round: parseRoundContext(input[key], path) };
}

function optionalRoundMemberIdentityField(
  input: Record<string, unknown>,
  key: string,
  path: string,
): { readonly adversaryOf?: AgentTaskRoundMemberIdentity } {
  return input[key] === undefined
    ? {}
    : { adversaryOf: parseRoundMemberIdentity(input[key], path) };
}

function optionalTelemetryField(
  input: Record<string, unknown>,
  key: string,
  path: string,
): { readonly telemetry?: ProviderTaskTelemetry } {
  return input[key] === undefined
    ? {}
    : { telemetry: parseTelemetryAt(input[key], path) };
}

function parseTelemetryAt(value: unknown, path: string): ProviderTaskTelemetry {
  try {
    return parseTelemetry(value);
  } catch (error) {
    if (error instanceof AgentTaskProtocolError) {
      throw protocolError(error.code, error.message.replace("telemetry", path));
    }
    throw error;
  }
}

function optionalUsageField(
  input: Record<string, unknown>,
  key: string,
  path: string,
): { readonly usage?: AgentUsage } {
  return input[key] === undefined ? {} : { usage: parseUsage(input[key], path) };
}

function optionalCostField(
  input: Record<string, unknown>,
  key: string,
  path: string,
): { readonly cost?: AgentCost } {
  return input[key] === undefined ? {} : { cost: parseCost(input[key], path) };
}

function optionalToolCallsField(
  input: Record<string, unknown>,
  key: string,
  path: string,
): { readonly toolCalls?: readonly AgentToolCall[] } {
  if (input[key] === undefined) return {};
  if (!Array.isArray(input[key])) {
    throw protocolError(
      "agent_task_result_invalid",
      `${path} must be an array`,
    );
  }
  return {
    toolCalls: input[key].map((toolCall, index) =>
      parseToolCall(toolCall, `${path}[${index}]`),
    ),
  };
}

function optionalMetadataField(
  input: Record<string, unknown>,
  key: string,
  path: string,
): { readonly [P in string]?: Readonly<Record<string, string>> } {
  if (input[key] === undefined) return {};
  const metadata = objectAt(input[key], path);
  const parsed: Record<string, string> = {};
  for (const [metadataKey, metadataValue] of Object.entries(metadata)) {
    parsed[metadataKey] = stringAt(metadataValue, `${path}.${metadataKey}`);
  }
  return { [key]: parsed };
}

function optionalStringField(
  input: Record<string, unknown>,
  key: string,
  path: string,
): { readonly [P in string]?: string } {
  return input[key] === undefined ? {} : { [key]: stringAt(input[key], path) };
}

function optionalStringArrayField(
  input: Record<string, unknown>,
  key: string,
  path: string,
): { readonly [P in string]?: readonly string[] } {
  if (input[key] === undefined) return {};
  if (!Array.isArray(input[key])) {
    throw protocolError(
      "agent_task_request_invalid",
      `${path} must be an array`,
    );
  }
  return {
    [key]: input[key].map((item, index) => stringAt(item, `${path}[${index}]`)),
  };
}

function optionalStringRecordField(
  input: Record<string, unknown>,
  key: string,
  path: string,
): { readonly [P in string]?: Readonly<Record<string, string>> } {
  if (input[key] === undefined) return {};
  const value = objectAt(input[key], path);
  const parsed: Record<string, string> = {};
  for (const [recordKey, recordValue] of Object.entries(value)) {
    parsed[recordKey] = stringAt(recordValue, `${path}.${recordKey}`);
  }
  return { [key]: parsed };
}

function optionalEnumField<T extends string>(
  input: Record<string, unknown>,
  key: string,
  path: string,
  allowed: ReadonlySet<T>,
): { readonly [P in string]?: T } {
  if (input[key] === undefined) return {};
  const value = stringAt(input[key], path);
  if (!allowed.has(value as T)) {
    throw protocolError("agent_task_request_invalid", `${path} is unsupported`);
  }
  return { [key]: value as T };
}

function optionalResultEnumField<T extends string>(
  input: Record<string, unknown>,
  key: string,
  path: string,
  allowed: ReadonlySet<T>,
): { readonly [P in string]?: T } {
  if (input[key] === undefined) return {};
  const value = stringAt(input[key], path);
  if (!allowed.has(value as T)) {
    throw protocolError("agent_task_result_invalid", `${path} is unsupported`);
  }
  return { [key]: value as T };
}

function optionalJsonObjectField(
  input: Record<string, unknown>,
  key: string,
  path: string,
): { readonly [P in string]?: JsonObject } {
  if (input[key] === undefined) return {};
  const value = parseJsonValue(input[key], path);
  if (!isPlainObject(value)) {
    throw protocolError(
      "agent_task_json_invalid",
      `${path} must be a JSON object`,
    );
  }
  return { [key]: value as JsonObject };
}

function optionalPositiveIntegerField(
  input: Record<string, unknown>,
  key: string,
  path: string,
): { readonly [P in string]?: number } {
  if (input[key] === undefined) return {};
  return { [key]: positiveIntegerAt(input[key], path) };
}

function optionalNonNegativeNumberField(
  input: Record<string, unknown>,
  key: string,
  path: string,
): { readonly [P in string]?: number } {
  if (input[key] === undefined) return {};
  return { [key]: nonNegativeNumberAt(input[key], path) };
}

function assertProtocolVersion(value: unknown, path: string): void {
  if (value !== agentTaskProtocolVersion) {
    throw protocolError(
      "agent_task_protocol_version_invalid",
      `${path} must be ${agentTaskProtocolVersion}`,
    );
  }
}

function objectAt(value: unknown, path: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw protocolError("agent_task_request_invalid", `${path} must be an object`);
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringAt(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw protocolError("agent_task_request_invalid", `${path} must be a string`);
  }
  return value;
}

function nonEmptyStringAt(value: unknown, path: string): string {
  const text = stringAt(value, path).trim();
  if (text.length === 0) {
    throw protocolError(
      "agent_task_request_invalid",
      `${path} must be a non-empty string`,
    );
  }
  return text;
}

function isoStringAt(value: unknown, path: string): string {
  const text = stringAt(value, path);
  if (Number.isNaN(Date.parse(text))) {
    throw protocolError(
      "agent_task_event_invalid",
      `${path} must be an ISO timestamp`,
    );
  }
  return text;
}

function booleanAt(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw protocolError("agent_task_result_invalid", `${path} must be a boolean`);
  }
  return value;
}

function positiveIntegerAt(value: unknown, path: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw protocolError(
      "agent_task_request_invalid",
      `${path} must be a positive integer`,
    );
  }
  return value as number;
}

function nonNegativeNumberAt(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw protocolError(
      "agent_task_result_invalid",
      `${path} must be a non-negative finite number`,
    );
  }
  return value;
}

function protocolError(
  code: ConstructorParameters<typeof AgentTaskProtocolError>[0],
  message: string,
): AgentTaskProtocolError {
  return new AgentTaskProtocolError(code, message);
}
