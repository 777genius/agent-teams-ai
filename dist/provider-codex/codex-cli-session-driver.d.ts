import type { ProviderFailure, ProviderCapabilities, ProviderSessionDriver, RedactorPort, RefreshedSession, SessionFreshnessAssessment, SessionArtifact, SessionRefreshPolicy, SessionValidationResult, WorkspaceHandle } from "@vioxen/subscription-runtime/core";
export type CodexCliSessionDriverOptions = {
    readonly codexBinaryPath?: string;
    readonly model?: string;
    readonly sourceEnv?: Readonly<Record<string, string | undefined>>;
    readonly refreshMode?: ProviderCapabilities["refreshMode"];
};
export declare class CodexCliSessionDriver implements ProviderSessionDriver {
    private readonly options;
    readonly providerId = "codex";
    readonly supportedArtifactKinds: readonly ["json-file"];
    readonly capabilities: ProviderCapabilities;
    constructor(options?: CodexCliSessionDriverOptions);
    validateSession(input: {
        readonly session: SessionArtifact;
    }): Promise<SessionValidationResult>;
    refreshSession(input: {
        readonly session: SessionArtifact;
        readonly workspace: WorkspaceHandle;
        readonly runner: Parameters<ProviderSessionDriver["refreshSession"]>[0]["runner"];
        readonly redactor: Parameters<ProviderSessionDriver["refreshSession"]>[0]["redactor"];
        readonly abortSignal: AbortSignal;
    }): Promise<RefreshedSession>;
    inspectSessionFreshness(input: {
        readonly session: SessionArtifact;
        readonly policy: Required<SessionRefreshPolicy>;
        readonly now: Date;
        readonly redactor: RedactorPort;
    }): Promise<SessionFreshnessAssessment>;
    classifySessionFailure(error: unknown): ProviderFailure;
}
//# sourceMappingURL=codex-cli-session-driver.d.ts.map