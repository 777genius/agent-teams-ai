import { computeSessionGenerationHash } from "../domain/generation-hash.js";
import { DefaultRedactor, DeterministicIdGenerator, NullObservability, } from "../application/redactor.js";
export const fakeProviderCapabilities = {
    providerId: "fake",
    displayName: "Fake Provider",
    sessionRequirement: {
        kind: "required",
        artifactKinds: ["json-file"],
    },
    sessionArtifactKinds: ["json-file"],
    refreshMode: "always-before-run",
    sessionRotationMode: "may-rotate",
    environmentPolicy: {
        inheritHostEnvironment: false,
        allowlist: ["PATH", "HOME", "CI"],
        denylist: ["*_TOKEN", "*_SECRET", "*_API_KEY"],
        credentialSourceOrder: ["session-artifact"],
    },
    supportsRefresh: true,
    refreshMayRotateSession: true,
    supportsNonInteractiveRuntime: true,
    requiresNetwork: false,
    requiresWorkspace: true,
    supportsStructuredOutput: true,
    supportsReadOnlySandbox: true,
    defaultTimeoutMs: 60_000,
    setupModes: ["manual-secret"],
};
export const fakeAgentCapabilities = {
    agentId: "fake-agent",
    providerId: "fake",
    taskModes: ["review", "structured-prompt", "health-check"],
    historyMode: "none",
    supportsReviewTasks: true,
    supportsStructuredOutput: true,
    supportsToolCalling: false,
    supportsRepositoryContext: true,
    supportsInlineFindings: true,
    requiresWritableWorkspace: false,
    maxRuntimeMs: 60_000,
};
export const fakeStaticProviderCapabilities = {
    ...fakeProviderCapabilities,
    providerId: "fake-static",
    displayName: "Fake Static Provider",
    refreshMode: "validate-only",
    sessionRotationMode: "never-rotates",
    supportsRefresh: false,
    refreshMayRotateSession: false,
};
export const fakeStaticAgentCapabilities = {
    ...fakeAgentCapabilities,
    agentId: "fake-static-agent",
    providerId: "fake-static",
};
export const fakeNoSessionProviderCapabilities = {
    ...fakeProviderCapabilities,
    providerId: "fake-no-session",
    displayName: "Fake No-Session Provider",
    sessionRequirement: { kind: "none" },
    sessionArtifactKinds: [],
    refreshMode: "none",
    sessionRotationMode: "never-rotates",
    supportsRefresh: false,
    refreshMayRotateSession: false,
};
export const fakeNoSessionAgentCapabilities = {
    ...fakeAgentCapabilities,
    agentId: "fake-no-session-agent",
    providerId: "fake-no-session",
};
export const fakeStoreCapabilities = {
    storeId: "memory-store",
    custody: "no-plaintext-backend",
    supportsRead: true,
    supportsWriteback: true,
    supportsCompareAndSwap: true,
    supportsIdempotency: true,
    supportsDelete: true,
    supportsAuditLog: false,
    supportsMetadataOnlyHealthCheck: true,
    plaintextAvailableToBackend: false,
    maxArtifactBytes: 256_000,
};
export const fakeLeaseCapabilities = {
    leaseStoreId: "memory-lease-store",
    supportsTtl: true,
    supportsFinalize: true,
    supportsWritebackCommit: true,
};
export const fakeRunnerCapabilities = {
    runnerId: "memory-runner",
    supportsEnvAllowlist: true,
    supportsWorkingDirectory: true,
    supportsTimeout: true,
    supportsAbortSignal: true,
    supportsOutputRedaction: true,
    supportsReadOnlySandbox: true,
    readOnlyFilesystem: false,
    platform: "node-process",
};
export const fakeWorkspaceCapabilities = {
    workspaceId: "memory-workspace",
    supportsTempDir: true,
    supportsExistingCheckout: false,
    supportsContainer: false,
};
export function makeFakeArtifact(text = "session-v1", providerId = "fake") {
    return {
        kind: "json-file",
        providerId,
        formatVersion: "fake-session-v1",
        bytes: new TextEncoder().encode(text),
        contentType: "application/json",
    };
}
export class FakeProviderSessionDriver {
    providerId = "fake";
    supportedArtifactKinds = ["json-file"];
    capabilities = fakeProviderCapabilities;
    refreshText = "session-v2";
    refreshCount = 0;
    validation = { status: "valid", warnings: [] };
    refreshedState = "refreshed";
    async validateSession() {
        return this.validation;
    }
    async refreshSession() {
        this.refreshCount += 1;
        return {
            artifact: makeFakeArtifact(this.refreshText),
            providerState: this.refreshedState,
            warnings: [],
        };
    }
    classifySessionFailure() {
        return fakeFailure("unknown_runtime_failure", "Fake provider failure.");
    }
}
export class FakeStaticProviderSessionDriver extends FakeProviderSessionDriver {
    providerId = "fake-static";
    capabilities = fakeStaticProviderCapabilities;
    async refreshSession() {
        throw new Error("static_provider_must_not_refresh");
    }
}
export class FakeNoSessionDriver {
    providerId = "fake-no-session";
    capabilities = fakeNoSessionProviderCapabilities;
    classifySessionFailure() {
        return fakeFailure("unknown_runtime_failure", "Fake provider failure.");
    }
}
export class FakeAgentDriver {
    agentId = "fake-agent";
    providerId = "fake";
    capabilities = fakeAgentCapabilities;
    lastPrompt = null;
    async runTask(input) {
        this.lastPrompt = input.task.prompt;
        return {
            status: "completed",
            outputText: `review:${input.task.prompt}`,
            warnings: [],
        };
    }
    classifyRunFailure() {
        return fakeFailure("unknown_runtime_failure", "Fake agent failure.");
    }
}
export class FakeStaticAgentDriver extends FakeAgentDriver {
    agentId = "fake-static-agent";
    providerId = "fake-static";
    capabilities = fakeStaticAgentCapabilities;
}
export class FakeNoSessionAgentDriver {
    agentId = "fake-no-session-agent";
    providerId = "fake-no-session";
    capabilities = fakeNoSessionAgentCapabilities;
    lastPrompt = null;
    lastSessionWasNull = false;
    async runTask(input) {
        this.lastPrompt = input.task.prompt;
        this.lastSessionWasNull = input.session === null;
        return {
            status: "completed",
            outputText: `no-session:${input.task.prompt}`,
            warnings: [],
        };
    }
    classifyRunFailure() {
        return fakeFailure("unknown_runtime_failure", "Fake agent failure.");
    }
}
export class InMemorySessionStore {
    storeId = "memory-store";
    custody = "no-plaintext-backend";
    capabilities = fakeStoreCapabilities;
    records = new Map();
    idempotency = new Map();
    seed(input) {
        const generation = input.generation ?? 1;
        const envelope = {
            providerInstanceId: input.providerInstanceId,
            providerId: input.artifact.providerId,
            artifact: input.artifact,
            generation,
            generationHash: computeSessionGenerationHash({
                artifact: input.artifact,
            }),
            storageVersion: "memory-v1",
            custody: this.custody,
            metadata: {},
        };
        this.records.set(input.providerInstanceId, envelope);
        return envelope;
    }
    async read(input) {
        const record = this.records.get(input.providerInstanceId);
        if (!record)
            return null;
        if (input.expectedProviderId &&
            record.providerId !== input.expectedProviderId) {
            return null;
        }
        return record;
    }
    async write(input) {
        const idempotent = this.idempotency.get(input.idempotencyKey);
        if (idempotent) {
            return {
                status: "idempotent_replay",
                generation: idempotent.generation,
                generationHash: idempotent.generationHash,
            };
        }
        const current = this.records.get(input.providerInstanceId);
        if (!current) {
            throw new Error("session_missing");
        }
        if (current.generation !== input.expectedGeneration) {
            return {
                status: "stale_generation",
                currentGeneration: current.generation,
                currentGenerationHash: current.generationHash,
            };
        }
        const next = {
            ...current,
            artifact: input.nextArtifact,
            generation: current.generation + 1,
            generationHash: computeSessionGenerationHash({
                artifact: input.nextArtifact,
            }),
        };
        this.records.set(input.providerInstanceId, next);
        this.idempotency.set(input.idempotencyKey, next);
        return {
            status: "accepted",
            generation: next.generation,
            generationHash: next.generationHash,
        };
    }
}
export class InMemoryLeaseStore {
    leaseStoreId = "memory-lease-store";
    capabilities = fakeLeaseCapabilities;
    committed = [];
    async acquire(input) {
        return {
            status: "granted",
            leaseId: [
                input.providerInstanceId,
                input.runId,
                String(input.attempt),
            ].join(":"),
            expiresAt: new Date(Date.now() + 60_000),
        };
    }
    async finalize(input) {
        return input;
    }
    async markWritebackStarted() { }
    async markWritebackCommitted(input) {
        this.committed.push(input.leaseId);
        return { status: "committed" };
    }
}
export class FakeRunner {
    runnerId = "memory-runner";
    capabilities = fakeRunnerCapabilities;
    async run() {
        return {
            exitCode: 0,
            stdout: "",
            stderr: "",
            durationMs: 1,
        };
    }
}
export class FakeWorkspace {
    workspaceId = "memory-workspace";
    capabilities = fakeWorkspaceCapabilities;
    async create() {
        return {
            path: "/tmp/subscription-runtime-fake",
        };
    }
}
export class MemoryObservability {
    events = [];
    counts = [];
    timings = [];
    emit(event) {
        this.events.push(event);
    }
    count(metric, value = 1) {
        this.counts.push({ metric, value });
    }
    timing(metric, durationMs) {
        this.timings.push({ metric, durationMs });
    }
}
export function makeFakeRuntimeDeps(overrides = {}) {
    const provider = overrides.provider ?? new FakeProviderSessionDriver();
    const agent = overrides.agent ?? new FakeAgentDriver();
    const store = overrides.store ?? new InMemorySessionStore();
    const leaseStore = overrides.leaseStore ?? new InMemoryLeaseStore();
    const base = {
        policy: {
            custodyMode: "no-plaintext-backend",
            requireNoBackendPlaintext: true,
            requireWritebackBeforeTask: true,
            requireCompareAndSwap: true,
            allowInteractiveSetupInRuntime: false,
            allowedProviderIds: [provider.providerId],
            allowedAgentIds: [agent.agentId],
            allowedStoreIds: [store.storeId],
            allowedRunnerIds: ["memory-runner"],
        },
        sessionDriver: provider,
        agentDriver: agent,
        runner: new FakeRunner(),
        workspace: new FakeWorkspace(),
        redactor: new DefaultRedactor(),
        observability: overrides.observability ?? new NullObservability(),
        clock: {
            now: () => new Date("2026-05-26T00:00:00.000Z"),
            monotonicMs: () => 1,
        },
        idGenerator: new DeterministicIdGenerator(),
    };
    if (provider.capabilities.sessionRequirement.kind === "none") {
        return {
            ...base,
            ...(overrides.store ? { sessionStore: overrides.store } : {}),
            ...(overrides.leaseStore ? { leaseStore: overrides.leaseStore } : {}),
        };
    }
    return {
        ...base,
        sessionStore: store,
        leaseStore,
    };
}
function fakeFailure(code, safeMessage) {
    return {
        code,
        retryable: false,
        reconnectRequired: code === "needs_reconnect",
        safeMessage,
    };
}
//# sourceMappingURL=fakes.js.map