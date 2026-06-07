import type { ProviderFailure, RuntimeWarning, SessionArtifact } from "@vioxen/subscription-runtime/core";
export type ClaudeOAuthSession = {
    readonly authMode: "oauth";
    readonly oauthToken: string;
    readonly configDir?: string;
    readonly refreshedAt?: string;
    readonly expiresAt?: string;
    readonly metadata?: Readonly<Record<string, string>>;
};
export type ClaudeSessionValidation = {
    readonly session: ClaudeOAuthSession;
    readonly warnings: readonly RuntimeWarning[];
};
export declare function sessionArtifactFromClaudeOAuth(input: {
    readonly oauthToken: string;
    readonly configDir?: string;
    readonly refreshedAt?: string;
    readonly expiresAt?: string;
    readonly metadata?: Readonly<Record<string, string>>;
}): SessionArtifact;
export declare function validateClaudeSessionArtifact(artifact: SessionArtifact): ClaudeSessionValidation;
export declare function invalidClaudeSessionFailure(error: unknown): ProviderFailure;
//# sourceMappingURL=claude-session-codec.d.ts.map