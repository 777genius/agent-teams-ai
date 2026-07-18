import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";
import {
  ReviewDecisionStatus,
  type ReviewDecision,
} from "@vioxen/subscription-runtime/worker-core";
import { resolveReviewedOutputAggregate } from "../application/project-control/reviewed-output-aggregate-materializer";
import { MAX_STAGED_PATCH_BYTES } from "../application/project-control/codex-goal-project-git";
import {
  reviewedWorkerOutputFormat,
  reviewedWorkerOutputIdentityPayload,
  type ReviewedWorkerOutputIdentity,
  type ReviewedWorkerOutputSnapshot,
} from "../reviewed-worker-output";

describe("reviewed output aggregate materializer", () => {
  it("binds ordered disjoint immutable outputs to one aggregate hash", async () => {
    const fixture = aggregateFixture();
    const first = await fixture.resolve([
      fixture.a.reviewedOutputId,
      fixture.b.reviewedOutputId,
    ]);
    const reversed = await fixture.resolve([
      fixture.b.reviewedOutputId,
      fixture.a.reviewedOutputId,
    ]);

    expect(first.changedFiles).toEqual(["a.ts", "b.ts"]);
    expect(first.patchSha256).not.toBe(reversed.patchSha256);
    expect(first.reviewedOutputIds).toEqual([
      fixture.a.reviewedOutputId,
      fixture.b.reviewedOutputId,
    ]);
  });

  it("rejects a base mismatch", async () => {
    const fixture = aggregateFixture({ bBaseCommit: "2".repeat(40) });
    await expect(
      fixture.resolve([fixture.a.reviewedOutputId, fixture.b.reviewedOutputId]),
    ).rejects.toThrow("reviewed_output_aggregate_base_commit_mismatch");
  });

  it("rejects overlapping changed files", async () => {
    const fixture = aggregateFixture({ bChangedFile: "a.ts" });
    await expect(
      fixture.resolve([fixture.a.reviewedOutputId, fixture.b.reviewedOutputId]),
    ).rejects.toThrow("reviewed_output_aggregate_changed_file_overlap:a.ts");
  });

  it("rejects a missing reviewed snapshot", async () => {
    const fixture = aggregateFixture();
    await expect(
      fixture.resolve([fixture.a.reviewedOutputId, "f".repeat(64)]),
    ).rejects.toThrow("reviewed_worker_output_not_found");
  });

  it("rejects a tampered reviewed patch", async () => {
    const fixture = aggregateFixture({ tamperB: true });
    await expect(
      fixture.resolve([fixture.a.reviewedOutputId, fixture.b.reviewedOutputId]),
    ).rejects.toThrow("reviewed_output_aggregate_patch_hash_mismatch");
  });

  it("rejects an aggregate bound to a different canonical target", async () => {
    const fixture = aggregateFixture();
    await expect(
      fixture.resolve(
        [fixture.a.reviewedOutputId, fixture.b.reviewedOutputId],
        "3".repeat(40),
      ),
    ).rejects.toThrow("reviewed_output_aggregate_target_commit_mismatch");
  });

  it("allows an aggregate exactly at the staged-index byte limit", async () => {
    const componentBytes = MAX_STAGED_PATCH_BYTES / 2;
    const aggregate = await resolvePatchAggregate([
      `${"a".repeat(componentBytes - 1)}\n`,
      `${"b".repeat(componentBytes - 1)}\n`,
    ]);

    expect(aggregate.patchByteLength).toBe(MAX_STAGED_PATCH_BYTES);
  });

  it("rejects an aggregate one byte over the staged-index limit", async () => {
    const componentBytes = MAX_STAGED_PATCH_BYTES / 2;

    await expect(
      resolvePatchAggregate([
        `${"a".repeat(componentBytes - 1)}\n`,
        `${"b".repeat(componentBytes)}\n`,
      ]),
    ).rejects.toThrow("reviewed_output_aggregate_patch_size_limit_exceeded");
  });
});

async function resolvePatchAggregate(patches: readonly string[]) {
  const items = patches.map((patch, index) =>
    snapshot({
      workerJobId: `worker-limit-${index}`,
      baseCommit: "1".repeat(40),
      changedFile: `limit-${index}.ts`,
      patch,
    }),
  );
  const byId = new Map(items.map((item) => [item.reviewedOutputId, item]));
  const patchById = new Map(
    items.map((item, index) => [item.reviewedOutputId, patches[index] ?? ""]),
  );
  return await resolveReviewedOutputAggregate(
    {
      store: {
        async create() {
          throw new Error("unexpected_create");
        },
        async commitReviewAttestation() {
          throw new Error("unexpected_attestation");
        },
        async get(reviewedOutputId) {
          return byId.get(reviewedOutputId);
        },
      },
      readPatch: async (item) => patchById.get(item.reviewedOutputId) ?? "",
    },
    {
      projectId: "project",
      reviewedOutputIds: items.map((item) => item.reviewedOutputId),
      expectedBaseCommit: "1".repeat(40),
    },
  );
}

function aggregateFixture(
  options: {
    readonly bBaseCommit?: string;
    readonly bChangedFile?: string;
    readonly tamperB?: boolean;
  } = {},
) {
  const baseCommit = "1".repeat(40);
  const aPatch = patch("a.ts", "a");
  const bPatch = patch(options.bChangedFile ?? "b.ts", "b");
  const a = snapshot({
    workerJobId: "worker-a",
    baseCommit,
    changedFile: "a.ts",
    patch: aPatch,
  });
  const b = snapshot({
    workerJobId: "worker-b",
    baseCommit: options.bBaseCommit ?? baseCommit,
    changedFile: options.bChangedFile ?? "b.ts",
    patch: bPatch,
  });
  const snapshots = new Map([
    [a.reviewedOutputId, a],
    [b.reviewedOutputId, b],
  ]);
  const patches = new Map([
    [a.reviewedOutputId, aPatch],
    [b.reviewedOutputId, options.tamperB ? `${bPatch}tampered` : bPatch],
  ]);
  return {
    a,
    b,
    resolve: async (
      reviewedOutputIds: readonly string[],
      expectedBaseCommit = baseCommit,
    ) =>
      await resolveReviewedOutputAggregate(
        {
          store: {
            async create() {
              throw new Error("unexpected_create");
            },
            async commitReviewAttestation() {
              throw new Error("unexpected_attestation");
            },
            async get(reviewedOutputId) {
              return snapshots.get(reviewedOutputId);
            },
          },
          readPatch: async (item) => patches.get(item.reviewedOutputId) ?? "",
        },
        { projectId: "project", reviewedOutputIds, expectedBaseCommit },
      ),
  };
}

function snapshot(input: {
  readonly workerJobId: string;
  readonly baseCommit: string;
  readonly changedFile: string;
  readonly patch: string;
}): ReviewedWorkerOutputSnapshot {
  const reviewDecision: ReviewDecision = {
    reviewedBy: "controller",
    decision: ReviewDecisionStatus.Approved,
    reason: "approved",
    approvedFiles: [input.changedFile],
    requiredChecks: [],
  };
  const identity: ReviewedWorkerOutputIdentity = {
    format: reviewedWorkerOutputFormat,
    formatRevision: 1 as const,
    projectId: "project",
    controllerJobId: "controller",
    workerJobId: input.workerJobId,
    taskId: input.workerJobId,
    sourceWorkspacePath: `/worktrees/${input.workerJobId}`,
    baseCommit: input.baseCommit,
    patchSha256: sha256(input.patch),
    changedFiles: [input.changedFile],
    reviewDecision,
  };
  const reviewedOutputId = sha256(
    reviewedWorkerOutputIdentityPayload(identity),
  );
  return {
    ...identity,
    reviewedOutputId,
    patchPath: `/reviewed/${reviewedOutputId}/output.patch`,
    patchByteLength: Buffer.byteLength(input.patch),
    capturedAt: "2026-07-16T00:00:00.000Z",
  };
}

function patch(path: string, value: string): string {
  return `diff --git a/${path} b/${path}\nnew file mode 100644\nindex 0000000..${value.repeat(7)}\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+${value}\n`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
