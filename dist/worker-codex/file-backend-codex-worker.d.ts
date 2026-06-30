import { type ClockPort, type ManagedRunInputRequest, type ManagedRunRecoveryPacket, type ManagedRunResumeHandle, type ObservabilityPort, type ProviderTask, type RuntimeDeps } from "@vioxen/subscription-runtime/core";
import { type CodexExecutionProfile, type CodexAppServerProcessFactory, type CodexReasoningEffort, type CodexServiceTier } from "@vioxen/subscription-runtime/provider-codex";
import { type CapacityAwareSubscriptionWorker, type SubscriptionWorkerHealth, type SubscriptionWorkerPrewarmResult, type SubscriptionWorkerRunOptions, type SubscriptionWorkerState, type WorkerCapacitySnapshot } from "@vioxen/subscription-runtime/worker-core";
export type FileBackendCodexWorkerOptions = {
    readonly workerId?: string;
    readonly providerInstanceId: string;
    readonly stateRootDir: string;
    readonly codexBinaryPath: string;
    readonly encryptionKey: Uint8Array | string;
    readonly model?: string;
    readonly reasoningEffort?: CodexReasoningEffort;
    readonly serviceTier?: CodexServiceTier;
    readonly sessionCacheSlots?: number;
    /**
     * Prompt used to fully warm the Codex app-server and model path.
     * Set to false to warm only the daemon process.
     */
    readonly warmupPrompt?: string | false;
    readonly taskTimeoutMs?: number;
    readonly refreshFreshnessMs?: number;
    readonly refreshBeforeExpiryMs?: number;
    readonly maxSessionAgeMs?: number;
    readonly refreshConflictRetryMaxMs?: number;
    readonly sourceEnv?: Readonly<Record<string, string | undefined>>;
    readonly executionEngine?: CodexWorkerExecutionEngine;
    readonly appServerProcessFactory?: CodexAppServerProcessFactory;
    readonly executionProfile?: CodexExecutionProfile;
    readonly cleanThreadPrewarm?: boolean;
    readonly observability?: ObservabilityPort;
    readonly runner?: RuntimeDeps["runner"];
    readonly workspace?: RuntimeDeps["workspace"];
    readonly workspacePath?: string;
    readonly clock?: ClockPort;
    readonly capacityAccountId?: string;
    readonly capacityPolicy?: CodexWorkerCapacityPolicy;
};
export type CodexWorkerExecutionEngine = "app-server" | "app-server-goal" | "packaged-exec" | "plain-exec";
export type CodexWorkerCapacityPolicy = {
    readonly softMaxRunsPerWindow?: number;
    readonly windowMs?: number;
    readonly quotaCooldownMs?: number;
    readonly reconnectCooldownMs?: number;
    readonly maxReconnectRetriesPerAccount?: number;
};
export type FileBackendCodexWorkerJob = {
    readonly runId?: string;
    readonly prompt: string;
    readonly systemPrompt?: string;
    readonly kind?: ProviderTask["kind"];
    readonly outputSchemaName?: string;
    readonly controls?: ProviderTask["controls"];
    readonly abortSignal?: AbortSignal;
    readonly metadata?: Readonly<Record<string, string>>;
    readonly recoveryPacket?: ManagedRunRecoveryPacket;
};
export type FileBackendCodexWorkerResult = {
    readonly status?: "completed";
    readonly outputText: string;
    readonly structuredOutput?: unknown;
    readonly warnings: readonly {
        readonly code: string;
        readonly safeMessage: string;
    }[];
} | {
    readonly status: "waiting_for_input";
    readonly runId: string;
    readonly outputText: string;
    readonly request: ManagedRunInputRequest;
    readonly resumeHandle: ManagedRunResumeHandle;
    readonly structuredOutput?: unknown;
    readonly warnings: readonly {
        readonly code: string;
        readonly safeMessage: string;
    }[];
};
export type FileBackendCodexManagedRunResumeInput = {
    readonly runId: string;
    readonly requestId: string;
    readonly answer: string;
    readonly resumeHandle: ManagedRunResumeHandle;
    readonly outputSchemaName?: string;
    readonly controls?: ProviderTask["controls"];
    readonly abortSignal?: AbortSignal;
};
export declare class FileBackendCodexWorker implements CapacityAwareSubscriptionWorker<FileBackendCodexWorkerJob, FileBackendCodexWorkerResult> {
    private readonly options;
    readonly workerId: string;
    private workerState;
    private readonly redactor;
    private readonly runner;
    private readonly workspace;
    private readonly observability;
    private readonly clock;
    private readonly sessionDriver;
    private readonly agentDriver;
    private readonly sessionStore;
    private readonly managedRunStore;
    private readonly runtime;
    private readonly ownedWorkspace;
    private readonly prewarmWorkspace;
    private capacityState;
    private windowStartedAtMs;
    private runsInWindow;
    private consecutiveReconnectFailures;
    private quotaGroup;
    private capacityAccountId;
    private seededCodexAuthJsonPath;
    constructor(options: FileBackendCodexWorkerOptions);
    get state(): SubscriptionWorkerState;
    start(): Promise<void>;
    seedCodexAuthJsonFile(authJsonPath: string): Promise<void>;
    seedCodexAuthJson(authJson: string): Promise<void>;
    prewarm(): Promise<SubscriptionWorkerPrewarmResult>;
    run(job: FileBackendCodexWorkerJob, options?: SubscriptionWorkerRunOptions): Promise<FileBackendCodexWorkerResult>;
    resumeManagedRun(input: FileBackendCodexManagedRunResumeInput): Promise<FileBackendCodexWorkerResult>;
    health(): Promise<SubscriptionWorkerHealth>;
    dispose(): Promise<void>;
    capacity(): WorkerCapacitySnapshot;
    private recoverManagedRun;
    private taskResultToOutput;
    private persistResumeSessionUpdate;
    private persistWaitingManagedRun;
    private workerWaitingResult;
    private workerResumeHandle;
    private assertResumeHandleMatchesWorker;
    private recordSuccessfulRun;
    private recordFailure;
    private recordBlocked;
    private recordReconnectRequired;
    private rollCapacityWindow;
    private rememberStoredQuotaGroup;
    private rememberQuotaGroup;
    private exportSeededCodexAuthJsonFileQuietly;
    private withCapacityDetails;
    private assertStarted;
}
//# sourceMappingURL=file-backend-codex-worker.d.ts.map