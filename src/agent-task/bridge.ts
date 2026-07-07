import { pathToFileURL } from "node:url";
import type {
  ProviderTaskEvent,
  ProviderTaskResult,
} from "@vioxen/subscription-runtime/core";
import {
  AgentTaskProtocolError,
  agentTaskProtocolVersion,
  makeAgentTaskFailure,
  parseAgentTaskEvent,
  parseAgentTaskRequest,
  parseAgentTaskResult,
  providerTaskEventToAgentTaskEvent,
  providerTaskResultToAgentTaskResult,
  type AgentTaskBridgeRunResult,
  type AgentTaskEvent,
  type AgentTaskRequest,
  type AgentTaskResult,
} from "./task-codec";
import {
  type AgentTaskHandler,
  type AgentTaskHandlerContext,
  type AgentTaskRunFunction,
  type AgentTaskStreamFunction,
} from "./task-codec/ports";

export type AgentTaskBridgeOptions = {
  readonly abortSignal?: AbortSignal;
  readonly now?: () => Date;
  onEvent?(event: AgentTaskEvent): void | Promise<void>;
};

export async function runAgentTaskBridge(
  requestValue: unknown,
  handler: AgentTaskHandler | AgentTaskRunFunction,
  options: AgentTaskBridgeOptions = {},
): Promise<AgentTaskBridgeRunResult> {
  const request = parseAgentTaskRequest(requestValue);
  const normalizedHandler = normalizeHandler(handler);
  const events: AgentTaskEvent[] = [];
  let startedEmitted = false;
  let terminalFromEmit: AgentTaskResult | null = null;
  const emit = async (
    event: AgentTaskEvent | ProviderTaskEvent,
  ): Promise<void> => {
    const normalized = normalizeEvent(event);
    if (normalized.type === "started") startedEmitted = true;
    if (normalized.type === "completed") terminalFromEmit = normalized.result;
    events.push(normalized);
    await options.onEvent?.(normalized);
  };
  const emitStarted = async (occurredAt = nowIso(options)): Promise<void> => {
    if (startedEmitted) return;
    await emit({
      protocolVersion: agentTaskProtocolVersion,
      type: "started",
      occurredAt,
    });
  };
  const context = createContext({ ...options, emit });

  try {
    if (normalizedHandler.streamTask) {
      let yieldedTerminal: AgentTaskResult | null = null;
      for await (const event of normalizedHandler.streamTask(request, context)) {
        const normalized = normalizeEvent(event);
        if (normalized.type === "started" && startedEmitted) continue;
        if (normalized.type === "started") {
          await emit(normalized);
          continue;
        }
        await emitStarted(normalized.occurredAt);
        await emit(normalized);
        if (normalized.type === "completed") yieldedTerminal = normalized.result;
      }
      const terminal = yieldedTerminal ?? terminalFromEmit;
      if (terminal) return { request, result: terminal, events };
      await emitStarted();
      const result = makeBridgeFailure(
        "provider_output_invalid",
        "Stream ended without a completed event.",
      );
      await emit({
        protocolVersion: agentTaskProtocolVersion,
        type: "completed",
        occurredAt: nowIso(options),
        result,
      });
      return {
        request,
        result,
        events,
      };
    }

    await emitStarted();
    if (!normalizedHandler.runTask) {
      return {
        request,
        result: makeBridgeFailure(
          "provider_output_invalid",
          "Agent task handler has no runTask implementation.",
        ),
        events,
      };
    }

    const result = normalizeResult(
      await normalizedHandler.runTask(request, context),
    );
    await emit({
      protocolVersion: agentTaskProtocolVersion,
      type: "completed",
      occurredAt: nowIso(options),
      result,
    });
    return { request, result, events };
  } catch (error) {
    await emitStarted();
    const result = makeBridgeFailure(
      error instanceof AgentTaskProtocolError
        ? "provider_output_invalid"
        : "unknown_runtime_failure",
      error instanceof Error ? error.message : "Agent task handler failed.",
    );
    await emit({
      protocolVersion: agentTaskProtocolVersion,
      type: "completed",
      occurredAt: nowIso(options),
      result,
    });
    return { request, result, events };
  }
}

export async function* streamAgentTaskBridge(
  requestValue: unknown,
  handler: AgentTaskHandler | AgentTaskRunFunction,
  options: Omit<AgentTaskBridgeOptions, "onEvent"> = {},
): AsyncIterable<AgentTaskEvent> {
  const queued: AgentTaskEvent[] = [];
  let done = false;
  let failed: unknown;
  let wake: (() => void) | null = null;
  const notify = (): void => {
    wake?.();
    wake = null;
  };

  const run = runAgentTaskBridge(requestValue, handler, {
    ...options,
    onEvent: (event) => {
      queued.push(event);
      notify();
    },
  }).then(
    () => {
      done = true;
      notify();
    },
    (error: unknown) => {
      failed = error;
      done = true;
      notify();
    },
  );

  while (!done || queued.length > 0) {
    if (queued.length === 0) {
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
      continue;
    }
    yield queued.shift() as AgentTaskEvent;
  }

  await run;
  if (failed !== undefined) {
    throw failed;
  }
}

export async function loadAgentTaskHandler(
  specifier: string,
  input?: { readonly cwd?: string },
): Promise<AgentTaskHandler | AgentTaskRunFunction> {
  const module = await import(resolveImportSpecifier(specifier, input?.cwd));
  const candidate =
    module.runAgentTask ??
    module.handler ??
    module.default ??
    module.runTask ??
    module.streamTask;
  if (typeof candidate === "function") return candidate as AgentTaskRunFunction;
  if (candidate && typeof candidate === "object") {
    const maybeHandler = candidate as Partial<AgentTaskHandler>;
    if (
      typeof maybeHandler.runTask === "function" ||
      typeof maybeHandler.streamTask === "function"
    ) {
      return maybeHandler as AgentTaskHandler;
    }
  }
  if (
    typeof module.runTask === "function" ||
    typeof module.streamTask === "function"
  ) {
    return {
      ...(typeof module.runTask === "function"
        ? { runTask: module.runTask as AgentTaskRunFunction }
        : {}),
      ...(typeof module.streamTask === "function"
        ? { streamTask: module.streamTask as AgentTaskStreamFunction }
        : {}),
    };
  }
  throw new AgentTaskProtocolError(
    "agent_task_handler_invalid",
    "Handler module must export runAgentTask, handler, default, runTask, or streamTask.",
  );
}

function normalizeHandler(
  handler: AgentTaskHandler | AgentTaskRunFunction,
): AgentTaskHandler {
  if (typeof handler === "function") return { runTask: handler };
  if (
    typeof handler.runTask === "function" ||
    typeof handler.streamTask === "function"
  ) {
    return handler;
  }
  throw new AgentTaskProtocolError(
    "agent_task_handler_invalid",
    "Agent task handler must be a function or an object with runTask/streamTask.",
  );
}

function createContext(input: {
  readonly abortSignal?: AbortSignal;
  emit(event: AgentTaskEvent | ProviderTaskEvent): Promise<void>;
}): AgentTaskHandlerContext {
  return {
    abortSignal: input.abortSignal ?? new AbortController().signal,
    emit: input.emit,
  };
}

function normalizeResult(
  value: AgentTaskResult | ProviderTaskResult,
): AgentTaskResult {
  if (isAgentTaskResultLike(value)) return parseAgentTaskResult(value);
  return providerTaskResultToAgentTaskResult(value);
}

function normalizeEvent(
  value: AgentTaskEvent | ProviderTaskEvent,
): AgentTaskEvent {
  if (isAgentTaskEventLike(value)) return parseAgentTaskEvent(value);
  return providerTaskEventToAgentTaskEvent(value);
}

function isAgentTaskResultLike(value: unknown): value is AgentTaskResult {
  return hasProtocolVersion(value) && hasStringProperty(value, "status");
}

function isAgentTaskEventLike(value: unknown): value is AgentTaskEvent {
  return hasProtocolVersion(value) && hasStringProperty(value, "type");
}

function hasProtocolVersion(
  value: unknown,
): value is { readonly protocolVersion: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    "protocolVersion" in value
  );
}

function hasStringProperty(value: unknown, key: string): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>)[key] === "string"
  );
}

function makeBridgeFailure(
  code: Parameters<typeof makeAgentTaskFailure>[0],
  safeMessage: string,
): AgentTaskResult {
  return {
    protocolVersion: agentTaskProtocolVersion,
    status: "failed",
    failure: makeAgentTaskFailure(code, safeMessage),
    warnings: [],
  };
}

function nowIso(options: AgentTaskBridgeOptions): string {
  return (options.now?.() ?? new Date()).toISOString();
}

function resolveImportSpecifier(specifier: string, cwd = process.cwd()): string {
  if (
    specifier.startsWith("file:") ||
    specifier.startsWith("node:") ||
    specifier.startsWith("data:") ||
    /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(specifier)
  ) {
    return specifier;
  }
  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    const path = specifier.startsWith("/")
      ? specifier
      : new URL(specifier, pathToFileURL(`${cwd}/`)).pathname;
    return pathToFileURL(path).href;
  }
  return specifier;
}
