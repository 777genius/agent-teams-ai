import type { AgentToolCall, AgentUsage, RedactorPort, RuntimeWarning } from "@vioxen/subscription-runtime/core";
export type ClaudeRuntimeEventLike = {
    readonly type: "assistant_message";
    readonly text: string;
} | {
    readonly type: "tool_use";
    readonly id?: string;
    readonly toolName: string;
    readonly input?: unknown;
} | {
    readonly type: "tool_result";
    readonly id?: string;
    readonly toolName?: string;
    readonly output?: unknown;
    readonly isError?: boolean;
} | {
    readonly type: "usage";
    readonly usage: {
        readonly inputTokens?: number;
        readonly outputTokens?: number;
        readonly totalTokens?: number;
    };
} | {
    readonly type: "diagnostic";
    readonly level?: string;
    readonly message?: string;
    readonly code?: string;
    readonly details?: unknown;
} | {
    readonly type: "result_available";
    readonly result: {
        readonly text?: string;
        readonly output?: unknown;
        readonly detail?: string;
        readonly summary?: string;
        readonly usage?: {
            readonly inputTokens?: number;
            readonly outputTokens?: number;
            readonly totalTokens?: number;
        };
    };
} | {
    readonly type: string;
};
export declare function resultText(result: {
    readonly text?: string;
    readonly output?: unknown;
    readonly detail?: string;
    readonly summary?: string;
}): string;
export declare function parseStructuredJson(value: string): unknown;
export declare function toolUseCall(event: Extract<ClaudeRuntimeEventLike, {
    readonly type: "tool_use";
}>, redactor: RedactorPort): AgentToolCall;
export declare function toolResultCall(event: Extract<ClaudeRuntimeEventLike, {
    readonly type: "tool_result";
}>, redactor: RedactorPort): AgentToolCall;
export declare function runtimeUsage(usage: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly totalTokens?: number;
}): AgentUsage;
export declare function diagnosticWarning(event: Extract<ClaudeRuntimeEventLike, {
    readonly type: "diagnostic";
}>, redactor: RedactorPort): RuntimeWarning;
export declare function isAssistantMessageEvent(event: ClaudeRuntimeEventLike): event is Extract<ClaudeRuntimeEventLike, {
    readonly type: "assistant_message";
}>;
export declare function isToolUseEvent(event: ClaudeRuntimeEventLike): event is Extract<ClaudeRuntimeEventLike, {
    readonly type: "tool_use";
}>;
export declare function isToolResultEvent(event: ClaudeRuntimeEventLike): event is Extract<ClaudeRuntimeEventLike, {
    readonly type: "tool_result";
}>;
export declare function isUsageEvent(event: ClaudeRuntimeEventLike): event is Extract<ClaudeRuntimeEventLike, {
    readonly type: "usage";
}>;
export declare function isDiagnosticEvent(event: ClaudeRuntimeEventLike): event is Extract<ClaudeRuntimeEventLike, {
    readonly type: "diagnostic";
}>;
export declare function isResultAvailableEvent(event: ClaudeRuntimeEventLike): event is Extract<ClaudeRuntimeEventLike, {
    readonly type: "result_available";
}>;
//# sourceMappingURL=claude-runtime-event-mapper.d.ts.map