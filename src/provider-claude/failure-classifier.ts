import type { ProviderFailure } from "@vioxen/subscription-runtime/core";

export function classifyClaudeFailure(error: unknown): ProviderFailure {
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
      };
  }
}

export function classifyClaudeRuntimeFailure(message: string): string {
  const normalized = message.toLowerCase();
  if (isCancelled(normalized)) return "task_cancelled";
  if (isTimeout(normalized)) return "task_timeout";
  if (isInvalidOutput(normalized)) return "provider_output_invalid";
  if (isQuotaLimited(normalized)) return "quota_limited";
  if (isReconnectRequired(normalized)) return "needs_reconnect";
  if (isPermissionRequired(normalized)) return "permission_required";
  return "unknown_runtime_failure";
}

function isCancelled(normalized: string): boolean {
  return (
    normalized.includes("claude_bg_aborted") ||
    normalized.includes("claude_task_aborted") ||
    normalized.includes("node_process_runner_aborted") ||
    normalized.includes("aborterror") ||
    /\baborted\b/.test(normalized)
  );
}

function isTimeout(normalized: string): boolean {
  return (
    normalized.includes("claude_bg_timeout") ||
    normalized.includes("claude_task_timeout") ||
    normalized.includes("node_process_runner_timeout") ||
    /\btimeout\b/.test(normalized) ||
    /\btimed out\b/.test(normalized)
  );
}

function isInvalidOutput(normalized: string): boolean {
  return (
    normalized.includes("claude_output_invalid") ||
    normalized.includes("claude_json_invalid") ||
    normalized.includes("claude_final_message_missing") ||
    normalized.includes("claude_structured_output_invalid") ||
    normalized.includes("claude_output_too_large")
  );
}

function isReconnectRequired(normalized: string): boolean {
  return (
    normalized.includes("claude_code_oauth_token") ||
    normalized.includes("oauth") ||
    normalized.includes("unauthorized") ||
    normalized.includes("invalid_grant") ||
    normalized.includes("login required") ||
    normalized.includes("not authenticated")
  );
}

function isQuotaLimited(normalized: string): boolean {
  return (
    /\b(?:429|too many requests|rate[_ -]?limit(?:ed| exceeded)?|rate_limit_exceeded)\b/.test(
      normalized,
    ) ||
    /\b(?:usage[_ -]?limit(?: reached| exceeded)?|limit reached|quota_exceeded|insufficient_quota)\b/.test(
      normalized,
    ) ||
    /\byou(?:'|’)ve hit your usage limit\b/.test(normalized) ||
    /\b(?:purchase|buy|add|get) more credits\b/.test(normalized)
  );
}

function isPermissionRequired(normalized: string): boolean {
  return (
    normalized.includes("permission") ||
    normalized.includes("forbidden") ||
    normalized.includes("approval required") ||
    normalized.includes("resource not accessible")
  );
}
