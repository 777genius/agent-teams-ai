import type { AttemptFailureReason } from "@vioxen/subscription-runtime/worker-core";
import type { CodexGoalRunConfig } from "./codex-goal-runner.js";
export type CodexGoalOutputFormat = "text" | "json";
export type CodexGoalLaunchInput = {
    readonly config: CodexGoalRunConfig;
    readonly tmuxSession?: string;
    readonly cwd: string;
    readonly logPath: string;
    readonly format?: CodexGoalOutputFormat;
    readonly cliCommand: readonly string[];
};
export type CodexGoalTmuxCommand = {
    readonly args: readonly string[];
    readonly preview: string;
};
export type CodexGoalStatusInput = {
    readonly jobRootDir?: string;
    readonly taskId?: string;
    readonly workspacePath?: string;
    readonly tmuxSession?: string;
    readonly logPath?: string;
};
export type CodexGoalRecommendedAction = "start_worker" | "wait_for_worker" | "review_completed" | "continue_after_capacity" | "continue_after_timeout" | "inspect_dirty_workspace" | "inspect_dirty_failure" | "inspect_failure" | "check_log_or_result";
export type CodexGoalStatus = {
    readonly tmuxAlive?: boolean;
    readonly resultPath?: string;
    readonly resultExists?: boolean;
    readonly resultStatus?: string;
    readonly resultReason?: AttemptFailureReason;
    readonly workspaceDirty?: boolean;
    readonly changedFiles?: readonly string[];
    readonly logPath?: string;
    readonly logExists?: boolean;
    readonly logUpdatedAt?: string;
    readonly recommendedAction: CodexGoalRecommendedAction;
    readonly warnings: readonly string[];
};
export type CodexGoalDoctorCheck = {
    readonly name: string;
    readonly ok: boolean;
    readonly message: string;
};
export type CodexGoalDoctorResult = {
    readonly ok: boolean;
    readonly checks: readonly CodexGoalDoctorCheck[];
};
export type CodexGoalAccountStatus = "ready" | "auth_missing" | "auth_invalid";
export type CodexGoalAccountSlotStatus = {
    readonly name: string;
    readonly authJsonPath: string;
    readonly status: CodexGoalAccountStatus;
    readonly byteLength?: number;
    readonly authJsonSha256Prefix?: string;
    readonly lastRefreshAt?: string;
    readonly expiresAt?: string;
    readonly warnings: readonly string[];
    readonly safeMessage: string;
};
export type CodexGoalAccountStatusInput = {
    readonly authRootDir: string;
    readonly accounts?: readonly string[];
};
export declare function buildCodexGoalNoTmuxCommand(input: CodexGoalLaunchInput): string;
export declare function buildCodexGoalTmuxCommand(input: CodexGoalLaunchInput): CodexGoalTmuxCommand;
export declare function startCodexGoalTmux(input: CodexGoalLaunchInput): Promise<CodexGoalTmuxCommand>;
export declare function collectCodexGoalStatus(input: CodexGoalStatusInput): Promise<CodexGoalStatus>;
export declare function doctorCodexGoal(input: {
    readonly config: CodexGoalRunConfig;
    readonly tmuxSession?: string;
}): Promise<CodexGoalDoctorResult>;
export declare function tailCodexGoalLog(logPath: string, lines: number): Promise<string>;
export declare function listCodexGoalAccountStatuses(input: CodexGoalAccountStatusInput): Promise<readonly CodexGoalAccountSlotStatus[]>;
export declare function recommendCodexGoalAction(input: {
    readonly tmuxAlive?: boolean;
    readonly resultStatus?: string;
    readonly resultReason?: AttemptFailureReason;
    readonly workspaceDirty?: boolean;
    readonly resultExists?: boolean;
}): CodexGoalRecommendedAction;
export declare function shellQuote(value: string): string;
//# sourceMappingURL=codex-goal-ops.d.ts.map