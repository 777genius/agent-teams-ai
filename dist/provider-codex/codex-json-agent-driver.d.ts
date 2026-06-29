import { type AgentDriver, type ManagedRunResumeHandle, type ProviderFailure, type ProviderTask, type ProviderTaskResult, type RedactorPort, type SessionArtifact, type WorkspaceHandle } from "@vioxen/subscription-runtime/core";
import { type CodexExecutionEngine, type CodexReasoningEffort, type CodexServiceTier } from "./codex-json-execution-engine.js";
import { type CodexSessionMaterializer, type CodexSessionPrewarmResult } from "./codex-session-materializer.js";
type CodexJsonAgentDriverBaseOptions = {
    readonly model?: string;
    readonly reasoningEffort?: CodexReasoningEffort;
    readonly serviceTier?: CodexServiceTier;
    readonly warmupPrompt?: string;
    readonly sessionMaterializer?: CodexSessionMaterializer;
};
export type CodexJsonAgentDriverOptions = CodexJsonAgentDriverBaseOptions & ({
    readonly engine: CodexExecutionEngine;
} | {
    readonly codexBinaryPath: string;
    readonly sourceEnv?: Readonly<Record<string, string | undefined>>;
    readonly timeoutMs?: number;
});
export declare class CodexJsonAgentDriver implements AgentDriver {
    private readonly options;
    readonly agentId = "codex-json";
    readonly providerId = "codex";
    readonly capabilities: import("@vioxen/subscription-runtime/core").AgentCapabilities;
    private readonly engine;
    private readonly model;
    private readonly reasoningEffort;
    private readonly serviceTier;
    private readonly sessionMaterializer;
    private readonly managedRunSessions;
    constructor(options: CodexJsonAgentDriverOptions);
    runTask(input: {
        readonly session: SessionArtifact | null;
        readonly task: ProviderTask;
        readonly workspace: WorkspaceHandle;
        readonly runner: Parameters<AgentDriver["runTask"]>[0]["runner"];
        readonly redactor: RedactorPort;
        readonly abortSignal: AbortSignal;
    }): Promise<ProviderTaskResult>;
    resumeManagedRun(input: {
        readonly session: SessionArtifact;
        readonly runId: string;
        readonly requestId: string;
        readonly answer: string;
        readonly resumeHandle: ManagedRunResumeHandle;
        readonly task?: Pick<ProviderTask, "controls" | "outputSchemaName">;
        readonly workspace: WorkspaceHandle;
        readonly runner: Parameters<AgentDriver["runTask"]>[0]["runner"];
        readonly redactor: RedactorPort;
        readonly abortSignal: AbortSignal;
    }): Promise<ProviderTaskResult>;
    hasManagedRunSession(runId: string): boolean;
    classifyRunFailure(error: unknown): ProviderFailure;
    prewarmSession(input: {
        readonly session: SessionArtifact;
        readonly redactor: RedactorPort;
        readonly workspacePath?: string;
        readonly runner?: Parameters<AgentDriver["runTask"]>[0]["runner"];
        readonly abortSignal?: AbortSignal;
    }): Promise<CodexSessionPrewarmResult>;
    private prewarmMaterializerFallback;
    dispose(): Promise<void>;
}
export {};
//# sourceMappingURL=codex-json-agent-driver.d.ts.map