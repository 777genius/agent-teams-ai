import { claudeProviderId, claudeSessionFormatVersion } from "./capabilities.js";
import { classifyClaudeFailure } from "./failure-classifier.js";
export function sessionArtifactFromClaudeOAuth(input) {
    const payload = {
        authMode: "oauth",
        oauthToken: input.oauthToken,
        ...(input.configDir === undefined ? {} : { configDir: input.configDir }),
        ...(input.refreshedAt === undefined
            ? {}
            : { refreshedAt: input.refreshedAt }),
        ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    };
    return {
        kind: "json-file",
        providerId: claudeProviderId,
        formatVersion: claudeSessionFormatVersion,
        bytes: new TextEncoder().encode(JSON.stringify(payload)),
        contentType: "application/json",
    };
}
export function validateClaudeSessionArtifact(artifact) {
    if (artifact.providerId !== claudeProviderId) {
        throw new Error("claude_session_provider_mismatch");
    }
    const text = new TextDecoder().decode(artifact.bytes);
    if (artifact.kind === "env-token") {
        const oauthToken = text.trim();
        if (!oauthToken)
            throw new Error("claude_oauth_token_missing");
        return {
            session: {
                authMode: "oauth",
                oauthToken,
            },
            warnings: [],
        };
    }
    if (artifact.kind !== "json-file") {
        throw new Error("claude_session_artifact_kind_unsupported");
    }
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        throw new Error("claude_session_json_invalid");
    }
    const session = parseClaudeOAuthSession(parsed);
    return {
        session,
        warnings: freshnessWarnings(session),
    };
}
export function invalidClaudeSessionFailure(error) {
    const classified = classifyClaudeFailure(error);
    return classified.code === "unknown_runtime_failure"
        ? {
            code: "provider_session_invalid",
            retryable: false,
            reconnectRequired: true,
            safeMessage: "Claude session is invalid.",
            causeCategory: "provider_session_invalid",
        }
        : classified;
}
function parseClaudeOAuthSession(value) {
    if (!isObject(value))
        throw new Error("claude_session_shape_invalid");
    if (value.authMode !== "oauth") {
        throw new Error("claude_session_auth_mode_invalid");
    }
    if (typeof value.oauthToken !== "string" || value.oauthToken.length === 0) {
        throw new Error("claude_oauth_token_missing");
    }
    assertOptionalString(value.configDir, "claude_config_dir_invalid");
    assertOptionalString(value.refreshedAt, "claude_refreshed_at_invalid");
    assertOptionalString(value.expiresAt, "claude_expires_at_invalid");
    if (value.metadata !== undefined && !isStringRecord(value.metadata)) {
        throw new Error("claude_session_metadata_invalid");
    }
    return value;
}
function freshnessWarnings(session) {
    if (!session.expiresAt)
        return [];
    const expiresAtMs = Date.parse(session.expiresAt);
    if (!Number.isFinite(expiresAtMs)) {
        return [
            {
                code: "claude_session_expiry_unparseable",
                safeMessage: "Claude session expiry could not be parsed.",
            },
        ];
    }
    if (expiresAtMs <= Date.now()) {
        return [
            {
                code: "claude_session_expired",
                safeMessage: "Claude session appears expired.",
            },
        ];
    }
    return [];
}
function assertOptionalString(value, code) {
    if (value !== undefined && typeof value !== "string") {
        throw new Error(code);
    }
}
function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isStringRecord(value) {
    if (!isObject(value))
        return false;
    return Object.values(value).every((entry) => typeof entry === "string");
}
//# sourceMappingURL=claude-session-codec.js.map