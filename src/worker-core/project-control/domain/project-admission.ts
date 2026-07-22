import { ProjectOperation } from "../../access-control";

/**
 * Caller-supplied admission lane used for safety gating and audit.
 *
 * These names describe the intent of the requested operation. They are not
 * scheduler policy, desired worker mix or project strategy owned by the runtime.
 */
export enum ProjectAdmissionWorkerRole {
  Producer = "producer",
  Fastgate = "fastgate",
  Reviewer = "reviewer",
  Integration = "integration",
  Adoption = "adoption",
  ReadOnly = "read_only",
}

export enum ProjectAdmissionDecisionStatus {
  Allowed = "allowed",
  Denied = "denied",
  AllowedForDrainOnly = "allowed_for_drain_only",
}

export enum ProjectAdmissionDecisionReason {
  Allowed = "allowed",
  OutputDebtPresent = "output_debt_present",
  SnapshotUnavailable = "snapshot_unavailable",
  SnapshotStale = "snapshot_stale",
  UnreadableProjectState = "unreadable_project_state",
  DiskPressure = "disk_pressure",
}

export enum ProjectDebtReason {
  InactiveDirtyWorkspace = "inactive_dirty_workspace",
  UnconsumedCompletedJob = "unconsumed_completed_job",
  OrphanLegacyWorkspace = "orphan_legacy_workspace",
  ConsumedDirtyWorkspace = "consumed_dirty_workspace",
  IncompleteConsumedOutputRecord = "incomplete_consumed_output_record",
  LegacyOutputQuarantineRequired = "legacy_output_quarantine_required",
  ActiveWriterConflict = "active_writer_conflict",
  StaleDirtyWorker = "stale_dirty_worker",
  UnreadableRoot = "unreadable_root",
  UnreadableWorkspace = "unreadable_workspace",
  SnapshotStale = "snapshot_stale",
  DiskPressure = "disk_pressure",
}

export type ProjectDebtItem = {
  readonly reason: ProjectDebtReason;
  readonly subject: string;
  readonly evidence: readonly string[];
  readonly affectedPaths?: readonly string[];
  /**
   * Runtime proof that this is one healthy live producer whose complete
   * declared ownership is available in `affectedPaths`. Unsafe/unknown writer
   * debt deliberately omits this marker and therefore remains fail-closed.
   */
  readonly pathDisjointProducerEligible?: true;
  readonly severity?: "info" | "warning" | "blocking";
};

export type ProjectAdmissionSnapshot = {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly observedAt: string;
  readonly stale?: boolean;
  readonly unavailable?: boolean;
  readonly debt: readonly ProjectDebtItem[];
  readonly counts?: {
    readonly inactiveDirtyWorkspaces?: number;
    readonly unconsumedCompletedJobs?: number;
    readonly orphanLegacyWorkspaces?: number;
    readonly consumedDirtyWorkspaces?: number;
    readonly incompleteConsumedOutputRecords?: number;
    readonly legacyOutputQuarantineRequired?: number;
    readonly activeWriterConflicts?: number;
    readonly staleDirtyWorkers?: number;
    readonly unreadableRoots?: number;
    readonly unreadableWorkspaces?: number;
    readonly diskPressure?: number;
  };
};

export type ProjectAdmissionDebtSummary = {
  readonly unreadableProjectState: readonly ProjectDebtItem[];
  readonly staleSnapshot: readonly ProjectDebtItem[];
  readonly diskPressure: readonly ProjectDebtItem[];
  readonly blockingAdmissionDebt: readonly ProjectDebtItem[];
  readonly counts: NonNullable<ProjectAdmissionSnapshot["counts"]>;
};

export type ProjectAdmissionRequest = {
  readonly projectId?: string;
  readonly operation: ProjectOperation;
  readonly jobId?: string;
  readonly workspacePath?: string;
  readonly workerRole?: ProjectAdmissionWorkerRole | `${ProjectAdmissionWorkerRole}`;
  readonly tags?: readonly string[];
  readonly ownedPaths?: readonly string[];
};

export type ProjectAdmissionDecision = {
  readonly status: ProjectAdmissionDecisionStatus;
  readonly allowed: boolean;
  readonly operation: ProjectOperation;
  readonly reason: ProjectAdmissionDecisionReason;
  readonly projectId?: string;
  readonly workerRole: ProjectAdmissionWorkerRole;
  readonly evidence: readonly string[];
  readonly debt: readonly ProjectDebtItem[];
};

export interface ProjectAdmissionGate {
  evaluate(
    request: ProjectAdmissionRequest,
  ): Promise<ProjectAdmissionDecision> | ProjectAdmissionDecision;
}

export function evaluateProjectAdmission(input: {
  readonly request: ProjectAdmissionRequest;
  readonly snapshot?: ProjectAdmissionSnapshot;
}): ProjectAdmissionDecision {
  const workerRole = normalizeProjectAdmissionWorkerRole(
    input.request.workerRole,
    input.request.tags,
  );
  const base = {
    operation: input.request.operation,
    ...(input.request.projectId === undefined
      ? {}
      : { projectId: input.request.projectId }),
    workerRole,
  };
  const snapshot = input.snapshot;
  if (!snapshot || snapshot.unavailable) {
    return denied({
      ...base,
      reason: ProjectAdmissionDecisionReason.SnapshotUnavailable,
      evidence: ["project admission snapshot is unavailable"],
      debt: [],
    });
  }
  const debtSummary = summarizeProjectAdmissionDebt(snapshot.debt);
  if (debtSummary.unreadableProjectState.length > 0) {
    return denied({
      ...base,
      reason: ProjectAdmissionDecisionReason.UnreadableProjectState,
      evidence: debtSummary.unreadableProjectState.flatMap((item) => item.evidence),
      debt: debtSummary.unreadableProjectState,
    });
  }
  if (snapshot.stale || debtSummary.staleSnapshot.length > 0) {
    return denied({
      ...base,
      reason: ProjectAdmissionDecisionReason.SnapshotStale,
      evidence: debtSummary.staleSnapshot.length > 0
        ? debtSummary.staleSnapshot.flatMap((item) => item.evidence)
        : ["project admission snapshot is stale"],
      debt: debtSummary.staleSnapshot,
    });
  }
  if (debtSummary.diskPressure.length > 0) {
    return denied({
      ...base,
      reason: ProjectAdmissionDecisionReason.DiskPressure,
      evidence: debtSummary.diskPressure.flatMap((item) => item.evidence),
      debt: debtSummary.diskPressure,
    });
  }
  const requestOwnedPaths = input.request.ownedPaths;
  const blockingAdmissionDebt = producerBlockingAdmissionDebt({
    workerRole,
    ...(requestOwnedPaths ? { ownedPaths: requestOwnedPaths } : {}),
    debt: debtSummary.blockingAdmissionDebt,
  });
  if (blockingAdmissionDebt.length === 0) {
    return {
      ...base,
      status: ProjectAdmissionDecisionStatus.Allowed,
      allowed: true,
      reason: ProjectAdmissionDecisionReason.Allowed,
      evidence: debtSummary.blockingAdmissionDebt.length === 0
        ? ["project admission snapshot has no blocking debt"]
        : ["producer owned paths are disjoint from all unconsumed completed output"],
      debt: [],
    };
  }
  if (isDrainWorkerRole(workerRole)) {
    return {
      ...base,
      status: ProjectAdmissionDecisionStatus.AllowedForDrainOnly,
      allowed: true,
      reason: ProjectAdmissionDecisionReason.OutputDebtPresent,
      evidence: ["project output debt exists; only drain/review roles are admitted"],
      debt: blockingAdmissionDebt,
    };
  }
  return denied({
    ...base,
    reason: ProjectAdmissionDecisionReason.OutputDebtPresent,
    evidence: ["project output debt blocks producer work"],
    debt: blockingAdmissionDebt,
  });
}

function producerBlockingAdmissionDebt(input: {
  readonly workerRole: ProjectAdmissionWorkerRole;
  readonly ownedPaths?: readonly string[];
  readonly debt: readonly ProjectDebtItem[];
}): readonly ProjectDebtItem[] {
  const ownedPaths = input.ownedPaths;
  if (
    input.workerRole !== ProjectAdmissionWorkerRole.Producer ||
    !validAdmissionPaths(ownedPaths)
  ) {
    return input.debt;
  }
  return input.debt.filter((item) =>
    !producerDebtCanBeBypassedByDisjointPaths(item) ||
    admissionPathsOverlap(ownedPaths, item.affectedPaths)
  );
}

function producerDebtCanBeBypassedByDisjointPaths(
  item: ProjectDebtItem,
): item is ProjectDebtItem & { readonly affectedPaths: readonly string[] } {
  if (!validAdmissionPaths(item.affectedPaths)) return false;
  if (item.reason === ProjectDebtReason.UnconsumedCompletedJob) return true;
  return item.reason === ProjectDebtReason.ActiveWriterConflict &&
    item.pathDisjointProducerEligible === true;
}

function validAdmissionPaths(
  paths: readonly string[] | undefined,
): paths is readonly string[] {
  return Array.isArray(paths) && paths.length > 0 && paths.every((path) => {
    if (
      typeof path !== "string" ||
      path.length === 0 ||
      path.startsWith("/") ||
      path.includes("\\") ||
      /[\u0000-\u001f\u007f]/u.test(path)
    ) {
      return false;
    }
    const parts = path.endsWith("/")
      ? path.slice(0, -1).split("/")
      : path.split("/");
    return parts.length > 0 && parts.every(
      (part) => part.length > 0 && part !== "." && part !== "..",
    );
  });
}

function admissionPathsOverlap(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.some((leftPath) => right.some((rightPath) => {
    const leftBase = leftPath.endsWith("/") ? leftPath.slice(0, -1) : leftPath;
    const rightBase = rightPath.endsWith("/") ? rightPath.slice(0, -1) : rightPath;
    return leftBase === rightBase ||
      leftBase.startsWith(`${rightBase}/`) ||
      rightBase.startsWith(`${leftBase}/`);
  }));
}

export function summarizeProjectAdmissionDebt(
  debt: readonly ProjectDebtItem[],
): ProjectAdmissionDebtSummary {
  return {
    unreadableProjectState: debt.filter((item) =>
      item.reason === ProjectDebtReason.UnreadableRoot
    ),
    staleSnapshot: debt.filter((item) =>
      item.reason === ProjectDebtReason.SnapshotStale
    ),
    diskPressure: debt.filter((item) =>
      item.reason === ProjectDebtReason.DiskPressure
    ),
    blockingAdmissionDebt: debt.filter((item) => item.severity !== "info"),
    counts: projectAdmissionDebtCounts(debt),
  };
}

export function normalizeProjectAdmissionWorkerRole(
  value?: ProjectAdmissionRequest["workerRole"],
  tags: readonly string[] = [],
): ProjectAdmissionWorkerRole {
  if (value && isProjectAdmissionWorkerRole(value)) return value;
  const tagRole = tags
    .map((tag) => tag.trim())
    .find((tag) => tag.startsWith("worker-role-"))
    ?.replace(/^worker-role-/, "");
  if (tagRole && isProjectAdmissionWorkerRole(tagRole)) return tagRole;
  return ProjectAdmissionWorkerRole.Producer;
}

export function isDrainWorkerRole(role: ProjectAdmissionWorkerRole): boolean {
  return role === ProjectAdmissionWorkerRole.Fastgate ||
    role === ProjectAdmissionWorkerRole.Reviewer ||
    role === ProjectAdmissionWorkerRole.Integration ||
    role === ProjectAdmissionWorkerRole.Adoption ||
    role === ProjectAdmissionWorkerRole.ReadOnly;
}

function isProjectAdmissionWorkerRole(
  value: string,
): value is ProjectAdmissionWorkerRole {
  return (Object.values(ProjectAdmissionWorkerRole) as readonly string[])
    .includes(value);
}

function denied(input: Omit<ProjectAdmissionDecision, "status" | "allowed">): ProjectAdmissionDecision {
  return {
    ...input,
    status: ProjectAdmissionDecisionStatus.Denied,
    allowed: false,
  };
}

function projectAdmissionDebtCounts(
  debt: readonly ProjectDebtItem[],
): NonNullable<ProjectAdmissionSnapshot["counts"]> {
  const count = (reason: ProjectDebtReason) =>
    debt.filter((item) => item.reason === reason).length;
  return {
    inactiveDirtyWorkspaces: count(ProjectDebtReason.InactiveDirtyWorkspace),
    unconsumedCompletedJobs: count(ProjectDebtReason.UnconsumedCompletedJob),
    orphanLegacyWorkspaces: count(ProjectDebtReason.OrphanLegacyWorkspace),
    consumedDirtyWorkspaces: count(ProjectDebtReason.ConsumedDirtyWorkspace),
    incompleteConsumedOutputRecords: count(ProjectDebtReason.IncompleteConsumedOutputRecord),
    legacyOutputQuarantineRequired: count(
      ProjectDebtReason.LegacyOutputQuarantineRequired,
    ),
    activeWriterConflicts: count(ProjectDebtReason.ActiveWriterConflict),
    staleDirtyWorkers: count(ProjectDebtReason.StaleDirtyWorker),
    unreadableRoots: count(ProjectDebtReason.UnreadableRoot),
    unreadableWorkspaces: count(ProjectDebtReason.UnreadableWorkspace),
    diskPressure: count(ProjectDebtReason.DiskPressure),
  };
}
