import { isAbsolute, join, relative, resolve } from "node:path";
import type {
  AgentUsage,
  ManagedRunInputRequest,
  ManagedRunResumeHandle,
} from "@vioxen/subscription-runtime/core";
import type {
  CodexReasoningEffort,
  CodexSandboxMode,
  CodexServiceTier,
} from "../../codex-json-execution-engine";

export type AppServerWarning = {
  readonly code: string;
  readonly safeMessage: string;
};

export type AppServerWaitingForInputResult = {
  readonly status: "waiting_for_input";
  readonly runId: string;
  readonly outputText: string;
  readonly request: ManagedRunInputRequest;
  readonly resumeHandle: ManagedRunResumeHandle;
  readonly usage?: AgentUsage;
  readonly warnings: readonly AppServerWarning[];
};

export type AppServerCompletedResult = {
  readonly status?: "completed";
  readonly outputText: string;
  readonly usage?: AgentUsage;
  readonly warnings: readonly AppServerWarning[];
};

export type AppServerRunResult =
  | AppServerCompletedResult
  | AppServerWaitingForInputResult;

export type PreparedThread = {
  readonly threadId: string;
  readonly workspacePath: string;
  readonly model: string;
  readonly reasoningEffort: CodexReasoningEffort;
  readonly serviceTier?: CodexServiceTier;
  readonly sandboxMode: CodexSandboxMode;
  readonly systemPrompt: string | null;
};

export type CodexThreadGoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "usageLimited"
  | "budgetLimited"
  | "complete";

export type CodexThreadGoal = {
  readonly threadId: string;
  readonly objective: string;
  readonly status: CodexThreadGoalStatus;
  readonly usage?: AgentUsage;
};

export type CodexAppServerNativeToolSurface = "default" | "disabled";

export type CodexAppServerCommandApprovalInput = {
  readonly source:
    | "command_execution"
    | "legacy_exec"
    | "thread_shell_command";
  readonly command?: readonly string[];
  readonly commandText?: string;
  readonly cwd?: string;
};

export type CodexAppServerCommandApprovalDecision = {
  readonly approved: boolean;
  readonly reason?: string;
};

export type CodexAppServerCommandApprovalPolicy = {
  readonly reviewCommand: (
    input: CodexAppServerCommandApprovalInput,
  ) => CodexAppServerCommandApprovalDecision;
};

export type CodexAppServerSandboxPolicy =
  | { readonly type: "dangerFullAccess" }
  | { readonly type: "readOnly"; readonly networkAccess: false }
  | {
      readonly type: "workspaceWrite";
      readonly writableRoots: readonly string[];
      readonly networkAccess: false;
      readonly excludeSlashTmp: true;
      readonly excludeTmpdirEnvVar: boolean;
    };

export type CodexAppServerThreadRuntimePolicy = {
  readonly runtimeWorkspaceRoots: readonly string[];
  readonly sandboxMode: CodexSandboxMode;
  readonly developerInstructions: string | null;
};

export const defaultTimeoutMs = 10 * 60 * 1000;
export const defaultStartupTimeoutMs = 2 * 60 * 1000;
export const defaultControlRequestTimeoutMs = 30 * 1000;
export const defaultReconnectGraceMs = 10 * 60 * 1000;
export const defaultMaxOutputBytes = 512 * 1024;
export const defaultMaxGoalTurns = 20;
export const appServerGoalObjectiveMaxChars = 4000;
export const defaultGoalContinuePrompt =
  "Continue working toward the active goal. If the goal is complete, mark it complete and summarize the result.";

export function normalizeSystemPrompt(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function uniqueNonEmptyStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function codexExtraWritableRootsFromEnv(
  sourceEnv: Readonly<Record<string, string | undefined>> | undefined,
): readonly string[] {
  if (sourceEnv?.SUBSCRIPTION_RUNTIME_CODEX_SUPPRESS_EXTRA_WRITABLE_ROOTS === "1") {
    return [];
  }
  const raw = sourceEnv?.SUBSCRIPTION_RUNTIME_CODEX_EXTRA_WRITABLE_ROOTS;
  if (!raw) return [];
  return uniqueNonEmptyStrings(raw.split(/[,\n:]/u));
}

export function codexAgentTempRootFromEnv(
  sourceEnv: Readonly<Record<string, string | undefined>> | undefined,
): string | null {
  const jobRoot = sourceEnv?.SUBSCRIPTION_RUNTIME_JOB_ROOT?.trim();
  const runtimeTempRoot = sourceEnv?.SUBSCRIPTION_RUNTIME_TMPDIR?.trim();
  const agentTempRoot = sourceEnv?.TMPDIR?.trim();
  if (!jobRoot || !runtimeTempRoot || !agentTempRoot) return null;
  if (!isAbsolute(jobRoot) || !isAbsolute(runtimeTempRoot) || !isAbsolute(agentTempRoot)) {
    return null;
  }
  const resolvedJobRoot = resolve(jobRoot);
  const resolvedRuntimeTempRoot = resolve(runtimeTempRoot);
  const resolvedAgentTempRoot = resolve(agentTempRoot);
  if (relative(resolvedJobRoot, resolvedRuntimeTempRoot) !== "tmp") return null;
  if (resolvedAgentTempRoot !== join(resolvedRuntimeTempRoot, "agent")) return null;
  return resolvedAgentTempRoot;
}

export function codexAgentTempWritableRootsFromEnv(
  sourceEnv: Readonly<Record<string, string | undefined>> | undefined,
): readonly string[] {
  const agentTempRoot = codexAgentTempRootFromEnv(sourceEnv);
  return agentTempRoot ? [agentTempRoot] : [];
}

export function mergeDeveloperInstructions(input: {
  readonly base: string | null;
  readonly systemPrompt?: string | undefined;
}): string | null {
  const systemPrompt = normalizeSystemPrompt(input.systemPrompt);
  if (!systemPrompt) return input.base;
  if (!input.base) return systemPrompt;
  return `${input.base}\n\n${systemPrompt}`;
}

export function codexAppServerThreadRuntimePolicy(input: {
  readonly workspacePath: string;
  readonly sandboxMode?: CodexSandboxMode;
  readonly sourceEnv?: Readonly<Record<string, string | undefined>>;
  readonly baseDeveloperInstructions: string | null;
  readonly systemPrompt?: string | undefined;
}): CodexAppServerThreadRuntimePolicy {
  const sandboxMode = input.sandboxMode ?? "read-only";
  return {
    runtimeWorkspaceRoots: uniqueNonEmptyStrings([
      input.workspacePath,
      ...(sandboxMode === "workspace-write"
        ? codexAgentTempWritableRootsFromEnv(input.sourceEnv)
        : []),
      ...codexExtraWritableRootsFromEnv(input.sourceEnv),
    ]),
    sandboxMode,
    developerInstructions: mergeDeveloperInstructions({
      base: input.baseDeveloperInstructions,
      systemPrompt: input.systemPrompt,
    }),
  };
}

export function codexAppServerSandboxPolicy(input: {
  readonly sandboxMode?: CodexSandboxMode;
  readonly workspacePath: string;
  readonly sourceEnv?: Readonly<Record<string, string | undefined>>;
}): CodexAppServerSandboxPolicy {
  const sandboxMode = input.sandboxMode ?? "read-only";
  if (sandboxMode === "danger-full-access") {
    return { type: "dangerFullAccess" };
  }
  if (sandboxMode === "workspace-write") {
    const agentTempRoots = codexAgentTempWritableRootsFromEnv(input.sourceEnv);
    return {
      type: "workspaceWrite",
      writableRoots: uniqueNonEmptyStrings([
        input.workspacePath,
        ...agentTempRoots,
        ...codexExtraWritableRootsFromEnv(input.sourceEnv),
      ]),
      networkAccess: false,
      excludeSlashTmp: true,
      excludeTmpdirEnvVar: agentTempRoots.length === 0,
    };
  }
  return { type: "readOnly", networkAccess: false };
}
