export type CustodyMode =
  | "no-plaintext-backend"
  | "backend-custody"
  | "local-only";

export type SessionArtifactKind =
  | "json-file"
  | "env-token"
  | "directory"
  | "opaque-bytes";

export type SessionArtifact = {
  readonly kind: SessionArtifactKind;
  readonly providerId: string;
  readonly formatVersion: string;
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly createdAt?: Date;
  readonly updatedAt?: Date;
};

export type SessionEnvelope = {
  readonly providerInstanceId: string;
  readonly providerId: string;
  readonly artifact: SessionArtifact;
  readonly generation: number;
  readonly generationHash: string;
  readonly storageVersion: string;
  readonly custody: CustodyMode;
  readonly metadata: Readonly<Record<string, string>>;
};

export type RuntimeWarning = {
  readonly code: string;
  readonly safeMessage: string;
  readonly details?: Readonly<Record<string, string>>;
};

export type RefreshedSession = {
  readonly artifact: SessionArtifact;
  readonly providerState:
    | "unchanged"
    | "refreshed"
    | "needs-reconnect"
    | "quota-limited"
    | "permission-required";
  readonly warnings: readonly RuntimeWarning[];
};

export type SessionOwner = {
  readonly tenantId: string;
  readonly workspaceId?: string;
  readonly repositoryId?: string;
  readonly accountHint?: string;
};

export type SessionBoundary = {
  readonly owner: SessionOwner;
  readonly providerInstanceId: string;
  readonly allowedRunners: readonly string[];
  readonly allowedStores: readonly string[];
  readonly allowedProviderIds: readonly string[];
};

export type ProviderSetupMode =
  | "manual-secret"
  | "device-auth"
  | "browser-auth"
  | "api-key"
  | "import-local-session";

export type SessionRequirement =
  | {
      readonly kind: "required";
      readonly artifactKinds: readonly SessionArtifactKind[];
    }
  | {
      readonly kind: "optional";
      readonly artifactKinds: readonly SessionArtifactKind[];
    }
  | {
      readonly kind: "none";
    };

export type ProviderRefreshMode =
  | "none"
  | "validate-only"
  | "always-before-run"
  | "lazy-refresh";

export type ProviderSessionRotationMode = "never-rotates" | "may-rotate";

export type ProviderEnvironmentPolicy = {
  readonly inheritHostEnvironment: false;
  readonly allowlist: readonly string[];
  readonly denylist: readonly string[];
  readonly credentialSourceOrder: readonly string[];
};

export type ProviderCapabilities = {
  readonly providerId: string;
  readonly displayName: string;
  readonly sessionRequirement: SessionRequirement;
  /**
   * Legacy compatibility field. New policy decisions must use
   * sessionRequirement instead.
   */
  readonly sessionArtifactKinds: readonly SessionArtifactKind[];
  readonly refreshMode: ProviderRefreshMode;
  readonly sessionRotationMode: ProviderSessionRotationMode;
  readonly environmentPolicy: ProviderEnvironmentPolicy;
  readonly supportsRefresh: boolean;
  readonly refreshMayRotateSession: boolean;
  readonly supportsNonInteractiveRuntime: boolean;
  readonly requiresNetwork: boolean;
  readonly requiresWorkspace: boolean;
  readonly supportsStructuredOutput: boolean;
  readonly supportsReadOnlySandbox: boolean;
  readonly defaultTimeoutMs: number;
  readonly setupModes: readonly ProviderSetupMode[];
};

export type AgentTaskMode = ProviderTaskKind;
export type AgentHistoryMode =
  | "none"
  | "host-managed-thread"
  | "provider-thread";
export type AgentExecutionMode = "task" | "streaming-task" | "managed-run";
export type ToolPolicyMode =
  | "none"
  | "provider-enforced"
  | "host-filtered"
  | "unsupported";
export type OutputMode = "text" | "json" | "schema-json";

export type AgentCapabilities = {
  readonly agentId: string;
  readonly providerId: string;
  readonly taskModes: readonly AgentTaskMode[];
  readonly historyMode: AgentHistoryMode;
  readonly supportsReviewTasks: boolean;
  readonly supportsStructuredOutput: boolean;
  readonly supportsToolCalling: boolean;
  readonly supportsRepositoryContext: boolean;
  readonly supportsInlineFindings: boolean;
  readonly requiresWritableWorkspace: boolean;
  readonly maxPromptBytes?: number;
  readonly maxRuntimeMs: number;
  readonly executionModes?: readonly AgentExecutionMode[];
  readonly toolPolicyMode?: ToolPolicyMode;
  readonly outputModes?: readonly OutputMode[];
  readonly supportsStreaming?: boolean;
  readonly supportsUsageTelemetry?: boolean;
  readonly supportsCostTelemetry?: boolean;
  readonly supportsProviderRunId?: boolean;
  readonly supportsAbort?: boolean;
  readonly supportsCleanup?: boolean;
};

export type SessionStoreCapabilities = {
  readonly storeId: string;
  readonly custody: CustodyMode;
  readonly supportsRead: boolean;
  readonly supportsWriteback: boolean;
  readonly supportsCompareAndSwap: boolean;
  readonly supportsIdempotency: boolean;
  readonly supportsDelete: boolean;
  readonly supportsAuditLog: boolean;
  readonly supportsMetadataOnlyHealthCheck: boolean;
  readonly plaintextAvailableToBackend: boolean;
  readonly maxArtifactBytes: number;
};

export type LeaseStoreCapabilities = {
  readonly leaseStoreId: string;
  readonly supportsTtl: boolean;
  readonly supportsFinalize: boolean;
  readonly supportsWritebackCommit: boolean;
};

export type RunnerCapabilities = {
  readonly runnerId: string;
  readonly supportsEnvAllowlist: boolean;
  readonly supportsWorkingDirectory: boolean;
  readonly supportsTimeout: boolean;
  readonly supportsAbortSignal: boolean;
  readonly supportsOutputRedaction: boolean;
  readonly supportsReadOnlySandbox: boolean;
  readonly readOnlyFilesystem: boolean;
  readonly platform: "github-actions" | "node-process" | "container" | "remote";
};

export type WorkspaceCapabilities = {
  readonly workspaceId: string;
  readonly supportsTempDir: boolean;
  readonly supportsExistingCheckout: boolean;
  readonly supportsContainer: boolean;
};

export type RuntimePolicy = {
  readonly custodyMode: CustodyMode;
  readonly requireNoBackendPlaintext: boolean;
  readonly requireWritebackBeforeTask: boolean;
  readonly requireCompareAndSwap: boolean;
  readonly refreshPolicy?: SessionRefreshPolicy;
  readonly requestedTaskMode?: AgentTaskMode;
  readonly requestedHistoryMode?: AgentHistoryMode | "unsupported";
  readonly allowInteractiveSetupInRuntime: false;
  readonly allowedProviderIds: readonly string[];
  readonly allowedAgentIds: readonly string[];
  readonly allowedStoreIds: readonly string[];
  readonly allowedRunnerIds: readonly string[];
  readonly maxTaskOutputBytes?: number;
};

export type SessionRefreshPolicy = {
  readonly minFreshMs?: number;
  readonly refreshBeforeExpiryMs?: number;
  readonly maxSessionAgeMs?: number;
};

export type CompiledRuntimePolicy = {
  readonly trustMode: CustodyMode;
  readonly providerId: string;
  readonly agentId: string;
  readonly storeId: string | null;
  readonly runnerId: string;
  readonly requiresDurableWriteback: boolean;
  readonly requiresLease: boolean;
  readonly requiresCas: boolean;
  readonly allowsInteractiveRuntime: false;
  readonly maxSessionBytes: number;
  readonly maxTaskOutputBytes: number;
  readonly timeoutMs: number;
  readonly refreshPolicy: Required<SessionRefreshPolicy>;
};

export type RuntimeExecutionPlan =
  | {
      readonly kind: "no-session";
      readonly readSession: false;
      readonly acquireLease: false;
      readonly refresh: "never";
      readonly writeback: "never";
      readonly sessionForAgent: "absent";
    }
  | {
      readonly kind: "static-session";
      readonly readSession: true;
      readonly acquireLease: boolean;
      readonly refresh: "never" | "validate-only";
      readonly writeback: "never";
      readonly sessionForAgent: "stored";
    }
  | {
      readonly kind: "rotating-session";
      readonly readSession: true;
      readonly acquireLease: true;
      readonly refresh: "before-run" | "lazy";
      readonly writeback: "before-task" | "after-successful-refresh";
      readonly sessionForAgent: "refreshed";
    };

export const providerFailureCodes = [
  "needs_reconnect",
  "quota_limited",
  "permission_required",
  "provider_session_invalid",
  "provider_output_invalid",
  "task_mode_unsupported",
  "task_cancelled",
  "task_timeout",
  "stale_generation",
  "backend_unavailable",
  "goal_slice_exhausted",
  "model_unavailable",
  "unknown_runtime_failure",
] as const;

export type ProviderFailureCode = (typeof providerFailureCodes)[number];

export function isProviderFailureCode(
  value: unknown,
): value is ProviderFailureCode {
  return (
    typeof value === "string" &&
    providerFailureCodes.includes(value as ProviderFailureCode)
  );
}

export type ProviderFailure = {
  readonly code: ProviderFailureCode;
  readonly retryable: boolean;
  readonly reconnectRequired: boolean;
  readonly safeMessage: string;
  readonly causeCategory?: string;
  readonly details?: Readonly<Record<string, string>>;
};

export type SessionValidationResult =
  | { readonly status: "valid"; readonly warnings: readonly RuntimeWarning[] }
  | { readonly status: "invalid"; readonly failure: ProviderFailure };

export type ProviderTaskKind = "review" | "structured-prompt" | "health-check";

export type AgentUsage = {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
};

export type AgentCost = {
  readonly amount: number;
  readonly currency: "USD";
};

export type AgentToolCall = {
  readonly id?: string;
  readonly name: string;
  readonly status?: "started" | "completed" | "failed" | "denied";
  readonly safeInput?: Readonly<Record<string, unknown>>;
  readonly safeInputPreview?: string;
  readonly safeOutputPreview?: string;
};

export type ProviderTaskControls = {
  readonly model?: string;
  readonly maxTurns?: number;
  readonly allowedTools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly editMode?: "read-only" | "allow-edits";
  readonly providerSandboxMode?: "workspace-write" | "danger-full-access";
  readonly responseFormat?: "text" | "json";
  readonly outputSchemaName?: string;
};

export type ProviderTaskTelemetry = {
  readonly providerRunId?: string;
  readonly providerSessionId?: string;
  readonly durationMs?: number;
  readonly turns?: number;
  readonly usage?: AgentUsage;
  readonly cost?: AgentCost;
  readonly toolCalls?: readonly AgentToolCall[];
  readonly finishReason?:
    | "completed"
    | "waiting_for_input"
    | "max_turns"
    | "cancelled"
    | "timeout"
    | "provider_error";
};

export type ProviderTaskEvent =
  | {
      readonly type: "started";
      readonly occurredAt: Date;
      readonly telemetry?: ProviderTaskTelemetry;
    }
  | {
      readonly type: "text_delta";
      readonly occurredAt: Date;
      readonly text: string;
      readonly telemetry?: ProviderTaskTelemetry;
    }
  | {
      readonly type: "tool_call";
      readonly occurredAt: Date;
      readonly toolCall: AgentToolCall;
      readonly telemetry?: ProviderTaskTelemetry;
    }
  | {
      readonly type: "usage";
      readonly occurredAt: Date;
      readonly usage: AgentUsage;
      readonly telemetry?: ProviderTaskTelemetry;
    }
  | {
      readonly type: "warning";
      readonly occurredAt: Date;
      readonly warning: RuntimeWarning;
      readonly telemetry?: ProviderTaskTelemetry;
    }
  | {
      readonly type: "completed";
      readonly occurredAt: Date;
      readonly result: ProviderTaskResult;
      readonly telemetry?: ProviderTaskTelemetry;
    };

export type ProviderTask = {
  readonly kind: ProviderTaskKind;
  readonly prompt: string;
  readonly systemPrompt?: string;
  readonly outputSchemaName?: string;
  readonly controls?: ProviderTaskControls;
  readonly metadata?: Readonly<Record<string, string>>;
};

export type ManagedRunStatus =
  | "active"
  | "waiting_for_input"
  | "completed"
  | "failed"
  | "aborted";

export type ManagedRunInputRequest = {
  readonly id: string;
  readonly kind:
    | "missing_context"
    | "decision_required"
    | "permission_required";
  readonly question: string;
  readonly contextSummary?: string;
  readonly suggestedAnswers?: readonly string[];
  readonly audience: "orchestrator" | "user";
};

export type ManagedRunResumeHandle = {
  readonly runId: string;
  readonly providerId: string;
  readonly providerInstanceId?: string;
  readonly agentId?: string;
  readonly workerId?: string;
  readonly workspacePath: string;
  readonly threadId?: string;
  readonly providerState?: Readonly<Record<string, string>>;
};

export type ManagedRunRecoveryPacket = {
  readonly originalPrompt: string;
  readonly goalObjective?: string;
  readonly lastOutput: string;
  readonly blockerQuestion: string;
  readonly contextSummary?: string;
  readonly attemptSummary?: string;
  readonly kind?: ProviderTaskKind;
  readonly systemPrompt?: string;
  readonly outputSchemaName?: string;
  readonly controls?: ProviderTaskControls;
  readonly metadata?: Readonly<Record<string, string>>;
};

export type ManagedRunRecord = {
  readonly runId: string;
  readonly status: ManagedRunStatus;
  readonly request?: ManagedRunInputRequest;
  readonly resumeHandle?: ManagedRunResumeHandle;
  readonly recoveryPacket?: ManagedRunRecoveryPacket;
  readonly taskId?: string;
  readonly assignedWorkerId?: string;
  readonly providerInstanceId?: string;
  readonly workspacePath?: string;
  readonly outputText?: string;
  readonly failure?: ProviderFailure;
  readonly updatedAt: Date;
};

export type ProviderTaskResult =
  | {
      readonly status: "completed";
      readonly outputText: string;
      readonly structuredOutput?: unknown;
      /**
       * Optional refreshed session captured during task execution.
       *
       * Some local CLIs rotate auth files while a task is running, not only
       * during the explicit refresh step. Runtime stores may persist this
       * update after a successful task using the same CAS/writeback path as
       * normal refresh.
       */
      readonly sessionUpdate?: SessionArtifact;
      readonly telemetry?: ProviderTaskTelemetry;
      readonly warnings: readonly RuntimeWarning[];
    }
  | {
      readonly status: "waiting_for_input";
      readonly runId: string;
      readonly outputText: string;
      readonly structuredOutput?: unknown;
      readonly request: ManagedRunInputRequest;
      readonly resumeHandle: ManagedRunResumeHandle;
      readonly telemetry?: ProviderTaskTelemetry;
      readonly warnings: readonly RuntimeWarning[];
    }
  | {
      readonly status: "failed";
      readonly failure: ProviderFailure;
      readonly telemetry?: ProviderTaskTelemetry;
      readonly warnings: readonly RuntimeWarning[];
    };

export type WorkspaceHandle = {
  readonly path: string;
  readonly dispose?: () => Promise<void>;
};

export type OutputSink = {
  write(chunk: Uint8Array | string): void;
};

export type ProcessResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
};

export type RunContext = {
  readonly runId: string;
  readonly attempt: number;
  readonly abortSignal: AbortSignal;
};

export type SessionFreshnessAssessment =
  | {
      readonly status: "fresh";
      readonly reason:
        | "recent_refresh"
        | "expires_later"
        | "provider_considers_fresh";
      readonly refreshedAt?: Date;
      readonly expiresAt?: Date;
      readonly warnings: readonly RuntimeWarning[];
    }
  | {
      readonly status: "refresh_recommended";
      readonly reason:
        | "expires_soon"
        | "expired"
        | "max_age_exceeded"
        | "freshness_unknown"
        | "provider_considers_stale";
      readonly refreshedAt?: Date;
      readonly expiresAt?: Date;
      readonly warnings: readonly RuntimeWarning[];
    };

export type SessionReadPurpose = "refresh" | "run" | "health-check";

export type PreparedSessionWrite = {
  readonly writeId: string;
  readonly expectedGeneration: number;
};

export type SessionWriteResult =
  | {
      readonly status: "accepted";
      readonly generation: number;
      readonly generationHash: string;
    }
  | {
      readonly status: "idempotent_replay";
      readonly generation: number;
      readonly generationHash: string;
    }
  | {
      readonly status: "stale_generation";
      readonly currentGeneration: number;
      readonly currentGenerationHash: string;
    };

export type LeaseAcquireResult =
  | {
      readonly status: "granted";
      readonly leaseId: string;
      readonly expiresAt: Date;
    }
  | {
      readonly status: "stale";
      readonly safeMessage: string;
    }
  | {
      readonly status: "denied";
      readonly safeMessage: string;
    };

export type FinalizedLease = {
  readonly leaseId: string;
  readonly restoredGenerationHash: string;
};

export type WritebackCommitResult =
  | { readonly status: "committed" }
  | { readonly status: "idempotent_replay" }
  | { readonly status: "stale_generation"; readonly safeMessage: string };

export type RuntimeEvent = {
  readonly name: string;
  readonly providerId?: string;
  readonly agentId?: string;
  readonly storeId?: string;
  readonly runId?: string;
  readonly durationMs?: number;
  readonly metadata?: Readonly<Record<string, string>>;
};

export type RuntimeMetric = string;

export type IdempotencyKeyInput = {
  readonly providerInstanceId: string;
  readonly runId: string;
  readonly attempt: number;
  readonly purpose: "refresh" | "writeback" | "run-task";
};

export type RefreshSessionResult =
  | {
      readonly status: "ready";
      readonly session: SessionEnvelope;
      readonly writeback: SessionWriteResult;
      readonly warnings: readonly RuntimeWarning[];
    }
  | {
      readonly status: "blocked";
      readonly reason:
        | "provider_reconnect_required"
        | "permission_required"
        | "quota_limited";
      readonly safeMessage: string;
      readonly warnings: readonly RuntimeWarning[];
    }
  | {
      readonly status: "skipped";
      readonly reason:
        | "stale_generation"
        | "session_unchanged"
        | "refresh_not_required";
      readonly session?: SessionEnvelope;
      readonly warnings: readonly RuntimeWarning[];
    };

export type RefreshThenRunResult =
  | {
      readonly status: "completed";
      readonly refresh: RefreshSessionResult;
      readonly task: ProviderTaskResult;
    }
  | {
      readonly status: "blocked";
      readonly reason:
        | "provider_reconnect_required"
        | "permission_required"
        | "quota_limited"
        | "stale_generation"
        | "task_mode_unsupported";
      readonly safeMessage: string;
      readonly warnings: readonly RuntimeWarning[];
    };

export type RuntimeHealthCheckResult = {
  readonly status: "healthy" | "unhealthy";
  readonly failures: readonly ProviderFailure[];
  readonly warnings: readonly RuntimeWarning[];
};
