import type { AgentDriver, ProviderFailure, ProviderTask, ProviderTaskResult, SessionArtifact, WorkspaceHandle } from "@777genius/subscription-runtime/core";
export type CodexCliAgentDriverOptions = {
    readonly codexBinaryPath?: string;
    readonly model?: string;
    readonly sourceEnv?: Readonly<Record<string, string | undefined>>;
    readonly timeoutMs?: number;
};
export declare class CodexCliAgentDriver implements AgentDriver {
    private readonly options;
    readonly agentId = "codex-cli";
    readonly providerId = "codex";
    readonly capabilities: import("@777genius/subscription-runtime/core").AgentCapabilities;
    constructor(options?: CodexCliAgentDriverOptions);
    runTask(input: {
        readonly session: SessionArtifact | null;
        readonly task: ProviderTask;
        readonly workspace: WorkspaceHandle;
        readonly runner: Parameters<AgentDriver["runTask"]>[0]["runner"];
        readonly redactor: Parameters<AgentDriver["runTask"]>[0]["redactor"];
        readonly abortSignal: AbortSignal;
    }): Promise<ProviderTaskResult>;
    classifyRunFailure(error: unknown): ProviderFailure;
}
//# sourceMappingURL=codex-cli-agent-driver.d.ts.map