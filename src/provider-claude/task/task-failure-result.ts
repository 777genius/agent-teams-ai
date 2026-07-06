import type {
  ProviderFailure,
  ProviderTaskResult,
} from "@vioxen/subscription-runtime/core";

export function failedClaudeTask(
  failure: ProviderFailure,
  startedAt: number,
): Extract<ProviderTaskResult, { readonly status: "failed" }> {
  return {
    status: "failed",
    failure,
    telemetry: {
      durationMs: Date.now() - startedAt,
      finishReason: finishReasonForFailure(failure.code),
    },
    warnings: [],
  };
}

function finishReasonForFailure(
  code: ProviderFailure["code"],
): "cancelled" | "timeout" | "provider_error" {
  if (code === "task_cancelled") return "cancelled";
  if (code === "task_timeout") return "timeout";
  return "provider_error";
}
