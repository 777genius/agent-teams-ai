import { describe, expect, it } from "vitest";

import {
  recordFailedNoOutput,
  type ConsumedOutputLedgerWriterPort,
  type ConsumedOutputRecord,
  type TerminalOutputDecision,
} from "../index";

describe("recordFailedNoOutput", () => {
  it("records an append-only correction from complete clean evidence", async () => {
    const writer = new CapturingWriter();

    const receipt = await recordFailedNoOutput({ writer }, {
      allowedLedgerRoots: ["/project/control/ledger"],
      ledgerRoot: "/project/control/ledger",
      sourceRecord: sourceRecord(),
      jobId: "project-worker-1",
      workspace: "/project/worktrees/project-worker-1",
      workerAlive: false,
      workspaceDirty: false,
      attemptId: "terminalize-project-worker-1",
      closedAt: "2026-07-13T20:00:00.001Z",
      failureCategory: "infrastructure",
      failureCode: "prewarm_failed_before_task",
      note: "Worker failed before producing authored output.",
    });

    expect(receipt.decision).toMatchObject({
      status: "failed_no_output",
      output: { authoredChanges: false, workspaceDirty: false },
      backup: {
        workspace: "/project/worktrees/project-worker-1",
      },
    });
  });

  it("rejects live, dirty, or incomplete evidence", async () => {
    const writer = new CapturingWriter();
    const base = {
      allowedLedgerRoots: ["/project/control/ledger"],
      ledgerRoot: "/project/control/ledger",
      sourceRecord: sourceRecord(),
      jobId: "project-worker-1",
      workspace: "/project/worktrees/project-worker-1",
      workerAlive: false,
      workspaceDirty: false as boolean | undefined,
      attemptId: "terminalize-project-worker-1",
      closedAt: "2026-07-13T20:00:00.001Z",
      failureCategory: "infrastructure",
      failureCode: "prewarm_failed_before_task",
      note: "Worker failed before producing authored output.",
    };

    await expect(recordFailedNoOutput({ writer }, {
      ...base,
      workerAlive: true,
    })).rejects.toThrow("failed_no_output_worker_still_alive");
    await expect(recordFailedNoOutput({ writer }, {
      ...base,
      workspaceDirty: true,
    })).rejects.toThrow("failed_no_output_clean_workspace_required");
    await expect(recordFailedNoOutput({ writer }, {
      ...base,
      sourceRecord: {
        ...base.sourceRecord,
        reclassifiableAsFailedNoOutput: false,
      },
    })).rejects.toThrow("failed_no_output_source_evidence_invalid");
  });

  it("requires the correction timestamp to supersede the source record", async () => {
    await expect(recordFailedNoOutput({ writer: new CapturingWriter() }, {
      allowedLedgerRoots: ["/project/control/ledger"],
      ledgerRoot: "/project/control/ledger",
      sourceRecord: sourceRecord(),
      jobId: "project-worker-1",
      workspace: "/project/worktrees/project-worker-1",
      workerAlive: false,
      workspaceDirty: false,
      attemptId: "terminalize-project-worker-1",
      closedAt: "2026-07-13T20:00:00.000Z",
      failureCategory: "infrastructure",
      failureCode: "prewarm_failed_before_task",
      note: "Worker failed before producing authored output.",
    })).rejects.toThrow("failed_no_output_closed_at_must_follow_source");
  });

  it("allows relocating legacy preexisting patch evidence into terminal backup", async () => {
    const source = sourceRecord();
    await expect(recordFailedNoOutput({ writer: new CapturingWriter() }, {
      allowedLedgerRoots: ["/project/control/ledger"],
      ledgerRoot: "/project/control/ledger",
      sourceRecord: {
        ...source,
        status: "failed_no_output",
        backupWorkspaceDirty: true,
        reclassifiableAsFailedNoOutput: false,
        evidence: [
          "preexisting workspace patch is outside terminal backup",
          "failed_no_output record contradicts non-empty workspace status evidence",
        ],
      },
      jobId: "project-worker-1",
      workspace: "/project/worktrees/project-worker-1",
      workerAlive: false,
      workspaceDirty: true,
      attemptId: "relocate-legacy-baseline-v2",
      closedAt: "2026-07-13T20:00:00.001Z",
      failureCategory: "infrastructure",
      failureCode: "legacy_shared_workspace",
      note: "Relocated the immutable preexisting patch into terminal backup.",
      preexistingWorkspacePatch: {
        path: "/project/evidence/project-worker-1/preexisting-workspace.patch",
        sha256: "a".repeat(64),
      },
    })).resolves.toMatchObject({
      decision: {
        status: "failed_no_output",
        preexistingWorkspacePatch: {
          path: "/project/evidence/project-worker-1/preexisting-workspace.patch",
          sha256: "a".repeat(64),
        },
      },
    });
  });

  it("rejects unrelated evidence during legacy baseline relocation", async () => {
    const source = sourceRecord();
    await expect(recordFailedNoOutput({ writer: new CapturingWriter() }, {
      allowedLedgerRoots: ["/project/control/ledger"],
      ledgerRoot: "/project/control/ledger",
      sourceRecord: {
        ...source,
        status: "failed_no_output",
        backupWorkspaceDirty: true,
        reclassifiableAsFailedNoOutput: false,
        evidence: [
          "preexisting workspace patch is outside terminal backup",
          "failed_no_output record contradicts non-empty workspace status evidence",
          "backup statusPath is missing",
        ],
      },
      jobId: "project-worker-1",
      workspace: "/project/worktrees/project-worker-1",
      workerAlive: false,
      workspaceDirty: true,
      attemptId: "relocate-invalid-baseline-v2",
      closedAt: "2026-07-13T20:00:00.001Z",
      failureCategory: "infrastructure",
      failureCode: "legacy_shared_workspace",
      note: "This correction must remain blocked.",
      preexistingWorkspacePatch: {
        path: "/project/evidence/project-worker-1/preexisting-workspace.patch",
        sha256: "a".repeat(64),
      },
    })).rejects.toThrow("failed_no_output_source_evidence_invalid");
  });
});

class CapturingWriter implements ConsumedOutputLedgerWriterPort {
  async record(input: {
    readonly ledgerRoot: string;
    readonly decision: TerminalOutputDecision;
  }) {
    return {
      ledgerPath: `${input.ledgerRoot}/items/${input.decision.jobId}.json`,
      decision: input.decision,
      idempotentReplay: false,
    };
  }
}

function sourceRecord(): ConsumedOutputRecord {
  return {
    jobId: "project-worker-1",
    status: "rejected",
    ledgerPath: "/project/control/ledger/items/project-worker-1.json",
    closedAt: "2026-07-13T20:00:00.000Z",
    workspace: "/project/worktrees/project-worker-1",
    backup: {
      workspace: "/project/worktrees/project-worker-1",
      statusPath: "/project/evidence/project-worker-1/git-status.txt",
      patchPath: "/project/evidence/project-worker-1/worker-output.patch",
      numstatPath: "/project/evidence/project-worker-1/tracked.numstat",
    },
    backupEvidenceValid: true,
    backupWorkspaceDirty: false,
    reclassifiableAsFailedNoOutput: true,
    hasAuthoredOutput: false,
    valid: false,
    evidence: [
      "terminal output status rejected has no authored output evidence; use failed_no_output for infrastructure failures",
    ],
  };
}
