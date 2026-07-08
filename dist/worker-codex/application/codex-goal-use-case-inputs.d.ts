/// <reference types="node" />
import type { WorkerControlActor, WorkerControlDeliveryMode, WorkerControlIntent, WorkerControlPriority } from "@vioxen/subscription-runtime/worker-core";
import type { CodexGoalOutputFormat } from "../codex-goal-ops.js";
import type { CodexGoalRunConfig } from "../codex-goal-runner.js";
export type CodexGoalInput = {
    readonly jobId?: string;
    readonly configPath?: string;
    readonly jobRootDir?: string;
    readonly authRootDir?: string;
    readonly stateRootDir?: string;
    readonly workspacePath?: string;
    readonly promptPath?: string;
    readonly codexGoalObjective?: string;
    readonly taskId?: string;
    readonly accounts?: string | readonly string[];
    readonly outputPath?: string;
    readonly progressPath?: string;
    readonly progressHeartbeatMs?: number;
    readonly codexBinaryPath?: string;
    readonly model?: string;
    readonly reasoningEffort?: CodexGoalRunConfig["reasoningEffort"];
    readonly serviceTier?: CodexGoalRunConfig["serviceTier"];
    readonly executionEngine?: CodexGoalRunConfig["executionEngine"];
    readonly taskTimeoutMs?: number;
    readonly appServerStartupTimeoutMs?: number;
    readonly staleLockMs?: number;
    readonly maxAccountCycles?: number;
    readonly editMode?: CodexGoalRunConfig["editMode"];
    readonly providerSandboxMode?: CodexGoalRunConfig["providerSandboxMode"];
    readonly accessBoundary?: CodexGoalRunConfig["accessBoundary"];
    readonly projectAccessScope?: CodexGoalRunConfig["projectAccessScope"];
    readonly allowDangerFullAccess?: boolean;
    readonly networkAccess?: CodexGoalRunConfig["networkAccess"];
    readonly allowDuplicateAccountIdentities?: boolean;
    readonly requireGitWorkspace?: boolean;
    readonly prewarmOnStart?: boolean;
    readonly workerReportMode?: CodexGoalRunConfig["workerReportMode"];
    readonly tmuxSession?: string;
    readonly cwd?: string;
    readonly logPath?: string;
    readonly outputFormat?: CodexGoalOutputFormat;
};
export type CodexGoalJobRegistryInput = {
    readonly registryRootDir?: string;
    readonly cwd?: string;
};
export type CodexGoalJobOverviewInput = CodexGoalJobRegistryInput & {
    readonly staleAfterMs?: number;
    readonly tailLines?: number;
    readonly limit?: number;
    readonly jobIdPrefix?: string;
};
export type CodexGoalJobWatchInput = CodexGoalJobOverviewInput & {
    readonly jobIds?: string | readonly string[];
    readonly continueSafeJobs?: boolean;
    readonly maxContinuesPerRun?: number;
    readonly skipDoctor?: boolean;
};
export type CodexGoalJobIdInput = CodexGoalJobRegistryInput & {
    readonly jobId?: string;
};
export type CodexGoalJobCreateInput = CodexGoalInput & CodexGoalJobIdInput & {
    readonly description?: string;
    readonly tags?: readonly string[] | string;
    readonly overwrite?: boolean;
};
export type CodexGoalJobUpdateInput = CodexGoalJobIdInput & Partial<CodexGoalJobCreateInput>;
export type CodexGoalJobLifecycleInput = CodexGoalJobIdInput & {
    readonly confirmContinue?: boolean;
    readonly confirmRecover?: boolean;
    readonly confirmStop?: boolean;
    readonly confirmPause?: boolean;
    readonly forceStart?: boolean;
    readonly forceStop?: boolean;
    readonly forcePause?: boolean;
    readonly skipDoctor?: boolean;
    readonly staleAfterMs?: number;
    readonly tailLines?: number;
    readonly reason?: string;
};
export type CodexGoalJobBriefInput = CodexGoalJobIdInput & {
    readonly staleAfterMs?: number;
    readonly tailLines?: number;
    readonly targetCommit?: string;
    readonly targetWorkspacePath?: string;
};
export type CodexGoalJobResultReconcileInput = CodexGoalJobBriefInput & {
    readonly forceWrite?: boolean;
    readonly preservePatch?: boolean;
};
export type CodexGoalJobDecisionInput = CodexGoalJobBriefInput & {
    readonly includeRegistryConflicts?: boolean;
};
export type CodexGoalJobHandoffInput = CodexGoalJobBriefInput & {
    readonly includeCliFallback?: boolean;
};
export type CodexGoalWorkerControlInput = CodexGoalJobIdInput & {
    readonly intent?: WorkerControlIntent;
    readonly deliveryMode?: WorkerControlDeliveryMode;
    readonly body?: string;
    readonly createdBy?: WorkerControlActor;
    readonly callerKind?: WorkerControlActor;
    readonly callerActor?: WorkerControlActor;
    readonly callerId?: string;
    readonly priority?: WorkerControlPriority;
    readonly idempotencyKey?: string;
    readonly expiresAt?: string;
    readonly supersedesSignalIds?: string | readonly string[];
    readonly signalId?: string;
    readonly supersededBySignalId?: string;
    readonly reason?: string;
    readonly includeBodies?: boolean;
    readonly repair?: boolean;
    readonly acceptedStaleAfterMs?: number;
};
export declare function registryRootFromInput(args: CodexGoalJobRegistryInput): string;
//# sourceMappingURL=codex-goal-use-case-inputs.d.ts.map