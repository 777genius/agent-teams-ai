import type { ProviderFailure } from "@vioxen/subscription-runtime/core";
import { classifyCodexRuntimeFailure } from "./codex-cli-domain";

export function classifyCodexFailure(error: unknown): ProviderFailure {
  const message = error instanceof Error ? error.message : String(error);
  const state = classifyCodexRuntimeFailure(message);

  switch (state) {
    case "task_cancelled":
      return {
        code: "task_cancelled",
        retryable: false,
        reconnectRequired: false,
        safeMessage: "Codex task was cancelled.",
        causeCategory: state,
      };
    case "task_timeout":
      return {
        code: "task_timeout",
        retryable: true,
        reconnectRequired: false,
        safeMessage: "Codex task timed out.",
        causeCategory: state,
      };
    case "provider_output_invalid":
      return {
        code: "provider_output_invalid",
        retryable: true,
        reconnectRequired: false,
        safeMessage: "Codex provider output was invalid.",
        causeCategory: state,
      };
    case "needs_reconnect":
      return {
        code: "needs_reconnect",
        retryable: false,
        reconnectRequired: true,
        safeMessage: "Codex session needs reconnect.",
        causeCategory: state,
      };
    case "quota_limited":
      return {
        code: "quota_limited",
        retryable: true,
        reconnectRequired: false,
        safeMessage: "Codex quota or billing limit was reached.",
        causeCategory: state,
      };
    case "permission_required":
      return {
        code: "permission_required",
        retryable: false,
        reconnectRequired: false,
        safeMessage: "Codex permission is required.",
        causeCategory: state,
      };
    default:
      return {
        code: "unknown_runtime_failure",
        retryable: true,
        reconnectRequired: false,
        safeMessage: "Codex runtime failed.",
        causeCategory: state,
      };
  }
}
