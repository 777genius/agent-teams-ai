import type { AgentDriver, ProviderFailure, ProviderTask, ProviderTaskResult, RedactorPort, SessionArtifact, WorkspaceHandle } from "@777genius/subscription-runtime/core";
import { type CodexExecutionEngine, type CodexReasoningEffort } from "./codex-json-execution-engine";
import { type CodexSessionMaterializer, type CodexSessionPrewarmResult } from "./codex-session-materializer";
type CodexJsonAgentDriverBaseOptions = {
    readonly model?: string;
    readonly reasoningEffort?: CodexReasoningEffort;
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
    readonly capabilities: import("@777genius/subscription-runtime/core").AgentCapabilities;
    private readonly engine;
    private readonly model;
    private readonly reasoningEffort;
    private readonly sessionMaterializer;
    constructor(options: CodexJsonAgentDriverOptions);
    runTask(input: {
        readonly session: SessionArtifact | null;
        readonly task: ProviderTask;
        readonly workspace: WorkspaceHandle;
        readonly runner: Parameters<AgentDriver["runTask"]>[0]["runner"];
        readonly redactor: RedactorPort;
        readonly abortSignal: AbortSignal;
    }): Promise<ProviderTaskResult>;
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