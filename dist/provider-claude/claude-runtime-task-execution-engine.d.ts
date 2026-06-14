import type { ProviderTaskEvent } from "@vioxen/subscription-runtime/core";
import type { ClaudeTaskEngineInput, ClaudeTaskExecutionEngine, ClaudeTaskExecutionResult } from "./claude-task-agent-driver.js";
import { type ClaudeBgRuntimeContextOptions } from "./claude-bg-runtime-context.js";
export type ClaudeRuntimeTaskExecutionEngineOptions = ClaudeBgRuntimeContextOptions & {
    readonly pluginDirs?: readonly string[];
    readonly settingsPath?: string;
};
export declare class ClaudeRuntimeTaskExecutionEngine implements ClaudeTaskExecutionEngine {
    private readonly options;
    readonly kind: "claude-runtime-bg";
    readonly capabilities: {
        readonly supportsStreaming: true;
        readonly supportsToolCalls: true;
        readonly supportsUsage: true;
        readonly supportsProviderRunId: true;
        readonly supportsCleanup: true;
    };
    constructor(options?: ClaudeRuntimeTaskExecutionEngineOptions);
    run(input: ClaudeTaskEngineInput): Promise<ClaudeTaskExecutionResult>;
    stream(input: ClaudeTaskEngineInput): AsyncIterable<ProviderTaskEvent>;
    private buildCommand;
}
//# sourceMappingURL=claude-runtime-task-execution-engine.d.ts.map