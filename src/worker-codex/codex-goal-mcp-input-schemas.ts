import { z } from "zod";
import { codexGoalObjectiveMaxChars } from "./codex-goal-jobs";
import { CODEX_GOAL_EXECUTION_ENGINE_SCHEMA } from "./codex-goal-mcp-decision";

export function goalInputSchema(): Record<string, z.ZodTypeAny> {
  return {
    jobId: z.string().optional(),
    configPath: z.string().optional(),
    jobRootDir: z.string().optional(),
    authRootDir: z.string().optional(),
    stateRootDir: z.string().optional(),
    workspacePath: z.string().optional(),
    promptPath: z.string().optional(),
    codexGoalObjective: z.string().max(codexGoalObjectiveMaxChars).describe(
      "Short app-server goal objective, max 4000 characters. For long instructions, keep the full task in promptPath and reference docs/files here.",
    ).optional(),
    taskId: z.string().optional(),
    accounts: z.union([z.string(), z.array(z.string())]).optional(),
    outputPath: z.string().optional(),
    progressPath: z.string().optional(),
    progressHeartbeatMs: z.number().int().positive().optional(),
    codexBinaryPath: z.string().optional(),
    model: z.string().optional(),
    reasoningEffort: z.string().optional(),
    serviceTier: z.string().optional(),
    executionEngine: CODEX_GOAL_EXECUTION_ENGINE_SCHEMA.optional(),
    taskTimeoutMs: z.number().int().positive().optional(),
    appServerStartupTimeoutMs: z.number().int().positive().optional(),
    staleLockMs: z.number().int().positive().optional(),
    maxAccountCycles: z.number().int().positive().optional(),
    editMode: z.string().optional(),
    providerSandboxMode: z.string().optional(),
    accessBoundary: z.string().optional(),
    projectAccessScope: z.record(z.string(), z.unknown()).optional(),
    allowDangerFullAccess: z.boolean().optional(),
    networkAccess: z.string().optional(),
    allowDuplicateAccountIdentities: z.boolean().optional(),
    requireGitWorkspace: z.boolean().optional(),
    prewarmOnStart: z.boolean().optional(),
    workerReportMode: z.enum(["runtime-only", "structured-output"]).optional(),
    tmuxSession: z.string().optional(),
    cwd: z.string().optional(),
    logPath: z.string().optional(),
    outputFormat: z.enum(["text", "json"]).optional(),
  };
}

export function statusInputSchema(): Record<string, z.ZodTypeAny> {
  return {
    jobRootDir: z.string().optional(),
    taskId: z.string().optional(),
    workspacePath: z.string().optional(),
    tmuxSession: z.string().optional(),
    logPath: z.string().optional(),
    progressPath: z.string().optional(),
    accessBoundary: z.string().optional(),
    cwd: z.string().optional(),
  };
}
