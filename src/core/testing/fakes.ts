import { computeSessionGenerationHash } from "../domain/generation-hash";
import type {
  AgentCapabilities,
  LeaseStoreCapabilities,
  ProviderTask,
  ProcessResult,
  ProviderCapabilities,
  ProviderFailure,
  ProviderTaskResult,
  RefreshedSession,
  RuntimeEvent,
  RuntimeMetric,
  RunnerCapabilities,
  SessionArtifact,
  SessionEnvelope,
  SessionStoreCapabilities,
  SessionValidationResult,
  WorkspaceCapabilities,
  WorkspaceHandle,
  WritebackCommitResult,
} from "../domain/types";
import type {
  AgentDriver,
  LeaseStorePort,
  NoSessionDriver,
  ObservabilityPort,
  ProviderSessionDriver,
  RedactorPort,
  RunnerPort,
  RuntimeDeps,
  SessionStorePort,
  WorkspacePort,
} from "../ports";
import {
  DefaultRedactor,
  DeterministicIdGenerator,
  NullObservability,
} from "../application/redactor";

export const fakeProviderCapabilities: ProviderCapabilities = {
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

export const fakeAgentCapabilities: AgentCapabilities = {
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

export const fakeStaticProviderCapabilities: ProviderCapabilities = {
  ...fakeProviderCapabilities,
  providerId: "fake-static",
  displayName: "Fake Static Provider",
  refreshMode: "validate-only",
  sessionRotationMode: "never-rotates",
  supportsRefresh: false,
  refreshMayRotateSession: false,
};

export const fakeStaticAgentCapabilities: AgentCapabilities = {
  ...fakeAgentCapabilities,
  agentId: "fake-static-agent",
  providerId: "fake-static",
};

export const fakeNoSessionProviderCapabilities: ProviderCapabilities = {
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

export const fakeNoSessionAgentCapabilities: AgentCapabilities = {
  ...fakeAgentCapabilities,
  agentId: "fake-no-session-agent",
  providerId: "fake-no-session",
};

export const fakeStoreCapabilities: SessionStoreCapabilities = {
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

export const fakeLeaseCapabilities: LeaseStoreCapabilities = {
  leaseStoreId: "memory-lease-store",
  supportsTtl: true,
  supportsFinalize: true,
  supportsWritebackCommit: true,
};

export const fakeRunnerCapabilities: RunnerCapabilities = {
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

export const fakeWorkspaceCapabilities: WorkspaceCapabilities = {
  workspaceId: "memory-workspace",
  supportsTempDir: true,
  supportsExistingCheckout: false,
  supportsContainer: false,
};

export function makeFakeArtifact(
  text = "session-v1",
  providerId = "fake",
): SessionArtifact {
  return {
    kind: "json-file",
    providerId,
    formatVersion: "fake-session-v1",
    bytes: new TextEncoder().encode(text),
    contentType: "application/json",
  };
}

export class FakeProviderSessionDriver implements ProviderSessionDriver {
  readonly providerId: string = "fake";
  readonly supportedArtifactKinds = ["json-file"] as const;
  readonly capabilities = fakeProviderCapabilities;
  refreshText = "session-v2";
  refreshCount = 0;
  validation: SessionValidationResult = { status: "valid", warnings: [] };
  refreshedState: RefreshedSession["providerState"] = "refreshed";

  async validateSession(): Promise<SessionValidationResult> {
    return this.validation;
  }

  async refreshSession(): Promise<RefreshedSession> {
    this.refreshCount += 1;
    return {
      artifact: makeFakeArtifact(this.refreshText),
      providerState: this.refreshedState,
      warnings: [],
    };
  }

  classifySessionFailure(): ProviderFailure {
    return fakeFailure("unknown_runtime_failure", "Fake provider failure.");
  }
}

export class FakeStaticProviderSessionDriver
  extends FakeProviderSessionDriver
  implements ProviderSessionDriver
{
  override readonly providerId = "fake-static";
  override readonly capabilities = fakeStaticProviderCapabilities;

  override async refreshSession(): Promise<RefreshedSession> {
    throw new Error("static_provider_must_not_refresh");
  }
}

export class FakeNoSessionDriver implements NoSessionDriver {
  readonly providerId = "fake-no-session";
  readonly capabilities =
    fakeNoSessionProviderCapabilities as ProviderCapabilities & {
      readonly sessionRequirement: { readonly kind: "none" };
    };

  classifySessionFailure(): ProviderFailure {
    return fakeFailure("unknown_runtime_failure", "Fake provider failure.");
  }
}

export class FakeAgentDriver implements AgentDriver {
  readonly agentId: string = "fake-agent";
  readonly providerId: string = "fake";
  readonly capabilities = fakeAgentCapabilities;
  lastPrompt: string | null = null;

  async runTask(input: {
    readonly task: { readonly prompt: string };
  }): Promise<ProviderTaskResult> {
    this.lastPrompt = input.task.prompt;
    return {
      status: "completed",
      outputText: `review:${input.task.prompt}`,
      warnings: [],
    };
  }

  classifyRunFailure(): ProviderFailure {
    return fakeFailure("unknown_runtime_failure", "Fake agent failure.");
  }
}

export class FakeStaticAgentDriver extends FakeAgentDriver {
  override readonly agentId = "fake-static-agent";
  override readonly providerId = "fake-static";
  override readonly capabilities = fakeStaticAgentCapabilities;
}

export class FakeNoSessionAgentDriver implements AgentDriver {
  readonly agentId = "fake-no-session-agent";
  readonly providerId = "fake-no-session";
  readonly capabilities = fakeNoSessionAgentCapabilities;
  lastPrompt: string | null = null;
  lastSessionWasNull = false;

  async runTask(input: {
    readonly session: SessionArtifact | null;
    readonly task: ProviderTask;
  }): Promise<ProviderTaskResult> {
    this.lastPrompt = input.task.prompt;
    this.lastSessionWasNull = input.session === null;
    return {
      status: "completed",
      outputText: `no-session:${input.task.prompt}`,
      warnings: [],
    };
  }

  classifyRunFailure(): ProviderFailure {
    return fakeFailure("unknown_runtime_failure", "Fake agent failure.");
  }
}

export class InMemorySessionStore implements SessionStorePort {
  readonly storeId = "memory-store";
  readonly custody = "no-plaintext-backend" as const;
  readonly capabilities = fakeStoreCapabilities;
  private readonly records = new Map<string, SessionEnvelope>();
  private readonly idempotency = new Map<string, SessionEnvelope>();

  seed(input: {
    readonly providerInstanceId: string;
    readonly artifact: SessionArtifact;
    readonly generation?: number;
  }): SessionEnvelope {
    const generation = input.generation ?? 1;
    const envelope: SessionEnvelope = {
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

  async read(input: {
    readonly providerInstanceId: string;
    readonly expectedProviderId?: string;
    readonly purpose?: string;
  }): Promise<SessionEnvelope | null> {
    const record = this.records.get(input.providerInstanceId);
    if (!record) return null;
    if (
      input.expectedProviderId &&
      record.providerId !== input.expectedProviderId
    ) {
      return null;
    }
    return record;
  }

  async write(input: {
    readonly providerInstanceId: string;
    readonly expectedGeneration: number;
    readonly nextArtifact: SessionArtifact;
    readonly idempotencyKey: string;
  }) {
    const idempotent = this.idempotency.get(input.idempotencyKey);
    if (idempotent) {
      return {
        status: "idempotent_replay" as const,
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
        status: "stale_generation" as const,
        currentGeneration: current.generation,
        currentGenerationHash: current.generationHash,
      };
    }

    const next: SessionEnvelope = {
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
      status: "accepted" as const,
      generation: next.generation,
      generationHash: next.generationHash,
    };
  }
}

export class InMemoryLeaseStore implements LeaseStorePort {
  readonly leaseStoreId = "memory-lease-store";
  readonly capabilities = fakeLeaseCapabilities;
  readonly committed: string[] = [];

  async acquire(input: {
    readonly providerInstanceId: string;
    readonly runId: string;
    readonly attempt: number;
  }) {
    return {
      status: "granted" as const,
      leaseId: [
        input.providerInstanceId,
        input.runId,
        String(input.attempt),
      ].join(":"),
      expiresAt: new Date(Date.now() + 60_000),
    };
  }

  async finalize(input: {
    readonly leaseId: string;
    readonly restoredGenerationHash: string;
  }) {
    return input;
  }

  async markWritebackStarted(): Promise<void> {}

  async markWritebackCommitted(input: {
    readonly leaseId: string;
  }): Promise<WritebackCommitResult> {
    this.committed.push(input.leaseId);
    return { status: "committed" };
  }
}

export class FakeRunner implements RunnerPort {
  readonly runnerId = "memory-runner";
  readonly capabilities = fakeRunnerCapabilities;

  async run(): Promise<ProcessResult> {
    return {
      exitCode: 0,
      stdout: "",
      stderr: "",
      durationMs: 1,
    };
  }
}

export class FakeWorkspace implements WorkspacePort {
  readonly workspaceId = "memory-workspace";
  readonly capabilities = fakeWorkspaceCapabilities;

  async create(): Promise<WorkspaceHandle> {
    return {
      path: "/tmp/subscription-runtime-fake",
    };
  }
}

export class MemoryObservability implements ObservabilityPort {
  readonly events: RuntimeEvent[] = [];
  readonly counts: Array<{
    readonly metric: RuntimeMetric;
    readonly value: number;
  }> = [];
  readonly timings: Array<{
    readonly metric: RuntimeMetric;
    readonly durationMs: number;
  }> = [];

  emit(event: RuntimeEvent): void {
    this.events.push(event);
  }

  count(metric: RuntimeMetric, value = 1): void {
    this.counts.push({ metric, value });
  }

  timing(metric: RuntimeMetric, durationMs: number): void {
    this.timings.push({ metric, durationMs });
  }
}

export function makeFakeRuntimeDeps(
  overrides: {
    readonly provider?: ProviderSessionDriver | NoSessionDriver;
    readonly agent?: AgentDriver;
    readonly store?: SessionStorePort;
    readonly leaseStore?: LeaseStorePort;
    readonly observability?: ObservabilityPort;
  } = {},
): RuntimeDeps {
  const provider = overrides.provider ?? new FakeProviderSessionDriver();
  const agent = overrides.agent ?? new FakeAgentDriver();
  const store = overrides.store ?? new InMemorySessionStore();
  const leaseStore = overrides.leaseStore ?? new InMemoryLeaseStore();
  const base = {
    policy: {
      custodyMode: "no-plaintext-backend" as const,
      requireNoBackendPlaintext: true,
      requireWritebackBeforeTask: true,
      requireCompareAndSwap: true,
      allowInteractiveSetupInRuntime: false as const,
      allowedProviderIds: [provider.providerId],
      allowedAgentIds: [agent.agentId],
      allowedStoreIds: [store.storeId],
      allowedRunnerIds: ["memory-runner"],
    },
    sessionDriver: provider,
    agentDriver: agent,
    runner: new FakeRunner(),
    workspace: new FakeWorkspace(),
    redactor: new DefaultRedactor() as RedactorPort,
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

function fakeFailure(
  code: ProviderFailure["code"],
  safeMessage: string,
): ProviderFailure {
  return {
    code,
    retryable: false,
    reconnectRequired: code === "needs_reconnect",
    safeMessage,
  };
}
