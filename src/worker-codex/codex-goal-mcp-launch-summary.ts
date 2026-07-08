import type { CodexGoalLaunchInput } from "./codex-goal-ops";

type JsonObject = Readonly<Record<string, unknown>>;

export function codexGoalLaunchSummary(launch: CodexGoalLaunchInput): JsonObject {
  return {
    ...(launch.config.jobId ? { jobId: launch.config.jobId } : {}),
    taskId: launch.config.taskId,
    workspacePath: launch.config.workspacePath,
    promptPath: launch.config.promptPath,
    accountNames: launch.config.accounts.map((account) => account.name),
    model: launch.config.model,
    reasoningEffort: launch.config.reasoningEffort,
    serviceTier: launch.config.serviceTier,
    executionEngine: launch.config.executionEngine ?? "app-server-goal",
    taskTimeoutMs: launch.config.taskTimeoutMs,
    appServerStartupTimeoutMs: launch.config.appServerStartupTimeoutMs,
    progressPath: launch.config.progressPath,
    progressHeartbeatMs: launch.config.progressHeartbeatMs,
    maxAccountCycles: launch.config.maxAccountCycles,
    tmuxSession: launch.tmuxSession,
    logPath: launch.logPath,
  };
}
