export class ClaudeProviderFailureError extends Error {
    failure;
    name = "ClaudeProviderFailureError";
    constructor(failure) {
        super(failure.safeMessage);
        this.failure = failure;
    }
}
export function classifyClaudeFailure(error, options = {}) {
    const existingFailure = providerFailureFromUnknown(error);
    if (existingFailure)
        return redactProviderFailure(existingFailure, options.redactor);
    const message = error instanceof Error ? error.message : String(error);
    const state = classifyClaudeRuntimeFailure(message);
    switch (state) {
        case "task_cancelled":
            return {
                code: "task_cancelled",
                retryable: false,
                reconnectRequired: false,
                safeMessage: "Claude task was cancelled.",
                causeCategory: state,
            };
        case "task_timeout":
            return {
                code: "task_timeout",
                retryable: true,
                reconnectRequired: false,
                safeMessage: "Claude task timed out.",
                causeCategory: state,
            };
        case "provider_output_invalid":
            return {
                code: "provider_output_invalid",
                retryable: true,
                reconnectRequired: false,
                safeMessage: "Claude provider output was invalid.",
                causeCategory: state,
            };
        case "needs_reconnect":
            return {
                code: "needs_reconnect",
                retryable: false,
                reconnectRequired: true,
                safeMessage: "Claude session needs reconnect.",
                causeCategory: state,
            };
        case "quota_limited":
            return {
                code: "quota_limited",
                retryable: true,
                reconnectRequired: false,
                safeMessage: "Claude quota or usage limit was reached.",
                causeCategory: state,
            };
        case "permission_required":
            return {
                code: "permission_required",
                retryable: false,
                reconnectRequired: false,
                safeMessage: "Claude permission is required.",
                causeCategory: state,
            };
        default:
            return {
                code: "unknown_runtime_failure",
                retryable: true,
                reconnectRequired: false,
                safeMessage: "Claude runtime failed.",
                causeCategory: state,
                ...(options.redactor === undefined
                    ? {}
                    : { details: safeFailureDetails(message, options.redactor) }),
            };
    }
}
export function classifyClaudeRuntimeFailure(message) {
    const normalized = message.toLowerCase();
    if (isCancelled(normalized))
        return "task_cancelled";
    if (isTimeout(normalized))
        return "task_timeout";
    if (isInvalidOutput(normalized))
        return "provider_output_invalid";
    if (isQuotaLimited(normalized))
        return "quota_limited";
    if (isReconnectRequired(normalized))
        return "needs_reconnect";
    if (isPermissionRequired(normalized))
        return "permission_required";
    return "unknown_runtime_failure";
}
function isCancelled(normalized) {
    return (normalized.includes("claude_bg_aborted") ||
        normalized.includes("claude_task_aborted") ||
        normalized.includes("node_process_runner_aborted") ||
        normalized.includes("aborterror") ||
        /\baborted\b/.test(normalized));
}
function isTimeout(normalized) {
    return (normalized.includes("claude_bg_timeout") ||
        normalized.includes("claude_task_timeout") ||
        normalized.includes("node_process_runner_timeout") ||
        /\btimeout\b/.test(normalized) ||
        /\btimed out\b/.test(normalized));
}
function isInvalidOutput(normalized) {
    return (normalized.includes("claude_output_invalid") ||
        normalized.includes("claude_json_invalid") ||
        normalized.includes("claude_final_message_missing") ||
        normalized.includes("claude_structured_output_invalid") ||
        normalized.includes("claude_output_too_large"));
}
function isReconnectRequired(normalized) {
    return (normalized.includes("claude_code_oauth_token") ||
        normalized.includes("oauth") ||
        normalized.includes("unauthorized") ||
        normalized.includes("invalid_grant") ||
        normalized.includes("login required") ||
        normalized.includes("not authenticated"));
}
function isQuotaLimited(normalized) {
    return (/\b(?:429|too many requests|rate[_ -]?limit(?:ed| exceeded)?|rate_limit_exceeded)\b/.test(normalized) ||
        /\b(?:usage[_ -]?limit(?: reached| exceeded)?|limit reached|quota_exceeded|insufficient_quota)\b/.test(normalized) ||
        /\byou(?:'|’)ve hit your usage limit\b/.test(normalized) ||
        /\b(?:purchase|buy|add|get) more credits\b/.test(normalized));
}
function isPermissionRequired(normalized) {
    return (normalized.includes("permission") ||
        normalized.includes("forbidden") ||
        normalized.includes("approval required") ||
        normalized.includes("resource not accessible"));
}
function providerFailureFromUnknown(error) {
    if (error instanceof ClaudeProviderFailureError)
        return error.failure;
    if (!isRecord(error))
        return null;
    const failure = error.failure;
    if (!isProviderFailure(failure))
        return null;
    return failure;
}
function isProviderFailure(value) {
    return (isRecord(value) &&
        isProviderFailureCode(value.code) &&
        typeof value.retryable === "boolean" &&
        typeof value.reconnectRequired === "boolean" &&
        typeof value.safeMessage === "string");
}
function isProviderFailureCode(value) {
    return typeof value === "string" && [
        "needs_reconnect",
        "quota_limited",
        "permission_required",
        "provider_session_invalid",
        "provider_output_invalid",
        "task_mode_unsupported",
        "task_cancelled",
        "task_timeout",
        "stale_generation",
        "backend_unavailable",
        "unknown_runtime_failure",
    ].includes(value);
}
function redactProviderFailure(failure, redactor) {
    if (redactor === undefined)
        return failure;
    return {
        ...failure,
        safeMessage: redactor.redact(failure.safeMessage),
        ...(failure.details === undefined
            ? {}
            : { details: redactDetails(failure.details, redactor) }),
    };
}
function safeFailureDetails(message, redactor) {
    return {
        runtimeMessage: truncateDetail(redactor.redact(message)),
    };
}
function redactDetails(details, redactor) {
    return Object.fromEntries(Object.entries(details).map(([key, value]) => [
        key,
        truncateDetail(redactor.redact(value)),
    ]));
}
function truncateDetail(value) {
    const maxLength = 1000;
    return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
//# sourceMappingURL=failure-classifier.js.map