import { freemem, totalmem } from "node:os";
import {
  ProjectAdmissionWorkerRole,
  ProjectOperationsWorkerState,
  ProjectOperationsWorkloadClass,
  buildProjectOperationsSnapshot,
  normalizeProjectAdmissionWorkerRole,
  type ProjectAccessScope,
  type ProjectAdmissionDecision,
  type ProjectAdmissionSnapshot,
  type ProjectOperationsSnapshot,
  type ProjectOperationsWorkerObservation,
} from "@vioxen/subscription-runtime/worker-core";
import type { CodexGoalJobSummary } from "../../codex-goal-jobs";
import type { CodexProjectAdmissionDeps } from "./codex-goal-project-admission";
import { matchesProjectControlPrefix } from "./codex-goal-project-utils";

type JsonObject = Readonly<Record<string, unknown>>;

export async function buildCodexProjectOperationsSnapshot(input: {
  readonly registryRootDir: string;
  readonly scope: ProjectAccessScope;
  readonly admissionSnapshot: ProjectAdmissionSnapshot;
  readonly admissionDecision: ProjectAdmissionDecision;
  readonly deps: CodexProjectAdmissionDeps;
  readonly now?: Date;
  readonly staleAfterMs?: number;
  readonly hostMemory?: {
    readonly totalBytes: number;
    readonly availableBytes: number;
  };
}): Promise<ProjectOperationsSnapshot> {
  const workers = await readCodexProjectWorkerObservations(input);
  const memory = input.hostMemory ?? {
    totalBytes: totalmem(),
    availableBytes: freemem(),
  };
  return buildProjectOperationsSnapshot({
    projectId: input.scope.projectId,
    observedAt: new Date(input.admissionSnapshot.observedAt),
    now: input.now ?? new Date(),
    staleAfterMs: input.staleAfterMs ?? 10 * 60_000,
    ...(workers === undefined ? {} : { workers }),
    outputDebt: {
      count: input.admissionSnapshot.debt.length,
      reasons: [...new Set(
        input.admissionSnapshot.debt.map((item) => item.reason),
      )],
    },
    hostMemory: memory,
    admission: {
      allowed: input.admissionDecision.allowed,
      reason: input.admissionDecision.reason,
    },
  });
}

async function readCodexProjectWorkerObservations(input: {
  readonly registryRootDir: string;
  readonly scope: ProjectAccessScope;
  readonly deps: CodexProjectAdmissionDeps;
  readonly staleAfterMs?: number;
}): Promise<readonly ProjectOperationsWorkerObservation[] | undefined> {
  try {
    const summaries = await input.deps.listJobs({
      registryRootDir: input.registryRootDir,
    });
    const projectSummaries = summaries.filter((summary) =>
      matchesProjectControlPrefix(
        summary.jobId,
        input.scope.jobIdPrefixes ?? [],
      )
    );
    const overviewItems = await input.deps.buildOverviewItems(
      projectSummaries.map((summary) => ({
        registryRootDir: input.registryRootDir,
        jobId: summary.jobId,
        staleAfterMs: input.staleAfterMs ?? 10 * 60_000,
        tailLines: 0,
      })),
    );
    const overviewByJobId = new Map(
      overviewItems.flatMap((item) =>
        typeof item.jobId === "string" ? [[item.jobId, item] as const] : []
      ),
    );
    return projectSummaries.map((summary) => {
      const overview = overviewByJobId.get(summary.jobId);
      return codexProjectWorkerObservation({
        summary,
        ...(overview === undefined ? {} : { overview }),
      });
    });
  } catch {
    return undefined;
  }
}

export function codexProjectWorkerObservation(input: {
  readonly summary: CodexGoalJobSummary;
  readonly overview?: JsonObject;
}): ProjectOperationsWorkerObservation {
  const role = normalizeProjectAdmissionWorkerRole(undefined, input.summary.tags);
  const state = codexProjectWorkerState(input.overview);
  return {
    workerId: input.summary.jobId,
    role,
    state,
    workloadClass: codexProjectWorkloadClass(input.summary.tags, role),
    evidence: codexProjectWorkerEvidence(input.overview),
  };
}

function codexProjectWorkerState(
  overview: JsonObject | undefined,
): ProjectOperationsWorkerState {
  if (!overview || overview.ok === false) {
    return ProjectOperationsWorkerState.Unknown;
  }
  if (overview.workerAlive === true) {
    return overview.isStale === true
      ? ProjectOperationsWorkerState.Blocked
      : ProjectOperationsWorkerState.Running;
  }
  const resultStatus = optionalText(overview.resultStatus)?.toLowerCase();
  if (resultStatus === "completed" || resultStatus === "succeeded") {
    return ProjectOperationsWorkerState.Completed;
  }
  if (resultStatus === "failed" || resultStatus === "error") {
    return ProjectOperationsWorkerState.Failed;
  }
  const progressStatus = optionalText(overview.progressStatus)?.toLowerCase();
  if (progressStatus === "queued" || progressStatus === "pending") {
    return ProjectOperationsWorkerState.Queued;
  }
  if (progressStatus === "starting") {
    return ProjectOperationsWorkerState.Starting;
  }
  const markerTypes = stringArray(overview.lifecycleMarkerTypes);
  if (markerTypes.includes("stop_event") || markerTypes.includes("review")) {
    return ProjectOperationsWorkerState.Stopped;
  }
  return ProjectOperationsWorkerState.Unknown;
}

function codexProjectWorkloadClass(
  tags: readonly string[],
  role: ProjectAdmissionWorkerRole,
): ProjectOperationsWorkloadClass {
  if (
    tags.includes("workload-heavy") ||
    role === ProjectAdmissionWorkerRole.Fastgate ||
    role === ProjectAdmissionWorkerRole.Reviewer
  ) {
    return ProjectOperationsWorkloadClass.Heavy;
  }
  return ProjectOperationsWorkloadClass.Standard;
}

function codexProjectWorkerEvidence(
  overview: JsonObject | undefined,
): readonly string[] {
  if (!overview) return ["overview unavailable"];
  return [
    optionalText(overview.recommendedAction),
    optionalText(overview.progressStatus),
    optionalText(overview.resultStatus),
    overview.isStale === true ? "stale" : undefined,
    overview.activeWriterRisk === "active" ? "active writer" : undefined,
  ].filter((value): value is string => value !== undefined);
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
