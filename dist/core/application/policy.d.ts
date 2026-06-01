import type { AgentCapabilities, CompiledRuntimePolicy, ProviderCapabilities, RuntimeExecutionPlan, RuntimePolicy, RuntimeWarning, RunnerCapabilities, SessionStoreCapabilities } from "../domain/types";
export type CapabilityDecision = {
    readonly status: "accepted";
    readonly compiledPolicy: CompiledRuntimePolicy;
    readonly executionPlan: RuntimeExecutionPlan;
    readonly warnings: readonly RuntimeWarning[];
} | {
    readonly status: "rejected";
    readonly code: "provider_store_incompatible" | "runner_provider_incompatible" | "custody_mode_forbidden" | "interactive_runtime_forbidden" | "missing_required_capability" | "task_mode_unsupported" | "history_mode_unsupported" | "session_store_required";
    readonly safeMessage: string;
    readonly details: Readonly<Record<string, string>>;
};
export declare function assertRuntimeCapabilities(input: {
    readonly provider: ProviderCapabilities;
    readonly agent: AgentCapabilities;
    readonly store?: SessionStoreCapabilities;
    readonly runner: RunnerCapabilities;
    readonly policy: RuntimePolicy;
}): void;
export declare function negotiateCapabilities(input: {
    readonly requested: RuntimePolicy;
    readonly provider: ProviderCapabilities;
    readonly agent: AgentCapabilities;
    readonly store?: SessionStoreCapabilities;
    readonly runner: RunnerCapabilities;
}): CapabilityDecision;
export declare function negotiateCapabilities(input: {
    readonly policy: RuntimePolicy;
    readonly provider: ProviderCapabilities;
    readonly agent: AgentCapabilities;
    readonly store?: SessionStoreCapabilities;
    readonly runner: RunnerCapabilities;
}): CapabilityDecision;
export declare function compileRuntimePolicy(input: {
    readonly requested: RuntimePolicy;
    readonly provider: ProviderCapabilities;
    readonly agent: AgentCapabilities;
    readonly store?: SessionStoreCapabilities;
    readonly runner: RunnerCapabilities;
}): CompiledRuntimePolicy;
export declare function compileRuntimeExecutionPlan(input: {
    readonly policy: RuntimePolicy;
    readonly provider: ProviderCapabilities;
}): RuntimeExecutionPlan;
export declare function providerMayRotateSession(provider: ProviderCapabilities): boolean;
//# sourceMappingURL=policy.d.ts.map