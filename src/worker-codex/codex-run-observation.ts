import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { DefaultRedactor } from "@vioxen/subscription-runtime/core";
import {
  LocalFileRunObservationHistoryStore,
  LocalFileWorkerControlInboxStore,
} from "@vioxen/subscription-runtime/store-local-file";
import {
  decideRunObservation,
  actionForRuntimeState,
  classifyRuntimeRunState,
  compareRunObservationHistory,
  runObservationHistoryEntryFromSnapshot,
  RunEventProviderKind,
  WorkerControlService,
  type RunCapacityHint,
  type RunControlInboxSummary,
  type RunObservationGrowth,
  type RunObservationHistoryEntry,
  type RunObservationHistoryStorePort,
  type RunArtifactSummary,
  type RunLogExcerpt,
  type RunObservationLiveness,
  type RunObservationPort,
  type RunObservationRequest,
  type RunObservationSnapshot,
  type RunObservationStatus,
  type RunObservationWarning,
} from "@vioxen/subscription-runtime/worker-core";
import {
  codexGoalJobToArgs,
  listCodexGoalJobs,
  readCodexGoalJob,
  resolveCodexGoalJobRegistryRoot,
  type CodexGoalJobManifest,
} from "./codex-goal-jobs";
import {
  collectCodexGoalStatus,
  isCodexGoalStoppedProgressStatus,
  listCodexGoalAccountStatuses,
  resolveCodexGoalWorkerLiveness,
  tailCodexGoalLog,
  type CodexGoalStatus,
} from "./codex-goal-ops";
import { codexGoalProgressPath } from "./codex-goal-runner";

const defaultAuthRoot = "~/.cache/subscription-runtime/live-codex-auth";
const defaultStaleAfterMs = 10 * 60_000;
const defaultTailLines = 20;
const heartbeatOnlyNoOutputAfterMs = 2 * 60_000;

export type CodexRunObservationAdapterOptions = {
  readonly registryRootDir?: string;
  readonly cwd?: string;
  readonly staleAfterMs?: number;
  readonly tailLines?: number;
  readonly controlInboxReader?: (input: {
    readonly runId: string;
    readonly manifest: CodexGoalJobManifest;
  }) => Promise<RunControlInboxSummary | undefined>;
  readonly historyStore?: RunObservationHistoryStorePort | null;
};

export class CodexRunObservationAdapter implements RunObservationPort {
  private readonly cwd: string;
  private readonly registryRootDir: string;
  private readonly staleAfterMs: number;
  private readonly tailLines: number;
  private readonly historyStore: RunObservationHistoryStorePort | undefined;
  private readonly redactor = new DefaultRedactor();

  constructor(private readonly options: CodexRunObservationAdapterOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.registryRootDir = resolveCodexGoalJobRegistryRoot({
      cwd: this.cwd,
      ...(options.registryRootDir ? { registryRootDir: options.registryRootDir } : {}),
    });
    this.staleAfterMs = options.staleAfterMs ?? defaultStaleAfterMs;
    this.tailLines = options.tailLines ?? defaultTailLines;
    this.historyStore = options.historyStore === undefined
      ? new LocalFileRunObservationHistoryStore({
          rootDir: join(this.registryRootDir, "state"),
        })
      : options.historyStore ?? undefined;
  }

  async listRunIds(): Promise<readonly string[]> {
    return (await listCodexGoalJobs({
      registryRootDir: this.registryRootDir,
    })).map((job) => job.jobId);
  }

  async observeRun(
    request: RunObservationRequest,
  ): Promise<RunObservationSnapshot> {
    const manifest = await readCodexGoalJob({
      registryRootDir: this.registryRootDir,
      jobId: request.runId,
    });
    const paths = codexManifestPaths(manifest, this.cwd);
    const status = await collectCodexGoalStatus({
      jobRootDir: paths.jobRootDir,
      taskId: manifest.taskId,
      resultPath: paths.outputPath,
      workspacePath: paths.workspacePath,
      logPath: paths.logPath,
      progressPath: paths.progressPath,
      ...(manifest.tmuxSession ? { tmuxSession: manifest.tmuxSession } : {}),
    });
    const capacity = await this.capacityHints({ manifest, paths });
    const warnings = status.warnings.map((message): RunObservationWarning => ({
      code: "codex_status_warning",
      message,
      severity: "warning",
    }));
    const logUpdatedAgeMs = isoAgeMs(status.logUpdatedAt);
    const logStale = logUpdatedAgeMs !== undefined &&
      logUpdatedAgeMs > this.staleAfterMs;
    const logs = await this.logExcerpt({
      status,
      request,
      warnings,
      logUpdatedAgeMs,
      logStale,
    });
    const progressStale = status.progressHeartbeatAgeMs !== undefined &&
      status.progressHeartbeatAgeMs > this.staleAfterMs;
    const workerLiveness = resolveCodexGoalWorkerLiveness({
      status,
      progressStale,
    });
    const heartbeatOnlyNoOutput = isHeartbeatOnlyNoOutput({
      status,
      progressStale,
      logUpdatedAgeMs,
      workerAlive: workerLiveness.alive,
    });
    const silentStale = Boolean(workerLiveness.alive && progressStale);
    if (workerLiveness.alive && logStale) {
      warnings.push({
        code: "log_stale_while_worker_alive",
        message: "worker appears alive but the log has not changed recently",
        severity: "warning",
      });
    }
    if (heartbeatOnlyNoOutput) {
      warnings.push({
        code: "heartbeat_only_no_output",
        message:
          "worker heartbeat is fresh, but there is no result, log output or workspace change",
        severity: "blocked",
      });
    }
    if (
      (status.progressHeartbeatAgeMs !== undefined &&
        status.progressHeartbeatAgeMs < -5_000) ||
      (logUpdatedAgeMs !== undefined && logUpdatedAgeMs < -5_000)
    ) {
      warnings.push({
        code: "clock_skew",
        message: "observed progress or log timestamp is in the future",
        severity: "warning",
      });
    }
    const liveness = codexLiveness({
      status,
      silentStale,
      workerAlive: workerLiveness.alive,
    });
    const runStatus = codexRunStatus({
      status,
      workerAlive: workerLiveness.alive,
    });
    const changedFiles = status.changedFiles ?? [];
    const manualReviewReasons = codexManualReviewReasons(status, {
      workerAlive: workerLiveness.alive,
    });
    const workspaceKey = await safeWorkspaceKey(paths.workspacePath);
    const workspace = {
      path: paths.workspacePath,
      key: workspaceKey,
      ...(status.workspaceExists === undefined ? {} : { exists: status.workspaceExists }),
      changedFilesCount: changedFiles.length,
      ...(status.workspaceDirty === undefined ? {} : { dirty: status.workspaceDirty }),
      ...(request.includeChangedFiles ? { changedFiles } : {}),
    };
    const progress = {
      ...(status.progressStatus === undefined ? {} : { status: status.progressStatus }),
      ...(status.progressUpdatedAt === undefined
        ? {}
        : { updatedAt: status.progressUpdatedAt }),
      ...(status.progressHeartbeatAgeMs === undefined
        ? {}
        : { heartbeatAgeMs: status.progressHeartbeatAgeMs }),
      staleAfterMs: this.staleAfterMs,
      stale: progressStale,
      silentStale,
      heartbeatOnlyNoOutput,
      ...(status.progressAttemptCount === undefined
        ? {}
        : { attemptCount: status.progressAttemptCount }),
      ...(status.progressCurrentAccount === undefined
        ? {}
        : { currentAccount: status.progressCurrentAccount }),
    };
    const result = {
      ...(status.resultExists === undefined ? {} : { exists: status.resultExists }),
      ...(status.resultStatus === undefined ? {} : { status: status.resultStatus }),
      ...(status.resultReason === undefined ? {} : { reason: status.resultReason }),
      ...(status.resultUpdatedAt === undefined ? {} : { updatedAt: status.resultUpdatedAt }),
      ...(status.resultPath === undefined ? {} : { path: status.resultPath }),
    };
    const artifacts = [
      artifactSummary("result", {
        path: status.resultPath,
        exists: status.resultExists,
      }),
      artifactSummary("progress", {
        path: status.progressPath,
        exists: status.progressExists,
        updatedAt: status.progressUpdatedAt,
      }),
      artifactSummary("log", {
        path: status.logPath,
        exists: status.logExists,
        updatedAt: status.logUpdatedAt,
        byteLength: status.logByteLength,
      }),
    ];
    const controlInbox = this.options.controlInboxReader
      ? await this.options.controlInboxReader({
          runId: manifest.jobId,
          manifest,
      })
      : await this.controlInboxSummary({ manifest, paths });
    const observedAt = new Date().toISOString();
    const historyEntry = runObservationHistoryEntryFromSnapshot({
      runId: manifest.jobId,
      providerKind: RunEventProviderKind.Codex,
      observedAt,
      workspace: {
        ...workspace,
        changedFiles,
      },
      result,
      logs,
    });
    const growth = await this.observationGrowth({
      runId: manifest.jobId,
      current: historyEntry,
      warnings,
    });
    const classification = classifyRuntimeRunState({
      status: runStatus,
      liveness,
      workspaceDirty: workspace.dirty,
      changedFilesCount: workspace.changedFilesCount,
      processAlive: workerLiveness.alive,
      processCpuActive: status.progressCpuActive,
      processCommand: status.progressCommand,
      progressStatus: progress.status,
      progressStale,
      progressSilentStale: silentStale,
      heartbeatOnlyNoOutput,
      resultExists: result.exists,
      resultStatus: result.status,
      resultReason: result.reason,
      logStale,
      logByteLength: logs.byteLength,
      logGrew: growth.logGrew,
      resultChanged: growth.resultChanged,
      workspaceChanged: growth.workspaceChanged,
      capacity,
      controlInboxPendingCount: controlInbox?.pendingCount,
    });
    const recommendedAction = actionForRuntimeState({
      status: runtimeStatusForCodexObservation({
        runStatus,
        resultStatus: result.status,
        workspaceDirty: workspace.dirty,
        changedFilesCount: workspace.changedFilesCount,
      }),
      classification,
      reason: result.reason,
      changedFilesCount: workspace.changedFilesCount,
    });
    const snapshotBase = {
      runId: manifest.jobId,
      providerKind: RunEventProviderKind.Codex,
      observedAt,
      status: runStatus,
      liveness,
      classification,
      recommendedAction,
      workspace,
      process: {
        supervisor: workerLiveness.supervisorKind,
        ...(manifest.tmuxSession ? { sessionId: manifest.tmuxSession } : {}),
        alive: workerLiveness.alive,
        aliveReason: workerLiveness.aliveReason,
        ...(status.progressPid === undefined ? {} : { pid: status.progressPid }),
        ...(status.progressCpuActive === undefined
          ? {}
          : { cpuActive: status.progressCpuActive }),
        ...(status.progressCommand === undefined
          ? {}
          : { command: status.progressCommand }),
      },
      progress,
      result,
      logs,
      artifacts,
      capacity,
      ...(controlInbox === undefined ? {} : { controlInbox }),
      manualReviewReasons,
      warnings,
    } satisfies Omit<RunObservationSnapshot, "readOnlyDecision">;
    return {
      ...snapshotBase,
      readOnlyDecision: decideRunObservation({
        status: snapshotBase.status,
        liveness: snapshotBase.liveness,
        workspace: snapshotBase.workspace,
        progress: snapshotBase.progress,
        result: snapshotBase.result,
        capacity: snapshotBase.capacity,
        ...(snapshotBase.controlInbox === undefined
          ? {}
          : { controlInbox: snapshotBase.controlInbox }),
        manualReviewReasons: snapshotBase.manualReviewReasons,
        warnings: snapshotBase.warnings,
      }),
    };
  }

  private async controlInboxSummary(input: {
    readonly manifest: CodexGoalJobManifest;
    readonly paths: CodexManifestPaths;
  }): Promise<RunControlInboxSummary | undefined> {
    const control = new WorkerControlService({
      store: new LocalFileWorkerControlInboxStore({
        rootDir: input.paths.stateRootDir,
      }),
    });
    const target = {
      jobId: input.manifest.jobId,
      taskId: input.manifest.taskId,
      workspaceId: input.paths.workspacePath,
    };
    const [report, signals] = await Promise.all([
      control.reconcile({ target }),
      control.listSignals({ target, includeExpired: true, includeBodies: false }),
    ]);
    if (report.signalCount === 0) return undefined;
    const latestSignalAt = latestIso(signals.map((view) => view.signal.createdAt));
    const latestDeliveredAt = latestIso(signals
      .map((view) => view.latestReceipt?.deliveredAt)
      .filter((value): value is Date => value instanceof Date));
    return {
      pendingCount: report.pendingCount,
      acceptedCount: report.acceptedCount,
      deliverableCount: report.deliverableCount,
      deliveredCount: report.deliveredCount,
      failedCount: report.failedCount,
      blockedDeliveryCount: report.blockedCount,
      safeToContinue: report.blockedCount === 0,
      ...(latestSignalAt === undefined ? {} : { latestSignalAt }),
      ...(latestDeliveredAt === undefined ? {} : { latestDeliveredAt }),
    };
  }

  private async observationGrowth(input: {
    readonly runId: string;
    readonly current: RunObservationHistoryEntry;
    readonly warnings: RunObservationWarning[];
  }): Promise<RunObservationGrowth> {
    const empty = compareRunObservationHistory(null, input.current);
    if (!this.historyStore) return empty;
    let previous: RunObservationHistoryEntry | null = null;
    try {
      previous = await this.historyStore.readObservation(input.runId);
    } catch {
      input.warnings.push({
        code: "observation_history_read_failed",
        message: "run observation history could not be read; growth signals were ignored",
        severity: "warning",
      });
    }
    const growth = compareRunObservationHistory(previous, input.current);
    try {
      await this.historyStore.writeObservation(input.current);
    } catch {
      input.warnings.push({
        code: "observation_history_write_failed",
        message: "run observation history could not be written; later growth signals may be weaker",
        severity: "warning",
      });
    }
    return growth;
  }

  private async capacityHints(input: {
    readonly manifest: CodexGoalJobManifest;
    readonly paths: CodexManifestPaths;
  }): Promise<readonly RunCapacityHint[]> {
    const accounts = await listCodexGoalAccountStatuses({
      authRootDir: input.paths.authRootDir,
      accounts: input.manifest.accounts,
      stateRootDir: input.paths.stateRootDir,
    });
    return accounts.map((account) => ({
      account: account.name,
      status: account.status,
      ...(account.capacityAvailability === undefined
        ? {}
        : { availability: account.capacityAvailability }),
      ...(account.capacityReason === undefined
        ? {}
        : { reason: account.capacityReason }),
      ...(account.capacityCooldownUntil === undefined
        ? {}
        : { cooldownUntil: account.capacityCooldownUntil }),
      ...(account.warnings.length ? { warning: account.warnings.join("; ") } : {}),
    }));
  }

  private async logExcerpt(input: {
    readonly status: CodexGoalStatus;
    readonly request: RunObservationRequest;
    readonly warnings: RunObservationWarning[];
    readonly logUpdatedAgeMs?: number | undefined;
    readonly logStale: boolean;
  }): Promise<RunLogExcerpt> {
    const log: RunLogExcerpt = {
      ...(input.status.logPath === undefined ? {} : { path: input.status.logPath }),
      ...(input.status.logExists === undefined
        ? {}
        : { exists: input.status.logExists }),
      ...(input.status.logUpdatedAt === undefined
        ? {}
        : { updatedAt: input.status.logUpdatedAt }),
      ...(input.logUpdatedAgeMs === undefined
        ? {}
        : { updatedAgeMs: input.logUpdatedAgeMs }),
      staleAfterMs: this.staleAfterMs,
      stale: input.logStale,
      ...(input.status.logByteLength === undefined
        ? {}
        : { byteLength: input.status.logByteLength }),
    };
    if (!input.request.includeLogTail || !input.status.logPath) return log;
    try {
      const lines = input.request.tailLines ?? this.tailLines;
      return {
        ...log,
        tailLines: lines,
        tail: this.redactor.redact(await tailCodexGoalLog(input.status.logPath, lines)),
        ...(input.status.logByteLength === undefined
          ? {}
          : { truncated: input.status.logByteLength > 0 }),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "log_tail_unreadable";
      input.warnings.push({
        code: "log_tail_unreadable",
        message,
        severity: "warning",
      });
      return {
        ...log,
        warning: message,
      };
    }
  }
}

function artifactSummary(
  kind: string,
  input: {
    readonly path?: string | undefined;
    readonly exists?: boolean | undefined;
    readonly updatedAt?: string | undefined;
    readonly byteLength?: number | undefined;
  },
): RunArtifactSummary {
  return {
    kind,
    ...(input.path === undefined ? {} : { path: input.path }),
    ...(input.exists === undefined ? {} : { exists: input.exists }),
    ...(input.updatedAt === undefined ? {} : { updatedAt: input.updatedAt }),
    ...(input.byteLength === undefined ? {} : { byteLength: input.byteLength }),
  };
}

type CodexManifestPaths = {
  readonly jobRootDir: string;
  readonly authRootDir: string;
  readonly stateRootDir: string;
  readonly workspacePath: string;
  readonly outputPath: string;
  readonly progressPath: string;
  readonly logPath: string;
};

function codexManifestPaths(
  manifest: CodexGoalJobManifest,
  cwd: string,
): CodexManifestPaths {
  const args = codexGoalJobToArgs(manifest);
  const jobRootDir = resolvePath(cwd, String(args.jobRootDir));
  const authRootDir = resolvePath(cwd, String(args.authRootDir ?? defaultAuthRoot));
  const workspacePath = resolvePath(cwd, String(args.workspacePath));
  const outputPath = resolvePath(
    cwd,
    String(args.outputPath ?? join(jobRootDir, `${manifest.taskId}.latest-result.json`)),
  );
  const progressPath = resolvePath(
    cwd,
    String(args.progressPath ?? codexGoalProgressPath({
      jobRootDir,
      taskId: manifest.taskId,
    })),
  );
  return {
    jobRootDir,
    authRootDir,
    stateRootDir: resolvePath(cwd, String(args.stateRootDir ?? join(jobRootDir, "state"))),
    workspacePath,
    outputPath,
    progressPath,
    logPath: resolvePath(
      cwd,
      String(args.logPath ?? join(jobRootDir, `${manifest.taskId}.log`)),
    ),
  };
}

function codexRunStatus(input: {
  readonly status: CodexGoalStatus;
  readonly workerAlive: boolean;
}): RunObservationStatus {
  if (
    input.status.resultStatus === "done" ||
    input.status.resultStatus === "completed"
  ) {
    return "completed";
  }
  if (input.workerAlive && input.status.progressStatus === "running") return "running";
  if (
    input.status.resultStatus === "waiting_capacity" ||
    input.status.progressStatus === "blocked"
  ) {
    return "blocked";
  }
  if (input.workerAlive) return "running";
  if (isCodexGoalStoppedProgressStatus(input.status.progressStatus)) {
    return "stopped";
  }
  if (
    input.status.resultStatus === "failed" ||
    input.status.resultStatus === "partial" ||
    input.status.resultStatus === "blocked" ||
    input.status.resultStatus === "aborted"
  ) {
    return "failed";
  }
  if (input.status.resultExists === false && input.status.tmuxAlive === false) {
    return "stopped";
  }
  return "unknown";
}

function codexLiveness(input: {
  readonly status: CodexGoalStatus;
  readonly silentStale: boolean;
  readonly workerAlive: boolean;
}): RunObservationLiveness {
  if (input.silentStale) return "stale";
  if (input.workerAlive) return "alive";
  if (isCodexGoalStoppedProgressStatus(input.status.progressStatus)) {
    return "dead";
  }
  if (input.status.tmuxAlive === false || input.status.progressProcessAlive === false) {
    return "dead";
  }
  return "unknown";
}

function codexManualReviewReasons(
  status: CodexGoalStatus,
  input: { readonly workerAlive: boolean },
): readonly string[] {
  if (input.workerAlive && status.progressStatus === "running") return [];
  if (
    status.recommendedAction === "inspect_dirty_workspace" ||
    status.recommendedAction === "inspect_dirty_failure" ||
    status.recommendedAction === "inspect_failure" ||
    status.recommendedAction === "check_log_or_result"
  ) {
    return [status.recommendedAction];
  }
  return [];
}

function isHeartbeatOnlyNoOutput(input: {
  readonly status: CodexGoalStatus;
  readonly progressStale: boolean;
  readonly logUpdatedAgeMs?: number | undefined;
  readonly workerAlive: boolean;
}): boolean {
  const status = input.status;
  const noOutputAgeMs = input.logUpdatedAgeMs ?? status.progressHeartbeatAgeMs;
  return Boolean(
    input.workerAlive &&
      status.progressExists &&
      status.progressStatus === "running" &&
      !input.progressStale &&
      status.appServerProcessAlive !== true &&
      status.progressCpuActive !== true &&
      noOutputAgeMs !== undefined &&
      noOutputAgeMs >= heartbeatOnlyNoOutputAfterMs &&
      status.resultExists === false &&
      (status.logExists === false || status.logByteLength === 0) &&
      status.workspaceDirty === false &&
      (status.changedFiles ?? []).length === 0,
  );
}

async function safeWorkspaceKey(workspacePath: string): Promise<string> {
  try {
    return await realpath(workspacePath);
  } catch {
    return resolve(process.cwd(), workspacePath);
  }
}

function resolvePath(cwd: string, value: string): string {
  const expanded = value.startsWith("~/")
    ? join(homedir(), value.slice(2))
    : value;
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

function isoAgeMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? Date.now() - time : undefined;
}

function latestIso(values: readonly Date[]): string | undefined {
  const latestTime = values
    .map((value) => value.getTime())
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => b - a)[0];
  return latestTime === undefined ? undefined : new Date(latestTime).toISOString();
}

function runtimeStatusForCodexObservation(input: {
  readonly runStatus: RunObservationStatus;
  readonly resultStatus?: string | undefined;
  readonly workspaceDirty?: boolean | undefined;
  readonly changedFilesCount?: number | undefined;
}) {
  if (input.resultStatus === "done" || input.resultStatus === "completed") {
    return "done" as const;
  }
  if (
    input.resultStatus === "blocked" ||
    input.resultStatus === "waiting_capacity" ||
    input.runStatus === "blocked" ||
    input.runStatus === "running"
  ) {
    return "blocked" as const;
  }
  if (
    input.resultStatus === "partial" ||
    input.workspaceDirty ||
    (input.changedFilesCount ?? 0) > 0
  ) {
    return "partial" as const;
  }
  return "failed" as const;
}
