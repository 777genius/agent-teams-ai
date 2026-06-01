import type { AgentCapabilities, ProviderCapabilities, ProviderFailure, ProviderTask, ProviderTaskResult, RefreshedSession, SessionArtifact, SessionValidationResult, SubscriptionProviderDriver, WorkspaceHandle } from "@777genius/subscription-runtime/core";
import { CodexCliAgentDriver, type CodexCliAgentDriverOptions } from "./codex-cli-agent-driver";
import { CodexCliSessionDriver, type CodexCliSessionDriverOptions } from "./codex-cli-session-driver";
export type CodexCliProviderDriverOptions = CodexCliSessionDriverOptions & CodexCliAgentDriverOptions;
export declare class CodexCliProviderDriver implements SubscriptionProviderDriver {
    private readonly sessionDriver;
    private readonly agentDriver;
    readonly providerId: string;
    readonly agentId: string;
    readonly supportedArtifactKinds: readonly SessionArtifact["kind"][];
    readonly capabilities: ProviderCapabilities;
    readonly agentCapabilities: AgentCapabilities;
    constructor(options?: CodexCliProviderDriverOptions);
    validateSession(input: {
        readonly session: SessionArtifact;
    }): Promise<SessionValidationResult>;
    refreshSession(input: {
        readonly session: SessionArtifact;
        readonly workspace: WorkspaceHandle;
        readonly runner: Parameters<CodexCliSessionDriver["refreshSession"]>[0]["runner"];
        readonly redactor: Parameters<CodexCliSessionDriver["refreshSession"]>[0]["redactor"];
        readonly abortSignal: AbortSignal;
    }): Promise<RefreshedSession>;
    classifySessionFailure(error: unknown): ProviderFailure;
    runTask(input: {
        readonly session: SessionArtifact;
        readonly task: ProviderTask;
        readonly workspace: WorkspaceHandle;
        readonly runner: Parameters<CodexCliAgentDriver["runTask"]>[0]["runner"];
        readonly redactor: Parameters<CodexCliAgentDriver["runTask"]>[0]["redactor"];
        readonly abortSignal: AbortSignal;
    }): Promise<ProviderTaskResult>;
    classifyRunFailure(error: unknown): ProviderFailure;
}
//# sourceMappingURL=codex-cli-provider-driver.d.ts.map