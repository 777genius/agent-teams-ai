import type { AgentUsage } from "@vioxen/subscription-runtime/core";

export type CodexAppServerJsonRpcResponse = {
  readonly id?: number;
  readonly result?: Record<string, unknown>;
  readonly error?: { readonly message?: string };
};

export type CodexThreadGoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "usageLimited"
  | "budgetLimited"
  | "complete";

export type CodexThreadGoal = {
  readonly threadId: string;
  readonly objective: string;
  readonly status: CodexThreadGoalStatus;
  readonly usage?: AgentUsage;
};

export function nestedString(
  value: Record<string, unknown> | undefined,
  path: readonly string[],
): string | null {
  let current: unknown = value;
  for (const segment of path) {
    const record = readRecord(current);
    current = record?.[segment];
  }
  return typeof current === "string" ? current : null;
}

export function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

export function stringField(
  record: Record<string, unknown> | null,
  field: string,
): string | null {
  const value = record?.[field];
  return typeof value === "string" ? value : null;
}

export function stringArrayField(
  record: Record<string, unknown> | null,
  field: string,
): readonly string[] | null {
  const value = record?.[field];
  if (!Array.isArray(value)) return null;
  const values = value.filter((item): item is string => typeof item === "string");
  return values.length === value.length ? values : null;
}

export function agentMessageText(item: Record<string, unknown>): string | null {
  return stringifyContent(item.text) ?? stringifyContent(item.content);
}

function stringifyContent(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value;
  if (Array.isArray(value)) {
    const parts = value
      .map((entry) => stringifyContentEntry(entry))
      .filter((entry): entry is string => typeof entry === "string");
    return parts.length > 0 ? parts.join("") : null;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (!isAssistantContentRecord(record)) return null;
    return stringifyContent(
      record.text ?? record.output_text ?? record.content ?? record.output,
    );
  }
  return null;
}

function stringifyContentEntry(entry: unknown): string | null {
  if (typeof entry === "string") return entry;
  if (!entry || typeof entry !== "object") return null;
  const record = entry as Record<string, unknown>;
  if (!isAssistantContentRecord(record)) return null;
  return stringifyContent(
    record.text ?? record.output_text ?? record.content ?? record.output,
  );
}

function isAssistantContentRecord(record: Record<string, unknown>): boolean {
  const type = typeof record.type === "string" ? record.type : null;
  if (!hasAssistantRole(record)) return false;
  return (
    !type ||
    type === "agentMessage" ||
    type === "agent_message" ||
    type === "assistant_message" ||
    type === "message" ||
    type === "output_text" ||
    type === "text"
  );
}

function hasAssistantRole(record: Record<string, unknown>): boolean {
  const role = record.role;
  return typeof role !== "string" || role === "assistant";
}

export function readGoal(value: unknown): CodexThreadGoal | null {
  const goal = readRecord(value);
  if (!goal) return null;
  const threadId = stringField(goal, "threadId");
  const objective = stringField(goal, "objective");
  const status = stringField(goal, "status");
  if (!threadId || !objective || !isGoalStatus(status)) return null;
  return {
    threadId,
    objective,
    status,
    ...usageField(readUsage(goal)),
  };
}

export function readUsageFromRecords(
  ...values: readonly unknown[]
): AgentUsage | undefined {
  let usage: AgentUsage | undefined;
  for (const value of values) {
    usage = mergeAgentUsage(usage, readUsage(value));
  }
  return usage;
}

function readUsage(value: unknown): AgentUsage | undefined {
  const record = readRecord(value);
  if (!record) return undefined;
  const direct = normalizeUsageRecord(record);
  const nested = readUsageFromRecords(
    record.usage,
    record.tokenUsage,
    record.token_usage,
    record.tokens,
    record.metrics,
    readRecord(record.status)?.usage,
  );
  return mergeAgentUsage(direct, nested);
}

function normalizeUsageRecord(
  record: Record<string, unknown>,
): AgentUsage | undefined {
  const inputTokens = numberField(
    record,
    "inputTokens",
    "input_tokens",
    "promptTokens",
    "prompt_tokens",
    "totalInputTokens",
    "total_input_tokens",
  );
  const outputTokens = numberField(
    record,
    "outputTokens",
    "output_tokens",
    "completionTokens",
    "completion_tokens",
    "totalOutputTokens",
    "total_output_tokens",
  );
  const totalTokens =
    numberField(
      record,
      "totalTokens",
      "total_tokens",
      "tokensUsed",
      "tokens_used",
      "usedTokens",
      "used_tokens",
    ) ?? derivedTotalTokens(inputTokens, outputTokens);
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    totalTokens === undefined
  ) {
    return undefined;
  }
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
  };
}

function numberField(
  record: Record<string, unknown>,
  ...keys: readonly string[]
): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return value;
    }
  }
  return undefined;
}

function derivedTotalTokens(
  inputTokens: number | undefined,
  outputTokens: number | undefined,
): number | undefined {
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  return (inputTokens ?? 0) + (outputTokens ?? 0);
}

export function mergeAgentUsage(
  left: AgentUsage | undefined,
  right: AgentUsage | undefined,
): AgentUsage | undefined {
  if (!left) return right;
  if (!right) return left;
  const inputTokens = sumOptional(left.inputTokens, right.inputTokens);
  const outputTokens = sumOptional(left.outputTokens, right.outputTokens);
  const totalTokens = sumOptional(left.totalTokens, right.totalTokens);
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
  };
}

export function preferredUsage(
  turnUsage: AgentUsage | undefined,
  goalUsage: AgentUsage | undefined,
): AgentUsage | undefined {
  if (hasDetailedUsage(turnUsage)) return turnUsage;
  return turnUsage ?? goalUsage;
}

function hasDetailedUsage(usage: AgentUsage | undefined): boolean {
  return usage?.inputTokens !== undefined || usage?.outputTokens !== undefined;
}

export function usageField(
  usage: AgentUsage | undefined,
): { readonly usage: AgentUsage } | Record<string, never> {
  return usage === undefined ? {} : { usage };
}

function sumOptional(
  left: number | undefined,
  right: number | undefined,
): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return left + right;
}

export function isGoalStatus(
  value: string | null,
): value is CodexThreadGoalStatus {
  return (
    value === "active" ||
    value === "paused" ||
    value === "blocked" ||
    value === "usageLimited" ||
    value === "budgetLimited" ||
    value === "complete"
  );
}

export function isCodexAppServerReconnectProgressMessage(
  message: string,
): boolean {
  return /\breconnecting(?:\.{3}|…)?\s*\d+\s*\/\s*\d+\b/i.test(message);
}

export function safeMessage(error: unknown): string {
  if (error instanceof Error) return error.message.slice(-1000);
  if (typeof error === "string") return error.slice(-1000);
  const record = readRecord(error);
  if (typeof record?.message === "string") return record.message.slice(-1000);
  const nested = record ? readRecord(record.error) : null;
  if (typeof nested?.message === "string") return nested.message.slice(-1000);
  return "unknown";
}
