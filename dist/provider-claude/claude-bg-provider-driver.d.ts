import type { AgentCapabilities, ProviderCapabilities, ProviderFailure, ProviderTask, ProviderTaskEvent, ProviderTaskResult, RefreshedSession, RunnerPort, SessionArtifact, SessionValidationResult, SubscriptionProviderDriver, WorkspaceHandle } from "@vioxen/subscription-runtime/core";
import { ClaudeSessionDriver } from "./claude-session-driver.js";
import { ClaudeTaskAgentDriver, type ClaudeTaskAgentDriverOptions } from "./claude-task-agent-driver.js";
export type ClaudeBgProviderDriverOptions = ClaudeTaskAgentDriverOptions;
export declare class ClaudeBgProviderDriver implements SubscriptionProviderDriver {
    private readonly sessionDriver;
    private readonly agentDriver;
    readonly providerId: string;
    readonly agentId: string;
    readonly supportedArtifactKinds: readonly SessionArtifact["kind"][];
    readonly capabilities: ProviderCapabilities;
    readonly agentCapabilities: AgentCapabilities;
    constructor(options: ClaudeBgProviderDriverOptions);
    validateSession(input: {
        readonly session: SessionArtifact;
        readonly redactor: Parameters<ClaudeSessionDriver["validateSession"]>[0]["redactor"];
    }): Promise<SessionValidationResult>;
    refreshSession(input: {
        readonly session: SessionArtifact;
        readonly workspace: WorkspaceHandle;
        readonly runner: RunnerPort;
        readonly redactor: Parameters<ClaudeSessionDriver["refreshSession"]>[0]["redactor"];
        readonly abortSignal: AbortSignal;
    }): Promise<RefreshedSession>;
    classifySessionFailure(error: unknown): ProviderFailure;
    runTask(input: {
        readonly session: SessionArtifact;
        readonly task: ProviderTask;
        readonly workspace: WorkspaceHandle;
        readonly runner: RunnerPort;
        readonly redactor: Parameters<ClaudeTaskAgentDriver["runTask"]>[0]["redactor"];
        readonly abortSignal: AbortSignal;
    }): Promise<ProviderTaskResult>;
    classifyRunFailure(error: unknown): ProviderFailure;
    streamTask(input: {
        readonly session: SessionArtifact;
        readonly task: ProviderTask;
        readonly workspace: WorkspaceHandle;
        readonly runner: RunnerPort;
        readonly redactor: Parameters<ClaudeTaskAgentDriver["runTask"]>[0]["redactor"];
        readonly abortSignal: AbortSignal;
    }): AsyncIterable<ProviderTaskEvent>;
    dispose(): Promise<void>;
}
//# sourceMappingURL=claude-bg-provider-driver.d.ts.map