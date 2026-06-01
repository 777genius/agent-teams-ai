import type {
  AgentCapabilities,
  FinalizedLease,
  IdempotencyKeyInput,
  LeaseAcquireResult,
  LeaseStoreCapabilities,
  PreparedSessionWrite,
  ProcessResult,
  ProviderCapabilities,
  ProviderFailure,
  ProviderTask,
  ProviderTaskResult,
  RefreshedSession,
  RuntimeEvent,
  RuntimeMetric,
  RunnerCapabilities,
  SessionFreshnessAssessment,
  SessionArtifact,
  SessionEnvelope,
  SessionRefreshPolicy,
  SessionReadPurpose,
  SessionStoreCapabilities,
  SessionValidationResult,
  SessionWriteResult,
  WorkspaceCapabilities,
  WorkspaceHandle,
  WritebackCommitResult,
  OutputSink,
} from "../domain/types";

export interface ProviderSessionDriver {
  readonly providerId: string;
  readonly supportedArtifactKinds: readonly SessionArtifact["kind"][];
  readonly capabilities: ProviderCapabilities;

  validateSession(input: {
    readonly session: SessionArtifact;
    readonly redactor: RedactorPort;
  }): Promise<SessionValidationResult>;

  refreshSession(input: {
    readonly session: SessionArtifact;
    readonly workspace: WorkspaceHandle;
    readonly runner: RunnerPort;
    readonly redactor: RedactorPort;
    readonly abortSignal: AbortSignal;
  }): Promise<RefreshedSession>;

  inspectSessionFreshness?(input: {
    readonly session: SessionArtifact;
    readonly policy: Required<SessionRefreshPolicy>;
    readonly now: Date;
    readonly redactor: RedactorPort;
  }): Promise<SessionFreshnessAssessment>;

  classifySessionFailure(error: unknown): ProviderFailure;
}

export interface NoSessionDriver {
  readonly providerId: string;
  readonly capabilities: ProviderCapabilities & {
    readonly sessionRequirement: { readonly kind: "none" };
  };

  classifySessionFailure?(error: unknown): ProviderFailure;
}

export interface AgentDriver {
  readonly agentId: string;
  readonly providerId: string;
  readonly capabilities: AgentCapabilities;

  runTask(input: {
    readonly session: SessionArtifact | null;
    readonly task: ProviderTask;
    readonly workspace: WorkspaceHandle;
    readonly runner: RunnerPort;
    readonly redactor: RedactorPort;
    readonly abortSignal: AbortSignal;
  }): Promise<ProviderTaskResult>;

  classifyRunFailure(error: unknown): ProviderFailure;
}

export interface SubscriptionProviderDriver extends ProviderSessionDriver {
  readonly agentId: string;
  readonly agentCapabilities: AgentCapabilities;

  runTask(input: {
    readonly session: SessionArtifact;
    readonly task: ProviderTask;
    readonly workspace: WorkspaceHandle;
    readonly runner: RunnerPort;
    readonly redactor: RedactorPort;
    readonly abortSignal: AbortSignal;
  }): Promise<ProviderTaskResult>;

  classifyRunFailure(error: unknown): ProviderFailure;
}

export interface SessionStorePort {
  readonly storeId: string;
  readonly custody: SessionStoreCapabilities["custody"];
  readonly capabilities: SessionStoreCapabilities;

  read(input: {
    readonly providerInstanceId: string;
    readonly expectedProviderId?: string;
    readonly purpose: SessionReadPurpose;
  }): Promise<SessionEnvelope | null>;

  prepareWrite?(input: {
    readonly providerInstanceId: string;
    readonly expectedGeneration: number;
    readonly nextArtifact: SessionArtifact;
  }): Promise<PreparedSessionWrite>;

  write(input: {
    readonly providerInstanceId: string;
    readonly expectedGeneration: number;
    readonly nextArtifact: SessionArtifact;
    readonly idempotencyKey: string;
    readonly leaseId: string;
  }): Promise<SessionWriteResult>;

  delete?(input: {
    readonly providerInstanceId: string;
    readonly reason: string;
  }): Promise<void>;
}

export interface LeaseStorePort {
  readonly leaseStoreId: string;
  readonly capabilities: LeaseStoreCapabilities;

  acquire(input: {
    readonly providerInstanceId: string;
    readonly runId: string;
    readonly attempt: number;
    readonly ttlMs: number;
    readonly restoredGenerationHash: string;
  }): Promise<LeaseAcquireResult>;

  finalize(input: {
    readonly leaseId: string;
    readonly restoredGenerationHash: string;
  }): Promise<FinalizedLease>;

  markWritebackStarted(input: {
    readonly leaseId: string;
    readonly keyId?: string;
  }): Promise<void>;

  markWritebackCommitted(input: {
    readonly leaseId: string;
    readonly nextGenerationHash: string;
    readonly idempotencyKey: string;
  }): Promise<WritebackCommitResult>;

  release?(input: {
    readonly leaseId: string;
    readonly reason: string;
  }): Promise<void>;
}

export interface RunnerPort {
  readonly runnerId: string;
  readonly capabilities: RunnerCapabilities;

  run(input: {
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
    readonly stdin?: Uint8Array;
    readonly timeoutMs: number;
    readonly stdout?: OutputSink;
    readonly stderr?: OutputSink;
    readonly abortSignal: AbortSignal;
  }): Promise<ProcessResult>;
}

export interface WorkspacePort {
  readonly workspaceId: string;
  readonly capabilities: WorkspaceCapabilities;

  create(input: {
    readonly purpose: "refresh" | "run-task";
    readonly isolation: "temp-dir" | "existing-checkout" | "container";
  }): Promise<WorkspaceHandle>;
}

export interface RedactorPort {
  registerSecret(value: string | Uint8Array, label?: string): void;
  redact(input: string): string;
  assertNoKnownSecret(input: string, context: string): void;
}

export interface ObservabilityPort {
  emit(event: RuntimeEvent): void;
  count(metric: RuntimeMetric, value?: number): void;
  timing(metric: RuntimeMetric, durationMs: number): void;
}

export interface ClockPort {
  now(): Date;
  monotonicMs(): number;
}

export interface IdGeneratorPort {
  leaseId(): string;
  idempotencyKey(input: IdempotencyKeyInput): string;
  operationId(prefix: string): string;
}

export type RuntimeDeps = {
  readonly policy: import("../domain/types").RuntimePolicy;
  readonly sessionDriver: ProviderSessionDriver | NoSessionDriver;
  readonly agentDriver: AgentDriver;
  readonly sessionStore?: SessionStorePort;
  readonly leaseStore?: LeaseStorePort;
  readonly runner: RunnerPort;
  readonly workspace: WorkspacePort;
  readonly redactor: RedactorPort;
  readonly observability: ObservabilityPort;
  readonly clock: ClockPort;
  readonly idGenerator: IdGeneratorPort;
};
