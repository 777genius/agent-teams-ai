import type { CompiledRuntimePolicy, ProviderTask, ProviderTaskResult, RefreshSessionResult, RefreshThenRunResult, RunContext, RuntimeHealthCheckResult, RuntimeExecutionPlan } from "../domain/types";
import type { RuntimeDeps } from "../ports";
export type SubscriptionRuntime = {
    readonly capabilities: CompiledRuntimePolicy;
    readonly executionPlan: RuntimeExecutionPlan;
    refreshSession(input: {
        readonly providerInstanceId: string;
        readonly runContext: RunContext;
        readonly forceRefresh?: boolean;
    }): Promise<RefreshSessionResult>;
    runTask(input: {
        readonly providerInstanceId: string;
        readonly task: ProviderTask;
        readonly runContext: RunContext;
    }): Promise<ProviderTaskResult>;
    refreshThenRunTask(input: {
        readonly providerInstanceId: string;
        readonly task: ProviderTask;
        readonly runContext: RunContext;
    }): Promise<RefreshThenRunResult>;
    healthCheck(input: {
        readonly providerInstanceId: string;
    }): Promise<RuntimeHealthCheckResult>;
};
export declare function createSubscriptionRuntime(deps: RuntimeDeps): SubscriptionRuntime;
export declare function combineSessionAndAgent(input: {
    readonly sessionDriver: RuntimeDeps["sessionDriver"];
    readonly agentDriver: RuntimeDeps["agentDriver"];
}): RuntimeDeps["sessionDriver"] & {
    readonly agentId: string;
    readonly agentCapabilities: RuntimeDeps["agentDriver"]["capabilities"];
    runTask: RuntimeDeps["agentDriver"]["runTask"];
    classifyRunFailure: RuntimeDeps["agentDriver"]["classifyRunFailure"];
};
//# sourceMappingURL=runtime.d.ts.map