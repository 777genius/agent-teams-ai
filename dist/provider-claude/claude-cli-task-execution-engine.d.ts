import type { ClaudeTaskEngineInput, ClaudeTaskExecutionEngine, ClaudeTaskExecutionResult } from "./claude-task-agent-driver.js";
export type ClaudeCliTaskExecutionEngineOptions = {
    readonly baseEnv?: Readonly<Record<string, string | undefined>>;
    readonly claudePath?: string;
    readonly timeoutMs?: number;
    readonly maxOutputBytes?: number;
};
export declare class ClaudeCliTaskExecutionEngine implements ClaudeTaskExecutionEngine {
    private readonly options;
    readonly kind: "claude-cli-print";
    readonly capabilities: {
        readonly supportsStreaming: false;
        readonly supportsToolCalls: false;
        readonly supportsUsage: false;
        readonly supportsProviderRunId: false;
        readonly supportsCleanup: true;
    };
    constructor(options?: ClaudeCliTaskExecutionEngineOptions);
    run(input: ClaudeTaskEngineInput): Promise<ClaudeTaskExecutionResult>;
    private args;
    private env;
}
//# sourceMappingURL=claude-cli-task-execution-engine.d.ts.map