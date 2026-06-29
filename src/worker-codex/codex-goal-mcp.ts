#!/usr/bin/env node
import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { execPath } from "node:process";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { codexGoalAccountSlots, type CodexGoalRunConfig } from "./codex-goal-runner";
import {
  buildCodexGoalNoTmuxCommand,
  buildCodexGoalTmuxCommand,
  collectCodexGoalStatus,
  doctorCodexGoal,
  listCodexGoalAccountStatuses,
  startCodexGoalTmux,
  tailCodexGoalLog,
  type CodexGoalLaunchInput,
  type CodexGoalOutputFormat,
} from "./codex-goal-ops";

const serverVersion = "0.1.0-main.2";
const defaultAuthRoot = "~/.cache/subscription-runtime/live-codex-auth";
const defaultTimeoutMs = 72 * 60 * 60 * 1000;

type JsonObject = Readonly<Record<string, unknown>>;

type GoalMcpArgs = {
  readonly configPath?: string;
  readonly jobRootDir?: string;
  readonly authRootDir?: string;
  readonly stateRootDir?: string;
  readonly workspacePath?: string;
  readonly promptPath?: string;
  readonly taskId?: string;
  readonly accounts?: string | readonly string[];
  readonly outputPath?: string;
  readonly codexBinaryPath?: string;
  readonly model?: string;
  readonly reasoningEffort?: CodexGoalRunConfig["reasoningEffort"];
  readonly serviceTier?: CodexGoalRunConfig["serviceTier"];
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

type StartMcpArgs = GoalMcpArgs & {
  readonly confirmStart?: boolean;
  readonly skipDoctor?: boolean;
  readonly forceStart?: boolean;
};

export function createCodexGoalMcpServer(): McpServer {
  const server = new McpServer({
    name: "subscription-runtime-codex-goal",
    version: serverVersion,
  });

  server.registerTool(
    "codex_goal_dry_run",
    {
      title: "Codex Goal Dry Run",
      description:
        "Build the exact Codex goal worker command without starting a worker.",
      inputSchema: goalInputSchema(),
    },
    async (args) => withMcpErrors(async () => {
      const launch = await goalLaunchInput(args as GoalMcpArgs);
      const noTmuxCommand = buildCodexGoalNoTmuxCommand(launch);
      const tmuxCommand = launch.tmuxSession
        ? buildCodexGoalTmuxCommand(launch)
        : undefined;
      return mcpJson({
        ok: true,
        taskId: launch.config.taskId,
        noTmuxCommand,
        ...(tmuxCommand ? { tmuxCommand: tmuxCommand.preview } : {}),
        summary: launchSummary(launch),
      });
    }),
  );

  server.registerTool(
    "codex_goal_start",
    {
      title: "Start Codex Goal Worker",
      description:
        "Start a detached tmux Codex goal worker after explicit confirmation.",
      inputSchema: {
        ...goalInputSchema(),
        confirmStart: z.boolean().optional(),
        skipDoctor: z.boolean().optional(),
        forceStart: z.boolean().optional(),
      },
    },
    async (args) => withMcpErrors(async () => {
      const launch = await goalLaunchInput(args as StartMcpArgs);
      if (!launch.tmuxSession) {
        return mcpJson({
          ok: false,
          reason: "tmux_session_required",
          noTmuxCommand: buildCodexGoalNoTmuxCommand(launch),
        });
      }
      const statusBefore = await collectCodexGoalStatus(statusInput(launch));
      if (statusBefore.tmuxAlive) {
        return mcpJson({
          ok: false,
          reason: "worker_already_running",
          status: statusBefore,
        });
      }
      if (
        !isSafeStartAction(statusBefore.recommendedAction) &&
        !(args as StartMcpArgs).forceStart
      ) {
        return mcpJson({
          ok: false,
          reason: "status_requires_review",
          status: statusBefore,
          requiredOverride: "forceStart",
        });
      }
      if (!(args as StartMcpArgs).confirmStart) {
        return mcpJson({
          ok: false,
          reason: "confirm_start_required",
          tmuxCommand: buildCodexGoalTmuxCommand(launch).preview,
          summary: launchSummary(launch),
        });
      }
      if (!(args as StartMcpArgs).skipDoctor) {
        const doctor = await doctorCodexGoal({
          config: launch.config,
          tmuxSession: launch.tmuxSession,
        });
        if (!doctor.ok) {
          return mcpJson({
            ok: false,
            reason: "doctor_failed",
            doctor,
          });
        }
      }
      const command = await startCodexGoalTmux(launch);
      return mcpJson({
        ok: true,
        taskId: launch.config.taskId,
        tmuxSession: launch.tmuxSession,
        tmuxCommand: command.preview,
        summary: launchSummary(launch),
      });
    }),
  );

  server.registerTool(
    "codex_goal_status",
    {
      title: "Codex Goal Status",
      description:
        "Inspect tmux, result JSON, log freshness and workspace dirtiness.",
      inputSchema: statusInputSchema(),
    },
    async (args) => withMcpErrors(async () => {
      const cwd = resolvePath(
        process.cwd(),
        stringValue(args.cwd) ?? process.cwd(),
      );
      return mcpJson(await collectCodexGoalStatus({
        ...(stringValue(args.jobRootDir)
          ? { jobRootDir: resolvePath(cwd, stringValue(args.jobRootDir) as string) }
          : {}),
        ...(stringValue(args.taskId)
          ? { taskId: stringValue(args.taskId) as string }
          : {}),
        ...(stringValue(args.workspacePath)
          ? { workspacePath: resolvePath(cwd, stringValue(args.workspacePath) as string) }
          : {}),
        ...(stringValue(args.tmuxSession)
          ? { tmuxSession: stringValue(args.tmuxSession) as string }
          : {}),
        ...(stringValue(args.logPath)
          ? { logPath: resolvePath(cwd, stringValue(args.logPath) as string) }
          : {}),
      }));
    }),
  );

  server.registerTool(
    "codex_goal_doctor",
    {
      title: "Codex Goal Doctor",
      description:
        "Validate prompt, job root, auth root, workspace and account auth files.",
      inputSchema: goalInputSchema(),
    },
    async (args) => withMcpErrors(async () => {
      const launch = await goalLaunchInput(args as GoalMcpArgs);
      return mcpJson(await doctorCodexGoal({
        config: launch.config,
        ...(launch.tmuxSession ? { tmuxSession: launch.tmuxSession } : {}),
      }));
    }),
  );

  server.registerTool(
    "codex_goal_tail",
    {
      title: "Codex Goal Tail",
      description: "Read the last lines from a Codex goal worker log.",
      inputSchema: {
        jobRootDir: z.string().optional(),
        taskId: z.string().optional(),
        logPath: z.string().optional(),
        cwd: z.string().optional(),
        lines: z.number().int().positive().optional(),
      },
    },
    async (args) => withMcpErrors(async () => {
      const cwd = resolvePath(
        process.cwd(),
        stringValue(args.cwd) ?? process.cwd(),
      );
      const logPath = stringValue(args.logPath) ??
        (stringValue(args.jobRootDir) && stringValue(args.taskId)
          ? join(
              resolvePath(cwd, stringValue(args.jobRootDir) as string),
              `${stringValue(args.taskId) as string}.log`,
            )
          : undefined);
      if (!logPath) throw new Error("logPath or jobRootDir with taskId is required");
      const resolvedLogPath = resolvePath(cwd, logPath);
      const text = await tailCodexGoalLog(
        resolvedLogPath,
        numberValue(args.lines) ?? 100,
      );
      return mcpJson({ ok: true, logPath: resolvedLogPath, text });
    }),
  );

  server.registerTool(
    "codex_accounts_status",
    {
      title: "Codex Account Slot Status",
      description:
        "Inspect Codex account slot auth files without printing tokens.",
      inputSchema: {
        authRootDir: z.string().optional(),
        accounts: z.union([z.string(), z.array(z.string())]).optional(),
      },
    },
    async (args) => withMcpErrors(async () => {
      const authRootDir = resolvePath(
        process.cwd(),
        stringValue(args.authRootDir) ?? defaultAuthRoot,
      );
      const accounts = accountNames(args.accounts);
      const slots = await listCodexGoalAccountStatuses({
        authRootDir,
        ...(accounts.length ? { accounts } : {}),
      });
      return mcpJson({
        ok: slots.every((slot) => slot.status === "ready"),
        authRootDir,
        slots,
      });
    }),
  );

  return server;
}

async function goalLaunchInput(args: GoalMcpArgs): Promise<CodexGoalLaunchInput> {
  const cwd = resolvePath(process.cwd(), args.cwd ?? process.cwd());
  const fileConfig = args.configPath
    ? await readGoalConfigFile(resolvePath(cwd, args.configPath))
    : {};
  const merged = mergeDefined(fileConfig, args);
  const jobRootDir = requiredString(merged.jobRootDir, "jobRootDir", cwd);
  const taskId = requiredRawString(merged.taskId, "taskId");
  const authRootDir = resolvePath(
    cwd,
    stringValue(merged.authRootDir) ?? defaultAuthRoot,
  );
  const workspacePath = requiredString(merged.workspacePath, "workspacePath", cwd);
  const promptPath = requiredString(merged.promptPath, "promptPath", cwd);
  const accounts = codexGoalAccountSlots(accountNames(merged.accounts));
  if (!accounts.length) throw new Error("accounts are required");
  const config: CodexGoalRunConfig = {
    jobRootDir,
    authRootDir,
    workspacePath,
    promptPath,
    taskId,
    accounts,
    outputPath: resolvePath(
      cwd,
      stringValue(merged.outputPath) ??
        join(jobRootDir, `${taskId}.latest-result.json`),
    ),
    model: stringValue(merged.model) ?? "gpt-5.5",
    reasoningEffort:
      (stringValue(merged.reasoningEffort) ?? "xhigh") as NonNullable<CodexGoalRunConfig["reasoningEffort"]>,
    serviceTier:
      (stringValue(merged.serviceTier) ?? "fast") as NonNullable<CodexGoalRunConfig["serviceTier"]>,
    codexBinaryPath: stringValue(merged.codexBinaryPath) ?? "codex",
    permissionMode:
      (stringValue(merged.permissionMode) ?? "allow-edits") as NonNullable<CodexGoalRunConfig["permissionMode"]>,
    taskTimeoutMs: numberValue(merged.taskTimeoutMs) ?? defaultTimeoutMs,
    ...(numberValue(merged.staleLockMs) === undefined
      ? {}
      : { staleLockMs: numberValue(merged.staleLockMs) as number }),
    maxAccountCycles: numberValue(merged.maxAccountCycles) ?? 3,
    allowDuplicateAccountIdentities:
      booleanValue(merged.allowDuplicateAccountIdentities) ?? false,
    requireGitWorkspace: booleanValue(merged.requireGitWorkspace) ?? true,
    prewarmOnStart: booleanValue(merged.prewarmOnStart) ?? false,
  };
  const stateRootDir = stringValue(merged.stateRootDir);
  const finalConfig = stateRootDir
    ? { ...config, stateRootDir: resolvePath(cwd, stateRootDir) }
    : config;
  return {
    config: finalConfig,
    ...(stringValue(merged.tmuxSession)
      ? { tmuxSession: stringValue(merged.tmuxSession) as string }
      : {}),
    cwd,
    logPath: resolvePath(
      cwd,
      stringValue(merged.logPath) ?? join(jobRootDir, `${taskId}.log`),
    ),
    format: (stringValue(merged.outputFormat) ?? "json") as CodexGoalOutputFormat,
    cliCommand: defaultCliCommand(import.meta.url),
  };
}

function goalInputSchema(): Record<string, z.ZodTypeAny> {
  return {
    configPath: z.string().optional(),
    jobRootDir: z.string().optional(),
    authRootDir: z.string().optional(),
    stateRootDir: z.string().optional(),
    workspacePath: z.string().optional(),
    promptPath: z.string().optional(),
    taskId: z.string().optional(),
    accounts: z.union([z.string(), z.array(z.string())]).optional(),
    outputPath: z.string().optional(),
    codexBinaryPath: z.string().optional(),
    model: z.string().optional(),
    reasoningEffort: z.string().optional(),
    serviceTier: z.string().optional(),
    taskTimeoutMs: z.number().int().positive().optional(),
    staleLockMs: z.number().int().positive().optional(),
    maxAccountCycles: z.number().int().positive().optional(),
    permissionMode: z.string().optional(),
    allowDuplicateAccountIdentities: z.boolean().optional(),
    requireGitWorkspace: z.boolean().optional(),
    prewarmOnStart: z.boolean().optional(),
    tmuxSession: z.string().optional(),
    cwd: z.string().optional(),
    logPath: z.string().optional(),
    outputFormat: z.enum(["text", "json"]).optional(),
  };
}

function statusInputSchema(): Record<string, z.ZodTypeAny> {
  return {
    jobRootDir: z.string().optional(),
    taskId: z.string().optional(),
    workspacePath: z.string().optional(),
    tmuxSession: z.string().optional(),
    logPath: z.string().optional(),
    cwd: z.string().optional(),
  };
}

function statusInput(launch: CodexGoalLaunchInput) {
  return {
    jobRootDir: launch.config.jobRootDir,
    taskId: launch.config.taskId,
    workspacePath: launch.config.workspacePath,
    ...(launch.tmuxSession ? { tmuxSession: launch.tmuxSession } : {}),
    logPath: launch.logPath,
  };
}

function isSafeStartAction(action: string): boolean {
  return (
    action === "start_worker" ||
    action === "continue_after_capacity" ||
    action === "continue_after_timeout"
  );
}

function launchSummary(launch: CodexGoalLaunchInput): JsonObject {
  return {
    taskId: launch.config.taskId,
    workspacePath: launch.config.workspacePath,
    promptPath: launch.config.promptPath,
    accountNames: launch.config.accounts.map((account) => account.name),
    model: launch.config.model,
    reasoningEffort: launch.config.reasoningEffort,
    serviceTier: launch.config.serviceTier,
    taskTimeoutMs: launch.config.taskTimeoutMs,
    maxAccountCycles: launch.config.maxAccountCycles,
    tmuxSession: launch.tmuxSession,
    logPath: launch.logPath,
  };
}

async function readGoalConfigFile(path: string): Promise<JsonObject> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isRecord(parsed)) throw new Error("configPath must contain a JSON object");
  return parsed;
}

function defaultCliCommand(importMetaUrl: string): readonly string[] {
  return [
    execPath,
    join(dirname(fileURLToPath(importMetaUrl)), "codex-goal-cli.js"),
  ];
}

function mergeDefined(...items: readonly JsonObject[]): JsonObject {
  const merged: Record<string, unknown> = {};
  for (const item of items) {
    for (const [key, value] of Object.entries(item)) {
      if (value !== undefined) merged[key] = value;
    }
  }
  return merged;
}

function accountNames(value: unknown): readonly string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function requiredString(value: unknown, name: string, cwd: string): string {
  return resolvePath(cwd, requiredRawString(value, name));
}

function requiredRawString(value: unknown, name: string): string {
  const text = stringValue(value);
  if (!text) throw new Error(`${name} is required`);
  return text;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function resolvePath(cwd: string, value: string): string {
  const expanded = value.startsWith("~/")
    ? join(homedir(), value.slice(2))
    : value;
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

function mcpJson(value: JsonObject) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

async function withMcpErrors(
  action: () => Promise<ReturnType<typeof mcpJson>>,
): Promise<ReturnType<typeof mcpJson> & { readonly isError?: boolean }> {
  try {
    return await action();
  } catch (error) {
    const value = {
      ok: false,
      error: error instanceof Error ? error.message : "codex_goal_mcp_error",
    };
    return {
      ...mcpJson(value),
      isError: true,
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (await isMainModule()) {
  try {
    const server = createCodexGoalMcpServer();
    await server.connect(new StdioServerTransport());
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "codex goal mcp failed"}\n`,
    );
    process.exitCode = 1;
  }
}

async function isMainModule(): Promise<boolean> {
  if (!process.argv[1]) return false;
  try {
    return (await realpath(fileURLToPath(import.meta.url))) ===
      (await realpath(process.argv[1]));
  } catch {
    return fileURLToPath(import.meta.url) === process.argv[1];
  }
}
