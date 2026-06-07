import { type ClockPort, type ObservabilityPort, type ProviderTask, type RuntimeDeps } from "@vioxen/subscription-runtime/core";
import { type CodexExecutionProfile, type CodexAppServerProcessFactory, type CodexReasoningEffort } from "@vioxen/subscription-runtime/provider-codex";
import { type SubscriptionWorker, type SubscriptionWorkerHealth, type SubscriptionWorkerPrewarmResult, type SubscriptionWorkerState } from "@vioxen/subscription-runtime/worker-core";
export type FileBackendCodexWorkerOptions = {
    readonly workerId?: string;
    readonly providerInstanceId: string;
    readonly stateRootDir: string;
    readonly codexBinaryPath: string;
    readonly encryptionKey: Uint8Array | string;
    readonly model?: string;
    readonly reasoningEffort?: CodexReasoningEffort;
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
    readonly appServerProcessFactory?: CodexAppServerProcessFactory;
    readonly executionProfile?: CodexExecutionProfile;
    readonly cleanThreadPrewarm?: boolean;
    readonly observability?: ObservabilityPort;
    readonly runner?: RuntimeDeps["runner"];
    readonly workspace?: RuntimeDeps["workspace"];
    readonly clock?: ClockPort;
};
export type FileBackendCodexWorkerJob = {
    readonly runId?: string;
    readonly prompt: string;
    readonly kind?: ProviderTask["kind"];
    readonly outputSchemaName?: string;
    readonly abortSignal?: AbortSignal;
    readonly metadata?: Readonly<Record<string, string>>;
};
export type FileBackendCodexWorkerResult = {
    readonly outputText: string;
    readonly structuredOutput?: unknown;
    readonly warnings: readonly {
        readonly code: string;
        readonly safeMessage: string;
    }[];
};
export declare class FileBackendCodexWorker implements SubscriptionWorker<FileBackendCodexWorkerJob, FileBackendCodexWorkerResult> {
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
    private readonly runtime;
    private readonly ownedWorkspace;
    constructor(options: FileBackendCodexWorkerOptions);
    get state(): SubscriptionWorkerState;
    start(): Promise<void>;
    seedCodexAuthJsonFile(authJsonPath: string): Promise<void>;
    seedCodexAuthJson(authJson: string): Promise<void>;
    prewarm(): Promise<SubscriptionWorkerPrewarmResult>;
    run(job: FileBackendCodexWorkerJob): Promise<FileBackendCodexWorkerResult>;
    health(): Promise<SubscriptionWorkerHealth>;
    dispose(): Promise<void>;
    private assertStarted;
}
//# sourceMappingURL=file-backend-codex-worker.d.ts.map