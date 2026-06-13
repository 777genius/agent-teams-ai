import type { AgentCapabilities, LeaseStoreCapabilities, ProviderTask, ProcessResult, ProviderCapabilities, ProviderFailure, ProviderTaskResult, RefreshedSession, RuntimeEvent, RuntimeMetric, RunnerCapabilities, SessionArtifact, SessionEnvelope, SessionStoreCapabilities, SessionValidationResult, WorkspaceCapabilities, WorkspaceHandle, WritebackCommitResult } from "../domain/types.js";
import type { AgentDriver, LeaseStorePort, NoSessionDriver, ObservabilityPort, ProviderSessionDriver, RunnerPort, RuntimeDeps, SessionStorePort, WorkspacePort } from "../ports/index.js";
export declare const fakeProviderCapabilities: ProviderCapabilities;
export declare const fakeAgentCapabilities: AgentCapabilities;
export declare const fakeStaticProviderCapabilities: ProviderCapabilities;
export declare const fakeStaticAgentCapabilities: AgentCapabilities;
export declare const fakeNoSessionProviderCapabilities: ProviderCapabilities;
export declare const fakeNoSessionAgentCapabilities: AgentCapabilities;
export declare const fakeStoreCapabilities: SessionStoreCapabilities;
export declare const fakeLeaseCapabilities: LeaseStoreCapabilities;
export declare const fakeRunnerCapabilities: RunnerCapabilities;
export declare const fakeWorkspaceCapabilities: WorkspaceCapabilities;
export declare function makeFakeArtifact(text?: string, providerId?: string): SessionArtifact;
export declare class FakeProviderSessionDriver implements ProviderSessionDriver {
    readonly providerId: string;
    readonly supportedArtifactKinds: readonly ["json-file"];
    readonly capabilities: ProviderCapabilities;
    refreshText: string;
    refreshCount: number;
    validation: SessionValidationResult;
    refreshedState: RefreshedSession["providerState"];
    validateSession(): Promise<SessionValidationResult>;
    refreshSession(): Promise<RefreshedSession>;
    classifySessionFailure(): ProviderFailure;
}
export declare class FakeStaticProviderSessionDriver extends FakeProviderSessionDriver implements ProviderSessionDriver {
    readonly providerId = "fake-static";
    readonly capabilities: ProviderCapabilities;
    refreshSession(): Promise<RefreshedSession>;
}
export declare class FakeNoSessionDriver implements NoSessionDriver {
    readonly providerId = "fake-no-session";
    readonly capabilities: ProviderCapabilities & {
        readonly sessionRequirement: {
            readonly kind: "none";
        };
    };
    classifySessionFailure(): ProviderFailure;
}
export declare class FakeAgentDriver implements AgentDriver {
    readonly agentId: string;
    readonly providerId: string;
    readonly capabilities: AgentCapabilities;
    lastPrompt: string | null;
    runTask(input: {
        readonly task: {
            readonly prompt: string;
        };
    }): Promise<ProviderTaskResult>;
    classifyRunFailure(): ProviderFailure;
}
export declare class FakeStaticAgentDriver extends FakeAgentDriver {
    readonly agentId = "fake-static-agent";
    readonly providerId = "fake-static";
    readonly capabilities: AgentCapabilities;
}
export declare class FakeNoSessionAgentDriver implements AgentDriver {
    readonly agentId = "fake-no-session-agent";
    readonly providerId = "fake-no-session";
    readonly capabilities: AgentCapabilities;
    lastPrompt: string | null;
    lastSessionWasNull: boolean;
    runTask(input: {
        readonly session: SessionArtifact | null;
        readonly task: ProviderTask;
    }): Promise<ProviderTaskResult>;
    classifyRunFailure(): ProviderFailure;
}
export declare class InMemorySessionStore implements SessionStorePort {
    readonly storeId = "memory-store";
    readonly custody: "no-plaintext-backend";
    readonly capabilities: SessionStoreCapabilities;
    private readonly records;
    private readonly idempotency;
    seed(input: {
        readonly providerInstanceId: string;
        readonly artifact: SessionArtifact;
        readonly generation?: number;
    }): SessionEnvelope;
    read(input: {
        readonly providerInstanceId: string;
        readonly expectedProviderId?: string;
        readonly purpose?: string;
    }): Promise<SessionEnvelope | null>;
    write(input: {
        readonly providerInstanceId: string;
        readonly expectedGeneration: number;
        readonly nextArtifact: SessionArtifact;
        readonly idempotencyKey: string;
    }): Promise<{
        status: "idempotent_replay";
        generation: number;
        generationHash: string;
        currentGeneration?: never;
        currentGenerationHash?: never;
    } | {
        status: "stale_generation";
        currentGeneration: number;
        currentGenerationHash: string;
        generation?: never;
        generationHash?: never;
    } | {
        status: "accepted";
        generation: number;
        generationHash: string;
        currentGeneration?: never;
        currentGenerationHash?: never;
    }>;
}
export declare class InMemoryLeaseStore implements LeaseStorePort {
    readonly leaseStoreId = "memory-lease-store";
    readonly capabilities: LeaseStoreCapabilities;
    readonly committed: string[];
    acquire(input: {
        readonly providerInstanceId: string;
        readonly runId: string;
        readonly attempt: number;
    }): Promise<{
        status: "granted";
        leaseId: string;
        expiresAt: Date;
    }>;
    finalize(input: {
        readonly leaseId: string;
        readonly restoredGenerationHash: string;
    }): Promise<{
        readonly leaseId: string;
        readonly restoredGenerationHash: string;
    }>;
    markWritebackStarted(): Promise<void>;
    markWritebackCommitted(input: {
        readonly leaseId: string;
    }): Promise<WritebackCommitResult>;
}
export declare class FakeRunner implements RunnerPort {
    readonly runnerId = "memory-runner";
    readonly capabilities: RunnerCapabilities;
    run(): Promise<ProcessResult>;
}
export declare class FakeWorkspace implements WorkspacePort {
    readonly workspaceId = "memory-workspace";
    readonly capabilities: WorkspaceCapabilities;
    create(): Promise<WorkspaceHandle>;
}
export declare class MemoryObservability implements ObservabilityPort {
    readonly events: RuntimeEvent[];
    readonly counts: Array<{
        readonly metric: RuntimeMetric;
        readonly value: number;
    }>;
    readonly timings: Array<{
        readonly metric: RuntimeMetric;
        readonly durationMs: number;
    }>;
    emit(event: RuntimeEvent): void;
    count(metric: RuntimeMetric, value?: number): void;
    timing(metric: RuntimeMetric, durationMs: number): void;
}
export declare function makeFakeRuntimeDeps(overrides?: {
    readonly provider?: ProviderSessionDriver | NoSessionDriver;
    readonly agent?: AgentDriver;
    readonly store?: SessionStorePort;
    readonly leaseStore?: LeaseStorePort;
    readonly observability?: ObservabilityPort;
}): RuntimeDeps;
//# sourceMappingURL=fakes.d.ts.map