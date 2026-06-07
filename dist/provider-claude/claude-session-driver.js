import { claudeProviderId, claudeSessionCapabilities, } from "./capabilities.js";
import { invalidClaudeSessionFailure, validateClaudeSessionArtifact, } from "./claude-session-codec.js";
import { classifyClaudeFailure } from "./failure-classifier.js";
export class ClaudeSessionDriver {
    providerId = claudeProviderId;
    supportedArtifactKinds = [
        "json-file",
        "env-token",
    ];
    capabilities = claudeSessionCapabilities;
    async validateSession(input) {
        try {
            const validation = validateClaudeSessionArtifact(input.session);
            registerClaudeSecrets(input.redactor, validation.session.oauthToken);
            return {
                status: "valid",
                warnings: validation.warnings,
            };
        }
        catch (error) {
            return {
                status: "invalid",
                failure: invalidClaudeSessionFailure(error),
            };
        }
    }
    async refreshSession(input) {
        const validation = await this.validateSession({
            session: input.session,
            redactor: input.redactor,
        });
        if (validation.status === "invalid") {
            return {
                artifact: input.session,
                providerState: validation.failure.reconnectRequired
                    ? "needs-reconnect"
                    : "permission-required",
                warnings: [],
            };
        }
        return {
            artifact: input.session,
            providerState: "unchanged",
            warnings: refreshUnsupportedWarning(validation.warnings),
        };
    }
    classifySessionFailure(error) {
        return classifyClaudeFailure(error);
    }
}
export function registerClaudeSecrets(redactor, oauthToken) {
    redactor.registerSecret(oauthToken, "claude-oauth-token");
}
function refreshUnsupportedWarning(warnings) {
    return [
        ...warnings,
        {
            code: "claude_session_refresh_unavailable",
            safeMessage: "Claude session refresh is not implemented by this adapter.",
        },
    ];
}
//# sourceMappingURL=claude-session-driver.js.map