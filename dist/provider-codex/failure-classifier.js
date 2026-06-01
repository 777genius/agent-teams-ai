import { classifyCodexRuntimeFailure } from "./codex-cli-domain.js";
export function classifyCodexFailure(error) {
    const message = error instanceof Error ? error.message : String(error);
    const state = classifyCodexRuntimeFailure(message);
    switch (state) {
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
//# sourceMappingURL=failure-classifier.js.map