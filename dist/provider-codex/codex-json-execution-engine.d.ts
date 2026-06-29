import type { ProviderTaskControls, ProviderTaskResult, ManagedRunInputRequest, ManagedRunResumeHandle, RedactorPort, RunnerPort, SessionArtifact } from "@vioxen/subscription-runtime/core";
export type CodexReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";
export type CodexServiceTier = string;
export type CodexSandboxMode = "read-only" | "workspace-write";
export type CodexMaterializedSession = {
    readonly home: string;
    readonly codexHome: string;
    readonly sessionHash?: string;
    readonly env: Readonly<Record<string, string>>;
    snapshotSession?(): Promise<SessionArtifact | null>;
    release(): Promise<void>;
};
export type CodexExecutionWarning = {
    readonly code: string;
    readonly safeMessage: string;
};
export type CodexExecutionCompletedResult = {
    readonly status?: "completed";
    readonly outputText: string;
    readonly structuredOutput?: unknown;
    readonly warnings: readonly CodexExecutionWarning[];
};
export type CodexExecutionWaitingForInputResult = {
    readonly status: "waiting_for_input";
    readonly runId: string;
    readonly outputText: string;
    readonly structuredOutput?: unknown;
    readonly request: ManagedRunInputRequest;
    readonly resumeHandle: ManagedRunResumeHandle;
    readonly warnings: readonly CodexExecutionWarning[];
};
export type CodexExecutionResult = CodexExecutionCompletedResult | CodexExecutionWaitingForInputResult;
export type CodexExecutionPrewarmResult = {
    readonly kind: string;
    readonly reusable: boolean;
    readonly warmedAt: Date;
    readonly warnings: readonly {
        readonly code: string;
        readonly safeMessage: string;
    }[];
};
export type CodexExecutionEngine = {
    readonly kind: string;
    readonly capabilities: {
        readonly supportsStructuredOutput: boolean;
        readonly supportsJsonEvents: boolean;
        readonly supportsThreadResume: boolean;
        readonly requiresSchemaFile: boolean;
    };
    run(input: {
        readonly runId?: string;
        readonly prompt: string;
        readonly goalObjective?: string;
        readonly systemPrompt?: string;
        readonly session: CodexMaterializedSession;
        readonly workspacePath: string;
        readonly runner: RunnerPort;
        readonly redactor: RedactorPort;
        readonly model: string;
        readonly reasoningEffort: CodexReasoningEffort;
        readonly serviceTier?: CodexServiceTier;
        readonly sandboxMode?: CodexSandboxMode;
        readonly outputSchema?: unknown;
        readonly abortSignal: AbortSignal;
    }): Promise<CodexExecutionResult>;
    resume?(input: {
        readonly runId: string;
        readonly requestId: string;
        readonly answer: string;
        readonly resumeHandle: ManagedRunResumeHandle;
        readonly session: CodexMaterializedSession;
        readonly workspacePath: string;
        readonly runner: RunnerPort;
        readonly redactor: RedactorPort;
        readonly model: string;
        readonly reasoningEffort: CodexReasoningEffort;
        readonly serviceTier?: CodexServiceTier;
        readonly sandboxMode?: CodexSandboxMode;
        readonly outputSchema?: unknown;
        readonly abortSignal: AbortSignal;
    }): Promise<CodexExecutionResult>;
    prewarm?(input: {
        readonly session: CodexMaterializedSession;
        readonly workspacePath: string;
        readonly runner: RunnerPort;
        readonly redactor: RedactorPort;
        readonly model: string;
        readonly reasoningEffort: CodexReasoningEffort;
        readonly serviceTier?: CodexServiceTier;
        readonly warmupPrompt?: string;
        readonly abortSignal: AbortSignal;
    }): Promise<CodexExecutionPrewarmResult>;
    dispose?(): Promise<void>;
};
export type PackagedCodexJsonExecutionEngineOptions = {
    readonly codexBinaryPath: string;
    readonly sourceEnv?: Readonly<Record<string, string | undefined>>;
    readonly timeoutMs?: number;
    readonly jsonFlag?: "--json" | "--experimental-json";
    readonly maxOutputBytes?: number;
};
export declare class PackagedCodexJsonExecutionEngine implements CodexExecutionEngine {
    private readonly options;
    readonly kind: "packaged-json";
    readonly capabilities: {
        readonly supportsStructuredOutput: true;
        readonly supportsJsonEvents: true;
        readonly supportsThreadResume: false;
        readonly requiresSchemaFile: false;
    };
    constructor(options: PackagedCodexJsonExecutionEngineOptions);
    run(input: {
        readonly runId?: string;
        readonly prompt: string;
        readonly goalObjective?: string;
        readonly systemPrompt?: string;
        readonly session: CodexMaterializedSession;
        readonly workspacePath: string;
        readonly runner: RunnerPort;
        readonly redactor: RedactorPort;
        readonly model: string;
        readonly reasoningEffort: CodexReasoningEffort;
        readonly serviceTier?: CodexServiceTier;
        readonly sandboxMode?: CodexSandboxMode;
        readonly outputSchema?: unknown;
        readonly abortSignal: AbortSignal;
    }): Promise<CodexExecutionResult>;
    prewarm(): Promise<CodexExecutionPrewarmResult>;
}
export declare function buildCodexJsonExecArgs(input: {
    readonly jsonFlag: "--json" | "--experimental-json";
    readonly model: string;
    readonly reasoningEffort: CodexReasoningEffort;
    readonly serviceTier?: CodexServiceTier;
    readonly sandboxMode?: CodexSandboxMode;
}): readonly string[];
export declare function codexSandboxModeForPermissionMode(mode: ProviderTaskControls["permissionMode"] | undefined): CodexSandboxMode;
export declare function codexExecutionFailure(error: unknown): Extract<ProviderTaskResult, {
    readonly status: "failed";
}>;
//# sourceMappingURL=codex-json-execution-engine.d.ts.map