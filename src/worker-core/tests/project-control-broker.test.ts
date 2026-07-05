import { describe, expect, it } from "vitest";

import {
  AccessBoundary,
  AccessDecisionReason,
  ProjectControlAuditEventType,
  ProjectAdmissionDecisionReason,
  ProjectAdmissionDecisionStatus,
  ProjectAdmissionWorkerRole,
  ProjectControlBroker,
  ProjectControlAdmissionDeniedError,
  ProjectControlDeniedError,
  ProjectDebtReason,
  projectControlDeniedReason,
  type ProjectAccessScope,
  type ProjectAdmissionDecision,
  type ProjectAdmissionGate,
  type ProjectControlBrokerEvent,
  type ProjectControlBrokerPorts,
  type ProjectControlOperationResult,
} from "../index";

describe("ProjectControlBroker", () => {
  it("executes allowed project-scoped operations through ports and audits decisions", async () => {
    const calls: string[] = [];
    const audits: ProjectControlBrokerEvent[] = [];
    const broker = new ProjectControlBroker({
      boundary: AccessBoundary.ProjectScopedControl,
      scope: scope(),
    }, ports(calls, audits));

    await expect(broker.createJob({
      jobId: "infinity-context-child-v1",
      registryRoot: "/var/data/worker-jobs/registry",
      workspacePath: "/work/infinity-context-child",
      tmuxSession: "infinity-context-child-v1",
    })).resolves.toMatchObject({ status: "applied" });
    await expect(broker.pushBranch({
      branch: "main",
      remote: "origin",
    })).resolves.toMatchObject({ status: "applied" });

    expect(calls).toEqual(["createJob:infinity-context-child-v1", "push:main"]);
    expect(audits).toEqual([
      expect.objectContaining({
        type: ProjectControlAuditEventType.DecisionRecorded,
        decision: expect.objectContaining({ allowed: true }),
      }),
      expect.objectContaining({
        type: ProjectControlAuditEventType.DecisionRecorded,
        decision: expect.objectContaining({ allowed: true }),
      }),
    ]);
  });

  it("fails closed and does not call ports when a job is outside project scope", async () => {
    const calls: string[] = [];
    const audits: ProjectControlBrokerEvent[] = [];
    const broker = new ProjectControlBroker({
      boundary: AccessBoundary.ProjectScopedControl,
      scope: scope(),
    }, ports(calls, audits));

    await expect(broker.startWorker({
      jobId: "quanta-child-v1",
      tmuxSession: "quanta-child-v1",
    })).rejects.toMatchObject({
      decision: {
        allowed: false,
        reason: AccessDecisionReason.JobPrefixDenied,
      },
    });

    expect(calls).toEqual([]);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      decision: {
        allowed: false,
        reason: AccessDecisionReason.JobPrefixDenied,
      },
    });
  });

  it("fails closed when a project job requests an account outside scope", async () => {
    const calls: string[] = [];
    const audits: ProjectControlBrokerEvent[] = [];
    const broker = new ProjectControlBroker({
      boundary: AccessBoundary.ProjectScopedControl,
      scope: {
        ...scope(),
        allowedAccountIds: ["account-a"],
      },
    }, ports(calls, audits));

    await expect(broker.createJob({
      jobId: "infinity-context-child-v1",
      workspacePath: "/work/infinity-context-child",
      tmuxSession: "infinity-context-child-v1",
      accounts: ["account-b"],
    })).rejects.toMatchObject({
      decision: {
        allowed: false,
        reason: AccessDecisionReason.AccountDenied,
      },
    });

    expect(calls).toEqual([]);
    expect(audits.map((event) => event.decision.reason)).toEqual([
      AccessDecisionReason.Allowed,
      AccessDecisionReason.AccountDenied,
    ]);
  });

  it("does not let isolated workspace writers become coordinators", async () => {
    const calls: string[] = [];
    const broker = new ProjectControlBroker({
      boundary: AccessBoundary.IsolatedWorkspaceWrite,
      scope: scope(),
    }, ports(calls, []));

    await expect(broker.createWorktree({
      path: "/work/infinity-context-child",
      baseBranch: "main",
    })).rejects.toBeInstanceOf(ProjectControlDeniedError);
    expect(calls).toEqual([]);
  });

  it("exposes a safe denial helper for adapters", async () => {
    const broker = new ProjectControlBroker({
      boundary: AccessBoundary.ProjectScopedControl,
      scope: scope(),
    }, ports([], []));

    try {
      await broker.pushBranch({ branch: "feature/outside", remote: "origin" });
      throw new Error("expected denial");
    } catch (error) {
      expect(projectControlDeniedReason(error)).toBe(
        AccessDecisionReason.BranchDenied,
      );
    }
  });

  it("blocks producer work before broker side effects when project output debt exists", async () => {
    const calls: string[] = [];
    const audits: ProjectControlBrokerEvent[] = [];
    const broker = new ProjectControlBroker({
      boundary: AccessBoundary.ProjectScopedControl,
      scope: scope(),
    }, ports(calls, audits, admission({
      allowed: false,
      status: ProjectAdmissionDecisionStatus.Denied,
      reason: ProjectAdmissionDecisionReason.OutputDebtPresent,
      workerRole: ProjectAdmissionWorkerRole.Producer,
      evidence: ["dirty completed worker output blocks producer work"],
      debt: [{
        reason: ProjectDebtReason.UnconsumedCompletedJob,
        subject: "infinity-context-worker-v1",
        evidence: ["reviewed is not consumed"],
      }],
    })));

    await expect(broker.createJob({
      jobId: "infinity-context-child-v1",
      registryRoot: "/var/data/worker-jobs/registry",
      workspacePath: "/work/infinity-context-child",
      tmuxSession: "infinity-context-child-v1",
      workerRole: ProjectAdmissionWorkerRole.Producer,
    })).rejects.toBeInstanceOf(ProjectControlAdmissionDeniedError);

    expect(calls).toEqual([]);
    expect(audits.map((event) => event.type)).toEqual([
      ProjectControlAuditEventType.DecisionRecorded,
      ProjectControlAuditEventType.AdmissionDecisionRecorded,
    ]);
  });

  it("allows reviewer work through the broker when admission is drain-only", async () => {
    const calls: string[] = [];
    const broker = new ProjectControlBroker({
      boundary: AccessBoundary.ProjectScopedControl,
      scope: scope(),
    }, ports(calls, [], admission({
      allowed: true,
      status: ProjectAdmissionDecisionStatus.AllowedForDrainOnly,
      reason: ProjectAdmissionDecisionReason.OutputDebtPresent,
      workerRole: ProjectAdmissionWorkerRole.Reviewer,
      evidence: ["debt exists but reviewer drains it"],
      debt: [{
        reason: ProjectDebtReason.InactiveDirtyWorkspace,
        subject: "/work/infinity-context-old",
        evidence: ["dirty inactive workspace"],
      }],
    })));

    await expect(broker.startWorker({
      jobId: "infinity-context-reviewer-v1",
      tmuxSession: "infinity-context-reviewer-v1",
      workerRole: ProjectAdmissionWorkerRole.Reviewer,
    })).resolves.toMatchObject({ status: "applied" });

    expect(calls).toEqual(["start:infinity-context-reviewer-v1"]);
  });

  it("gates refill worktree creation before creating filesystem side effects", async () => {
    const calls: string[] = [];
    const broker = new ProjectControlBroker({
      boundary: AccessBoundary.ProjectScopedControl,
      scope: scope(),
    }, ports(calls, [], admission({
      allowed: false,
      status: ProjectAdmissionDecisionStatus.Denied,
      reason: ProjectAdmissionDecisionReason.OutputDebtPresent,
      workerRole: ProjectAdmissionWorkerRole.Producer,
      evidence: ["producer refill is blocked by output debt"],
      debt: [{
        reason: ProjectDebtReason.OrphanLegacyWorkspace,
        subject: "/work/orphan",
        evidence: ["legacy workspace not adopted"],
      }],
    })));

    await expect(broker.createWorktree({
      path: "/work/infinity-context-child",
      baseBranch: "main",
      workerRole: ProjectAdmissionWorkerRole.Producer,
    })).rejects.toBeInstanceOf(ProjectControlAdmissionDeniedError);

    expect(calls).toEqual([]);
  });
});

function ports(
  calls: string[],
  audits: ProjectControlBrokerEvent[],
  admissionGate?: ProjectAdmissionGate,
): ProjectControlBrokerPorts {
  const result = (resourceId: string): ProjectControlOperationResult => ({
    status: "applied",
    resourceId,
  });
  return {
    audit: {
      record(event) {
        audits.push(event);
      },
    },
    registry: {
      async createJob(input) {
        calls.push(`createJob:${input.jobId}`);
        return result(input.jobId);
      },
      async writeReviewMarker(input) {
        calls.push(`marker:${input.jobId}:${input.markerType}`);
        return result(input.jobId);
      },
    },
    supervisor: {
      async startWorker(input) {
        calls.push(`start:${input.jobId}`);
        return result(input.jobId);
      },
      async stopWorker(input) {
        calls.push(`stop:${input.jobId}`);
        return result(input.jobId);
      },
    },
    workspace: {
      async createWorktree(input) {
        calls.push(`worktree:${input.path}`);
        return result(input.path);
      },
    },
    git: {
      async integrateCommit(input) {
        calls.push(`integrate:${input.branch}`);
        return result(input.branch);
      },
      async pushBranch(input) {
        calls.push(`push:${input.branch}`);
        return result(input.branch);
      },
    },
    ...(admissionGate ? { admission: admissionGate } : {}),
  };
}

function admission(
  decision: Omit<ProjectAdmissionDecision, "operation">,
): ProjectAdmissionGate {
  return {
    evaluate(request) {
      return {
        ...decision,
        operation: request.operation,
      };
    },
  };
}

function scope(): ProjectAccessScope {
  return {
    projectId: "infinity-context",
    workspaceRoots: ["/work/infinity-context"],
    worktreeRoots: ["/work/infinity-context-child"],
    registryRoot: "/var/data/worker-jobs/registry",
    jobIdPrefixes: ["infinity-context-"],
    tmuxSessionPrefixes: ["infinity-context-"],
    allowedBranches: ["main", "refactor/infinity-*"],
    allowedGitRemotes: ["origin"],
  };
}
