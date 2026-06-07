const diagnosticDetailPreviewLimit = 2000;
export function resultText(result) {
    if (result.text !== undefined)
        return result.text;
    if (typeof result.output === "string")
        return result.output;
    if (result.output !== undefined)
        return JSON.stringify(result.output);
    if (result.summary !== undefined)
        return result.summary;
    return result.detail ?? "";
}
export function parseStructuredJson(value) {
    const direct = parseJson(value);
    if (direct !== null)
        return direct;
    const fence = value.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence?.[1]) {
        const parsed = parseJson(fence[1].trim());
        if (parsed !== null)
            return parsed;
    }
    return extractBalancedJson(value);
}
export function toolUseCall(event, redactor) {
    const safeInput = safeInputRecord(event.input, redactor);
    return {
        ...(typeof event.id === "string" ? { id: event.id } : {}),
        name: event.toolName,
        status: "started",
        ...(safeInput === undefined ? {} : { safeInput }),
        ...(safeInput === undefined ? {} : { safeInputPreview: stringifyPreview(safeInput, redactor) }),
    };
}
export function toolResultCall(event, redactor) {
    const safeInput = isRecord(event.output)
        ? safeInputRecord(event.output, redactor)
        : undefined;
    return {
        ...(typeof event.id === "string" ? { id: event.id } : {}),
        name: event.toolName ?? "unknown",
        status: event.isError === true ? "failed" : "completed",
        ...(safeInput === undefined ? {} : { safeInput }),
        safeInputPreview: stringifyPreview(event.output, redactor),
    };
}
export function runtimeUsage(usage) {
    return {
        ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
        ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
        ...(usage.totalTokens === undefined ? {} : { totalTokens: usage.totalTokens }),
    };
}
export function diagnosticWarning(event, redactor) {
    return {
        code: event.code ?? `claude_${event.level ?? "diagnostic"}`,
        safeMessage: redactor.redact(event.message ?? "Claude runtime diagnostic."),
        ...(isRecord(event.details)
            ? { details: stringRecordPreview(event.details, redactor) }
            : {}),
    };
}
export function isAssistantMessageEvent(event) {
    return event.type === "assistant_message" && "text" in event;
}
export function isToolUseEvent(event) {
    return event.type === "tool_use" && "toolName" in event;
}
export function isToolResultEvent(event) {
    return event.type === "tool_result";
}
export function isUsageEvent(event) {
    return event.type === "usage" && "usage" in event;
}
export function isDiagnosticEvent(event) {
    return event.type === "diagnostic";
}
export function isResultAvailableEvent(event) {
    return event.type === "result_available" && "result" in event;
}
function parseJson(value) {
    try {
        return JSON.parse(value);
    }
    catch {
        return null;
    }
}
function extractBalancedJson(value) {
    const start = value.indexOf("{");
    if (start === -1)
        return null;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let index = start; index < value.length; index++) {
        const char = value[index];
        if (escape) {
            escape = false;
            continue;
        }
        if (char === "\\" && inString) {
            escape = true;
            continue;
        }
        if (char === "\"") {
            inString = !inString;
            continue;
        }
        if (inString)
            continue;
        if (char === "{")
            depth++;
        if (char === "}") {
            depth--;
            if (depth === 0) {
                const parsed = parseJson(value.slice(start, index + 1));
                if (parsed !== null)
                    return parsed;
                return extractBalancedJson(value.slice(index + 1));
            }
        }
    }
    return null;
}
function safeInputRecord(value, redactor) {
    const redacted = redactStructured(value, redactor);
    return isRecord(redacted) ? redacted : undefined;
}
function redactStructured(value, redactor) {
    if (typeof value === "string")
        return redactor.redact(value);
    if (Array.isArray(value)) {
        return value.map((item) => redactStructured(item, redactor));
    }
    if (isRecord(value)) {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [
            key,
            redactStructured(item, redactor),
        ]));
    }
    return value;
}
function stringifyPreview(value, redactor) {
    const raw = typeof value === "string" ? value : JSON.stringify(value);
    return redactor.redact(raw ?? "").slice(0, 2000);
}
function stringRecordPreview(value, redactor) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
        key,
        redactor.redact(typeof item === "string" ? item : JSON.stringify(item) ?? "")
            .slice(0, diagnosticDetailPreviewLimit),
    ]));
}
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
//# sourceMappingURL=claude-runtime-event-mapper.js.map