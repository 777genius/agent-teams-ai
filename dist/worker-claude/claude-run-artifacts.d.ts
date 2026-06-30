import { type ClockPort, type ProviderTaskTelemetry, type RuntimeWarning } from "@vioxen/subscription-runtime/core";
import type { WorkerCapacitySnapshot } from "@vioxen/subscription-runtime/worker-core";
export declare const claudeRunArtifactSchemaVersion = 1;
export type ClaudeRunArtifactStatus = "running" | "completed" | "failed" | "blocked";
export type ClaudeRunManifest = {
    readonly schemaVersion: typeof claudeRunArtifactSchemaVersion;
    readonly providerKind: "claude";
    readonly runId: string;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly providerInstanceId: string;
    readonly workerId: string;
    readonly configDir: string;
    readonly workspacePath?: string;
    readonly jobId?: string;
    readonly threadId?: string;
    readonly capacityAccountId?: string;
};
export type ClaudeRunProgress = {
    readonly schemaVersion: typeof claudeRunArtifactSchemaVersion;
    readonly runId: string;
    readonly status: ClaudeRunArtifactStatus;
    readonly updatedAt: string;
    readonly pid: number;
    readonly workerState?: string;
    readonly providerRunId?: string;
    readonly providerSessionId?: string;
    readonly capacity?: WorkerCapacitySnapshot;
    readonly warningCount?: number;
    readonly controlSignalIds?: readonly string[];
};
export type ClaudeRunResult = {
    readonly schemaVersion: typeof claudeRunArtifactSchemaVersion;
    readonly runId: string;
    readonly status: Exclude<ClaudeRunArtifactStatus, "running">;
    readonly updatedAt: string;
    readonly reason?: string;
    readonly safeMessage?: string;
    readonly failureDetails?: Readonly<Record<string, string>>;
    readonly outputTextPreview?: string;
    readonly telemetry?: ProviderTaskTelemetry;
    readonly warnings?: readonly RuntimeWarning[];
};
export type ClaudeRunArtifactPaths = {
    readonly runDir: string;
    readonly manifestPath: string;
    readonly progressPath: string;
    readonly resultPath: string;
    readonly logPath: string;
};
export type ClaudeRunArtifactStoreOptions = {
    readonly rootDir: string;
    readonly clock?: ClockPort;
    readonly redactor?: {
        redact(input: string): string;
    };
};
export type ClaudeRunArtifactStartInput = {
    readonly runId: string;
    readonly providerInstanceId: string;
    readonly workerId: string;
    readonly configDir: string;
    readonly workspacePath?: string;
    readonly jobId?: string;
    readonly threadId?: string;
    readonly capacityAccountId?: string;
    readonly workerState?: string;
    readonly capacity?: WorkerCapacitySnapshot;
    readonly controlSignalIds?: readonly string[];
};
export declare class FileClaudeRunArtifactStore {
    private readonly options;
    private readonly clock;
    private readonly redactor;
    private readonly terminalRunIds;
    constructor(options: ClaudeRunArtifactStoreOptions);
    paths(runId: string): ClaudeRunArtifactPaths;
    listRunIds(): Promise<readonly string[]>;
    startRun(input: ClaudeRunArtifactStartInput): Promise<void>;
    startHeartbeat(input: {
        readonly runId: string;
        readonly intervalMs: number;
        readonly snapshot: () => Omit<ClaudeRunProgress, "schemaVersion" | "runId" | "updatedAt" | "pid" | "status">;
    }): {
        stop(): void;
    };
    completeRun(input: {
        readonly runId: string;
        readonly outputText?: string;
        readonly telemetry?: ProviderTaskTelemetry;
        readonly warnings?: readonly RuntimeWarning[];
        readonly workerState?: string;
        readonly capacity?: WorkerCapacitySnapshot;
    }): Promise<void>;
    failRun(input: {
        readonly runId: string;
        readonly status?: "failed" | "blocked";
        readonly reason?: string;
        readonly safeMessage?: string;
        readonly failureDetails?: Readonly<Record<string, string>>;
        readonly telemetry?: ProviderTaskTelemetry;
        readonly warnings?: readonly RuntimeWarning[];
        readonly workerState?: string;
        readonly capacity?: WorkerCapacitySnapshot;
    }): Promise<void>;
    writeProgress(input: Omit<ClaudeRunProgress, "schemaVersion" | "updatedAt" | "pid">): Promise<void>;
    appendLog(runId: string, value: Readonly<Record<string, unknown>>): Promise<void>;
    readManifest(runId: string): Promise<ClaudeRunManifest>;
    readManifestByDir(runDir: string): Promise<ClaudeRunManifest>;
    readProgress(runId: string): Promise<ClaudeRunProgress | null>;
    readResult(runId: string): Promise<ClaudeRunResult | null>;
    logStatus(runId: string): Promise<{
        readonly exists: boolean;
        readonly updatedAt?: string;
        readonly byteLength?: number;
    }>;
    tailLog(runId: string, lines: number): Promise<string>;
}
//# sourceMappingURL=claude-run-artifacts.d.ts.map