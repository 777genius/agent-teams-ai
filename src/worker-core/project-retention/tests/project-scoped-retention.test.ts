import { describe, expect, it } from "vitest";

import {
  ProjectScopedRetention,
  ProjectScopedRetentionDecision,
  type ProjectScopedRetentionAuditRecord,
  type ProjectScopedRetentionInspection,
  type ProjectScopedRetentionPorts,
} from "../project-scoped-retention";

const acceptedCommit = "a".repeat(40);

describe("ProjectScopedRetention", () => {
  it("previews eligible exact candidates without removing them", async () => {
    const ports = new RetentionPorts();
    const result = await new ProjectScopedRetention(ports).execute({
      controllerId: "controller-1",
      projectId: "project-1",
      candidateIds: ["worker-1"],
      acceptedCanonicalCommit: acceptedCommit,
    });

    expect(result).toMatchObject({
      mode: "preview",
      results: [{
        candidateId: "worker-1",
        decision: ProjectScopedRetentionDecision.Eligible,
      }],
    });
    expect(ports.removals).toEqual([]);
    expect(ports.audit).toEqual([
      expect.objectContaining({
        confirmed: false,
        decision: ProjectScopedRetentionDecision.Eligible,
      }),
    ]);
  });

  it("removes a clean terminal linked worktree under both exclusive locks", async () => {
    const ports = new RetentionPorts();
    const result = await new ProjectScopedRetention(ports).execute({
      controllerId: "controller-1",
      projectId: "project-1",
      candidateIds: ["worker-1"],
      acceptedCanonicalCommit: acceptedCommit,
      confirm: true,
    });

    expect(result.results).toEqual([
      expect.objectContaining({
        decision: ProjectScopedRetentionDecision.Removed,
      }),
    ]);
    expect(ports.lockTrace).toEqual([
      "project:enter",
      "workspace:worker-1:enter",
      "workspace:worker-1:exit",
      "project:exit",
    ]);
    expect(ports.removals).toEqual([{
      candidateId: "worker-1",
      workspacePath: "/project/worktrees/worker-1",
      force: false,
    }]);
    expect(ports.audit.map((record) => record.decision)).toEqual([
      ProjectScopedRetentionDecision.Eligible,
      ProjectScopedRetentionDecision.Removed,
    ]);
  });

  it.each([
    [
      "dirty",
      { worktreeClean: false },
      ProjectScopedRetentionDecision.DeniedDirty,
    ],
    [
      "live",
      { workerAlive: true },
      ProjectScopedRetentionDecision.DeniedLiveWorker,
    ],
    [
      "unfinished operation",
      { unfinishedProjectOperation: true },
      ProjectScopedRetentionDecision.DeniedUnfinishedOperation,
    ],
    [
      "non-ancestor",
      { headAncestorOfAcceptedCommit: false },
      ProjectScopedRetentionDecision.DeniedNonAncestor,
    ],
    [
      "foreign",
      { ownedByController: false },
      ProjectScopedRetentionDecision.DeniedForeign,
    ],
  ] as const)("denies %s candidates without removing", async (
    _label,
    patch,
    decision,
  ) => {
    const ports = new RetentionPorts(patch);
    const result = await new ProjectScopedRetention(ports).execute({
      controllerId: "controller-1",
      projectId: "project-1",
      candidateIds: ["worker-1"],
      acceptedCanonicalCommit: acceptedCommit,
      confirm: true,
    });

    expect(result.results[0]?.decision).toBe(decision);
    expect(ports.removals).toEqual([]);
  });

  it("hard-codes non-force worktree removal at the port boundary", async () => {
    const ports = new RetentionPorts();
    await new ProjectScopedRetention(ports).execute({
      controllerId: "controller-1",
      projectId: "project-1",
      candidateIds: ["worker-1"],
      acceptedCanonicalCommit: acceptedCommit,
      confirm: true,
    });

    expect(ports.removals[0]).toMatchObject({ force: false });
  });

  it("denies removal when the manifest workspace path changes under the lock", async () => {
    const ports = new RetentionPorts();
    ports.lockedWorkspacePath = "/project/worktrees/rebound-worker-1";

    const result = await new ProjectScopedRetention(ports).execute({
      controllerId: "controller-1",
      projectId: "project-1",
      candidateIds: ["worker-1"],
      acceptedCanonicalCommit: acceptedCommit,
      confirm: true,
    });

    expect(result.results[0]).toMatchObject({
      decision: ProjectScopedRetentionDecision.DeniedWorkspacePathChanged,
      workspacePath: "/project/worktrees/rebound-worker-1",
      detail: "workspace_path_changed_while_locking",
    });
    expect(ports.removals).toEqual([]);
  });

  it("requires immutable ledger evidence rather than a plain terminal process result", async () => {
    const ports = new RetentionPorts({ terminalEvidence: undefined });
    const result = await new ProjectScopedRetention(ports).execute({
      controllerId: "controller-1",
      projectId: "project-1",
      candidateIds: ["worker-1"],
      acceptedCanonicalCommit: acceptedCommit,
      confirm: true,
    });

    expect(result.results[0]?.decision).toBe(
      ProjectScopedRetentionDecision.DeniedTerminalEvidence,
    );
    expect(ports.removals).toEqual([]);
  });

  it("is idempotent after the registered path is already gone", async () => {
    const ports = new RetentionPorts({
      pathExists: false,
      exactRegisteredLinkedWorktree: false,
    });
    const result = await new ProjectScopedRetention(ports).execute({
      controllerId: "controller-1",
      projectId: "project-1",
      candidateIds: ["worker-1"],
      acceptedCanonicalCommit: acceptedCommit,
      confirm: true,
    });

    expect(result.results[0]?.decision).toBe(
      ProjectScopedRetentionDecision.AlreadyRemoved,
    );
    expect(ports.removals).toEqual([]);
  });

  it("rejects duplicate or over-bound candidate selections", async () => {
    const retention = new ProjectScopedRetention(new RetentionPorts());
    await expect(retention.execute({
      controllerId: "controller-1",
      projectId: "project-1",
      candidateIds: ["worker-1", "worker-1"],
      acceptedCanonicalCommit: acceptedCommit,
    })).rejects.toThrow("project_retention_candidate_ids_not_exact");
    await expect(retention.execute({
      controllerId: "controller-1",
      projectId: "project-1",
      candidateIds: ["worker-1", "worker-2"],
      acceptedCanonicalCommit: acceptedCommit,
      maxCount: 1,
    })).rejects.toThrow("project_retention_candidate_count_invalid");
  });
});

class RetentionPorts implements ProjectScopedRetentionPorts {
  readonly removals: Array<{
    readonly candidateId: string;
    readonly workspacePath: string;
    readonly force: false;
  }> = [];
  readonly audit: ProjectScopedRetentionAuditRecord[] = [];
  readonly lockTrace: string[] = [];
  lockedWorkspacePath: string | undefined;
  private removed = false;
  private workspaceLocked = false;

  constructor(
    private readonly patch: Partial<ProjectScopedRetentionInspection> = {},
  ) {}

  async inspect(): Promise<ProjectScopedRetentionInspection> {
    return {
      candidateId: "worker-1",
      workspacePath: this.workspaceLocked && this.lockedWorkspacePath
        ? this.lockedWorkspacePath
        : "/project/worktrees/worker-1",
      ownedByController: true,
      childWorkspace: true,
      jobRoot: false,
      sharedDependencyCache: false,
      workerAlive: false,
      unfinishedProjectOperation: false,
      terminalEvidence: "consumed",
      repositoryIdentityMatches: true,
      exactRegisteredLinkedWorktree: this.removed ? false : true,
      pathExists: this.removed ? false : true,
      indexClean: true,
      worktreeClean: true,
      untrackedClean: true,
      unresolvedIndex: false,
      headAncestorOfAcceptedCommit: true,
      ...this.patch,
    };
  }

  async withExclusiveProjectRetentionLock<T>(
    input: { readonly effect: () => Promise<T> },
  ): Promise<T> {
    this.lockTrace.push("project:enter");
    try {
      return await input.effect();
    } finally {
      this.lockTrace.push("project:exit");
    }
  }

  async withExclusiveWorkspaceLock<T>(
    input: {
      readonly candidateId: string;
      readonly effect: () => Promise<T>;
    },
  ): Promise<T> {
    this.lockTrace.push(`workspace:${input.candidateId}:enter`);
    this.workspaceLocked = true;
    try {
      return await input.effect();
    } finally {
      this.workspaceLocked = false;
      this.lockTrace.push(`workspace:${input.candidateId}:exit`);
    }
  }

  async removeRegisteredWorktree(input: {
    readonly candidateId: string;
    readonly workspacePath: string;
    readonly force: false;
  }): Promise<void> {
    this.removals.push(input);
    this.removed = true;
  }

  async appendAudit(record: ProjectScopedRetentionAuditRecord): Promise<void> {
    this.audit.push(record);
  }

  now(): Date {
    return new Date("2026-07-24T00:00:00.000Z");
  }
}
