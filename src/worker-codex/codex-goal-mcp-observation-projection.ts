import { stat } from "node:fs/promises";
import { join } from "node:path";
import { DefaultRedactor } from "@vioxen/subscription-runtime/core";
import {
  decideRunObservation,
  type RunEventProviderKind,
  type RunObservationSnapshot,
} from "@vioxen/subscription-runtime/worker-core";
import {
  collectCodexGoalStatus,
  resolveCodexGoalWorkerLiveness,
  tailCodexGoalLog,
} from "./codex-goal-ops";
import type { AgentRunWatchMcpArgs } from "./codex-goal-mcp-inputs";
import {
  booleanValue,
  resolvePath,
  stringValue,
} from "./codex-goal-mcp-values";
import {
  codexGoalOrphanLiveness,
  codexGoalOrphanManualReviewReasons,
  codexGoalOrphanRunStatus,
} from "./application/codex-goal-orphan-observation-policy";

type JsonObject = Readonly<Record<string, unknown>>;

export async function observeOrphanCodexRun(input: {
  readonly runId: string;
  readonly error: unknown;
  readonly args: AgentRunWatchMcpArgs;
  readonly providerKind: RunEventProviderKind;
  readonly staleAfterMs: number;
  readonly tailLines: number;
}): Promise<RunObservationSnapshot | null> {
  if (!isMissingCodexGoalManifestError(input.error)) return null;
  if (!stringValue(input.args.runArtifactsRootDir)) return null;
  const cwd = resolvePath(
    process.cwd(),
    stringValue(input.args.cwd) ?? process.cwd(),
  );
  const jobRootDir = join(
    resolvePath(cwd, stringValue(input.args.runArtifactsRootDir) as string),
    input.runId,
  );
  try {
    const rootStat = await stat(jobRootDir);
    if (!rootStat.isDirectory()) return null;
  } catch {
    return null;
  }
  const status = await collectCodexGoalStatus({
    jobRootDir,
    taskId: input.runId,
    resultPath: join(jobRootDir, "result.json"),
    logPath: join(jobRootDir, "worker.log"),
    progressPath: join(jobRootDir, "progress.json"),
    tmuxSession: input.runId,
  });
  const logUpdatedAgeMs = isoAgeMsForMcp(status.logUpdatedAt);
  const progressStale = status.progressHeartbeatAgeMs !== undefined &&
    status.progressHeartbeatAgeMs > input.staleAfterMs;
  const logStale = logUpdatedAgeMs !== undefined &&
    logUpdatedAgeMs > input.staleAfterMs;
  const workerLiveness = resolveCodexGoalWorkerLiveness({
    status,
    progressStale,
  });
  const workerAlive = workerLiveness.alive;
  const heartbeatOnlyNoOutput = Boolean(
    workerAlive &&
      status.progressExists &&
      !status.resultExists &&
      (status.logByteLength ?? 0) === 0,
  );
  const warnings = [
    {
      code: "codex_orphan_artifact_run",
      message:
        "Codex run artifacts exist but the job registry manifest is missing; observing artifact paths read-only.",
      severity: "warning" as const,
    },
    ...status.warnings.map((message) => ({
      code: "codex_status_warning",
      message,
      severity: "warning" as const,
    })),
    ...(heartbeatOnlyNoOutput
      ? [{
          code: "heartbeat_only_no_output",
          message:
            "worker heartbeat is fresh, but there is no result, log output or workspace change",
          severity: "blocked" as const,
        }]
      : []),
  ];
  const runStatus = codexGoalOrphanRunStatus({ status, workerAlive });
  const liveness = codexGoalOrphanLiveness({
    workerAlive,
    progressStale,
    logStale,
  });
  const manualReviewReasons = codexGoalOrphanManualReviewReasons({
    heartbeatOnlyNoOutput,
  });
  const snapshotBase = {
    runId: input.runId,
    providerKind: input.providerKind,
    observedAt: new Date().toISOString(),
    status: runStatus,
    liveness,
    process: {
      supervisor: workerLiveness.supervisorKind,
      sessionId: input.runId,
      alive: workerAlive,
      aliveReason: workerLiveness.aliveReason,
      ...(status.progressPid === undefined ? {} : { pid: status.progressPid }),
    },
    progress: {
      ...(status.progressStatus === undefined ? {} : { status: status.progressStatus }),
      ...(status.progressUpdatedAt === undefined ? {} : { updatedAt: status.progressUpdatedAt }),
      ...(status.progressHeartbeatAgeMs === undefined
        ? {}
        : { heartbeatAgeMs: status.progressHeartbeatAgeMs }),
      staleAfterMs: input.staleAfterMs,
      stale: progressStale,
      silentStale: Boolean(workerAlive && (progressStale || logStale)),
      heartbeatOnlyNoOutput,
      ...(status.progressAttemptCount === undefined
        ? {}
        : { attemptCount: status.progressAttemptCount }),
      ...(status.progressCurrentAccount === undefined
        ? {}
        : { currentAccount: status.progressCurrentAccount }),
    },
    result: {
      ...(status.resultExists === undefined ? {} : { exists: status.resultExists }),
      ...(status.resultStatus === undefined ? {} : { status: status.resultStatus }),
      ...(status.resultReason === undefined ? {} : { reason: status.resultReason }),
      ...(status.resultPath === undefined ? {} : { path: status.resultPath }),
    },
    logs: await orphanCodexLogExcerpt({
      status,
      includeLogTail: booleanValue(input.args.includeLogTail) === true,
      tailLines: input.tailLines,
    }),
    artifacts: [
      orphanArtifactSummary("result", status.resultPath, status.resultExists),
      orphanArtifactSummary(
        "progress",
        status.progressPath,
        status.progressExists,
        status.progressUpdatedAt,
      ),
      orphanArtifactSummary(
        "log",
        status.logPath,
        status.logExists,
        status.logUpdatedAt,
        status.logByteLength,
      ),
    ],
    manualReviewReasons,
    warnings,
  } satisfies Omit<RunObservationSnapshot, "readOnlyDecision">;
  return {
    ...snapshotBase,
    readOnlyDecision: {
      kind: "manual_review_required",
      reason: "missing_job_manifest",
      safeMessage:
        "This Codex run has artifacts but no job registry manifest. Watch remains read-only; review or recreate the job manifest before continuing.",
      evidence: ["manualReviewReasons", "artifacts"],
    },
  };
}

export function failedRunObservationSnapshot(input: {
  readonly runId: string;
  readonly providerKind: RunEventProviderKind;
  readonly error: unknown;
}): RunObservationSnapshot {
  const message = safeObservationErrorMessage(input.error);
  const warnings = [{
    code: "run_observation_failed",
    message,
    severity: "warning" as const,
  }];
  const manualReviewReasons = ["run_observation_failed"];
  return {
    runId: input.runId,
    providerKind: input.providerKind,
    observedAt: new Date().toISOString(),
    status: "unknown",
    liveness: "unknown",
    warnings,
    manualReviewReasons,
    readOnlyDecision: decideRunObservation({
      status: "unknown",
      liveness: "unknown",
      manualReviewReasons,
      warnings,
    }),
  };
}

export function safeObservationErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return new DefaultRedactor().redact(message);
}

export function summarizeRunObservationSnapshots(
  snapshots: readonly { readonly status: string; readonly liveness: string; readonly readOnlyDecision: { readonly kind: string }; readonly warnings: readonly unknown[] }[],
): JsonObject {
  return {
    running: snapshots.filter((snapshot) => snapshot.status === "running").length,
    completed: snapshots.filter((snapshot) => snapshot.status === "completed").length,
    failed: snapshots.filter((snapshot) => snapshot.status === "failed").length,
    stopped: snapshots.filter((snapshot) => snapshot.status === "stopped").length,
    unknown: snapshots.filter((snapshot) => snapshot.status === "unknown").length,
    alive: snapshots.filter((snapshot) => snapshot.liveness === "alive").length,
    stale: snapshots.filter((snapshot) => snapshot.liveness === "stale").length,
    manualReview: snapshots.filter((snapshot) =>
      snapshot.readOnlyDecision.kind === "manual_review_required"
    ).length,
    capacityBlocked: snapshots.filter((snapshot) =>
      snapshot.readOnlyDecision.kind === "capacity_blocked"
    ).length,
    unsafeStateMismatch: snapshots.filter((snapshot) =>
      snapshot.readOnlyDecision.kind === "unsafe_state_mismatch"
    ).length,
    warnings: snapshots.reduce((count, snapshot) => count + snapshot.warnings.length, 0),
  };
}

function isMissingCodexGoalManifestError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("job.json") && message.includes("ENOENT");
}

async function orphanCodexLogExcerpt(input: {
  readonly status: Awaited<ReturnType<typeof collectCodexGoalStatus>>;
  readonly includeLogTail: boolean;
  readonly tailLines: number;
}) {
  if (!input.status.logPath) return { exists: false };
  if (!input.status.logExists) {
    return { exists: false, path: input.status.logPath };
  }
  return {
    exists: true,
    path: input.status.logPath,
    ...(input.status.logUpdatedAt ? { updatedAt: input.status.logUpdatedAt } : {}),
    ...(input.status.logByteLength === undefined
      ? {}
      : { byteLength: input.status.logByteLength }),
    ...(input.includeLogTail
      ? { tail: await tailCodexGoalLog(input.status.logPath, input.tailLines) }
      : {}),
  };
}

function orphanArtifactSummary(
  kind: string,
  path: string | undefined,
  exists: boolean | undefined,
  updatedAt?: string,
  byteLength?: number,
) {
  return {
    kind,
    ...(path === undefined ? {} : { path }),
    ...(exists === undefined ? {} : { exists }),
    ...(updatedAt === undefined ? {} : { updatedAt }),
    ...(byteLength === undefined ? {} : { byteLength }),
  };
}

function isoAgeMsForMcp(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return undefined;
  return Date.now() - time;
}
