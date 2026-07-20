import { describe, expect, it } from "vitest";

import {
  CheckRunStatus,
  IntegrationAuditEventType,
  IntegrationAttemptStatus,
  IntegrationError,
  IntegrationErrorReason,
  PushAttemptStatus,
  SecretScanStatus,
  applyWorkerOutput,
  commitApprovedChanges,
  openProjectIntegrationAttempt,
  pushApprovedCommit,
  rejectIntegrationAttempt,
  rollupCheckRuns,
  runRequiredChecks,
  type ProjectIntegrationPolicy,
} from "../../index";
import {
  MERGE_SOURCE_COMMIT,
  MERGE_TARGET_COMMIT,
  createFixture,
  input,
  mergeInput,
  policy,
} from "./project-integration-use-cases.fixture";

function promotionPolicy(): ProjectIntegrationPolicy {
  const base = policy();
  const scope = base.access.scope;
  if (!scope) throw new Error("test_project_scope_required");
  return {
    ...base,
    access: {
      ...base.access,
      scope: {
        ...scope,
        allowedBranches: ["main", "release"],
      },
    },
  };
}

describe("project integration use cases", () => {
  it("opens, applies, checks, commits and pushes a reviewed worker output", async () => {
    const fixture = createFixture();

    const opened = await openProjectIntegrationAttempt(fixture.deps(), input());
    const applied = await applyWorkerOutput(fixture.deps(), {
      attemptId: opened.attemptId,
    });
    const checked = await runRequiredChecks(fixture.deps(), {
      attemptId: applied.attemptId,
    });
    const committed = await commitApprovedChanges(fixture.deps(), {
      attemptId: checked.attemptId,
      message: "fix(memory): integrate worker output",
      policy: policy(),
    });
    const pushed = await pushApprovedCommit(fixture.deps(), {
      attemptId: committed.attemptId,
      policy: policy(),
    });

    expect(pushed).toMatchObject({
      status: IntegrationAttemptStatus.Pushed,
      pushAttempt: {
        status: PushAttemptStatus.Pushed,
        remote: "origin",
        branch: "main",
        commitSha: "abc123",
      },
    });
    expect(fixture.git.calls).toEqual([
      "status",
      "apply",
      "diffCheck",
      "status",
      "commit",
      "branch",
      "remote",
      "push",
    ]);
    expect(fixture.events.map((event) => event.type)).toEqual([
      IntegrationAuditEventType.AttemptOpened,
      IntegrationAuditEventType.AttemptApplied,
      IntegrationAuditEventType.ChecksStarted,
      IntegrationAuditEventType.ChecksPassed,
      IntegrationAuditEventType.CommitCreated,
      IntegrationAuditEventType.Pushed,
    ]);
  });

  it("rejects dirty unrelated target workspaces before applying worker output", async () => {
    const fixture = createFixture();
    fixture.git.dirtyFiles = ["src/unrelated.ts"];
    const opened = await openProjectIntegrationAttempt(fixture.deps(), input());

    await expect(applyWorkerOutput(fixture.deps(), {
      attemptId: opened.attemptId,
    })).rejects.toMatchObject({
      reason: IntegrationErrorReason.DirtyWorkspace,
      evidence: ["src/unrelated.ts"],
    });
    expect(fixture.git.calls).toEqual(["status"]);
  });

  it("allows already-applied recovery only for exact expected dirty files", async () => {
    const recoverable = createFixture();
    recoverable.git.dirtyFiles = ["src/memory.ts"];
    const opened = await openProjectIntegrationAttempt(recoverable.deps(), input());

    await applyWorkerOutput(recoverable.deps(), {
      attemptId: opened.attemptId,
      allowedPreExistingDirtyFiles: ["src/memory.ts"],
    });
    expect(recoverable.git.lastAllowAlreadyApplied).toBe(true);

    const superset = createFixture();
    superset.git.dirtyFiles = ["src/memory.ts"];
    const second = await openProjectIntegrationAttempt(superset.deps(), {
      ...input(),
      attemptId: "attempt-2",
    });
    await applyWorkerOutput(superset.deps(), {
      attemptId: second.attemptId,
      allowedPreExistingDirtyFiles: ["src/memory.ts", "src/extra.ts"],
    });
    expect(superset.git.lastAllowAlreadyApplied).toBe(false);
  });

  it("does not commit when required checks failed", async () => {
    const fixture = createFixture({
      checkStatus: CheckRunStatus.Failed,
    });
    const opened = await openProjectIntegrationAttempt(fixture.deps(), input());
    const applied = await applyWorkerOutput(fixture.deps(), {
      attemptId: opened.attemptId,
    });
    const checked = await runRequiredChecks(fixture.deps(), {
      attemptId: applied.attemptId,
    });

    await expect(commitApprovedChanges(fixture.deps(), {
      attemptId: checked.attemptId,
      message: "fix(memory): integrate worker output",
      policy: policy(),
    })).rejects.toMatchObject({
      reason: IntegrationErrorReason.InvalidTransition,
    });
    expect(fixture.git.calls).toEqual(["status", "apply"]);
  });

  it("can retry required checks after a transient check failure", async () => {
    const fixture = createFixture({
      checkStatus: CheckRunStatus.Failed,
    });
    const opened = await openProjectIntegrationAttempt(fixture.deps(), input());
    const applied = await applyWorkerOutput(fixture.deps(), {
      attemptId: opened.attemptId,
    });
    const failed = await runRequiredChecks(fixture.deps(), {
      attemptId: applied.attemptId,
    });

    fixture.checks.status = CheckRunStatus.Passed;
    const retried = await runRequiredChecks(fixture.deps(), {
      attemptId: failed.attemptId,
    });

    expect(retried.status).toBe(IntegrationAttemptStatus.ChecksPassed);
    await expect(commitApprovedChanges(fixture.deps(), {
      attemptId: retried.attemptId,
      message: "fix(memory): integrate worker output",
      policy: policy(),
    })).resolves.toMatchObject({
      status: IntegrationAttemptStatus.CommitCreated,
    });
  });

  it("records terminal consumed-output evidence before marking an attempt rejected", async () => {
    const fixture = createFixture();
    const opened = await openProjectIntegrationAttempt(fixture.deps(), input());

    const rejected = await rejectIntegrationAttempt(fixture.deps(), {
      attemptId: opened.attemptId,
      reason: "review rejected",
    });

    expect(rejected).toMatchObject({
      status: IntegrationAttemptStatus.Rejected,
      rejectReason: "review rejected",
      consumedOutputLedger: {
        status: "rejected",
        ledgerPath: "/ledger/rejected.json",
      },
    });
    expect(fixture.ledger.prepareRejectionCalls).toBe(1);
    expect(fixture.ledger.finalizeRejectionCalls).toBe(1);
    expect(fixture.ledger.lastRejectedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(fixture.events.at(-1)?.type).toBe(IntegrationAuditEventType.Rejected);
  });

  it("rolls timed-out required checks into failed integration status", async () => {
    const fixture = createFixture({
      checkStatus: CheckRunStatus.TimedOut,
    });
    const opened = await openProjectIntegrationAttempt(fixture.deps(), input());
    const applied = await applyWorkerOutput(fixture.deps(), {
      attemptId: opened.attemptId,
    });

    const checked = await runRequiredChecks(fixture.deps(), {
      attemptId: applied.attemptId,
    });

    expect(checked).toMatchObject({
      status: IntegrationAttemptStatus.ChecksFailed,
      checkRuns: [
        {
          checkId: "test:memory",
          status: CheckRunStatus.TimedOut,
        },
      ],
    });
    expect(rollupCheckRuns(checked.checkRuns)).toEqual({
      status: IntegrationAttemptStatus.ChecksFailed,
      failedCheckIds: ["test:memory"],
    });
    expect(fixture.events.at(-1)?.type).toBe(
      IntegrationAuditEventType.ChecksFailed,
    );
  });

  it("blocks commit when secret scan fails", async () => {
    const fixture = createFixture({
      secretScanStatus: SecretScanStatus.Failed,
    });
    const opened = await openProjectIntegrationAttempt(fixture.deps(), input());
    const applied = await applyWorkerOutput(fixture.deps(), {
      attemptId: opened.attemptId,
    });
    const checked = await runRequiredChecks(fixture.deps(), {
      attemptId: applied.attemptId,
    });

    await expect(commitApprovedChanges(fixture.deps(), {
      attemptId: checked.attemptId,
      message: "fix(memory): integrate worker output",
      policy: policy(),
    })).rejects.toMatchObject({
      reason: IntegrationErrorReason.SecretScanFailed,
    });
    expect(fixture.git.calls).toEqual([
      "status",
      "apply",
      "diffCheck",
      "status",
    ]);
  });

  it("fails before git push when ledger preparation is unavailable", async () => {
    const fixture = createFixture();
    const opened = await openProjectIntegrationAttempt(fixture.deps(), input());
    await applyWorkerOutput(fixture.deps(), { attemptId: opened.attemptId });
    await runRequiredChecks(fixture.deps(), { attemptId: opened.attemptId });
    await commitApprovedChanges(fixture.deps(), {
      attemptId: opened.attemptId,
      message: "fix(memory): integrate worker output",
      policy: policy(),
    });
    fixture.ledger.prepareError = new Error("ledger_not_writable");

    await expect(pushApprovedCommit(fixture.deps(), {
      attemptId: opened.attemptId,
      policy: policy(),
    })).rejects.toThrow("ledger_not_writable");
    expect(fixture.git.calls).not.toContain("push");
  });

  it("fails before git push when terminal ledger preflight is incompatible", async () => {
    const fixture = createFixture();
    const opened = await openProjectIntegrationAttempt(fixture.deps(), input());
    await applyWorkerOutput(fixture.deps(), { attemptId: opened.attemptId });
    await runRequiredChecks(fixture.deps(), { attemptId: opened.attemptId });
    await commitApprovedChanges(fixture.deps(), {
      attemptId: opened.attemptId,
      message: "fix(memory): integrate worker output",
      policy: policy(),
    });
    fixture.ledger.preflightError = new Error(
      "consumed_output_ledger_terminal_conflict",
    );

    await expect(pushApprovedCommit(fixture.deps(), {
      attemptId: opened.attemptId,
      policy: policy(),
    })).rejects.toThrow("consumed_output_ledger_terminal_conflict");
    expect(fixture.git.calls).not.toContain("remote");
    expect(fixture.git.calls).not.toContain("push");
  });

  it("recovers an exact remote commit without pushing it again", async () => {
    const fixture = createFixture();
    const opened = await openProjectIntegrationAttempt(fixture.deps(), input());
    await applyWorkerOutput(fixture.deps(), { attemptId: opened.attemptId });
    await runRequiredChecks(fixture.deps(), { attemptId: opened.attemptId });
    await commitApprovedChanges(fixture.deps(), {
      attemptId: opened.attemptId,
      message: "fix(memory): integrate worker output",
      policy: policy(),
    });
    fixture.git.remoteCommit = "abc123";

    const recovered = await pushApprovedCommit(fixture.deps(), {
      attemptId: opened.attemptId,
      policy: policy(),
    });

    expect(recovered.status).toBe(IntegrationAttemptStatus.Pushed);
    expect(fixture.git.calls).toContain("remote");
    expect(fixture.git.calls).not.toContain("push");
    expect(fixture.ledger.finalizeCalls).toBe(1);
    expect(fixture.store.get(opened.attemptId)?.status)
      .toBe(IntegrationAttemptStatus.Pushed);
  });

  it("promotes a pushed commit while preserving immutable push evidence", async () => {
    let clockTick = 0;
    const fixture = createFixture({
      clockNow: () => new Date(Date.UTC(2026, 0, 1, 0, clockTick++)),
    });
    const promotePolicy = promotionPolicy();
    const targetCommit = "f".repeat(40);
    const opened = await openProjectIntegrationAttempt(fixture.deps(), {
      ...input(),
      workerOutput: {
        ...input().workerOutput,
        targetCommit,
      },
      policy: promotePolicy,
    });
    await applyWorkerOutput(fixture.deps(), { attemptId: opened.attemptId });
    await runRequiredChecks(fixture.deps(), { attemptId: opened.attemptId });
    await commitApprovedChanges(fixture.deps(), {
      attemptId: opened.attemptId,
      message: "fix(memory): integrate worker output",
      policy: promotePolicy,
    });
    await pushApprovedCommit(fixture.deps(), {
      attemptId: opened.attemptId,
      policy: promotePolicy,
    });
    fixture.git.remoteCommit = targetCommit;

    const promoted = await pushApprovedCommit(fixture.deps(), {
      attemptId: opened.attemptId,
      branch: "release",
      policy: promotePolicy,
    });

    expect(promoted.pushAttempt?.branch).toBe("main");
    expect(promoted.promotionAttempts).toHaveLength(1);
    expect(promoted.promotionAttempts?.[0]?.branch).toBe("release");
    expect(fixture.git.lastPushedBranch).toBe("release");
    expect(fixture.git.lastExpectedRemoteCommit).toBe(targetCommit);
    expect(fixture.ledger.finalizeCalls).toBe(2);
    expect(fixture.ledger.finalizedAt.at(-1)).toBe(
      promoted.pushAttempt?.pushedAt,
    );
    expect(promoted.promotionAttempts?.[0]?.pushedAt).not.toBe(
      promoted.pushAttempt?.pushedAt,
    );

    const pushCallsAfterPromotion = fixture.git.calls
      .filter((call) => call === "push").length;
    const replayed = await pushApprovedCommit(fixture.deps(), {
      attemptId: opened.attemptId,
      branch: "release",
      policy: promotePolicy,
    });
    expect(replayed.promotionAttempts).toHaveLength(1);
    expect(fixture.git.calls.filter((call) => call === "push"))
      .toHaveLength(pushCallsAfterPromotion);
    expect(fixture.ledger.finalizeCalls).toBe(3);
  });

  it("rejects promotion when the remote target changed", async () => {
    const fixture = createFixture();
    const promotePolicy = promotionPolicy();
    const opened = await openProjectIntegrationAttempt(fixture.deps(), {
      ...input(),
      workerOutput: {
        ...input().workerOutput,
        targetCommit: "f".repeat(40),
      },
      policy: promotePolicy,
    });
    await applyWorkerOutput(fixture.deps(), { attemptId: opened.attemptId });
    await runRequiredChecks(fixture.deps(), { attemptId: opened.attemptId });
    await commitApprovedChanges(fixture.deps(), {
      attemptId: opened.attemptId,
      message: "fix(memory): integrate worker output",
      policy: promotePolicy,
    });
    await pushApprovedCommit(fixture.deps(), {
      attemptId: opened.attemptId,
      policy: promotePolicy,
    });
    const pushCallsBeforePromotion = fixture.git.calls
      .filter((call) => call === "push").length;
    fixture.git.remoteCommit = "e".repeat(40);

    await expect(pushApprovedCommit(fixture.deps(), {
      attemptId: opened.attemptId,
      branch: "release",
      policy: promotePolicy,
    })).rejects.toMatchObject({
      reason: IntegrationErrorReason.StaleBase,
    });
    expect(fixture.git.calls.filter((call) => call === "push"))
      .toHaveLength(pushCallsBeforePromotion);
  });

  it("promotes an exact two-parent merge against its reviewed target", async () => {
    const fixture = createFixture();
    const promotePolicy = promotionPolicy();
    fixture.git.appliedFiles = ["src/base-change.ts", "src/memory.ts"];
    const opened = await openProjectIntegrationAttempt(fixture.deps(), {
      ...mergeInput(),
      policy: promotePolicy,
    });
    await applyWorkerOutput(fixture.deps(), { attemptId: opened.attemptId });
    await runRequiredChecks(fixture.deps(), { attemptId: opened.attemptId });
    await commitApprovedChanges(fixture.deps(), {
      attemptId: opened.attemptId,
      message: "chore(git): merge base branch",
      policy: promotePolicy,
    });
    await pushApprovedCommit(fixture.deps(), {
      attemptId: opened.attemptId,
      policy: promotePolicy,
    });
    fixture.git.remoteCommit = MERGE_TARGET_COMMIT;

    const promoted = await pushApprovedCommit(fixture.deps(), {
      attemptId: opened.attemptId,
      branch: "release",
      policy: promotePolicy,
    });

    expect(promoted.promotionAttempts).toHaveLength(1);
    expect(fixture.git.lastPushedBranch).toBe("release");
    expect(fixture.git.lastExpectedRemoteCommit).toBe(MERGE_TARGET_COMMIT);
  });

  it("recovers one promotion record after persistence fails post-push", async () => {
    let clockTick = 0;
    const fixture = createFixture({
      clockNow: () => new Date(Date.UTC(2026, 0, 1, 0, clockTick++)),
    });
    const promotePolicy = promotionPolicy();
    const targetCommit = "f".repeat(40);
    const opened = await openProjectIntegrationAttempt(fixture.deps(), {
      ...input(),
      policy: promotePolicy,
      workerOutput: { ...input().workerOutput, targetCommit },
    });
    await applyWorkerOutput(fixture.deps(), { attemptId: opened.attemptId });
    await runRequiredChecks(fixture.deps(), { attemptId: opened.attemptId });
    await commitApprovedChanges(fixture.deps(), {
      attemptId: opened.attemptId,
      message: "fix(memory): integrate worker output",
      policy: promotePolicy,
    });
    const pushed = await pushApprovedCommit(fixture.deps(), {
      attemptId: opened.attemptId,
      policy: promotePolicy,
    });
    fixture.git.remoteCommit = targetCommit;
    fixture.store.failNextUpdate = new Error("promotion persistence failed");

    await expect(pushApprovedCommit(fixture.deps(), {
      attemptId: opened.attemptId,
      branch: "release",
      policy: promotePolicy,
    })).rejects.toThrow("promotion persistence failed");
    expect(fixture.git.remoteCommit).toBe(pushed.commitCandidate?.commitSha);

    const recovered = await pushApprovedCommit(fixture.deps(), {
      attemptId: opened.attemptId,
      branch: "release",
      policy: promotePolicy,
    });

    expect(recovered.promotionAttempts).toHaveLength(1);
    expect(recovered.pushAttempt).toEqual(pushed.pushAttempt);
    expect(fixture.git.calls.filter((call) => call === "push")).toHaveLength(2);
    expect(fixture.ledger.finalizedAt.at(-1)).toBe(pushed.pushAttempt?.pushedAt);
  });

  it("rejects forced, out-of-policy and branch-mismatched promotions", async () => {
    const fixture = createFixture();
    const promotePolicy = promotionPolicy();
    const targetCommit = "f".repeat(40);
    const opened = await openProjectIntegrationAttempt(fixture.deps(), {
      ...input(),
      policy: promotePolicy,
      workerOutput: { ...input().workerOutput, targetCommit },
    });
    await applyWorkerOutput(fixture.deps(), { attemptId: opened.attemptId });
    await runRequiredChecks(fixture.deps(), { attemptId: opened.attemptId });
    await commitApprovedChanges(fixture.deps(), {
      attemptId: opened.attemptId,
      message: "fix(memory): integrate worker output",
      policy: promotePolicy,
    });
    await pushApprovedCommit(fixture.deps(), {
      attemptId: opened.attemptId,
      policy: promotePolicy,
    });
    fixture.git.remoteCommit = targetCommit;

    await expect(pushApprovedCommit(fixture.deps(), {
      attemptId: opened.attemptId,
      branch: "release",
      force: true,
      policy: promotePolicy,
    })).rejects.toMatchObject({ reason: IntegrationErrorReason.PolicyDenied });
    await expect(pushApprovedCommit(fixture.deps(), {
      attemptId: opened.attemptId,
      branch: "outside",
      policy: promotePolicy,
    })).rejects.toMatchObject({ reason: IntegrationErrorReason.PolicyDenied });
    fixture.git.branch = "release";
    await expect(pushApprovedCommit(fixture.deps(), {
      attemptId: opened.attemptId,
      branch: "release",
      policy: promotePolicy,
    })).rejects.toMatchObject({ reason: IntegrationErrorReason.BranchMismatch });
    expect(fixture.git.calls.filter((call) => call === "push")).toHaveLength(1);
  });

  it("rejects inconsistent merge and worker promotion targets", async () => {
    const fixture = createFixture();
    const promotePolicy = promotionPolicy();
    const candidate = mergeInput();
    fixture.git.appliedFiles = ["src/base-change.ts", "src/memory.ts"];
    const opened = await openProjectIntegrationAttempt(fixture.deps(), {
      ...candidate,
      policy: promotePolicy,
      workerOutput: {
        ...candidate.workerOutput,
        targetCommit: "c".repeat(40),
      },
    });
    await applyWorkerOutput(fixture.deps(), { attemptId: opened.attemptId });
    await runRequiredChecks(fixture.deps(), { attemptId: opened.attemptId });
    await commitApprovedChanges(fixture.deps(), {
      attemptId: opened.attemptId,
      message: "chore(git): merge base branch",
      policy: promotePolicy,
    });
    await pushApprovedCommit(fixture.deps(), {
      attemptId: opened.attemptId,
      policy: promotePolicy,
    });
    fixture.git.remoteCommit = MERGE_TARGET_COMMIT;

    await expect(pushApprovedCommit(fixture.deps(), {
      attemptId: opened.attemptId,
      branch: "release",
      policy: promotePolicy,
    })).rejects.toMatchObject({
      reason: IntegrationErrorReason.InvalidMergePlan,
    });
  });

  it("does not mark an attempt pushed when ledger finalization fails", async () => {
    const fixture = createFixture();
    const opened = await openProjectIntegrationAttempt(fixture.deps(), input());
    await applyWorkerOutput(fixture.deps(), { attemptId: opened.attemptId });
    await runRequiredChecks(fixture.deps(), { attemptId: opened.attemptId });
    await commitApprovedChanges(fixture.deps(), {
      attemptId: opened.attemptId,
      message: "fix(memory): integrate worker output",
      policy: policy(),
    });
    fixture.ledger.finalizeError = new Error("ledger_finalize_failed");

    await expect(pushApprovedCommit(fixture.deps(), {
      attemptId: opened.attemptId,
      policy: policy(),
    })).rejects.toThrow("ledger_finalize_failed");
    expect(fixture.git.calls).toContain("push");
    expect(fixture.store.get(opened.attemptId)?.status)
      .toBe(IntegrationAttemptStatus.CommitCreated);

    delete fixture.ledger.finalizeError;
    const recovered = await pushApprovedCommit(fixture.deps(), {
      attemptId: opened.attemptId,
      policy: policy(),
    });
    expect(recovered.status).toBe(IntegrationAttemptStatus.Pushed);
    expect(fixture.git.calls.filter((call) => call === "push")).toHaveLength(1);
    expect(fixture.git.calls.filter((call) => call === "remote")).toHaveLength(2);
  });

  it("re-verifies ledger evidence when a pushed attempt is replayed", async () => {
    const fixture = createFixture();
    const opened = await openProjectIntegrationAttempt(fixture.deps(), input());
    await applyWorkerOutput(fixture.deps(), { attemptId: opened.attemptId });
    await runRequiredChecks(fixture.deps(), { attemptId: opened.attemptId });
    await commitApprovedChanges(fixture.deps(), {
      attemptId: opened.attemptId,
      message: "fix(memory): integrate worker output",
      policy: policy(),
    });
    await pushApprovedCommit(fixture.deps(), {
      attemptId: opened.attemptId,
      policy: policy(),
    });
    await pushApprovedCommit(fixture.deps(), {
      attemptId: opened.attemptId,
      policy: policy(),
    });

    expect(fixture.git.calls.filter((call) => call === "push")).toHaveLength(1);
    expect(fixture.ledger.prepareCalls).toBe(2);
    expect(fixture.ledger.finalizeCalls).toBe(2);
  });

  it("fails closed when opening an attempt outside branch policy", async () => {
    const fixture = createFixture();

    await expect(openProjectIntegrationAttempt(fixture.deps(), {
      ...input(),
      targetBranch: "feature/outside",
    })).rejects.toBeInstanceOf(IntegrationError);
  });

  it("opens an attempt when an allowed path prefix has a trailing slash", async () => {
    const fixture = createFixture();
    const base = input();
    const approvedFile = "src/worker-codex/codex-goal-runner.ts";

    const opened = await openProjectIntegrationAttempt(fixture.deps(), {
      ...base,
      policy: {
        ...policy(),
        allowedPathPrefixes: ["src/worker-codex/"],
      },
      workerOutput: {
        ...base.workerOutput,
        changedFiles: [approvedFile],
      },
      reviewDecision: {
        ...base.reviewDecision,
        approvedFiles: [approvedFile],
      },
    });

    expect(opened.expectedFiles).toEqual([approvedFile]);
    expect(fixture.events).toMatchObject([
      {
        type: IntegrationAuditEventType.AttemptOpened,
        files: [approvedFile],
      },
    ]);
  });

  it("blocks stale worker output until review policy allows a rebase check", async () => {
    const fixture = createFixture();

    await expect(openProjectIntegrationAttempt(fixture.deps(), {
      ...input(),
      workerOutput: {
        ...input().workerOutput,
        baseCommit: "abc1234",
        targetCommit: "def5678",
        baseStatus: "needs_rebase_check",
        baseRevisionReasons: ["target_advanced", "output_changed_on_stale_base"],
      },
    })).rejects.toMatchObject({
      reason: IntegrationErrorReason.StaleBase,
      evidence: [
        "base:abc1234",
        "target:def5678",
        "target_advanced",
        "output_changed_on_stale_base",
      ],
    });
  });

  it("allows stale worker output when integration policy explicitly accepts it", async () => {
    const fixture = createFixture();

    await expect(openProjectIntegrationAttempt(fixture.deps(), {
      ...input(),
      policy: {
        ...policy(),
        allowStaleBase: true,
      },
      workerOutput: {
        ...input().workerOutput,
        baseCommit: "abc1234",
        targetCommit: "def5678",
        baseStatus: "needs_rebase_check",
        baseRevisionReasons: ["target_advanced", "output_changed_on_stale_base"],
      },
    })).resolves.toMatchObject({
      workerOutput: {
        baseCommit: "abc1234",
        targetCommit: "def5678",
        baseStatus: "needs_rebase_check",
      },
    });
  });

  it("opens and applies a pinned merge while preserving reviewed conflict files", async () => {
    const fixture = createFixture();
    fixture.git.appliedFiles = ["src/base-change.ts", "src/memory.ts"];

    const opened = await openProjectIntegrationAttempt(
      fixture.deps(),
      mergeInput(),
    );
    const applied = await applyWorkerOutput(fixture.deps(), {
      attemptId: opened.attemptId,
    });

    expect(applied).toMatchObject({
      merge: {
        sourceRemote: "origin",
        sourceBranch: "base",
        sourceCommit: MERGE_SOURCE_COMMIT,
        expectedTargetCommit: MERGE_TARGET_COMMIT,
      },
      workerOutput: {
        changedFiles: ["src/memory.ts"],
      },
      appliedFiles: ["src/base-change.ts", "src/memory.ts"],
    });
    expect(fixture.git.lastAllowAlreadyApplied).toBe(false);
  });

  it("opens and applies a reviewed clean merge with no resolution patch files", async () => {
    const fixture = createFixture();
    const candidate = mergeInput();
    fixture.git.appliedFiles = ["src/base-change.ts"];

    const opened = await openProjectIntegrationAttempt(fixture.deps(), {
      ...candidate,
      workerOutput: {
        ...candidate.workerOutput,
        changedFiles: [],
      },
      reviewDecision: {
        ...candidate.reviewDecision,
        approvedFiles: ["src/base-change.ts"],
      },
    });
    const applied = await applyWorkerOutput(fixture.deps(), {
      attemptId: opened.attemptId,
    });

    expect(applied).toMatchObject({
      workerOutput: { changedFiles: [] },
      expectedFiles: ["src/base-change.ts"],
      appliedFiles: ["src/base-change.ts"],
    });
  });

  it("rejects a merge whose reviewed patch is not based on the target parent", async () => {
    const fixture = createFixture();
    const candidate = mergeInput();

    await expect(openProjectIntegrationAttempt(fixture.deps(), {
      ...candidate,
      workerOutput: {
        ...candidate.workerOutput,
        baseCommit: "c".repeat(40),
      },
    })).rejects.toMatchObject({
      reason: IntegrationErrorReason.InvalidMergePlan,
    });
  });

  it("aborts a merge when an immutable patch file is absent from the result", async () => {
    const fixture = createFixture();
    fixture.git.appliedFiles = ["src/base-change.ts"];
    const opened = await openProjectIntegrationAttempt(
      fixture.deps(),
      mergeInput(),
    );

    await expect(applyWorkerOutput(fixture.deps(), {
      attemptId: opened.attemptId,
    })).rejects.toMatchObject({
      reason: IntegrationErrorReason.UnexpectedFiles,
      evidence: ["reviewed_merge_patch_files_missing:src/memory.ts"],
    });
    expect(fixture.git.calls).toEqual(["status", "apply", "abortMerge"]);
    expect(fixture.store.get(opened.attemptId)?.status).toBe(
      IntegrationAttemptStatus.Opened,
    );
  });

  it("records an exact ordered two-parent merge commit", async () => {
    const fixture = createFixture();
    fixture.git.appliedFiles = ["src/base-change.ts", "src/memory.ts"];
    fixture.git.changedSinceCommitFiles = [
      "src/clean-target-only.ts",
      "src/memory.ts",
    ];
    const opened = await openProjectIntegrationAttempt(
      fixture.deps(),
      mergeInput(),
    );
    await applyWorkerOutput(fixture.deps(), { attemptId: opened.attemptId });
    await runRequiredChecks(fixture.deps(), { attemptId: opened.attemptId });

    const committed = await commitApprovedChanges(fixture.deps(), {
      attemptId: opened.attemptId,
      message: "chore(git): merge base branch",
      policy: policy(),
    });

    expect(committed.commitCandidate?.parentCommits).toEqual([
      MERGE_TARGET_COMMIT,
      MERGE_SOURCE_COMMIT,
    ]);
    expect(fixture.git.lastExpectedParentCommits).toEqual([
      MERGE_TARGET_COMMIT,
      MERGE_SOURCE_COMMIT,
    ]);
    expect(fixture.git.lastCommittedFiles).toEqual([
      "src/base-change.ts",
      "src/memory.ts",
    ]);
    expect(fixture.git.lastChangedSinceCommit).toBe(MERGE_SOURCE_COMMIT);
    expect(fixture.scanner.lastFiles).toEqual(["src/memory.ts"]);
  });

  it("records an applied descendant source as the actual second parent", async () => {
    const fixture = createFixture();
    const appliedSourceCommit = "d".repeat(40);
    fixture.git.appliedFiles = ["src/base-change.ts", "src/memory.ts"];
    fixture.git.appliedMergeSourceCommit = appliedSourceCommit;
    fixture.git.changedSinceCommitFiles = ["src/memory.ts"];
    const opened = await openProjectIntegrationAttempt(
      fixture.deps(),
      mergeInput(),
    );
    const applied = await applyWorkerOutput(fixture.deps(), {
      attemptId: opened.attemptId,
    });
    expect(applied.appliedMergeSourceCommit).toBe(appliedSourceCommit);
    await runRequiredChecks(fixture.deps(), { attemptId: opened.attemptId });

    const committed = await commitApprovedChanges(fixture.deps(), {
      attemptId: opened.attemptId,
      message: "chore(git): merge advanced base branch",
      policy: policy(),
    });

    expect(committed.commitCandidate?.parentCommits).toEqual([
      MERGE_TARGET_COMMIT,
      appliedSourceCommit,
    ]);
    expect(fixture.git.lastExpectedParentCommits).toEqual([
      MERGE_TARGET_COMMIT,
      appliedSourceCommit,
    ]);
    expect(fixture.git.lastChangedSinceCommit).toBe(appliedSourceCommit);
  });

  it("fails closed when a merge commit reports different parents", async () => {
    const fixture = createFixture();
    fixture.git.appliedFiles = ["src/base-change.ts", "src/memory.ts"];
    fixture.git.commitParents = [MERGE_SOURCE_COMMIT, MERGE_TARGET_COMMIT];
    const opened = await openProjectIntegrationAttempt(
      fixture.deps(),
      mergeInput(),
    );
    await applyWorkerOutput(fixture.deps(), { attemptId: opened.attemptId });
    await runRequiredChecks(fixture.deps(), { attemptId: opened.attemptId });

    await expect(commitApprovedChanges(fixture.deps(), {
      attemptId: opened.attemptId,
      message: "chore(git): merge base branch",
      policy: policy(),
    })).rejects.toMatchObject({
      reason: IntegrationErrorReason.MergeParentsMismatch,
    });
  });

  it("rolls back an applied merge before recording rejection", async () => {
    const fixture = createFixture();
    fixture.git.appliedFiles = ["src/base-change.ts", "src/memory.ts"];
    const opened = await openProjectIntegrationAttempt(
      fixture.deps(),
      mergeInput(),
    );
    await applyWorkerOutput(fixture.deps(), { attemptId: opened.attemptId });
    const rejected = await rejectIntegrationAttempt(fixture.deps(), {
      attemptId: opened.attemptId,
      reason: "merge review rejected",
    });
    expect(rejected.status).toBe(IntegrationAttemptStatus.Rejected);
    expect(fixture.git.calls).toContain("abortMerge");
  });

  it("rolls back an opened merge after apply failed before persistence", async () => {
    const fixture = createFixture();
    const opened = await openProjectIntegrationAttempt(
      fixture.deps(),
      mergeInput(),
    );

    const rejected = await rejectIntegrationAttempt(fixture.deps(), {
      attemptId: opened.attemptId,
      reason: "apply failed after Git materialization",
    });

    expect(rejected.status).toBe(IntegrationAttemptStatus.Rejected);
    expect(fixture.git.calls).toContain("abortMerge");
  });

  it("rejects a committed merge without attempting to abort completed Git state", async () => {
    const fixture = createFixture();
    fixture.git.appliedFiles = ["src/base-change.ts", "src/memory.ts"];
    const opened = await openProjectIntegrationAttempt(
      fixture.deps(),
      mergeInput(),
    );
    await applyWorkerOutput(fixture.deps(), { attemptId: opened.attemptId });
    await runRequiredChecks(fixture.deps(), { attemptId: opened.attemptId });
    await commitApprovedChanges(fixture.deps(), {
      attemptId: opened.attemptId,
      message: "chore(git): merge base branch",
      policy: policy(),
    });
    const rejected = await rejectIntegrationAttempt(fixture.deps(), {
      attemptId: opened.attemptId,
      reason: "post-commit policy rejection",
    });
    expect(rejected.status).toBe(IntegrationAttemptStatus.Rejected);
    expect(fixture.git.calls.filter((call) => call === "abortMerge")).toEqual([]);
  });

  it("adopts an exact merge commit after state persistence fails", async () => {
    const fixture = createFixture();
    fixture.git.appliedFiles = ["src/base-change.ts", "src/memory.ts"];
    const opened = await openProjectIntegrationAttempt(
      fixture.deps(),
      mergeInput(),
    );
    await applyWorkerOutput(fixture.deps(), { attemptId: opened.attemptId });
    await runRequiredChecks(fixture.deps(), { attemptId: opened.attemptId });
    fixture.store.failNextUpdate = new Error("simulated state persistence crash");
    await expect(commitApprovedChanges(fixture.deps(), {
      attemptId: opened.attemptId,
      message: "chore(git): merge base branch",
      policy: policy(),
    })).rejects.toThrow("simulated state persistence crash");
    expect(fixture.store.get(opened.attemptId)?.status).toBe(
      IntegrationAttemptStatus.ChecksPassed,
    );
    const recovered = await commitApprovedChanges(fixture.deps(), {
      attemptId: opened.attemptId,
      message: "chore(git): merge base branch",
      policy: policy(),
    });
    expect(recovered.status).toBe(IntegrationAttemptStatus.CommitCreated);
    expect(fixture.git.calls.filter((call) => call === "commit")).toHaveLength(2);
  });

  it("does not record merge rejection when rollback fails", async () => {
    const fixture = createFixture();
    fixture.git.appliedFiles = ["src/base-change.ts", "src/memory.ts"];
    const opened = await openProjectIntegrationAttempt(
      fixture.deps(),
      mergeInput(),
    );
    await applyWorkerOutput(fixture.deps(), { attemptId: opened.attemptId });
    fixture.git.abortMergeError = new Error("merge abort failed");

    await expect(rejectIntegrationAttempt(fixture.deps(), {
      attemptId: opened.attemptId,
      reason: "merge review rejected",
    })).rejects.toMatchObject({
      reason: IntegrationErrorReason.MergeRollbackFailed,
    });
    expect(fixture.store.get(opened.attemptId)?.status).toBe(
      IntegrationAttemptStatus.Applied,
    );
  });
});
