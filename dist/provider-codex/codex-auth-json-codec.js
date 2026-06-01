import { compactCodexAuthJson, validateCodexAuthJsonBytes, } from "./codex-cli-domain.js";
import { codexAuthJsonFormatVersion, codexProviderId } from "./capabilities.js";
const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();
export function sessionArtifactFromCodexAuthJson(authJsonBytes) {
    const compact = compactCodexAuthJson({ authJsonBytes }).compactAuthJsonBytes;
    return {
        kind: "json-file",
        providerId: codexProviderId,
        formatVersion: codexAuthJsonFormatVersion,
        bytes: textEncoder.encode(compact),
        contentType: "application/json",
    };
}
export function codexAuthJsonFromArtifact(session) {
    if (session.providerId !== codexProviderId) {
        throw new Error("codex_session_provider_mismatch");
    }
    if (session.kind !== "json-file") {
        throw new Error("codex_session_artifact_kind_mismatch");
    }
    if (session.formatVersion !== codexAuthJsonFormatVersion) {
        throw new Error("codex_session_format_version_mismatch");
    }
    return textDecoder.decode(session.bytes);
}
export function validateCodexSessionArtifact(session) {
    try {
        const authJsonBytes = codexAuthJsonFromArtifact(session);
        const validation = validateCodexAuthJsonBytes({ authJsonBytes });
        return {
            status: "valid",
            warnings: validation.warnings.map((warning) => {
                return {
                    code: warning,
                    safeMessage: `Codex auth warning: ${warning}`,
                };
            }),
        };
    }
    catch (error) {
        return {
            status: "invalid",
            failure: codexValidationFailure(error),
        };
    }
}
export function codexValidationFailure(error) {
    const message = error instanceof Error ? error.message : "unknown_auth_state";
    const reconnectRequired = message.includes("auth_json") ||
        message.includes("provider_mismatch") ||
        message.includes("format_version");
    return {
        code: reconnectRequired
            ? "provider_session_invalid"
            : "unknown_runtime_failure",
        retryable: false,
        reconnectRequired,
        safeMessage: "Codex session artifact is invalid and must be reconnected.",
        causeCategory: safeCauseCategory(message),
    };
}
function safeCauseCategory(message) {
    return /^[a-z0-9_:-]{1,80}$/i.test(message) ? message : "codex_validation";
}
//# sourceMappingURL=codex-auth-json-codec.js.map