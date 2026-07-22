import { describe, expect, it } from "vitest";

import {
  CheckRunStatus,
  IntegrationAttemptStatus,
  IntegrationAuditEventType,
  OperatorArtifactRecoveryState,
  ReviewDecisionStatus,
  recoverOperatorCheckArtifact,
  type IntegrationAttempt,
  type IntegrationAttemptStorePort,
  type IntegrationAuditEvent,
  type OperatorArtifactRecoveryPermit,
  type OperatorArtifactRecoveryPort,
  type WorkspaceLockPort,
} from "../../index";

describe("recoverOperatorCheckArtifact", () => {
  it("previews an exact recovery without mutating evidence", async () => {
    const fixture = createFixture();
    const result = await recoverOperatorCheckArtifact(fixture.deps, {
      permit: fixture.permit,
      permitSha256: "f".repeat(64),
      confirm: false,
    });

    expect(result.state).toBe(OperatorArtifactRecoveryState.Ready);
    expect(fixture.recovery.calls).toEqual(["inspect"]);
    expect(fixture.store.events).toEqual([]);
    expect(fixture.lockEvents).toEqual([]);
  });

  it("prepares, completes and records idempotent audit evidence under one lock", async () => {
    const fixture = createFixture();
    const input = {
      permit: fixture.permit,
      permitSha256: "e".repeat(64),
      confirm: true,
    } as const;
    const first = await recoverOperatorCheckArtifact(fixture.deps, input);
    const second = await recoverOperatorCheckArtifact(fixture.deps, input);

    expect(first.state).toBe(OperatorArtifactRecoveryState.Completed);
    expect(second.state).toBe(OperatorArtifactRecoveryState.Completed);
    expect(fixture.store.events.map((event) => event.type)).toEqual([
      IntegrationAuditEventType.OperatorArtifactRecoveryPrepared,
      IntegrationAuditEventType.OperatorArtifactRecoveryCompleted,
    ]);
    expect(fixture.recovery.calls).toEqual([
      "inspect",
      "prepare",
      "complete",
      "inspect",
    ]);
    expect(fixture.lockEvents).toEqual([
      "acquire",
      "release",
      "acquire",
      "release",
    ]);
  });

  it("fails closed before adapter mutation when check provenance differs", async () => {
    const fixture = createFixture();
    const permit = {
      ...fixture.permit,
      check: { ...fixture.permit.check, command: ["npm", "run", "other"] },
    };
    await expect(
      recoverOperatorCheckArtifact(fixture.deps, {
        permit,
        permitSha256: "d".repeat(64),
        confirm: true,
      }),
    ).rejects.toThrow("operator_artifact_recovery_check_provenance_mismatch");
    expect(fixture.recovery.calls).toEqual([]);
    expect(fixture.store.events).toEqual([]);
  });

  it("backfills both audit events when a completed manifest outlived audit persistence", async () => {
    const fixture = createFixture();
    fixture.recovery.state = OperatorArtifactRecoveryState.Completed;
    await recoverOperatorCheckArtifact(fixture.deps, {
      permit: fixture.permit,
      permitSha256: "c".repeat(64),
      confirm: true,
    });
    expect(fixture.store.events.map((event) => event.type)).toEqual([
      IntegrationAuditEventType.OperatorArtifactRecoveryPrepared,
      IntegrationAuditEventType.OperatorArtifactRecoveryCompleted,
    ]);
  });
});

function createFixture() {
  const attempt = createAttempt();
  const permit = createPermit();
  const store = new MemoryStore(attempt);
  const recovery = new FakeRecovery();
  const lockEvents: string[] = [];
  const locks: WorkspaceLockPort = {
    acquire: ({ workspacePath, owner }) => {
      lockEvents.push("acquire");
      return { lockId: "lock-1", workspacePath, owner };
    },
    release: () => {
      lockEvents.push("release");
    },
  };
  return {
    permit,
    recovery,
    store,
    lockEvents,
    deps: {
      store,
      recovery,
      locks,
      clock: { now: () => new Date("2026-07-22T00:00:03.000Z") },
    },
  };
}

function createAttempt(): IntegrationAttempt {
  return {
    attemptId: "attempt-1",
    projectId: "project-1",
    controllerJobId: "controller-1",
    workerJobId: "worker-1",
    sourceWorkspacePath: "/work/worker",
    targetWorkspacePath: "/work/canonical",
    targetBranch: "main",
    targetRemote: "origin",
    expectedFiles: ["src/a.ts"],
    status: IntegrationAttemptStatus.ChecksPassed,
    workerOutput: {
      workerJobId: "worker-1",
      workspacePath: "/work/worker",
      patchPath: "/evidence/output.patch",
      patchSha256: "a".repeat(64),
      targetCommit: "b".repeat(40),
      changedFiles: ["src/a.ts"],
    },
    reviewDecision: {
      reviewedBy: "reviewer",
      decision: ReviewDecisionStatus.Approved,
      reason: "approved",
      approvedFiles: ["src/a.ts"],
      requiredChecks: [{ checkId: "lint", command: ["npm", "run", "lint"] }],
    },
    checkRuns: [
      {
        checkId: "lint",
        command: ["npm", "run", "lint"],
        status: CheckRunStatus.Passed,
        startedAt: "2026-07-22T00:00:01.000Z",
        completedAt: "2026-07-22T00:00:02.000Z",
        exitCode: 0,
      },
    ],
    createdAt: "2026-07-22T00:00:00.000Z",
    updatedAt: "2026-07-22T00:00:02.000Z",
  };
}

function createPermit(): OperatorArtifactRecoveryPermit {
  return {
    schemaVersion: 1,
    registryRootDir: "/registry",
    controllerJobId: "controller-1",
    projectId: "project-1",
    attemptId: "attempt-1",
    expectedAttemptStatus: IntegrationAttemptStatus.ChecksPassed,
    targetWorkspacePath: "/work/canonical",
    targetBranch: "main",
    targetHeadSha: "b".repeat(40),
    candidatePatchSha256: "a".repeat(64),
    candidatePatchSize: 123,
    artifact: {
      path: ".eslintcache",
      sha256: "c".repeat(64),
      size: 42,
      mode: 0o600,
      mtimeMs: Date.parse("2026-07-22T00:00:01.500Z"),
    },
    check: {
      checkId: "lint",
      command: ["npm", "run", "lint"],
      startedAt: "2026-07-22T00:00:01.000Z",
      completedAt: "2026-07-22T00:00:02.000Z",
    },
  };
}

class MemoryStore implements IntegrationAttemptStorePort {
  readonly events: IntegrationAuditEvent[] = [];
  constructor(private readonly attempt: IntegrationAttempt) {}
  create(): void {}
  get(): IntegrationAttempt {
    return this.attempt;
  }
  update(): void {}
  appendEvent(_attemptId: string, event: IntegrationAuditEvent): void {
    this.events.push(event);
  }
  readEvents(): readonly IntegrationAuditEvent[] {
    return this.events;
  }
}

class FakeRecovery implements OperatorArtifactRecoveryPort {
  readonly calls: string[] = [];
  state = OperatorArtifactRecoveryState.Ready;
  async inspect() {
    this.calls.push("inspect");
    return { state: this.state, permitSha256: "f".repeat(64) };
  }
  async prepare() {
    this.calls.push("prepare");
    this.state = OperatorArtifactRecoveryState.Prepared;
    return { state: this.state, permitSha256: "f".repeat(64) };
  }
  async complete() {
    this.calls.push("complete");
    this.state = OperatorArtifactRecoveryState.Completed;
    return { state: this.state, permitSha256: "f".repeat(64) };
  }
}
