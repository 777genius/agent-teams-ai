import { describe, expect, it, vi } from "vitest";

import { inspectReviewedMergeScope } from "../project-integration-local-merge-scope";

describe("reviewed merge scope", () => {
  it("allows an approved Git-created file-location conflict destination", async () => {
    const destination = "src/features/view/output/Coordinator.ts";
    const source = "src/main/ipc/Coordinator.ts";
    const runtime = {
      git: vi.fn().mockResolvedValue({ stdout: `${"a".repeat(40)}\n` }),
      gitNullTerminatedPaths: vi.fn().mockResolvedValue([source]),
    };

    await expect(
      inspectReviewedMergeScope({
        runtime,
        workspacePath: "/tmp/integration",
        targetCommit: "b".repeat(40),
        sourceCommit: "c".repeat(40),
        conflictFiles: [destination],
        mergeFootprint: [source, destination],
        approvedFiles: [source, destination],
        patchFiles: [source],
      }),
    ).resolves.toEqual({
      parentFootprint: [destination, source],
      semanticFiles: [source],
    });
  });

  it("still rejects an unapproved file-location conflict destination", async () => {
    const destination = "src/features/view/output/Coordinator.ts";

    await expect(
      inspectReviewedMergeScope({
        runtime: {
          git: vi.fn(),
          gitNullTerminatedPaths: vi.fn(),
        },
        workspacePath: "/tmp/integration",
        targetCommit: "b".repeat(40),
        sourceCommit: "c".repeat(40),
        conflictFiles: [destination],
        mergeFootprint: [destination],
        approvedFiles: [],
        patchFiles: [],
      }),
    ).rejects.toThrow(
      `local_git_integration_merge_conflicts_missing_from_reviewed_scope:${destination}`,
    );
  });
});
