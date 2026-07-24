export const PROJECT_SCOPED_RETENTION_MAX_CANDIDATES = 20;

export enum ProjectScopedRetentionDecision {
  Eligible = "eligible",
  Removed = "removed",
  AlreadyRemoved = "already_removed",
  DeniedForeign = "denied_foreign",
  DeniedJobRoot = "denied_job_root",
  DeniedSharedCache = "denied_shared_cache",
  DeniedLiveWorker = "denied_live_worker",
  DeniedUnfinishedOperation = "denied_unfinished_operation",
  DeniedTerminalEvidence = "denied_terminal_evidence",
  DeniedRepositoryIdentity = "denied_repository_identity",
  DeniedWorktreeRegistration = "denied_worktree_registration",
  DeniedWorkspacePathChanged = "denied_workspace_path_changed",
  DeniedDirty = "denied_dirty",
  DeniedUnresolvedIndex = "denied_unresolved_index",
  DeniedNonAncestor = "denied_non_ancestor",
  DeniedAmbiguous = "denied_ambiguous",
  RemovalFailed = "removal_failed",
  PostVerificationFailed = "post_verification_failed",
}

export type ProjectScopedRetentionInspection = {
  readonly candidateId: string;
  readonly workspacePath?: string;
  readonly ownedByController: boolean | undefined;
  readonly childWorkspace: boolean | undefined;
  readonly jobRoot: boolean | undefined;
  readonly sharedDependencyCache: boolean | undefined;
  readonly workerAlive: boolean | undefined;
  readonly unfinishedProjectOperation: boolean | undefined;
  readonly terminalEvidence:
    | "consumed"
    | "reviewed"
    | "failed_no_output"
    | undefined;
  readonly repositoryIdentityMatches: boolean | undefined;
  readonly exactRegisteredLinkedWorktree: boolean | undefined;
  readonly pathExists: boolean | undefined;
  readonly indexClean: boolean | undefined;
  readonly worktreeClean: boolean | undefined;
  readonly untrackedClean: boolean | undefined;
  readonly unresolvedIndex: boolean | undefined;
  readonly headAncestorOfAcceptedCommit: boolean | undefined;
};

export type ProjectScopedRetentionAuditRecord = {
  readonly schemaVersion: 1;
  readonly operation: "project_scoped_retention";
  readonly controllerId: string;
  readonly projectId: string;
  readonly candidateId: string;
  readonly acceptedCanonicalCommit: string;
  readonly confirmed: boolean;
  readonly decision: ProjectScopedRetentionDecision;
  readonly workspacePath?: string;
  readonly occurredAt: string;
  readonly detail?: string;
};

export type ProjectScopedRetentionPorts = {
  readonly inspect: (input: {
    readonly controllerId: string;
    readonly projectId: string;
    readonly candidateId: string;
    readonly acceptedCanonicalCommit: string;
  }) => Promise<ProjectScopedRetentionInspection>;
  readonly withExclusiveProjectRetentionLock: <T>(
    input: {
      readonly controllerId: string;
      readonly projectId: string;
      readonly effect: () => Promise<T>;
    },
  ) => Promise<T>;
  readonly withExclusiveWorkspaceLock: <T>(
    input: {
      readonly controllerId: string;
      readonly candidateId: string;
      readonly workspacePath: string;
      readonly effect: () => Promise<T>;
    },
  ) => Promise<T>;
  readonly removeRegisteredWorktree: (input: {
    readonly candidateId: string;
    readonly workspacePath: string;
    readonly force: false;
  }) => Promise<void>;
  readonly appendAudit: (
    record: ProjectScopedRetentionAuditRecord,
  ) => Promise<void>;
  readonly now?: () => Date;
};

export type ProjectScopedRetentionInput = {
  readonly controllerId: string;
  readonly projectId: string;
  readonly candidateIds: readonly string[];
  readonly acceptedCanonicalCommit: string;
  readonly confirm?: boolean;
  readonly maxCount?: number;
};

export type ProjectScopedRetentionCandidateResult = {
  readonly candidateId: string;
  readonly decision: ProjectScopedRetentionDecision;
  readonly workspacePath?: string;
  readonly detail?: string;
};

export type ProjectScopedRetentionResult = {
  readonly mode: "preview" | "confirmed";
  readonly controllerId: string;
  readonly projectId: string;
  readonly acceptedCanonicalCommit: string;
  readonly results: readonly ProjectScopedRetentionCandidateResult[];
};

export class ProjectScopedRetention {
  constructor(private readonly ports: ProjectScopedRetentionPorts) {}

  async execute(
    input: ProjectScopedRetentionInput,
  ): Promise<ProjectScopedRetentionResult> {
    const normalized = normalizeInput(input);
    const run = () => this.evaluateCandidates(normalized);
    const results = normalized.confirm
      ? await this.ports.withExclusiveProjectRetentionLock({
          controllerId: normalized.controllerId,
          projectId: normalized.projectId,
          effect: run,
        })
      : await run();
    return {
      mode: normalized.confirm ? "confirmed" : "preview",
      controllerId: normalized.controllerId,
      projectId: normalized.projectId,
      acceptedCanonicalCommit: normalized.acceptedCanonicalCommit,
      results,
    };
  }

  private async evaluateCandidates(
    input: NormalizedRetentionInput,
  ): Promise<readonly ProjectScopedRetentionCandidateResult[]> {
    const results: ProjectScopedRetentionCandidateResult[] = [];
    for (const candidateId of input.candidateIds) {
      const result = input.confirm
        ? await this.confirmCandidate(input, candidateId)
        : await this.previewCandidate(input, candidateId);
      results.push(result);
    }
    return results;
  }

  private async previewCandidate(
    input: NormalizedRetentionInput,
    candidateId: string,
  ): Promise<ProjectScopedRetentionCandidateResult> {
    const inspection = await this.safeInspect(input, candidateId);
    const result = decideInspection(inspection);
    await this.audit(input, result);
    return result;
  }

  private async confirmCandidate(
    input: NormalizedRetentionInput,
    candidateId: string,
  ): Promise<ProjectScopedRetentionCandidateResult> {
    const initial = await this.safeInspect(input, candidateId);
    const initialDecision = decideInspection(initial);
    if (
      initialDecision.decision !== ProjectScopedRetentionDecision.Eligible
    ) {
      await this.audit(input, initialDecision);
      return initialDecision;
    }
    const workspacePath = initialDecision.workspacePath!;
    return this.ports.withExclusiveWorkspaceLock({
      controllerId: input.controllerId,
      candidateId,
      workspacePath,
      effect: async () => {
        const locked = await this.safeInspect(input, candidateId);
        if (locked.workspacePath !== workspacePath) {
          const changed = result(
            candidateId,
            ProjectScopedRetentionDecision.DeniedWorkspacePathChanged,
            locked.workspacePath,
            "workspace_path_changed_while_locking",
          );
          await this.audit(input, changed);
          return changed;
        }
        const lockedDecision = decideInspection(locked);
        if (
          lockedDecision.decision !== ProjectScopedRetentionDecision.Eligible
        ) {
          await this.audit(input, lockedDecision);
          return lockedDecision;
        }
        await this.audit(input, {
          ...lockedDecision,
          detail: "authorized_before_remove",
        });
        try {
          await this.ports.removeRegisteredWorktree({
            candidateId,
            workspacePath: lockedDecision.workspacePath!,
            force: false,
          });
        } catch (error) {
          const failed = result(
            candidateId,
            ProjectScopedRetentionDecision.RemovalFailed,
            lockedDecision.workspacePath,
            safeError(error),
          );
          await this.audit(input, failed);
          return failed;
        }
        const verified = await this.safeInspect(input, candidateId);
        const removed = verified.ownedByController === true &&
            verified.pathExists === false &&
            verified.exactRegisteredLinkedWorktree === false
          ? result(
              candidateId,
              ProjectScopedRetentionDecision.Removed,
              lockedDecision.workspacePath,
            )
          : result(
              candidateId,
              ProjectScopedRetentionDecision.PostVerificationFailed,
              lockedDecision.workspacePath,
            );
        await this.audit(input, removed);
        return removed;
      },
    });
  }

  private async safeInspect(
    input: NormalizedRetentionInput,
    candidateId: string,
  ): Promise<ProjectScopedRetentionInspection> {
    try {
      const inspected = await this.ports.inspect({
        controllerId: input.controllerId,
        projectId: input.projectId,
        candidateId,
        acceptedCanonicalCommit: input.acceptedCanonicalCommit,
      });
      if (inspected.candidateId !== candidateId) {
        throw new Error("candidate_identity_mismatch");
      }
      return inspected;
    } catch {
      return {
        candidateId,
        ownedByController: undefined,
        childWorkspace: undefined,
        jobRoot: undefined,
        sharedDependencyCache: undefined,
        workerAlive: undefined,
        unfinishedProjectOperation: undefined,
        terminalEvidence: undefined,
        repositoryIdentityMatches: undefined,
        exactRegisteredLinkedWorktree: undefined,
        pathExists: undefined,
        indexClean: undefined,
        worktreeClean: undefined,
        untrackedClean: undefined,
        unresolvedIndex: undefined,
        headAncestorOfAcceptedCommit: undefined,
      };
    }
  }

  private async audit(
    input: NormalizedRetentionInput,
    candidate: ProjectScopedRetentionCandidateResult,
  ): Promise<void> {
    await this.ports.appendAudit({
      schemaVersion: 1,
      operation: "project_scoped_retention",
      controllerId: input.controllerId,
      projectId: input.projectId,
      candidateId: candidate.candidateId,
      acceptedCanonicalCommit: input.acceptedCanonicalCommit,
      confirmed: input.confirm,
      decision: candidate.decision,
      ...(candidate.workspacePath
        ? { workspacePath: candidate.workspacePath }
        : {}),
      occurredAt: (this.ports.now?.() ?? new Date()).toISOString(),
      ...(candidate.detail ? { detail: candidate.detail } : {}),
    });
  }
}

type NormalizedRetentionInput = {
  readonly controllerId: string;
  readonly projectId: string;
  readonly candidateIds: readonly string[];
  readonly acceptedCanonicalCommit: string;
  readonly confirm: boolean;
};

function normalizeInput(
  input: ProjectScopedRetentionInput,
): NormalizedRetentionInput {
  const controllerId = requiredId(input.controllerId, "controllerId");
  const projectId = requiredId(input.projectId, "projectId");
  if (!/^[0-9a-f]{40}$/i.test(input.acceptedCanonicalCommit)) {
    throw new Error("project_retention_accepted_commit_invalid");
  }
  const maxCount = input.maxCount ?? PROJECT_SCOPED_RETENTION_MAX_CANDIDATES;
  if (
    !Number.isSafeInteger(maxCount) ||
    maxCount < 1 ||
    maxCount > PROJECT_SCOPED_RETENTION_MAX_CANDIDATES
  ) {
    throw new Error("project_retention_max_count_invalid");
  }
  if (
    input.candidateIds.length < 1 ||
    input.candidateIds.length > maxCount
  ) {
    throw new Error("project_retention_candidate_count_invalid");
  }
  const candidateIds = input.candidateIds.map((id) =>
    requiredId(id, "candidateId")
  );
  if (new Set(candidateIds).size !== candidateIds.length) {
    throw new Error("project_retention_candidate_ids_not_exact");
  }
  return {
    controllerId,
    projectId,
    candidateIds,
    acceptedCanonicalCommit: input.acceptedCanonicalCommit.toLowerCase(),
    confirm: input.confirm === true,
  };
}

function decideInspection(
  inspection: ProjectScopedRetentionInspection,
): ProjectScopedRetentionCandidateResult {
  const candidateId = inspection.candidateId;
  const workspacePath = inspection.workspacePath;
  if (inspection.ownedByController !== true || inspection.childWorkspace !== true) {
    return result(candidateId, inspection.ownedByController === false
      ? ProjectScopedRetentionDecision.DeniedForeign
      : ProjectScopedRetentionDecision.DeniedAmbiguous, workspacePath);
  }
  if (
    inspection.pathExists === false &&
    inspection.exactRegisteredLinkedWorktree === false
  ) {
    return result(
      candidateId,
      ProjectScopedRetentionDecision.AlreadyRemoved,
      workspacePath,
    );
  }
  if (inspection.jobRoot !== false) {
    return result(candidateId, inspection.jobRoot === true
      ? ProjectScopedRetentionDecision.DeniedJobRoot
      : ProjectScopedRetentionDecision.DeniedAmbiguous, workspacePath);
  }
  if (inspection.sharedDependencyCache !== false) {
    return result(candidateId, inspection.sharedDependencyCache === true
      ? ProjectScopedRetentionDecision.DeniedSharedCache
      : ProjectScopedRetentionDecision.DeniedAmbiguous, workspacePath);
  }
  if (inspection.workerAlive !== false) {
    return result(candidateId, inspection.workerAlive === true
      ? ProjectScopedRetentionDecision.DeniedLiveWorker
      : ProjectScopedRetentionDecision.DeniedAmbiguous, workspacePath);
  }
  if (inspection.unfinishedProjectOperation !== false) {
    return result(candidateId, inspection.unfinishedProjectOperation === true
      ? ProjectScopedRetentionDecision.DeniedUnfinishedOperation
      : ProjectScopedRetentionDecision.DeniedAmbiguous, workspacePath);
  }
  if (!inspection.terminalEvidence) {
    return result(
      candidateId,
      ProjectScopedRetentionDecision.DeniedTerminalEvidence,
      workspacePath,
    );
  }
  if (inspection.repositoryIdentityMatches !== true) {
    return result(candidateId, inspection.repositoryIdentityMatches === false
      ? ProjectScopedRetentionDecision.DeniedRepositoryIdentity
      : ProjectScopedRetentionDecision.DeniedAmbiguous, workspacePath);
  }
  if (
    inspection.pathExists !== true ||
    inspection.exactRegisteredLinkedWorktree !== true ||
    !workspacePath
  ) {
    return result(candidateId, inspection.exactRegisteredLinkedWorktree === false
      ? ProjectScopedRetentionDecision.DeniedWorktreeRegistration
      : ProjectScopedRetentionDecision.DeniedAmbiguous, workspacePath);
  }
  if (inspection.unresolvedIndex !== false) {
    return result(candidateId, inspection.unresolvedIndex === true
      ? ProjectScopedRetentionDecision.DeniedUnresolvedIndex
      : ProjectScopedRetentionDecision.DeniedAmbiguous, workspacePath);
  }
  if (
    inspection.indexClean !== true ||
    inspection.worktreeClean !== true ||
    inspection.untrackedClean !== true
  ) {
    const knownDirty = inspection.indexClean === false ||
      inspection.worktreeClean === false ||
      inspection.untrackedClean === false;
    return result(candidateId, knownDirty
      ? ProjectScopedRetentionDecision.DeniedDirty
      : ProjectScopedRetentionDecision.DeniedAmbiguous, workspacePath);
  }
  if (inspection.headAncestorOfAcceptedCommit !== true) {
    return result(candidateId, inspection.headAncestorOfAcceptedCommit === false
      ? ProjectScopedRetentionDecision.DeniedNonAncestor
      : ProjectScopedRetentionDecision.DeniedAmbiguous, workspacePath);
  }
  return result(
    candidateId,
    ProjectScopedRetentionDecision.Eligible,
    workspacePath,
  );
}

function result(
  candidateId: string,
  decision: ProjectScopedRetentionDecision,
  workspacePath?: string,
  detail?: string,
): ProjectScopedRetentionCandidateResult {
  return {
    candidateId,
    decision,
    ...(workspacePath ? { workspacePath } : {}),
    ...(detail ? { detail } : {}),
  };
}

function requiredId(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 200 || /[\u0000\r\n]/.test(normalized)) {
    throw new Error(`project_retention_${field}_invalid`);
  }
  return normalized;
}

function safeError(error: unknown): string {
  return error instanceof Error
    ? error.message.slice(0, 256)
    : "project_retention_remove_failed";
}
