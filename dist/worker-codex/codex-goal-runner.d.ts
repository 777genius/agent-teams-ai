import type { ProviderTaskControls } from "@vioxen/subscription-runtime/core";
import type { CodexReasoningEffort, CodexServiceTier } from "@vioxen/subscription-runtime/provider-codex";
import type { SafeExecutionPolicy, SafeExecutionRunResult, TaskEffectMode } from "@vioxen/subscription-runtime/worker-core";
import { FileBackendCodexSafeExecutor, type FileBackendCodexSafeExecutorOptions } from "./file-backend-codex-safe-executor.js";
import type { CodexWorkerExecutionEngine, FileBackendCodexWorkerResult } from "./file-backend-codex-worker.js";
export type CodexGoalAccountSlot = {
    readonly name: string;
    readonly authJsonPath?: string;
};
export type CodexGoalRunConfig = {
    readonly jobId?: string;
    readonly jobRootDir: string;
    readonly stateRootDir?: string;
    readonly encryptionKeyPath?: string;
    readonly authRootDir: string;
    readonly workspacePath: string;
    readonly promptPath: string;
    readonly taskId: string;
    readonly accounts: readonly CodexGoalAccountSlot[];
    readonly outputPath?: string;
    readonly progressPath?: string;
    readonly progressHeartbeatMs?: number;
    readonly executorId?: string;
    readonly codexBinaryPath?: string;
    readonly model?: string;
    readonly reasoningEffort?: CodexReasoningEffort;
    readonly serviceTier?: CodexServiceTier;
    readonly executionEngine?: CodexWorkerExecutionEngine;
    readonly taskTimeoutMs?: number;
    readonly staleLockMs?: number;
    readonly maxAccountCycles?: number;
    readonly quotaCooldownMs?: number;
    readonly reconnectCooldownMs?: number;
    readonly maxReconnectRetriesPerAccount?: number;
    readonly permissionMode?: ProviderTaskControls["permissionMode"];
    readonly goalSummary?: string;
    readonly codexGoalObjective?: string;
    readonly effectMode?: TaskEffectMode;
    readonly safeExecutionPolicy?: SafeExecutionPolicy;
    readonly allowDuplicateAccountIdentities?: boolean;
    readonly requireGitWorkspace?: boolean;
    readonly prewarmOnStart?: boolean;
    readonly sourceEnv?: Readonly<Record<string, string | undefined>>;
};
export type CodexGoalProgressStatus = "starting" | "running" | "completed" | "partial" | "failed" | "aborted";
export type CodexGoalProgressSnapshot = {
    readonly schemaVersion: 1;
    readonly taskId: string;
    readonly status: CodexGoalProgressStatus;
    readonly updatedAt: string;
    readonly pid: number;
    readonly reason?: string;
    readonly resultStatus?: string;
    readonly attemptCount?: number;
    readonly currentAccount?: string;
};
export type CodexGoalRunDeps = {
    readonly createExecutor?: (options: FileBackendCodexSafeExecutorOptions) => CodexGoalExecutor;
};
export type CodexGoalExecutor = {
    run(input: Parameters<FileBackendCodexSafeExecutor["run"]>[0]): Promise<SafeExecutionRunResult<FileBackendCodexWorkerResult>>;
    dispose(): Promise<void>;
};
export declare function runCodexGoal(config: CodexGoalRunConfig, deps?: CodexGoalRunDeps): Promise<SafeExecutionRunResult<FileBackendCodexWorkerResult>>;
export declare function buildCodexGoalExecutorOptions(input: {
    readonly config: CodexGoalRunConfig;
    readonly stateRootDir: string;
    readonly encryptionKey: Uint8Array;
}): FileBackendCodexSafeExecutorOptions;
export declare function readOrCreateCodexGoalEncryptionKey(keyPath: string): Promise<Uint8Array>;
export declare function codexGoalProgressPath(config: Pick<CodexGoalRunConfig, "jobRootDir" | "taskId" | "progressPath">): string;
export declare function codexGoalAccountSlots(accounts: readonly string[]): readonly CodexGoalAccountSlot[];
//# sourceMappingURL=codex-goal-runner.d.ts.map