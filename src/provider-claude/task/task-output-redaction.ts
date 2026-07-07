import type {
  AgentToolCall,
  ProviderTaskEvent,
  ProviderTaskResult,
  ProviderTaskTelemetry,
  RedactorPort,
  RuntimeWarning,
} from "@vioxen/subscription-runtime/core";

export function redactProviderTaskEvent(
  event: ProviderTaskEvent,
  redactor: RedactorPort,
): ProviderTaskEvent {
  if (event.type === "text_delta") {
    const text = redactor.redact(event.text);
    redactor.assertNoKnownSecret(text, "claude stream text delta");
    return {
      ...event,
      text,
      ...(event.telemetry === undefined
        ? {}
        : { telemetry: redactTelemetry(event.telemetry, redactor) }),
    };
  }
  if (event.type === "tool_call") {
    return {
      ...event,
      toolCall: redactToolCall(event.toolCall, redactor),
      ...(event.telemetry === undefined
        ? {}
        : { telemetry: redactTelemetry(event.telemetry, redactor) }),
    };
  }
  if (event.type === "warning") {
    return {
      ...event,
      warning: redactRuntimeWarning(event.warning, redactor),
      ...(event.telemetry === undefined
        ? {}
        : { telemetry: redactTelemetry(event.telemetry, redactor) }),
    };
  }
  if (event.type === "completed") {
    return {
      ...event,
      result: redactProviderTaskResult(event.result, redactor),
      ...(event.telemetry === undefined
        ? {}
        : { telemetry: redactTelemetry(event.telemetry, redactor) }),
    };
  }
  if (event.telemetry === undefined) return event;
  return {
    ...event,
    telemetry: redactTelemetry(event.telemetry, redactor),
  };
}

export function redactProviderTaskResult(
  result: ProviderTaskResult,
  redactor: RedactorPort,
): ProviderTaskResult {
  if (result.status === "failed") {
    return {
      ...result,
      failure: {
        ...result.failure,
        safeMessage: redactor.redact(result.failure.safeMessage),
        ...(result.failure.details === undefined
          ? {}
          : { details: redactStringRecord(result.failure.details, redactor) }),
      },
      ...(result.telemetry === undefined
        ? {}
        : { telemetry: redactTelemetry(result.telemetry, redactor) }),
      warnings: result.warnings.map((warning) =>
        redactRuntimeWarning(warning, redactor)
      ),
    };
  }

  const outputText = redactor.redact(result.outputText);
  redactor.assertNoKnownSecret(outputText, "claude task output");
  const structuredOutput =
    result.structuredOutput === undefined
      ? undefined
      : redactStructured(result.structuredOutput, redactor);
  if (structuredOutput !== undefined) {
    redactor.assertNoKnownSecret(
      JSON.stringify(structuredOutput),
      "claude structured task output",
    );
  }
  return {
    ...result,
    outputText,
    ...(structuredOutput === undefined ? {} : { structuredOutput }),
    ...(result.telemetry === undefined
      ? {}
      : { telemetry: redactTelemetry(result.telemetry, redactor) }),
    warnings: result.warnings.map((warning) =>
      redactRuntimeWarning(warning, redactor)
    ),
  };
}

export function redactRuntimeWarning(
  warning: RuntimeWarning,
  redactor: RedactorPort,
): RuntimeWarning {
  return {
    ...warning,
    safeMessage: redactor.redact(warning.safeMessage),
    ...(warning.details === undefined
      ? {}
      : {
          details: Object.fromEntries(
            Object.entries(warning.details).map(([key, value]) => [
              key,
              redactor.redact(value),
            ]),
          ),
        }),
  };
}

function redactStringRecord(
  record: Readonly<Record<string, string>>,
  redactor: RedactorPort,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [
      key,
      redactor.redact(value),
    ]),
  );
}

function redactTelemetry(
  telemetry: ProviderTaskTelemetry,
  redactor: RedactorPort,
): ProviderTaskTelemetry {
  return {
    ...telemetry,
    ...(telemetry.toolCalls === undefined
      ? {}
      : {
          toolCalls: telemetry.toolCalls.map((toolCall) =>
            redactToolCall(toolCall, redactor)
          ),
        }),
  };
}

function redactToolCall(
  toolCall: AgentToolCall,
  redactor: RedactorPort,
): AgentToolCall {
  const safeInput =
    toolCall.safeInput === undefined
      ? undefined
      : redactStructured(toolCall.safeInput, redactor);
  if (safeInput !== undefined) {
    redactor.assertNoKnownSecret(
      JSON.stringify(safeInput),
      "claude tool call safe input",
    );
  }
  return {
    ...toolCall,
    ...(safeInput === undefined || !isRecord(safeInput) ? {} : { safeInput }),
    ...(toolCall.safeInputPreview === undefined
      ? {}
      : { safeInputPreview: redactor.redact(toolCall.safeInputPreview) }),
    ...(toolCall.safeOutputPreview === undefined
      ? {}
      : { safeOutputPreview: redactor.redact(toolCall.safeOutputPreview) }),
  };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
