import type { ProviderFailure, ProviderSessionDriver, RedactorPort, RefreshedSession, RunnerPort, SessionArtifact, SessionValidationResult, WorkspaceHandle } from "@vioxen/subscription-runtime/core";
export declare class ClaudeSessionDriver implements ProviderSessionDriver {
    readonly providerId = "claude";
    readonly supportedArtifactKinds: readonly SessionArtifact["kind"][];
    readonly capabilities: import("@vioxen/subscription-runtime/core").ProviderCapabilities;
    validateSession(input: {
        readonly session: SessionArtifact;
        readonly redactor: RedactorPort;
    }): Promise<SessionValidationResult>;
    refreshSession(input: {
        readonly session: SessionArtifact;
        readonly workspace: WorkspaceHandle;
        readonly runner: RunnerPort;
        readonly redactor: RedactorPort;
        readonly abortSignal: AbortSignal;
    }): Promise<RefreshedSession>;
    classifySessionFailure(error: unknown): ProviderFailure;
}
export declare function registerClaudeSecrets(redactor: RedactorPort, oauthToken: string): void;
//# sourceMappingURL=claude-session-driver.d.ts.map