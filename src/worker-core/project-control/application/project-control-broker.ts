import {
  AccessDecisionReason,
  ProjectOperation,
  createAccessPolicyService,
  type AccessPolicyContext,
  type AccessPolicyService,
  type PolicyDecision,
  type ProjectGitAccessRequest,
  type ProjectJobAccessRequest,
  type ProjectWorktreeAccessRequest,
} from "../../access-control";
import {
  ProjectAdmissionDecisionReason,
  ProjectAdmissionDecisionStatus,
  normalizeProjectAdmissionWorkerRole,
  type ProjectAdmissionDecision,
  type ProjectAdmissionGate,
  type ProjectAdmissionWorkerRole,
} from "../domain/project-admission";

export enum ProjectControlAuditEventType {
  DecisionRecorded = "project_control.decision_recorded",
  AdmissionDecisionRecorded = "project_control.admission_decision_recorded",
}

export type ProjectControlOperationResult = {
  readonly status: "applied" | "noop";
  readonly safeMessage?: string;
  readonly resourceId?: string;
};

export type ProjectControlCreateJobInput = ProjectJobAccessRequest & {
  readonly promptPath?: string;
  readonly accounts?: readonly string[];
  readonly workerRole?: ProjectAdmissionWorkerRole | `${ProjectAdmissionWorkerRole}`;
  readonly tags?: readonly string[];
};

export type ProjectControlWriteReviewMarkerInput = ProjectJobAccessRequest & {
  readonly markerType: "review" | "stop" | "maintenance_pause" | "handoff";
  readonly note?: string;
};

export type ProjectControlAdmissionMetadata = {
  readonly jobId?: string;
  readonly workerRole?: ProjectAdmissionWorkerRole | `${ProjectAdmissionWorkerRole}`;
  readonly tags?: readonly string[];
};

export type ProjectControlCreateWorktreeInput =
  ProjectWorktreeAccessRequest & ProjectControlAdmissionMetadata;

export type ProjectResolvedWorktreeSource = {
  readonly revision: string;
  readonly sourceRealPath: string;
};

export type ProjectControlStartWorkerInput =
  ProjectJobAccessRequest & ProjectControlAdmissionMetadata & {
    readonly accounts?: readonly string[];
  };

export type ProjectControlPolicyBrokerEvent = {
  readonly schemaVersion: 1;
  readonly type: ProjectControlAuditEventType.DecisionRecorded;
  readonly occurredAt: string;
  readonly operation: ProjectOperation;
  readonly decision: PolicyDecision;
};

export type ProjectControlAdmissionBrokerEvent = {
  readonly schemaVersion: 1;
  readonly type: ProjectControlAuditEventType.AdmissionDecisionRecorded;
  readonly occurredAt: string;
  readonly operation: ProjectOperation;
  readonly decision: ProjectAdmissionDecision;
};

export type ProjectControlBrokerEvent =
  | ProjectControlPolicyBrokerEvent
  | ProjectControlAdmissionBrokerEvent;

export interface ProjectControlAuditPort {
  record(event: ProjectControlBrokerEvent): Promise<void> | void;
}

export interface ProjectJobRegistryPort {
  createJob(input: ProjectControlCreateJobInput): Promise<ProjectControlOperationResult>;
  writeReviewMarker(
    input: ProjectControlWriteReviewMarkerInput,
  ): Promise<ProjectControlOperationResult>;
}

export interface ProjectWorkerSupervisorPort {
  startWorker(input: ProjectControlStartWorkerInput): Promise<ProjectControlOperationResult>;
  stopWorker(input: ProjectJobAccessRequest): Promise<ProjectControlOperationResult>;
}

export interface ProjectWorkspacePort {
  resolveRevision?(
    input: ProjectControlCreateWorktreeInput,
  ): Promise<ProjectResolvedWorktreeSource>;
  createWorktree(
    input: ProjectControlCreateWorktreeInput,
  ): Promise<ProjectControlOperationResult>;
}

export interface ProjectGitPort {
  integrateCommit(input: ProjectGitAccessRequest): Promise<ProjectControlOperationResult>;
  pushBranch(input: ProjectGitAccessRequest): Promise<ProjectControlOperationResult>;
}

export type ProjectControlBrokerPorts = {
  readonly registry: ProjectJobRegistryPort;
  readonly supervisor: ProjectWorkerSupervisorPort;
  readonly workspace: ProjectWorkspacePort;
  readonly git: ProjectGitPort;
  readonly admission?: ProjectAdmissionGate;
  readonly audit?: ProjectControlAuditPort;
  readonly clock?: { now(): Date };
};

export class ProjectControlDeniedError extends Error {
  readonly decision: PolicyDecision;

  constructor(decision: PolicyDecision) {
    super(`project_control_denied:${decision.reason}`);
    this.name = "ProjectControlDeniedError";
    this.decision = decision;
  }
}

export class ProjectControlAdmissionDeniedError extends Error {
  readonly decision: ProjectAdmissionDecision;

  constructor(decision: ProjectAdmissionDecision) {
    super(`project_control_admission_denied:${decision.reason}`);
    this.name = "ProjectControlAdmissionDeniedError";
    this.decision = decision;
  }
}

export class ProjectControlBroker {
  private readonly policy: AccessPolicyService;
  private readonly clock: { now(): Date };

  constructor(
    context: AccessPolicyContext | AccessPolicyService,
    private readonly ports: ProjectControlBrokerPorts,
  ) {
    this.policy = isPolicyService(context)
      ? context
      : createAccessPolicyService(context);
    this.clock = ports.clock ?? { now: () => new Date() };
  }

  async createJob(
    input: ProjectControlCreateJobInput,
  ): Promise<ProjectControlOperationResult> {
    await this.authorize(this.policy.canCreateJob(input));
    for (const accountId of input.accounts ?? []) {
      await this.authorize(this.policy.canUseAccount({ accountId }));
    }
    await this.admit(ProjectOperation.CreateJob, input);
    return this.ports.registry.createJob(input);
  }

  async startWorker(
    input: ProjectControlStartWorkerInput,
  ): Promise<ProjectControlOperationResult> {
    await this.authorize(this.policy.canStartWorker(input));
    for (const accountId of input.accounts ?? []) {
      await this.authorize(this.policy.canUseAccount({ accountId }));
    }
    await this.admit(ProjectOperation.StartWorker, input);
    return this.ports.supervisor.startWorker(input);
  }

  async stopWorker(
    input: ProjectJobAccessRequest,
  ): Promise<ProjectControlOperationResult> {
    await this.authorize(this.policy.canStopWorker(input));
    return this.ports.supervisor.stopWorker(input);
  }

  async createWorktree(
    input: ProjectControlCreateWorktreeInput,
  ): Promise<ProjectControlOperationResult> {
    await this.authorize(this.policy.canCreateWorktree(input));
    await this.admit(ProjectOperation.CreateWorktree, {
      ...(input.jobId ? { jobId: input.jobId } : {}),
      workspacePath: input.path,
      ...(input.workerRole ? { workerRole: input.workerRole } : {}),
      ...(input.tags ? { tags: input.tags } : {}),
    });
    return this.ports.workspace.createWorktree(input);
  }

  async resolveWorktreeRevision(
    input: ProjectControlCreateWorktreeInput,
  ): Promise<ProjectResolvedWorktreeSource> {
    await this.authorize(this.policy.canCreateWorktree(input));
    if (!this.ports.workspace.resolveRevision) {
      throw new Error("project_control_worktree_revision_resolver_unavailable");
    }
    return this.ports.workspace.resolveRevision(input);
  }

  async writeReviewMarker(
    input: ProjectControlWriteReviewMarkerInput,
  ): Promise<ProjectControlOperationResult> {
    await this.authorize(this.policy.canWriteReviewMarker(input));
    return this.ports.registry.writeReviewMarker(input);
  }

  async integrateCommit(
    input: ProjectGitAccessRequest,
  ): Promise<ProjectControlOperationResult> {
    await this.authorize(this.policy.canIntegrateCommit(input));
    return this.ports.git.integrateCommit(input);
  }

  async pushBranch(
    input: ProjectGitAccessRequest,
  ): Promise<ProjectControlOperationResult> {
    await this.authorize(this.policy.canPushBranch(input));
    return this.ports.git.pushBranch(input);
  }

  private async authorize(decision: PolicyDecision): Promise<void> {
    await this.ports.audit?.record({
      schemaVersion: 1,
      type: ProjectControlAuditEventType.DecisionRecorded,
      occurredAt: this.clock.now().toISOString(),
      operation: decision.operation,
      decision,
    });
    if (!decision.allowed) throw new ProjectControlDeniedError(decision);
  }

  private async admit(
    operation: ProjectOperation.CreateJob | ProjectOperation.StartWorker | ProjectOperation.CreateWorktree,
    input: ProjectControlAdmissionMetadata & {
      readonly jobId?: string;
      readonly workspacePath?: string;
    },
  ): Promise<void> {
    const request = {
      operation,
      ...(input.jobId ? { jobId: input.jobId } : {}),
      ...(input.workspacePath ? { workspacePath: input.workspacePath } : {}),
      ...(input.workerRole ? { workerRole: input.workerRole } : {}),
      ...(input.tags ? { tags: input.tags } : {}),
    };
    const decision = this.ports.admission
      ? await this.ports.admission.evaluate(request)
      : missingAdmissionDecision(request);
    await this.ports.audit?.record({
      schemaVersion: 1,
      type: ProjectControlAuditEventType.AdmissionDecisionRecorded,
      occurredAt: this.clock.now().toISOString(),
      operation,
      decision,
    });
    if (!decision.allowed) {
      throw new ProjectControlAdmissionDeniedError(decision);
    }
  }
}

export function projectControlDeniedReason(error: unknown): AccessDecisionReason | null {
  return error instanceof ProjectControlDeniedError
    ? error.decision.reason
    : null;
}

export function projectControlAdmissionDeniedReason(
  error: unknown,
): ProjectAdmissionDecisionReason | null {
  return error instanceof ProjectControlAdmissionDeniedError
    ? error.decision.reason
    : null;
}

function missingAdmissionDecision(input: {
  readonly operation: ProjectOperation;
  readonly jobId?: string;
  readonly workspacePath?: string;
  readonly workerRole?: ProjectAdmissionWorkerRole | `${ProjectAdmissionWorkerRole}`;
  readonly tags?: readonly string[];
}): ProjectAdmissionDecision {
  return {
    operation: input.operation,
    workerRole: normalizeProjectAdmissionWorkerRole(input.workerRole, input.tags),
    status: ProjectAdmissionDecisionStatus.Denied,
    allowed: false,
    reason: ProjectAdmissionDecisionReason.SnapshotUnavailable,
    evidence: ["project admission gate is not configured"],
    debt: [],
  };
}

function isPolicyService(value: unknown): value is AccessPolicyService {
  return Boolean(
    value &&
      typeof value === "object" &&
      "canCreateJob" in value &&
      "canStartWorker" in value &&
      "canPushBranch" in value,
  );
}
