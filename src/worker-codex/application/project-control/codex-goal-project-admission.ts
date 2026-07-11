import { execFile } from "node:child_process";
import { lstat, readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  ProjectAdmissionWorkerRole,
  ProjectDebtReason,
  ProjectOperation,
  consumedDebt,
  consumedOutputRecordFor,
  evaluateProjectAdmission,
  projectAdmissionDebtCounts,
  type ConsumedOutputLedger,
  type ProjectAccessScope,
  type ProjectAdmissionGate,
  type ProjectAdmissionSnapshot,
  type ProjectDebtItem,
} from "@vioxen/subscription-runtime/worker-core";
import type { CodexGoalJobSummary } from "../../codex-goal-jobs";
import { stringValue } from "../codex-goal-input-values";
import { readCodexGoalConsumedOutputLedgers } from "./codex-goal-consumed-output-ledger-io";
import {
  matchesProjectControlPrefix,
  nodeErrorCode,
  stringArrayArg,
  uniqueProjectControlStrings,
} from "./codex-goal-project-utils";

type JsonObject = Readonly<Record<string, unknown>>;

const execFileAsync = promisify(execFile);

export type CodexProjectAdmissionDeps = {
  readonly listJobs: (input: {
    readonly registryRootDir: string;
  }) => Promise<readonly CodexGoalJobSummary[]>;
  readonly buildOverviewItem: (input: {
    readonly registryRootDir: string;
    readonly jobId: string;
    readonly staleAfterMs: number;
    readonly tailLines: number;
  }) => Promise<JsonObject>;
};

type CodexProjectAdmissionInput = {
  readonly registryRootDir: string;
  readonly scope: ProjectAccessScope;
  readonly deps: CodexProjectAdmissionDeps;
};

export function projectAdmissionDetailView(input: {
  readonly snapshot: ProjectAdmissionSnapshot;
  readonly decision?: ReturnType<typeof evaluateProjectAdmission>;
  readonly includeDetails: boolean;
  readonly maxDebtItems?: number;
}): {
  readonly snapshot: JsonObject;
  readonly decision?: JsonObject;
} {
  const debtLimit = projectAdmissionDebtLimit(input.maxDebtItems);
  const snapshotDebt = input.includeDetails
    ? limitedProjectDebt(input.snapshot.debt, debtLimit)
    : [];
  const decisionDebt = input.decision && input.includeDetails
    ? limitedProjectDebt(input.decision.debt, debtLimit)
    : [];
  return {
    snapshot: {
      ...input.snapshot,
      debt: snapshotDebt,
      debtCount: input.snapshot.debt.length,
      debtOmittedCount: input.snapshot.debt.length - snapshotDebt.length,
      detailsIncluded: input.includeDetails,
    } as unknown as JsonObject,
    ...(input.decision
      ? {
          decision: {
            ...input.decision,
            debt: decisionDebt,
            debtCount: input.decision.debt.length,
            debtOmittedCount: input.decision.debt.length - decisionDebt.length,
            detailsIncluded: input.includeDetails,
          } as unknown as JsonObject,
        }
      : {}),
  };
}

export function codexProjectAdmissionGate(
  input: CodexProjectAdmissionInput,
): ProjectAdmissionGate {
  return {
    async evaluate(request) {
      const snapshot = await readCodexProjectAdmissionSnapshot(input);
      return evaluateProjectAdmission({
        request: {
          ...request,
          projectId: request.projectId ?? input.scope.projectId,
        },
        snapshot,
      });
    },
  };
}

export async function readCodexProjectAdmissionSnapshot(
  input: CodexProjectAdmissionInput,
): Promise<ProjectAdmissionSnapshot> {
  const ttlMs = projectAdmissionCacheTtlMs();
  if (ttlMs <= 0) return buildCodexProjectAdmissionSnapshot(input);
  const key = projectAdmissionCacheKey(input);
  const now = Date.now();
  const cached = projectAdmissionSnapshotCache.get(key);
  if (cached && cached.expiresAtMs > now) return cached.snapshot;
  const snapshot = await buildCodexProjectAdmissionSnapshot(input);
  projectAdmissionSnapshotCache.set(key, {
    expiresAtMs: now + ttlMs,
    snapshot,
  });
  return snapshot;
}

export async function buildCodexProjectAdmissionSnapshot(
  input: CodexProjectAdmissionInput,
): Promise<ProjectAdmissionSnapshot> {
  const debt: ProjectDebtItem[] = [];
  const knownWorkspacePaths = new Set<string>();
  const prefixes = input.scope.jobIdPrefixes ?? [];
  const staleAfterMs = 10 * 60_000;
  const consumedOutput = await readCodexGoalConsumedOutputLedgers({
    roots: input.scope.consumedOutputLedgerRoots ?? [],
  });
  debt.push(...consumedOutput.debt);
  let summaries;
  try {
    summaries = await input.deps.listJobs({ registryRootDir: input.registryRootDir });
  } catch (error) {
    debt.push({
      reason: ProjectDebtReason.UnreadableRoot,
      subject: input.registryRootDir,
      severity: "blocking",
      evidence: [
        `registry unreadable: ${error instanceof Error ? error.message : String(error)}`,
      ],
    });
    summaries = [];
  }
  const projectSummaries = limitCodexProjectSummaries(
    summaries.filter((summary) => matchesProjectControlPrefix(summary.jobId, prefixes)),
  );
  const overviewSummaries: CodexGoalJobSummary[] = [];
  for (const summary of projectSummaries) {
    const consumed = await debtFromConsumedJobSummary({
      summary,
      consumedOutput,
      knownWorkspacePaths,
    });
    if (consumed) {
      debt.push(...consumed);
      continue;
    }
    overviewSummaries.push(summary);
  }
  const overviewItems = await Promise.all(
    overviewSummaries.map((summary) =>
      input.deps.buildOverviewItem({
        registryRootDir: input.registryRootDir,
        jobId: summary.jobId,
        staleAfterMs,
        tailLines: 0,
      })
    ),
  );
  for (const item of overviewItems) {
    if (typeof item.workspacePath === "string") {
      await rememberKnownWorkspacePath(knownWorkspacePaths, item.workspacePath);
    }
    debt.push(...await debtFromOverviewItem({
      item,
      consumedOutput,
    }));
  }
  const roots = uniqueProjectControlStrings([
    ...(input.scope.workspaceRoots ?? []),
    ...(input.scope.worktreeRoots ?? []),
    ...(input.scope.observedWorkspaceRoots ?? []),
  ]);
  for (const root of roots) {
    debt.push(...await orphanDirtyWorkspaceDebt({
      root,
      prefixes,
      knownWorkspacePaths,
      consumedOutput,
    }));
    debt.push(...await diskPressureDebt(root));
  }
  return {
    schemaVersion: 1,
    projectId: input.scope.projectId,
    observedAt: new Date().toISOString(),
    debt,
    counts: projectAdmissionDebtCounts(debt),
  };
}

export function projectAdmissionOperation(value: unknown): ProjectOperation | undefined {
  const operation = stringValue(value);
  if (operation === undefined) return undefined;
  if (operation === ProjectOperation.CreateJob) return ProjectOperation.CreateJob;
  if (operation === ProjectOperation.StartWorker) return ProjectOperation.StartWorker;
  if (operation === ProjectOperation.CreateWorktree) return ProjectOperation.CreateWorktree;
  throw new Error("project_admission_operation_invalid");
}

export function projectAdmissionWorkerRoleArg(
  value: unknown,
): ProjectAdmissionWorkerRole | undefined {
  const role = stringValue(value);
  if (role === undefined) return undefined;
  if ((Object.values(ProjectAdmissionWorkerRole) as readonly string[]).includes(role)) {
    return role as ProjectAdmissionWorkerRole;
  }
  throw new Error("project_admission_worker_role_invalid");
}

const projectAdmissionSnapshotCache = new Map<
  string,
  { readonly expiresAtMs: number; readonly snapshot: ProjectAdmissionSnapshot }
>();

function projectAdmissionDebtLimit(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value)) return undefined;
  return Math.max(0, Math.floor(value));
}

function limitedProjectDebt(
  debt: readonly ProjectDebtItem[],
  limit: number | undefined,
): readonly ProjectDebtItem[] {
  return limit === undefined ? debt : debt.slice(0, limit);
}

function projectAdmissionCacheTtlMs(): number {
  const raw = Number(process.env.SUBSCRIPTION_RUNTIME_PROJECT_ADMISSION_CACHE_TTL_MS ?? "0");
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(raw, 120_000);
}

function projectAdmissionMaxJobSummaries(): number {
  const raw = Number(process.env.SUBSCRIPTION_RUNTIME_PROJECT_ADMISSION_MAX_JOB_SUMMARIES ?? "0");
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.floor(raw);
}

function projectAdmissionCacheKey(input: {
  readonly registryRootDir: string;
  readonly scope: ProjectAccessScope;
}): string {
  return JSON.stringify({
    registryRootDir: input.registryRootDir,
    projectId: input.scope.projectId,
    jobIdPrefixes: input.scope.jobIdPrefixes ?? [],
    workspaceRoots: input.scope.workspaceRoots ?? [],
    worktreeRoots: input.scope.worktreeRoots ?? [],
    observedWorkspaceRoots: input.scope.observedWorkspaceRoots ?? [],
    consumedOutputLedgerRoots: input.scope.consumedOutputLedgerRoots ?? [],
  });
}

function limitCodexProjectSummaries(
  summaries: readonly CodexGoalJobSummary[],
): readonly CodexGoalJobSummary[] {
  const max = projectAdmissionMaxJobSummaries();
  if (max <= 0 || summaries.length <= max) return summaries;
  return [...summaries]
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
    .slice(-max);
}

async function debtFromConsumedJobSummary(input: {
  readonly summary: CodexGoalJobSummary;
  readonly consumedOutput: ConsumedOutputLedger;
  readonly knownWorkspacePaths: Set<string>;
}): Promise<readonly ProjectDebtItem[] | undefined> {
  // Workspace-level fallback is only safe once worker liveness is known. A live
  // verifier can intentionally share a dirty producer workspace whose output
  // was already consumed under the producer job id.
  if (!input.consumedOutput.byJobId.has(input.summary.jobId)) return undefined;
  const resolvedWorkspacePath = await optionalRealPathForAdmission(
    input.summary.workspacePath,
  );
  const consumed = consumedOutputRecordFor({
    ledger: input.consumedOutput,
    jobId: input.summary.jobId,
    workspacePath: input.summary.workspacePath,
    ...(resolvedWorkspacePath ? { resolvedWorkspacePath } : {}),
  });
  if (!consumed) return undefined;
  await rememberKnownWorkspacePath(
    input.knownWorkspacePaths,
    input.summary.workspacePath,
  );
  return consumedDebt(consumed);
}

async function debtFromOverviewItem(input: {
  readonly item: JsonObject;
  readonly consumedOutput: ConsumedOutputLedger;
}): Promise<ProjectDebtItem[]> {
  const { item } = input;
  const jobId = stringValue(item.jobId) ?? "unknown-job";
  const workspacePath = stringValue(item.workspacePath);
  if (item.ok !== true) {
    return [{
      reason: ProjectDebtReason.UnreadableRoot,
      subject: jobId,
      severity: "blocking",
      evidence: [stringValue(item.safeMessage) ?? "job overview unavailable"],
    }];
  }
  const debt: ProjectDebtItem[] = [];
  if (item.activeWriterRisk === true || item.workspaceConflict === true) {
    debt.push({
      reason: ProjectDebtReason.ActiveWriterConflict,
      subject: jobId,
      severity: "blocking",
      evidence: safeStringArray(item.activeWriterRiskReasons)
        .concat(["active writer conflict risk"]),
    });
  }
  if (item.workspaceDirty !== true) return debt;
  const subject = workspacePath ?? jobId;
  const workerAlive = item.workerAlive === true;
  const stale = item.silentStale === true || item.workerFreshProgressAlive === false;
  if (workerAlive && stale) {
    debt.push({
      reason: ProjectDebtReason.StaleDirtyWorker,
      subject,
      severity: "blocking",
      evidence: [`${jobId} is alive/stale with dirty workspace`],
    });
    return debt;
  }
  if (workerAlive) return debt;
  const resolvedWorkspacePath = workspacePath
    ? await optionalRealPathForAdmission(workspacePath)
    : undefined;
  const consumed = consumedOutputRecordFor({
    ledger: input.consumedOutput,
    jobId,
    ...(workspacePath ? { workspacePath } : {}),
    ...(resolvedWorkspacePath ? { resolvedWorkspacePath } : {}),
  });
  if (consumed) {
    debt.push(...consumedDebt(consumed));
    return debt;
  }
  const markerTypes = safeStringArray(item.lifecycleMarkerTypes);
  const recommendedAction = stringValue(item.recommendedAction);
  const resultStatus = stringValue(item.resultStatus);
  const completedOrReviewed = resultStatus === "completed" ||
    recommendedAction === "review_completed" ||
    markerTypes.includes("review");
  debt.push({
    reason: completedOrReviewed
      ? ProjectDebtReason.UnconsumedCompletedJob
      : ProjectDebtReason.InactiveDirtyWorkspace,
    subject,
    severity: "blocking",
    evidence: [
      `${jobId} is inactive with dirty workspace`,
      `reviewed marker present: ${String(markerTypes.includes("review"))}`,
      "reviewed is not consumed; output must be integrated/rejected/archived",
    ],
  });
  return debt;
}

async function rememberKnownWorkspacePath(
  target: Set<string>,
  workspacePath: string,
): Promise<void> {
  target.add(resolve(workspacePath));
  try {
    target.add(await realpath(workspacePath));
  } catch {
    // Missing workspaces are handled by overview debt; keep the raw path.
  }
}

async function orphanDirtyWorkspaceDebt(input: {
  readonly root: string;
  readonly prefixes: readonly string[];
  readonly knownWorkspacePaths: ReadonlySet<string>;
  readonly consumedOutput: ConsumedOutputLedger;
}): Promise<readonly ProjectDebtItem[]> {
  const root = resolve(input.root);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") return [];
    return [{
      reason: ProjectDebtReason.UnreadableRoot,
      subject: root,
      severity: "blocking",
      evidence: [
        `workspace root unreadable: ${error instanceof Error ? error.message : String(error)}`,
      ],
    }];
  }
  const debt: ProjectDebtItem[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (!matchesProjectControlPrefix(entry.name, input.prefixes)) continue;
    const workspacePath = join(root, entry.name);
    if (!await pathLooksLikeGitWorkspace(workspacePath)) continue;
    const resolved = await optionalRealPathForAdmission(workspacePath);
    if (
      input.knownWorkspacePaths.has(resolve(workspacePath)) ||
      (resolved && input.knownWorkspacePaths.has(resolved))
    ) {
      continue;
    }
    const consumed = consumedOutputRecordFor({
      ledger: input.consumedOutput,
      jobId: entry.name,
      workspacePath,
      ...(resolved ? { resolvedWorkspacePath: resolved } : {}),
    });
    if (consumed) {
      debt.push(...consumedDebt(consumed));
      continue;
    }
    const status = await gitStatusShort(workspacePath);
    if (status.ok && status.lines.length === 0) continue;
    debt.push({
      reason: status.ok
        ? ProjectDebtReason.OrphanLegacyWorkspace
        : ProjectDebtReason.UnreadableWorkspace,
      subject: workspacePath,
      severity: "blocking",
      evidence: status.ok
        ? [
            "dirty project workspace is not represented by the controller registry",
            ...status.lines.slice(0, 5),
          ]
        : [`git status failed: ${status.error}`],
    });
  }
  return debt;
}

async function diskPressureDebt(root: string): Promise<readonly ProjectDebtItem[]> {
  const minFreeKb = Number(process.env.SUBSCRIPTION_RUNTIME_PROJECT_ADMISSION_MIN_FREE_KB ?? "0");
  if (!Number.isFinite(minFreeKb) || minFreeKb <= 0) return [];
  try {
    const result = await execFileAsync("df", ["-Pk", root], {
      timeout: 8_000,
      maxBuffer: 256 * 1024,
    });
    const [, line] = result.stdout.trim().split(/\n/);
    const availableKb = Number(line?.trim().split(/\s+/)[3]);
    if (Number.isFinite(availableKb) && availableKb < minFreeKb) {
      return [{
        reason: ProjectDebtReason.DiskPressure,
        subject: root,
        severity: "blocking",
        evidence: [`availableKb=${availableKb} minFreeKb=${minFreeKb}`],
      }];
    }
    return [];
  } catch (error) {
    return [{
      reason: ProjectDebtReason.UnreadableRoot,
      subject: root,
      severity: "blocking",
      evidence: [
        `disk pressure check failed: ${error instanceof Error ? error.message : String(error)}`,
      ],
    }];
  }
}

async function pathLooksLikeGitWorkspace(path: string): Promise<boolean> {
  try {
    await lstat(join(path, ".git"));
    return true;
  } catch {
    return false;
  }
}

export async function optionalRealPathForAdmission(
  path: string,
): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch {
    return undefined;
  }
}

async function gitStatusShort(path: string): Promise<
  | { readonly ok: true; readonly lines: readonly string[] }
  | { readonly ok: false; readonly error: string }
> {
  try {
    const result = await execFileAsync("git", [
      "-C",
      path,
      "status",
      "--short",
      "--untracked-files=all",
    ], {
      timeout: 8_000,
      maxBuffer: 1024 * 1024,
    });
    return {
      ok: true,
      lines: result.stdout.split(/\n/).filter((line) => line.length > 0),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function safeStringArray(value: unknown): readonly string[] {
  try {
    return stringArrayArg(value);
  } catch {
    return [];
  }
}
