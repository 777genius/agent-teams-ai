import { type ProviderFailureCode, type ProviderTask, type ProviderTaskEvent, type ProviderTaskResult, type ProviderTaskTelemetry, type RuntimeWarning } from "@vioxen/subscription-runtime/core";
import { type AgentTaskEvent, type AgentTaskRequest, type AgentTaskResult, type JsonValue } from "./types.js";
export declare function createAgentTaskRequest(input: Omit<AgentTaskRequest, "protocolVersion">): AgentTaskRequest;
export declare function parseAgentTaskRequest(value: unknown): AgentTaskRequest;
export declare function agentTaskRequestToProviderTask(request: AgentTaskRequest): ProviderTask;
export declare function providerTaskResultToAgentTaskResult(result: ProviderTaskResult): AgentTaskResult;
export declare function agentTaskResultToProviderTaskResult(result: AgentTaskResult): ProviderTaskResult;
export declare function parseAgentTaskResult(value: unknown): AgentTaskResult;
export declare function providerTaskEventToAgentTaskEvent(event: ProviderTaskEvent): AgentTaskEvent;
export declare function parseAgentTaskEvent(value: unknown): AgentTaskEvent;
export declare function makeFailedAgentTaskResult(input: {
    readonly code: ProviderFailureCode;
    readonly safeMessage: string;
    readonly retryable?: boolean;
    readonly reconnectRequired?: boolean;
    readonly causeCategory?: string;
    readonly details?: Readonly<Record<string, string>>;
    readonly warnings?: readonly RuntimeWarning[];
    readonly telemetry?: ProviderTaskTelemetry;
}): AgentTaskResult;
export declare function parseJsonValue(value: unknown, path?: string): JsonValue;
//# sourceMappingURL=codec.d.ts.map