#!/usr/bin/env node
import { mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { execPath } from "node:process";
import { fileURLToPath } from "node:url";
import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DefaultRedactor } from "@vioxen/subscription-runtime/core";
import {
  codexGoalJobToArgs,
  createCodexGoalJob,
  defaultCodexGoalJobRoot,
  listCodexGoalJobs,
  readCodexGoalJob,
  resolveCodexGoalJobRegistryRoot,
  summarizeCodexGoalJob,
  updateCodexGoalJob,
  type CodexGoalJobManifestInput,
  type CodexGoalJobManifestPatch,
} from "./codex-goal-jobs";
import { codexGoalAccountSlots, type CodexGoalRunConfig } from "./codex-goal-runner";
import {
  buildCodexGoalNoTmuxCommand,
  buildCodexGoalTmuxCommand,
  collectCodexGoalStatus,
  doctorCodexGoal,
  listCodexGoalAccountStatuses,
  shellQuote,
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

type JobRegistryMcpArgs = {
  readonly registryRootDir?: string;
  readonly cwd?: string;
};

type JobIdMcpArgs = JobRegistryMcpArgs & {
  readonly jobId?: string;
};

type JobCreateMcpArgs = GoalMcpArgs & JobIdMcpArgs & {
  readonly description?: string;
  readonly tags?: readonly string[] | string;
  readonly overwrite?: boolean;
};

type JobUpdateMcpArgs = JobIdMcpArgs & Partial<JobCreateMcpArgs>;

type JobLifecycleMcpArgs = JobIdMcpArgs & {
  readonly confirmContinue?: boolean;
  readonly confirmRecover?: boolean;
  readonly forceStart?: boolean;
  readonly skipDoctor?: boolean;
};

type JobBriefMcpArgs = JobIdMcpArgs & {
  readonly staleAfterMs?: number;
  readonly tailLines?: number;
};

type AccountPoolMcpArgs = {
  readonly poolRootDir?: string;
  readonly pool?: string;
  readonly authRootDir?: string;
  readonly stateRootDir?: string;
  readonly accounts?: string | readonly string[];
};

export function createCodexGoalMcpServer(): McpServer {
  const server = new McpServer({
    name: "subscription-runtime-codex-goal",
    version: serverVersion,
  });

  server.registerResource(
    "codex-goal-job",
    new ResourceTemplate("codex-goal://jobs/{jobId}", {
      list: async () => {
        const registryRootDir = resolveCodexGoalJobRegistryRoot();
        const jobs = await listCodexGoalJobs({ registryRootDir });
        return {
          resources: jobs.map((job) => ({
            uri: `codex-goal://jobs/${job.jobId}`,
            name: job.jobId,
            description: job.description ?? job.workspacePath,
            mimeType: "application/json",
          })),
        };
      },
    }),
    {
      title: "Codex Goal Job",
      description: "A stored Codex goal job manifest.",
      mimeType: "application/json",
    },
    async (uri, { jobId }) => {
      const registryRootDir = resolveCodexGoalJobRegistryRoot();
      const manifest = await readCodexGoalJob({
        registryRootDir,
        jobId: String(jobId),
      });
      return {
        contents: [{
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify({
            manifest,
            summary: summarizeCodexGoalJob(manifest, registryRootDir),
          }, null, 2),
        }],
      };
    },
  );

  registerCodexGoalPrompts(server);

  server.registerTool(
    "codex_goal_list_jobs",
    {
      title: "List Codex Goal Jobs",
      description: "List stored Codex goal job manifests.",
      inputSchema: jobRegistryInputSchema(),
    },
    async (args) => withMcpErrors(async () => {
      const registryRootDir = registryRootFromArgs(args as JobRegistryMcpArgs);
      const jobs = await listCodexGoalJobs({ registryRootDir });
      return mcpJson({ ok: true, registryRootDir, jobs });
    }),
  );

  server.registerTool(
    "codex_goal_get_job",
    {
      title: "Get Codex Goal Job",
      description: "Read one Codex goal job manifest by jobId.",
      inputSchema: jobIdInputSchema(),
    },
    async (args) => withMcpErrors(async () => {
      const registryRootDir = registryRootFromArgs(args as JobIdMcpArgs);
      const manifest = await readCodexGoalJob({
        registryRootDir,
        jobId: requiredRawString(args.jobId, "jobId"),
      });
      return mcpJson({
        ok: true,
        registryRootDir,
        manifest,
        summary: summarizeCodexGoalJob(manifest, registryRootDir),
      });
    }),
  );

  server.registerTool(
    "codex_goal_create_job",
    {
      title: "Create Codex Goal Job",
      description:
        "Create a versioned job.json manifest so future tools can operate by jobId.",
      inputSchema: {
        ...goalInputSchema(),
        ...jobIdInputSchema(),
        description: z.string().optional(),
        tags: z.union([z.string(), z.array(z.string())]).optional(),
        overwrite: z.boolean().optional(),
      },
    },
    async (args) => withMcpErrors(async () => {
      const registryRootDir = registryRootFromArgs(args as JobCreateMcpArgs);
      const manifest = await createCodexGoalJob({
        registryRootDir,
        manifest: jobManifestInputFromArgs(args as JobCreateMcpArgs),
        overwrite: booleanValue(args.overwrite) ?? false,
      });
      return mcpJson({
        ok: true,
        registryRootDir,
        manifest,
        summary: summarizeCodexGoalJob(manifest, registryRootDir),
      });
    }),
  );

  server.registerTool(
    "codex_goal_update_job",
    {
      title: "Update Codex Goal Job",
      description: "Patch an existing job.json manifest by jobId.",
      inputSchema: {
        ...goalInputSchema(),
        ...jobIdInputSchema(),
        description: z.string().optional(),
        tags: z.union([z.string(), z.array(z.string())]).optional(),
      },
    },
    async (args) => withMcpErrors(async () => {
      const updateArgs = args as JobUpdateMcpArgs;
      const registryRootDir = registryRootFromArgs(updateArgs);
      const manifest = await updateCodexGoalJob({
        registryRootDir,
        jobId: requiredRawString(updateArgs.jobId, "jobId"),
        patch: jobManifestPatchFromArgs(updateArgs),
      });
      return mcpJson({
        ok: true,
        registryRootDir,
        manifest,
        summary: summarizeCodexGoalJob(manifest, registryRootDir),
      });
    }),
  );

  server.registerTool(
    "codex_goal_status_by_id",
    {
      title: "Codex Goal Status By Job",
      description: "Inspect a stored Codex goal job using only jobId.",
      inputSchema: jobIdInputSchema(),
    },
    async (args) => withMcpErrors(async () => {
      const registryRootDir = registryRootFromArgs(args as JobIdMcpArgs);
      const manifest = await readCodexGoalJob({
        registryRootDir,
        jobId: requiredRawString(args.jobId, "jobId"),
      });
      const launch = await goalLaunchInput(codexGoalJobToArgs(manifest));
      const status = await collectCodexGoalStatus(statusInput(launch));
      return mcpJson({
        ok: true,
        registryRootDir,
        jobId: manifest.jobId,
        status,
        summary: summarizeCodexGoalJob(manifest, registryRootDir),
      });
    }),
  );

  server.registerTool(
    "codex_goal_recommend_next_action",
    {
      title: "Recommend Codex Goal Action",
      description: "Return the next safe lifecycle action for a stored job.",
      inputSchema: jobIdInputSchema(),
    },
    async (args) => withMcpErrors(async () => {
      const loaded = await loadJobLaunch(args as JobIdMcpArgs);
      const status = await collectCodexGoalStatus(statusInput(loaded.launch));
      return mcpJson({
        ok: true,
        registryRootDir: loaded.registryRootDir,
        jobId: loaded.manifest.jobId,
        status,
        next: nextActionForStatus(status.recommendedAction),
        summary: summarizeCodexGoalJob(loaded.manifest, loaded.registryRootDir),
      });
    }),
  );

  server.registerTool(
    "codex_goal_assert_single_writer",
    {
      title: "Assert Single Codex Writer",
      description:
        "Check whether starting another writer for this job would be safe.",
      inputSchema: jobIdInputSchema(),
    },
    async (args) => withMcpErrors(async () => {
      const loaded = await loadJobLaunch(args as JobIdMcpArgs);
      const status = await collectCodexGoalStatus(statusInput(loaded.launch));
      const ok = !status.tmuxAlive && status.recommendedAction !== "wait_for_worker";
      return mcpJson({
        ok,
        registryRootDir: loaded.registryRootDir,
        jobId: loaded.manifest.jobId,
        status,
        safeToStart: isSafeStartAction(status.recommendedAction),
        safeMessage: ok
          ? "No active tmux writer was found for this job."
          : "A writer appears to be active; do not start another writer in this worktree.",
      });
    }),
  );

  server.registerTool(
    "codex_goal_continue",
    {
      title: "Continue Codex Goal",
      description:
        "Safely continue a stored job by jobId when status allows continuation.",
      inputSchema: {
        ...jobIdInputSchema(),
        confirmContinue: z.boolean().optional(),
        skipDoctor: z.boolean().optional(),
        forceStart: z.boolean().optional(),
      },
    },
    async (args) => withMcpErrors(async () =>
      continueStoredJob(args as JobLifecycleMcpArgs, {
        confirmKey: "confirmContinue",
        mode: "continue",
      }),
    ),
  );

  server.registerTool(
    "codex_goal_recover",
    {
      title: "Recover Codex Goal",
      description:
        "Recover a stored job after quota, auth, reconnect or timeout status.",
      inputSchema: {
        ...jobIdInputSchema(),
        confirmRecover: z.boolean().optional(),
        skipDoctor: z.boolean().optional(),
        forceStart: z.boolean().optional(),
      },
    },
    async (args) => withMcpErrors(async () =>
      continueStoredJob(args as JobLifecycleMcpArgs, {
        confirmKey: "confirmRecover",
        mode: "recover",
      }),
    ),
  );

  server.registerTool(
    "codex_goal_pause",
    {
      title: "Soft Pause Codex Goal",
      description:
        "Write a soft pause request marker. This never kills a running worker.",
      inputSchema: jobIdInputSchema(),
    },
    async (args) => withMcpErrors(async () => {
      const loaded = await loadJobLaunch(args as JobIdMcpArgs);
      await mkdir(loaded.launch.config.jobRootDir, { recursive: true, mode: 0o700 });
      const pausePath = join(
        loaded.launch.config.jobRootDir,
        `${loaded.launch.config.taskId}.pause-request.json`,
      );
      const status = await collectCodexGoalStatus(statusInput(loaded.launch));
      await writeFile(
        pausePath,
        `${JSON.stringify({
          schemaVersion: 1,
          jobId: loaded.manifest.jobId,
          taskId: loaded.launch.config.taskId,
          requestedAt: new Date().toISOString(),
          mode: "soft_pause_only",
          note: "The running worker is not terminated by this marker.",
        }, null, 2)}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      return mcpJson({
        ok: true,
        jobId: loaded.manifest.jobId,
        pausePath,
        status,
        safeMessage:
          "Soft pause marker written. No tmux session or worker process was killed.",
      });
    }),
  );

  server.registerTool(
    "codex_goal_mark_reviewed",
    {
      title: "Mark Codex Goal Reviewed",
      description:
        "Write a local review marker after a human or orchestrator has inspected the result.",
      inputSchema: {
        ...jobIdInputSchema(),
        note: z.string().optional(),
      },
    },
    async (args) => withMcpErrors(async () => {
      const loaded = await loadJobLaunch(args as JobIdMcpArgs);
      await mkdir(loaded.launch.config.jobRootDir, { recursive: true, mode: 0o700 });
      const reviewPath = join(
        loaded.launch.config.jobRootDir,
        `${loaded.launch.config.taskId}.review.json`,
      );
      const status = await collectCodexGoalStatus(statusInput(loaded.launch));
      await writeFile(
        reviewPath,
        `${JSON.stringify({
          schemaVersion: 1,
          jobId: loaded.manifest.jobId,
          taskId: loaded.launch.config.taskId,
          reviewedAt: new Date().toISOString(),
          note: stringValue(args.note) ?? "reviewed",
          status,
        }, null, 2)}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      return mcpJson({ ok: true, jobId: loaded.manifest.jobId, reviewPath, status });
    }),
  );

  server.registerTool(
    "codex_goal_brief",
    {
      title: "Codex Goal Brief",
      description: "Return a compact agent-friendly status summary by jobId.",
      inputSchema: {
        ...jobIdInputSchema(),
        staleAfterMs: z.number().int().positive().optional(),
        tailLines: z.number().int().positive().optional(),
      },
    },
    async (args) => withMcpErrors(async () => {
      const loaded = await loadJobLaunch(args as JobBriefMcpArgs);
      const status = await collectCodexGoalStatus(statusInput(loaded.launch));
      const accounts = await listCodexGoalAccountStatuses({
        authRootDir: loaded.launch.config.authRootDir,
        accounts: loaded.launch.config.accounts.map((account) => account.name),
        stateRootDir: loaded.launch.config.stateRootDir ??
          join(loaded.launch.config.jobRootDir, "state"),
      });
      const brief = await buildCodexGoalBrief({
        jobId: loaded.manifest.jobId,
        launch: loaded.launch,
        status,
        accounts,
        staleAfterMs: numberValue((args as JobBriefMcpArgs).staleAfterMs) ?? 10 * 60_000,
        tailLines: numberValue((args as JobBriefMcpArgs).tailLines) ?? 20,
      });
      return mcpJson({
        ok: true,
        registryRootDir: loaded.registryRootDir,
        jobId: loaded.manifest.jobId,
        brief,
        status,
      });
    }),
  );

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
    "codex_accounts_list_pools",
    {
      title: "List Codex Account Pools",
      description:
        "List account auth pools under a root directory without printing tokens.",
      inputSchema: {
        poolRootDir: z.string().optional(),
      },
    },
    async (args) => withMcpErrors(async () => {
      const poolRootDir = accountPoolRootFromArgs(args as AccountPoolMcpArgs);
      const pools = await listAccountPools(poolRootDir);
      return mcpJson({ ok: true, poolRootDir, pools });
    }),
  );

  server.registerTool(
    "codex_accounts_status",
    {
      title: "Codex Account Slot Status",
      description:
        "Inspect Codex account slot auth files without printing tokens.",
      inputSchema: {
        poolRootDir: z.string().optional(),
        pool: z.string().optional(),
        authRootDir: z.string().optional(),
        stateRootDir: z.string().optional(),
        accounts: z.union([z.string(), z.array(z.string())]).optional(),
      },
    },
    async (args) => withMcpErrors(async () => {
      const authRootDir = accountAuthRootFromArgs(args as AccountPoolMcpArgs);
      const accounts = accountNames(args.accounts);
      const slots = await listCodexGoalAccountStatuses({
        authRootDir,
        ...(accounts.length ? { accounts } : {}),
        ...(stringValue(args.stateRootDir)
          ? { stateRootDir: resolvePath(process.cwd(), stringValue(args.stateRootDir) as string) }
          : {}),
      });
      const duplicates = duplicateAccountGroups(slots);
      const dedupedSlots = dedupeCodexGoalAccountSlots(slots);
      const availableDedupedSlots = availableCodexGoalAccountSlots(dedupedSlots);
      return mcpJson({
        ok: availableDedupedSlots.length > 0,
        authRootDir,
        slots,
        duplicates,
        dedupedAccountNames: dedupedSlots.map((slot) => slot.name),
        availableDedupedAccountNames: availableDedupedSlots.map((slot) => slot.name),
        dedupeRecommendation: duplicates.length
          ? "Use dedupedAccountNames for worker pools. It keeps the newest ready slot per identity group."
          : "No duplicate identity groups detected.",
      });
    }),
  );

  server.registerTool(
    "codex_accounts_relogin_instructions",
    {
      title: "Codex Account Relogin Instructions",
      description:
        "Return safe manual relogin commands for account slots. Does not perform login.",
      inputSchema: {
        poolRootDir: z.string().optional(),
        pool: z.string().optional(),
        authRootDir: z.string().optional(),
        account: z.string().optional(),
      },
    },
    async (args) => withMcpErrors(async () => {
      const authRootDir = accountAuthRootFromArgs(args as AccountPoolMcpArgs);
      const account = stringValue(args.account) ?? "<account-slot>";
      return mcpJson({
        ok: true,
        authRootDir,
        account,
        instructions: [
          "This is a manual relogin flow. It does not automate browser login.",
          `mkdir -p ${shellText(join(authRootDir, account))}`,
          `test ! -f ${shellText(join(authRootDir, account, "auth.json"))} || cp ${shellText(join(authRootDir, account, "auth.json"))} ${shellText(join(authRootDir, account, "auth.json.bak.$(date +%Y%m%d-%H%M%S).before-relogin"))}`,
          `CODEX_HOME=${shellText(join(authRootDir, account))} codex login --device-auth`,
          "After login, run codex_accounts_status for this pool before starting workers.",
        ],
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

async function loadJobLaunch(args: JobIdMcpArgs): Promise<{
  readonly registryRootDir: string;
  readonly manifest: Awaited<ReturnType<typeof readCodexGoalJob>>;
  readonly launch: CodexGoalLaunchInput;
}> {
  const registryRootDir = registryRootFromArgs(args);
  const manifest = await readCodexGoalJob({
    registryRootDir,
    jobId: requiredRawString(args.jobId, "jobId"),
  });
  return {
    registryRootDir,
    manifest,
    launch: await goalLaunchInput(codexGoalJobToArgs(manifest)),
  };
}

async function continueStoredJob(
  args: JobLifecycleMcpArgs,
  options: {
    readonly mode: "continue" | "recover";
    readonly confirmKey: "confirmContinue" | "confirmRecover";
  },
) {
  const loaded = await loadJobLaunch(args);
  const status = await collectCodexGoalStatus(statusInput(loaded.launch));
  if (status.tmuxAlive) {
    return mcpJson({
      ok: false,
      reason: "worker_already_running",
      jobId: loaded.manifest.jobId,
      status,
    });
  }
  if (
    !isSafeStartAction(status.recommendedAction) &&
    !args.forceStart
  ) {
    return mcpJson({
      ok: false,
      reason: "status_requires_review",
      jobId: loaded.manifest.jobId,
      status,
      next: nextActionForStatus(status.recommendedAction),
      requiredOverride: "forceStart",
    });
  }
  if (!args[options.confirmKey]) {
    return mcpJson({
      ok: false,
      reason: `${options.confirmKey}_required`,
      jobId: loaded.manifest.jobId,
      status,
      tmuxCommand: loaded.launch.tmuxSession
        ? buildCodexGoalTmuxCommand(loaded.launch).preview
        : undefined,
      noTmuxCommand: buildCodexGoalNoTmuxCommand(loaded.launch),
      next: nextActionForStatus(status.recommendedAction),
    });
  }
  if (!loaded.launch.tmuxSession) {
    return mcpJson({
      ok: false,
      reason: "tmux_session_required",
      jobId: loaded.manifest.jobId,
      noTmuxCommand: buildCodexGoalNoTmuxCommand(loaded.launch),
    });
  }
  if (!args.skipDoctor) {
    const doctor = await doctorCodexGoal({
      config: loaded.launch.config,
      tmuxSession: loaded.launch.tmuxSession,
    });
    if (!doctor.ok) {
      return mcpJson({
        ok: false,
        reason: "doctor_failed",
        jobId: loaded.manifest.jobId,
        doctor,
      });
    }
  }
  const command = await startCodexGoalTmux(loaded.launch);
  return mcpJson({
    ok: true,
    mode: options.mode,
    jobId: loaded.manifest.jobId,
    taskId: loaded.launch.config.taskId,
    tmuxSession: loaded.launch.tmuxSession,
    tmuxCommand: command.preview,
    statusBefore: status,
  });
}

function jobRegistryInputSchema(): Record<string, z.ZodTypeAny> {
  return {
    registryRootDir: z.string().optional(),
    cwd: z.string().optional(),
  };
}

function jobIdInputSchema(): Record<string, z.ZodTypeAny> {
  return {
    ...jobRegistryInputSchema(),
    jobId: z.string().optional(),
  };
}

function registryRootFromArgs(args: JobRegistryMcpArgs): string {
  return resolveCodexGoalJobRegistryRoot({
    ...(args.registryRootDir ? { registryRootDir: args.registryRootDir } : {}),
    ...(args.cwd ? { cwd: args.cwd } : {}),
  });
}

function jobManifestInputFromArgs(args: JobCreateMcpArgs): CodexGoalJobManifestInput {
  const cwd = resolvePath(process.cwd(), args.cwd ?? process.cwd());
  const jobId = requiredRawString(args.jobId, "jobId");
  const jobRootDir = resolvePath(
    cwd,
    args.jobRootDir ?? defaultCodexGoalJobRoot(jobId),
  );
  return {
    jobId,
    ...(stringValue(args.description) ? { description: stringValue(args.description) as string } : {}),
    ...(tagValues(args.tags).length ? { tags: tagValues(args.tags) } : {}),
    jobRootDir,
    authRootDir: resolvePath(cwd, args.authRootDir ?? defaultAuthRoot),
    ...(args.stateRootDir ? { stateRootDir: resolvePath(cwd, args.stateRootDir) } : {}),
    workspacePath: requiredString(args.workspacePath, "workspacePath", cwd),
    promptPath: resolvePath(cwd, args.promptPath ?? join(jobRootDir, "prompt.md")),
    taskId: args.taskId ?? jobId,
    accounts: accountNames(args.accounts),
    ...(args.outputPath ? { outputPath: resolvePath(cwd, args.outputPath) } : {}),
    ...(args.codexBinaryPath ? { codexBinaryPath: args.codexBinaryPath } : {}),
    model: args.model ?? "gpt-5.5",
    reasoningEffort: args.reasoningEffort ?? "xhigh",
    serviceTier: args.serviceTier ?? "fast",
    taskTimeoutMs: args.taskTimeoutMs ?? defaultTimeoutMs,
    ...(args.staleLockMs ? { staleLockMs: args.staleLockMs } : {}),
    maxAccountCycles: args.maxAccountCycles ?? 3,
    permissionMode: args.permissionMode ?? "allow-edits",
    allowDuplicateAccountIdentities: args.allowDuplicateAccountIdentities ?? false,
    requireGitWorkspace: args.requireGitWorkspace ?? true,
    prewarmOnStart: args.prewarmOnStart ?? false,
    tmuxSession: args.tmuxSession ?? jobId,
    ...(args.cwd ? { cwd } : {}),
    ...(args.logPath ? { logPath: resolvePath(cwd, args.logPath) } : {}),
    outputFormat: args.outputFormat ?? "json",
  };
}

function jobManifestPatchFromArgs(args: JobUpdateMcpArgs): CodexGoalJobManifestPatch {
  const cwd = resolvePath(process.cwd(), args.cwd ?? process.cwd());
  const patch: Record<string, unknown> = {};
  putIfDefined(patch, "description", stringValue(args.description));
  const tags = tagValues(args.tags);
  if (args.tags !== undefined) patch.tags = tags;
  putIfDefined(patch, "jobRootDir", args.jobRootDir && resolvePath(cwd, args.jobRootDir));
  putIfDefined(patch, "authRootDir", args.authRootDir && resolvePath(cwd, args.authRootDir));
  putIfDefined(patch, "stateRootDir", args.stateRootDir && resolvePath(cwd, args.stateRootDir));
  putIfDefined(patch, "workspacePath", args.workspacePath && resolvePath(cwd, args.workspacePath));
  putIfDefined(patch, "promptPath", args.promptPath && resolvePath(cwd, args.promptPath));
  putIfDefined(patch, "taskId", stringValue(args.taskId));
  if (args.accounts !== undefined) patch.accounts = accountNames(args.accounts);
  putIfDefined(patch, "outputPath", args.outputPath && resolvePath(cwd, args.outputPath));
  putIfDefined(patch, "codexBinaryPath", stringValue(args.codexBinaryPath));
  putIfDefined(patch, "model", stringValue(args.model));
  putIfDefined(patch, "reasoningEffort", stringValue(args.reasoningEffort));
  putIfDefined(patch, "serviceTier", stringValue(args.serviceTier));
  putIfDefined(patch, "taskTimeoutMs", numberValue(args.taskTimeoutMs));
  putIfDefined(patch, "staleLockMs", numberValue(args.staleLockMs));
  putIfDefined(patch, "maxAccountCycles", numberValue(args.maxAccountCycles));
  putIfDefined(patch, "permissionMode", stringValue(args.permissionMode));
  putIfDefined(
    patch,
    "allowDuplicateAccountIdentities",
    booleanValue(args.allowDuplicateAccountIdentities),
  );
  putIfDefined(patch, "requireGitWorkspace", booleanValue(args.requireGitWorkspace));
  putIfDefined(patch, "prewarmOnStart", booleanValue(args.prewarmOnStart));
  putIfDefined(patch, "tmuxSession", stringValue(args.tmuxSession));
  putIfDefined(patch, "cwd", args.cwd && cwd);
  putIfDefined(patch, "logPath", args.logPath && resolvePath(cwd, args.logPath));
  putIfDefined(patch, "outputFormat", stringValue(args.outputFormat));
  return patch as CodexGoalJobManifestPatch;
}

export async function buildCodexGoalBrief(input: {
  readonly jobId: string;
  readonly launch: CodexGoalLaunchInput;
  readonly status: Awaited<ReturnType<typeof collectCodexGoalStatus>>;
  readonly accounts: Awaited<ReturnType<typeof listCodexGoalAccountStatuses>>;
  readonly staleAfterMs: number;
  readonly tailLines: number;
}) {
  const result = input.status.resultPath
    ? await readRuntimeResultBrief(input.status.resultPath)
    : {};
  const lastProgressAt = input.status.logUpdatedAt ?? result.updatedAt;
  const lastProgressMs = lastProgressAt ? Date.parse(lastProgressAt) : NaN;
  const isStale = Number.isFinite(lastProgressMs)
    ? Date.now() - lastProgressMs > input.staleAfterMs
    : false;
  const invalidAccounts = input.accounts.filter((slot) => slot.status !== "ready");
  const capacityBlockedAccounts = input.accounts.filter((slot) =>
    slot.capacityAvailability && slot.capacityAvailability !== "available"
  );
  const next = nextActionForStatus(input.status.recommendedAction);
  const recentLogTail = redactLogTail(await safeTail(input.launch.logPath, input.tailLines));
  return {
    text: [
      input.status.tmuxAlive ? "worker alive" : "worker not running",
      `recommendedAction ${input.status.recommendedAction}`,
      lastProgressAt ? `lastProgressAt ${lastProgressAt}` : "lastProgressAt unknown",
      input.status.workspaceDirty === undefined
        ? "workspace dirty unknown"
        : `workspace dirty ${input.status.workspaceDirty}`,
      input.status.changedFiles?.length
        ? `changed files ${input.status.changedFiles.length}`
        : "changed files 0",
    ].join(", "),
    lastProgressAt,
    isStale,
    currentAccount: result.currentAccount,
    lastFailureReason: input.status.resultReason ?? result.lastFailureReason,
    changedFiles: input.status.changedFiles ?? [],
    safeToContinue:
      !input.status.tmuxAlive && isSafeStartAction(input.status.recommendedAction),
    needsHumanRelogin: invalidAccounts.length > 0,
    invalidAccounts: invalidAccounts.map((slot) => slot.name),
    capacityBlockedAccounts: capacityBlockedAccounts.map((slot) => ({
      name: slot.name,
      availability: slot.capacityAvailability,
      reason: slot.capacityReason,
      cooldownUntil: slot.capacityCooldownUntil,
    })),
    recentCommands: extractRecentCommands(recentLogTail),
    nextBestTool: next.tool,
    nextBestReason: next.reason,
    nextBestCommand: nextBestCommand({
      jobId: input.jobId,
      action: next,
      status: input.status,
    }),
    recentLogTail,
  };
}

async function readRuntimeResultBrief(path: string): Promise<{
  readonly currentAccount?: string;
  readonly lastFailureReason?: string;
  readonly updatedAt?: string;
}> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isRecord(parsed)) return {};
    const attempts = Array.isArray(parsed.attempts) ? parsed.attempts : [];
    const lastAttempt = lastRecord(attempts);
    return {
      ...(isRecord(lastAttempt) && typeof lastAttempt.accountId === "string"
        ? { currentAccount: lastAttempt.accountId }
        : {}),
      ...(typeof parsed.reason === "string"
        ? { lastFailureReason: parsed.reason }
        : {}),
      ...(isRecord(parsed.task) && typeof parsed.task.updatedAt === "string"
        ? { updatedAt: parsed.task.updatedAt }
        : {}),
    };
  } catch {
    return {};
  }
}

function lastRecord(values: readonly unknown[]): Record<string, unknown> | undefined {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index];
    if (isRecord(value)) return value;
  }
  return undefined;
}

async function safeTail(path: string, lines: number): Promise<string> {
  try {
    return await tailCodexGoalLog(path, lines);
  } catch {
    return "";
  }
}

function nextActionForStatus(action: string): JsonObject {
  if (action === "wait_for_worker") {
    return { tool: "codex_goal_brief", reason: "worker is already running" };
  }
  if (action === "start_worker") {
    return { tool: "codex_goal_continue", reason: "no result exists and workspace is clean" };
  }
  if (action === "continue_after_capacity" || action === "continue_after_timeout") {
    return { tool: "codex_goal_continue", reason: "safe continuation condition" };
  }
  if (action === "review_completed") {
    return { tool: "codex_goal_mark_reviewed", reason: "worker completed" };
  }
  return { tool: "manual_review", reason: "status requires inspection before continuing" };
}

function nextBestCommand(input: {
  readonly jobId: string;
  readonly action: JsonObject;
  readonly status: Awaited<ReturnType<typeof collectCodexGoalStatus>>;
}): string {
  const tool = typeof input.action.tool === "string"
    ? input.action.tool
    : "manual_review";
  if (tool === "codex_goal_continue") {
    return `codex_goal_continue({ jobId: ${JSON.stringify(input.jobId)}, confirmContinue: true })`;
  }
  if (tool === "codex_goal_mark_reviewed") {
    return `codex_goal_mark_reviewed({ jobId: ${JSON.stringify(input.jobId)} })`;
  }
  if (tool === "codex_goal_brief") {
    return `codex_goal_brief({ jobId: ${JSON.stringify(input.jobId)} })`;
  }
  if (input.status.workspaceDirty) {
    return "manual_review_dirty_worktree";
  }
  return "manual_review_status";
}

function accountPoolRootFromArgs(args: AccountPoolMcpArgs): string {
  return resolvePath(
    process.cwd(),
    args.poolRootDir ?? join(homedir(), ".cache", "subscription-runtime"),
  );
}

function accountAuthRootFromArgs(args: AccountPoolMcpArgs): string {
  if (args.authRootDir) return resolvePath(process.cwd(), args.authRootDir);
  if (args.pool) return join(accountPoolRootFromArgs(args), args.pool);
  return resolvePath(process.cwd(), defaultAuthRoot);
}

async function listAccountPools(poolRootDir: string): Promise<readonly JsonObject[]> {
  let entries;
  try {
    entries = await readdir(poolRootDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const pools = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const authRootDir = join(poolRootDir, entry.name);
        const slots = await listCodexGoalAccountStatuses({ authRootDir });
        const visibleSlots = visibleCodexGoalAccountPoolSlots(entry.name, slots);
        const dedupedSlots = dedupeCodexGoalAccountSlots(visibleSlots);
        const availableDedupedSlots = availableCodexGoalAccountSlots(dedupedSlots);
        return {
          pool: entry.name,
          authRootDir,
          accountCount: visibleSlots.length,
          readyCount: visibleSlots.filter((slot) => slot.status === "ready").length,
          availableCount: availableDedupedSlots.length,
          dedupedAccountNames: dedupedSlots.map((slot) => slot.name),
          availableDedupedAccountNames: availableDedupedSlots.map((slot) => slot.name),
          hasDuplicates: duplicateAccountGroups(visibleSlots).length > 0,
        };
      }),
  );
  return pools.filter((pool) => (pool.accountCount as number) > 0);
}

function duplicateAccountGroups(
  slots: Awaited<ReturnType<typeof listCodexGoalAccountStatuses>>,
): readonly JsonObject[] {
  const groups = new Map<string, typeof slots>();
  for (const slot of slots) {
    if (!slot.identityHashPrefix) continue;
    groups.set(slot.identityHashPrefix, [
      ...(groups.get(slot.identityHashPrefix) ?? []),
      slot,
    ]);
  }
  return [...groups.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([identityHashPrefix, group]) => ({
      identityHashPrefix,
      slots: group.map((slot) => ({
        name: slot.name,
        status: slot.status,
        lastRefreshAt: slot.lastRefreshAt,
        expiresAt: slot.expiresAt,
      })),
      preferredSlot: preferredAccountSlot(group)?.name,
    }));
}

export function dedupeCodexGoalAccountSlots(
  slots: Awaited<ReturnType<typeof listCodexGoalAccountStatuses>>,
) {
  const byIdentity = new Map<string, typeof slots[number]>();
  const uniqueSlots: typeof slots[number][] = [];
  for (const slot of slots) {
    const key = slot.identityHashPrefix;
    if (!key) {
      uniqueSlots.push(slot);
      continue;
    }
    const existing = byIdentity.get(key);
    const preferred = existing ? preferredAccountSlot([existing, slot]) : slot;
    if (preferred) byIdentity.set(key, preferred);
  }
  const duplicateIdentities = new Set(
    duplicateAccountGroups(slots)
      .map((group) => group.identityHashPrefix)
      .filter((value): value is string => typeof value === "string"),
  );
  for (const slot of slots) {
    if (!slot.identityHashPrefix || duplicateIdentities.has(slot.identityHashPrefix)) {
      continue;
    }
    uniqueSlots.push(slot);
  }
  return [
    ...uniqueSlots,
    ...[...byIdentity.entries()]
      .filter(([identity]) => duplicateIdentities.has(identity))
      .map(([, slot]) => slot),
  ];
}

export function availableCodexGoalAccountSlots(
  slots: Awaited<ReturnType<typeof listCodexGoalAccountStatuses>>,
) {
  return slots.filter(isAccountSlotAvailable);
}

export function visibleCodexGoalAccountPoolSlots(
  poolName: string,
  slots: Awaited<ReturnType<typeof listCodexGoalAccountStatuses>>,
) {
  const likelyAuthPool = isLikelyAuthPoolName(poolName);
  return slots.filter((slot) =>
    slot.status !== "auth_missing" ||
    likelyAuthPool,
  );
}

function preferredAccountSlot(
  slots: Awaited<ReturnType<typeof listCodexGoalAccountStatuses>>,
) {
  return [...slots].sort((left, right) => {
    const leftReady = left.status === "ready" ? 1 : 0;
    const rightReady = right.status === "ready" ? 1 : 0;
    if (leftReady !== rightReady) return rightReady - leftReady;
    return Date.parse(right.lastRefreshAt ?? right.expiresAt ?? "0") -
      Date.parse(left.lastRefreshAt ?? left.expiresAt ?? "0");
  })[0];
}

function isAccountSlotAvailable(
  slot: Awaited<ReturnType<typeof listCodexGoalAccountStatuses>>[number],
): boolean {
  return slot.status === "ready" && (
    !slot.capacityAvailability || slot.capacityAvailability === "available"
  );
}

function isLikelyAuthPoolName(name: string): boolean {
  return /codex/i.test(name) &&
    /(?:^|[-_])(auth|accounts?)(?:$|[-_])/i.test(name);
}

function tagValues(value: unknown): readonly string[] {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value === "string") {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function extractRecentCommands(logTail: string): readonly string[] {
  const commands: string[] = [];
  for (const line of logTail.split(/\r?\n/)) {
    const command = commandFromLogLine(line);
    if (!command) continue;
    if (commands.at(-1) !== command) commands.push(command);
  }
  return commands.slice(-10);
}

function commandFromLogLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const promptMatch = /^(?:[$>]|\+\s)(.+)$/.exec(trimmed);
  const command = promptMatch?.[1]?.trim() ?? trimmed;
  if (!/^(?:git|npm|npx|node|pnpm|yarn|bun|uv|python|python3|pytest|ruff|mypy|tsc|vitest|cargo|go|make|cmake|docker|docker-compose|\.venv\/bin\/python|scripts\/)[\s/]/.test(command)) {
    return null;
  }
  return redactCommand(command).slice(0, 500);
}

function redactCommand(command: string): string {
  return new DefaultRedactor().redact(command);
}

function redactLogTail(logTail: string): string {
  return logTail
    .split(/\r?\n/)
    .map((line) => redactCommand(line))
    .join("\n");
}

function putIfDefined(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) target[key] = value;
}

function registerCodexGoalPrompts(server: McpServer): void {
  for (const prompt of [
    ["start_codex_goal_worker", "Start a stored Codex goal worker safely."],
    ["monitor_codex_goal_worker", "Monitor a running Codex goal worker."],
    ["recover_codex_goal_worker", "Recover a stopped Codex goal worker."],
    ["handoff_codex_goal_job", "Prepare a handoff for another agent."],
    ["review_worker_changes", "Review worker changes before merge or commit."],
  ] as const) {
    server.registerPrompt(
      prompt[0],
      {
        title: prompt[0],
        description: prompt[1],
        argsSchema: { jobId: z.string().optional() },
      },
      ({ jobId }) => ({
        messages: [{
          role: "user",
          content: {
            type: "text",
            text: codexGoalPromptText(prompt[0], jobId),
          },
        }],
      }),
    );
  }
}

function codexGoalPromptText(name: string, jobId: string | undefined): string {
  const id = jobId?.trim() || "<jobId>";
  const shared =
    `Use the subscription-runtime Codex goal MCP tools for jobId ${id}. ` +
    "Never print auth.json or tokens. Do not run two writer workers in the same worktree.";
  if (name === "start_codex_goal_worker") {
    return `${shared} First call codex_goal_status_by_id, then codex_goal_continue only if the status recommendation allows it.`;
  }
  if (name === "monitor_codex_goal_worker") {
    return `${shared} Call codex_goal_brief and follow recommendedAction. If worker is alive, keep monitoring instead of starting another worker.`;
  }
  if (name === "recover_codex_goal_worker") {
    return `${shared} Use codex_goal_recover for quota, capacity, reconnect or timeout states. Inspect dirty or unknown failures manually.`;
  }
  if (name === "handoff_codex_goal_job") {
    return `${shared} Provide the jobId, registryRootDir if non-default, current status, branch/worktree, and the next safe tool.`;
  }
  return `${shared} Inspect git diff and test evidence before merging. Use codex_goal_mark_reviewed only after review.`;
}

function shellText(value: string): string {
  return shellQuote(value);
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
