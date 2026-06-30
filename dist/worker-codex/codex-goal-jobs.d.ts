import type { CodexGoalRunConfig } from "./codex-goal-runner.js";
import type { CodexGoalOutputFormat } from "./codex-goal-ops.js";
export declare const codexGoalJobManifestSchemaVersion = 1;
export type CodexGoalJobManifest = {
    readonly schemaVersion: typeof codexGoalJobManifestSchemaVersion;
    readonly jobId: string;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly description?: string;
    readonly tags?: readonly string[];
    readonly jobRootDir: string;
    readonly authRootDir?: string;
    readonly stateRootDir?: string;
    readonly workspacePath: string;
    readonly promptPath: string;
    readonly taskId: string;
    readonly accounts: readonly string[];
    readonly outputPath?: string;
    readonly progressPath?: string;
    readonly progressHeartbeatMs?: number;
    readonly codexBinaryPath?: string;
    readonly model?: string;
    readonly reasoningEffort?: CodexGoalRunConfig["reasoningEffort"];
    readonly serviceTier?: CodexGoalRunConfig["serviceTier"];
    readonly executionEngine?: CodexGoalRunConfig["executionEngine"];
    readonly taskTimeoutMs?: number;
    readonly staleLockMs?: number;
    readonly maxAccountCycles?: number;
    readonly permissionMode?: CodexGoalRunConfig["permissionMode"];
    readonly allowDuplicateAccountIdentities?: boolean;
    readonly requireGitWorkspace?: boolean;
    readonly prewarmOnStart?: boolean;
    readonly tmuxSession?: string;
    readonly cwd?: string;
    readonly logPath?: string;
    readonly outputFormat?: CodexGoalOutputFormat;
};
export type CodexGoalJobManifestInput = Omit<CodexGoalJobManifest, "schemaVersion" | "createdAt" | "updatedAt"> & {
    readonly createdAt?: string;
    readonly updatedAt?: string;
};
export type CodexGoalJobManifestPatch = Partial<Omit<CodexGoalJobManifestInput, "jobId" | "createdAt">>;
export type CodexGoalJobSummary = {
    readonly jobId: string;
    readonly description?: string;
    readonly tags: readonly string[];
    readonly taskId: string;
    readonly workspacePath: string;
    readonly promptPath: string;
    readonly tmuxSession?: string;
    readonly accountNames: readonly string[];
    readonly updatedAt: string;
    readonly manifestPath: string;
};
export type CodexGoalJobRegistryInput = {
    readonly registryRootDir?: string;
    readonly cwd?: string;
};
export declare function defaultCodexGoalJobRegistryRoot(): string;
export declare function defaultCodexGoalJobRoot(jobId: string): string;
export declare function resolveCodexGoalJobRegistryRoot(input?: CodexGoalJobRegistryInput): string;
export declare function codexGoalJobManifestPath(input: {
    readonly registryRootDir: string;
    readonly jobId: string;
}): string;
export declare function listCodexGoalJobs(input?: CodexGoalJobRegistryInput): Promise<readonly CodexGoalJobSummary[]>;
export declare function readCodexGoalJob(input: {
    readonly registryRootDir?: string;
    readonly jobId: string;
    readonly cwd?: string;
}): Promise<CodexGoalJobManifest>;
export declare function createCodexGoalJob(input: {
    readonly registryRootDir?: string;
    readonly manifest: CodexGoalJobManifestInput;
    readonly overwrite?: boolean;
    readonly cwd?: string;
    readonly now?: Date;
}): Promise<CodexGoalJobManifest>;
export declare function updateCodexGoalJob(input: {
    readonly registryRootDir?: string;
    readonly jobId: string;
    readonly patch: CodexGoalJobManifestPatch;
    readonly cwd?: string;
    readonly now?: Date;
}): Promise<CodexGoalJobManifest>;
export declare function codexGoalJobToArgs(manifest: CodexGoalJobManifest): Readonly<Record<string, unknown>>;
export declare function summarizeCodexGoalJob(manifest: CodexGoalJobManifest, registryRootDir: string): CodexGoalJobSummary;
export declare function parseCodexGoalJobManifest(value: unknown): CodexGoalJobManifest;
//# sourceMappingURL=codex-goal-jobs.d.ts.map