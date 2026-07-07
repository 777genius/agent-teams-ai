import type {
  AgentToolCall,
  AgentUsage,
  RedactorPort,
  RuntimeWarning,
} from "@vioxen/subscription-runtime/core";
import { parseStructuredJson } from "./structured-json";

export { parseStructuredJson };

const diagnosticDetailPreviewLimit = 2000;

export type ClaudeRuntimeEventLike =
  | { readonly type: "assistant_message"; readonly text: string }
  | {
      readonly type: "tool_use";
      readonly id?: string;
      readonly toolName: string;
      readonly input?: unknown;
    }
  | {
      readonly type: "tool_result";
      readonly id?: string;
      readonly toolName?: string;
      readonly output?: unknown;
      readonly isError?: boolean;
    }
  | {
      readonly type: "usage";
      readonly usage: {
        readonly inputTokens?: number;
        readonly outputTokens?: number;
        readonly totalTokens?: number;
      };
    }
  | {
      readonly type: "diagnostic";
      readonly level?: string;
      readonly message?: string;
      readonly code?: string;
      readonly details?: unknown;
    }
  | {
      readonly type: "result_available";
      readonly result: {
        readonly text?: string;
        readonly output?: unknown;
        readonly detail?: string;
        readonly summary?: string;
        readonly usage?: {
          readonly inputTokens?: number;
          readonly outputTokens?: number;
          readonly totalTokens?: number;
        };
      };
    }
  | { readonly type: string };

export function resultText(result: {
  readonly text?: string;
  readonly output?: unknown;
  readonly detail?: string;
  readonly summary?: string;
}): string {
  if (result.text !== undefined) return result.text;
  if (typeof result.output === "string") return result.output;
  if (result.output !== undefined) return JSON.stringify(result.output);
  if (result.summary !== undefined) return result.summary;
  return result.detail ?? "";
}

export function toolUseCall(
  event: Extract<ClaudeRuntimeEventLike, { readonly type: "tool_use" }>,
  redactor: RedactorPort,
): AgentToolCall {
  const safeInput = safeInputRecord(event.input, redactor);
  return {
    ...(typeof event.id === "string" ? { id: event.id } : {}),
    name: event.toolName,
    status: "started",
    ...(safeInput === undefined ? {} : { safeInput }),
    ...(safeInput === undefined ? {} : { safeInputPreview: stringifyPreview(safeInput, redactor) }),
  };
}

export function toolResultCall(
  event: Extract<ClaudeRuntimeEventLike, { readonly type: "tool_result" }>,
  redactor: RedactorPort,
): AgentToolCall {
  const safeInput = isRecord(event.output)
    ? safeInputRecord(event.output, redactor)
    : undefined;
  return {
    ...(typeof event.id === "string" ? { id: event.id } : {}),
    name: event.toolName ?? "unknown",
    status: event.isError === true ? "failed" : "completed",
    ...(safeInput === undefined ? {} : { safeInput }),
    safeInputPreview: stringifyPreview(event.output, redactor),
    safeOutputPreview: stringifyPreview(event.output, redactor),
  };
}

export function runtimeUsage(usage: {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
}): AgentUsage {
  return {
    ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
    ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
    ...(usage.totalTokens === undefined ? {} : { totalTokens: usage.totalTokens }),
  };
}

export function diagnosticWarning(
  event: Extract<ClaudeRuntimeEventLike, { readonly type: "diagnostic" }>,
  redactor: RedactorPort,
): RuntimeWarning {
  return {
    code: event.code ?? `claude_${event.level ?? "diagnostic"}`,
    safeMessage: redactor.redact(event.message ?? "Claude runtime diagnostic."),
    ...(isRecord(event.details)
      ? { details: stringRecordPreview(event.details, redactor) }
      : {}),
  };
}

export function isAssistantMessageEvent(
  event: ClaudeRuntimeEventLike,
): event is Extract<ClaudeRuntimeEventLike, { readonly type: "assistant_message" }> {
  return event.type === "assistant_message" && "text" in event;
}

export function isToolUseEvent(
  event: ClaudeRuntimeEventLike,
): event is Extract<ClaudeRuntimeEventLike, { readonly type: "tool_use" }> {
  return event.type === "tool_use" && "toolName" in event;
}

export function isToolResultEvent(
  event: ClaudeRuntimeEventLike,
): event is Extract<ClaudeRuntimeEventLike, { readonly type: "tool_result" }> {
  return event.type === "tool_result";
}

export function isUsageEvent(
  event: ClaudeRuntimeEventLike,
): event is Extract<ClaudeRuntimeEventLike, { readonly type: "usage" }> {
  return event.type === "usage" && "usage" in event;
}

export function isDiagnosticEvent(
  event: ClaudeRuntimeEventLike,
): event is Extract<ClaudeRuntimeEventLike, { readonly type: "diagnostic" }> {
  return event.type === "diagnostic";
}

export function isResultAvailableEvent(
  event: ClaudeRuntimeEventLike,
): event is Extract<ClaudeRuntimeEventLike, { readonly type: "result_available" }> {
  return event.type === "result_available" && "result" in event;
}

function safeInputRecord(
  value: unknown,
  redactor: RedactorPort,
): Readonly<Record<string, unknown>> | undefined {
  const redacted = redactStructured(value, redactor);
  return isRecord(redacted) ? redacted : undefined;
}

function redactStructured(value: unknown, redactor: RedactorPort): unknown {
  if (typeof value === "string") return redactor.redact(value);
  if (Array.isArray(value)) {
    return value.map((item) => redactStructured(item, redactor));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        redactStructured(item, redactor),
      ]),
    );
  }
  return value;
}

function stringifyPreview(value: unknown, redactor: RedactorPort): string {
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  return redactor.redact(raw ?? "").slice(0, 2000);
}

function stringRecordPreview(
  value: Record<string, unknown>,
  redactor: RedactorPort,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      redactor.redact(typeof item === "string" ? item : JSON.stringify(item) ?? "")
        .slice(0, diagnosticDetailPreviewLimit),
    ]),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
