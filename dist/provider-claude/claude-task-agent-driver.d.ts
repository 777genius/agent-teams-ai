import type { AgentDriver, ProviderFailure, ProviderTask, ProviderTaskEvent, ProviderTaskControls, ProviderTaskResult, ProviderTaskTelemetry, RedactorPort, RunnerPort, SessionArtifact, StreamingAgentDriver, WorkspaceHandle } from "@vioxen/subscription-runtime/core";
import { type ClaudeOAuthSession } from "./claude-session-codec.js";
export type ClaudeTaskExecutionResult = {
    readonly outputText: string;
    readonly structuredOutput?: unknown;
    readonly telemetry?: ProviderTaskTelemetry;
    readonly warnings: ProviderTaskResult["warnings"];
};
export type ClaudeTaskEngineInput = {
    readonly prompt: string;
    readonly session: ClaudeOAuthSession;
    readonly workspacePath: string;
    readonly appendSystemPrompt?: string;
    readonly runner: RunnerPort;
    readonly redactor: RedactorPort;
    readonly model: string;
    readonly maxTurns?: number;
    readonly allowedTools?: readonly string[];
    readonly mcpConfig?: readonly string[];
    readonly permissionMode?: ProviderTaskControls["permissionMode"];
    readonly strictMcpConfig?: boolean;
    readonly outputSchemaName?: string;
    readonly abortSignal: AbortSignal;
};
export type ClaudeTaskExecutionEngine = {
    readonly kind: string;
    readonly capabilities: {
        readonly supportsStreaming: boolean;
        readonly supportsToolCalls: boolean;
        readonly supportsUsage: boolean;
        readonly supportsProviderRunId: boolean;
        readonly supportsCleanup: boolean;
    };
    run(input: ClaudeTaskEngineInput): Promise<ClaudeTaskExecutionResult>;
    stream?(input: ClaudeTaskEngineInput): AsyncIterable<ProviderTaskEvent>;
    dispose?(): Promise<void>;
};
export type ClaudeTaskAgentDriverOptions = {
    readonly engine: ClaudeTaskExecutionEngine;
    readonly appendSystemPrompt?: string;
    readonly model?: string;
    readonly maxTurns?: number;
    readonly allowedTools?: readonly string[];
    readonly mcpConfig?: readonly string[];
    readonly strictMcpConfig?: boolean;
};
export declare class ClaudeTaskAgentDriver implements AgentDriver, StreamingAgentDriver {
    private readonly options;
    readonly agentId = "claude-bg-task";
    readonly providerId = "claude";
    readonly capabilities: import("@vioxen/subscription-runtime/core").AgentCapabilities;
    private readonly model;
    constructor(options: ClaudeTaskAgentDriverOptions);
    runTask(input: {
        readonly session: SessionArtifact | null;
        readonly task: ProviderTask;
        readonly workspace: WorkspaceHandle;
        readonly runner: RunnerPort;
        readonly redactor: RedactorPort;
        readonly abortSignal: AbortSignal;
    }): Promise<ProviderTaskResult>;
    streamTask(input: {
        readonly session: SessionArtifact | null;
        readonly task: ProviderTask;
        readonly workspace: WorkspaceHandle;
        readonly runner: RunnerPort;
        readonly redactor: RedactorPort;
        readonly abortSignal: AbortSignal;
    }): AsyncIterable<ProviderTaskEvent>;
    classifyRunFailure(error: unknown): ProviderFailure;
    dispose(): Promise<void>;
    private prepareEngineInput;
}
//# sourceMappingURL=claude-task-agent-driver.d.ts.map