import { join } from "node:path";
import {
  type ParsedFlags,
  flag,
  option,
  parseOptionalPositiveInteger,
  requiredOption,
  resolvePath,
} from "./codex-goal-cli-support";
import {
  codexGoalAccountSlots,
  type CodexGoalRunConfig,
} from "./codex-goal-runner";
import {
  assertCodexGoalProviderSandboxModeAllowed,
  optionalCodexGoalProviderSandboxMode,
  parseCodexGoalEditMode,
} from "./codex-goal-control-modes";
import {
  optionalCodexGoalAccessBoundary,
  optionalCodexGoalNetworkAccess,
  parseCodexGoalProjectAccessScopeJson,
} from "./codex-goal-access-plan";

type CodexGoalRunConfigWithAppServerStartupTimeout = CodexGoalRunConfig & {
  readonly appServerStartupTimeoutMs?: number;
};

export function runConfigFromFlags(
  values: ParsedFlags,
  env: Readonly<Record<string, string | undefined>>,
  cwd: string,
  jobRootDir: string,
  taskId: string,
): CodexGoalRunConfig {
  const authRootDir = resolvePath(
    cwd,
    option(values, env, "--auth-root", [
      "SUBSCRIPTION_RUNTIME_CODEX_AUTH_ROOT",
    ]) ?? "~/.cache/subscription-runtime/live-codex-auth",
  );
  const accounts = codexGoalAccountSlots(
    splitCsv(
      requiredOption(values, env, "--accounts", ["CODEX_ACCOUNTS"]),
    ),
  );
  const reasoningEffort = (option(values, env, "--effort", [
    "CODEX_REASONING_EFFORT",
  ]) ?? "high") as CodexGoalRunConfig["reasoningEffort"];
  const serviceTier = (option(values, env, "--service-tier", [
    "CODEX_SERVICE_TIER",
  ]) ?? "default") as CodexGoalRunConfig["serviceTier"];
  const executionEngine = (option(values, env, "--execution-engine", [
    "CODEX_EXECUTION_ENGINE",
  ]) ?? "app-server-goal") as CodexGoalRunConfig["executionEngine"];
  const staleLockMs = parseOptionalPositiveInteger(
    option(values, env, "--stale-lock-ms", []),
    "--stale-lock-ms",
  );
  const editModeFlag = option(values, env, "--edit-mode", []);
  const legacyPermissionModeFlag = option(values, env, "--permission-mode", []);
  const editMode = parseCodexGoalEditMode(
    editModeFlag ?? legacyPermissionModeFlag ?? "allow-edits",
    editModeFlag === undefined && legacyPermissionModeFlag !== undefined
      ? "--permission-mode"
      : "--edit-mode",
  );
  const providerSandboxMode = optionalCodexGoalProviderSandboxMode(
    option(values, env, "--provider-sandbox-mode", []),
    "--provider-sandbox-mode",
  );
  const workerReportMode = parseCodexGoalWorkerReportMode(
    option(values, env, "--worker-report-mode", [
      "SUBSCRIPTION_RUNTIME_WORKER_REPORT_MODE",
    ]),
  );
  const appServerStartupTimeoutMs = parseOptionalPositiveInteger(
    option(values, env, "--app-server-startup-timeout-ms", [
      "SUBSCRIPTION_RUNTIME_APP_SERVER_STARTUP_TIMEOUT_MS",
    ]),
    "--app-server-startup-timeout-ms",
  );
  assertCodexGoalProviderSandboxModeAllowed({
    editMode,
    providerSandboxMode,
    fieldName: "--provider-sandbox-mode",
  });
  const accessBoundary = optionalCodexGoalAccessBoundary(
    option(values, env, "--access-boundary", [
      "SUBSCRIPTION_RUNTIME_ACCESS_BOUNDARY",
    ]),
    "--access-boundary",
  );
  const projectAccessScope = parseCodexGoalProjectAccessScopeJson(
    option(values, env, "--project-access-scope-json", [
      "SUBSCRIPTION_RUNTIME_PROJECT_ACCESS_SCOPE_JSON",
    ]),
    "--project-access-scope-json",
  );
  const networkAccess = optionalCodexGoalNetworkAccess(
    option(values, env, "--network-access", [
      "SUBSCRIPTION_RUNTIME_NETWORK_ACCESS",
    ]),
    "--network-access",
  );
  const resolvedJobRootDir = resolvePath(cwd, jobRootDir);
  const sourceEnv = {
    ...env,
    SUBSCRIPTION_RUNTIME_JOB_ROOT: resolvedJobRootDir,
    SUBSCRIPTION_RUNTIME_TMPDIR:
      env.SUBSCRIPTION_RUNTIME_TMPDIR ?? join(resolvedJobRootDir, "tmp"),
    TMPDIR: env.TMPDIR ?? join(resolvedJobRootDir, "tmp"),
  } as const;
  const config: CodexGoalRunConfigWithAppServerStartupTimeout = {
    ...(option(values, env, "--job-id", ["SUBSCRIPTION_RUNTIME_JOB_ID"]) === undefined
      ? {}
      : {
          jobId: option(values, env, "--job-id", [
            "SUBSCRIPTION_RUNTIME_JOB_ID",
          ]) as string,
        }),
    jobRootDir: resolvedJobRootDir,
    authRootDir,
    workspacePath: resolvePath(
      cwd,
      requiredOption(values, env, "--workspace", [
        "SUBSCRIPTION_RUNTIME_WORKSPACE_PATH",
        "MEMO_STACK_GOAL_WORKSPACE_PATH",
      ]),
    ),
    promptPath: resolvePath(
      cwd,
      requiredOption(values, env, "--prompt", [
        "SUBSCRIPTION_RUNTIME_PROMPT_PATH",
        "MEMO_STACK_GOAL_PROMPT_PATH",
      ]),
    ),
    ...(option(values, env, "--codex-goal-objective", [
      "SUBSCRIPTION_RUNTIME_CODEX_GOAL_OBJECTIVE",
    ]) === undefined
      ? {}
      : {
          codexGoalObjective: option(values, env, "--codex-goal-objective", [
            "SUBSCRIPTION_RUNTIME_CODEX_GOAL_OBJECTIVE",
          ]) as string,
        }),
    taskId,
    accounts,
    outputPath: resolvePath(
      cwd,
      option(values, env, "--output", []) ??
        join(resolvePath(cwd, jobRootDir), `${taskId}.latest-result.json`),
    ),
    progressPath: resolvePath(
      cwd,
      option(values, env, "--progress", []) ??
        join(resolvePath(cwd, jobRootDir), `${taskId}.progress.json`),
    ),
    model: option(values, env, "--model", ["CODEX_MODEL"]) ?? "gpt-5.5",
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(serviceTier ? { serviceTier } : {}),
    ...(executionEngine ? { executionEngine } : {}),
    codexBinaryPath: option(values, env, "--codex-binary", [
      "CODEX_BINARY_PATH",
    ]) ?? "codex",
    editMode,
    ...(providerSandboxMode === undefined ? {} : { providerSandboxMode }),
    ...(accessBoundary === undefined ? {} : { accessBoundary }),
    ...(projectAccessScope === undefined ? {} : { projectAccessScope }),
    allowDangerFullAccess: flag(values, "--allow-danger-full-access"),
    ...(networkAccess === undefined ? {} : { networkAccess }),
    taskTimeoutMs: parseOptionalPositiveInteger(
      option(values, env, "--timeout-ms", [
        "SUBSCRIPTION_RUNTIME_TASK_TIMEOUT_MS",
        "MEMO_STACK_GOAL_TASK_TIMEOUT_MS",
      ]),
      "--timeout-ms",
    ) ?? parseDurationMs(option(values, env, "--timeout", []) ?? "72h"),
    ...(appServerStartupTimeoutMs === undefined ? {} : { appServerStartupTimeoutMs }),
    progressHeartbeatMs: parseOptionalPositiveInteger(
      option(values, env, "--progress-heartbeat-ms", [
        "SUBSCRIPTION_RUNTIME_PROGRESS_HEARTBEAT_MS",
      ]),
      "--progress-heartbeat-ms",
    ) ?? 60_000,
    maxAccountCycles: parseOptionalPositiveInteger(
      option(values, env, "--max-account-cycles", [
        "SUBSCRIPTION_RUNTIME_MAX_ACCOUNT_CYCLES",
      ]),
      "--max-account-cycles",
    ) ?? 5,
    ...(staleLockMs === undefined ? {} : { staleLockMs }),
    allowDuplicateAccountIdentities: flag(values, "--allow-duplicate-accounts"),
    requireGitWorkspace: !flag(values, "--no-require-git-workspace"),
    prewarmOnStart: flag(values, "--prewarm"),
    ...(workerReportMode === undefined ? {} : { workerReportMode }),
    sourceEnv,
  };
  const stateRoot = option(values, env, "--state-root", []);
  return stateRoot
    ? { ...config, stateRootDir: resolvePath(cwd, stateRoot) }
    : config;
}

function parseDurationMs(value: string): number {
  const match = value.match(/^(\d+)(ms|s|m|h)$/);
  if (!match) throw new Error("--timeout must look like 72h, 30m, 10s or 1000ms");
  const amount = Number(match[1]);
  const unit = match[2];
  const multiplier =
    unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000;
  return amount * multiplier;
}

function parseCodexGoalWorkerReportMode(
  value: string | undefined,
): CodexGoalRunConfig["workerReportMode"] | undefined {
  if (value === undefined) return undefined;
  if (value === "runtime-only" || value === "structured-output") return value;
  throw new Error("--worker-report-mode must be runtime-only or structured-output");
}

export function splitCsv(value: string): readonly string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

