import type { ClaudeRuntimeEventLike } from "./claude-runtime-event-mapper.js";
export type ClaudeBgRuntimeContextOptions = {
    readonly baseEnv?: Readonly<Record<string, string | undefined>>;
    readonly claudePath?: string;
    readonly commandTimeoutMs?: number;
    readonly pollIntervalMs?: number;
    readonly stateFilePath?: string;
    readonly runtimeModuleLoader?: () => Promise<ClaudeRuntimeModule>;
    readonly providerModuleLoader?: () => Promise<ClaudeBgProviderRuntimeModule>;
};
export type ClaudeBgRuntimeContextInput = {
    readonly configDir: string | undefined;
    readonly oauthToken: string;
};
export type ClaudeBgRuntimeContext = {
    readonly runtime: ClaudeRuntimeModule;
    readonly provider: AgentRuntimeProviderLike;
};
export declare function createClaudeBgRuntimeContext(input: ClaudeBgRuntimeContextInput, options?: ClaudeBgRuntimeContextOptions): Promise<ClaudeBgRuntimeContext>;
export interface ClaudeRuntimeModule {
    readonly asCommandId: (value: string) => string;
    readonly asIsoTimestamp: (value: string) => string;
    readonly asThreadId: (value: string) => string;
    readonly FileRuntimeStateStore: new (options: {
        readonly filePath: string;
    }) => unknown;
}
export interface ClaudeBgProviderRuntimeModule {
    readonly ClaudeBgRuntimeProvider: new (options: Record<string, unknown>) => AgentRuntimeProviderLike;
}
export interface AgentRuntimeProviderLike {
    readonly id: string;
    start(request: {
        readonly command: AgentCommandLike;
        readonly providerId: string;
        readonly requestedAt: string;
        readonly threadId: string;
    }): Promise<AgentRunHandleLike>;
    send?(request: {
        readonly thread: AgentRuntimeThreadLike;
        readonly command: AgentCommandLike;
        readonly previousProviderSessionId?: string;
        readonly requestedAt: string;
    }): Promise<AgentRunHandleLike>;
    observe(handle: AgentRunHandleLike, options?: {
        readonly abortSignal?: AbortSignal;
        readonly pollIntervalMs?: number;
    }): AsyncIterable<ClaudeRuntimeEventLike>;
    remove(handle: AgentRunHandleLike): Promise<unknown>;
}
export interface AgentRuntimeThreadLike {
    readonly id: string;
    readonly status: "done";
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly cwd: string;
    readonly providerId: string;
    readonly latestProviderSessionId?: string;
}
export interface AgentRunHandleLike {
    readonly runId: string;
    readonly providerSessionId?: string;
}
export interface AgentCommandLike {
    readonly allowedTools?: readonly string[];
    readonly appendSystemPrompt?: string;
    readonly createdAt: string;
    readonly cwd: string;
    readonly id: string;
    readonly maxTurns?: number;
    readonly mcpConfig?: readonly string[];
    readonly mode: "initial" | "followup";
    readonly model: string;
    readonly permissionMode: "default" | "acceptEdits" | "bypassPermissions" | "dontAsk";
    readonly pluginDirs?: readonly string[];
    readonly prompt: string;
    readonly settings?: string;
    readonly strictMcpConfig?: boolean;
    readonly threadId: string;
}
//# sourceMappingURL=claude-bg-runtime-context.d.ts.map