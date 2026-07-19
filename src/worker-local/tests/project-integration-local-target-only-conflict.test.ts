import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { LocalGitIntegrationAdapter } from "../index";
import {
  createTargetOnlyConflictMergeFixture,
  gitOutput,
  tempRoots,
} from "./project-integration-local-adapters.fixture";

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("local target-only conflict integration", () => {
  it("resolves an approved target-only conflict outside the exact worker patch", async () => {
    const fixture = await createTargetOnlyConflictMergeFixture();
    const adapter = new LocalGitIntegrationAdapter({
      allowedPatchRoots: [fixture.rootDir],
    });
    const attempt = {
      targetWorkspacePath: fixture.workspacePath,
      expectedFiles: fixture.approvedFiles,
      merge: {
        sourceRemote: "origin",
        sourceBranch: "base",
        sourceCommit: fixture.sourceCommit,
        expectedTargetCommit: fixture.targetCommit,
      },
    };
    const workerOutput = {
      workerJobId: "target-only-conflict-resolution-worker",
      workspacePath: fixture.workspacePath,
      patchPath: fixture.patchPath,
      patchSha256: fixture.patchSha256,
      baseCommit: fixture.targetCommit,
      changedFiles: fixture.patchFiles,
    };

    await expect(
      adapter.applyWorkerOutput({ attempt, workerOutput }),
    ).resolves.toEqual({ changedFiles: fixture.expectedAppliedFiles });
    await expect(
      readFile(join(fixture.workspacePath, "src", "stop-flow.ts"), "utf8"),
    ).resolves.toBe("src/stop-flow.ts: target\n");
    for (const file of fixture.patchFiles.filter(
      (file) => file !== "src/member-lifecycle.ts",
    )) {
      await expect(
        readFile(join(fixture.workspacePath, file), "utf8"),
      ).resolves.toBe(`${file}: reviewed merge\n`);
    }
    await expect(
      readFile(
        join(fixture.workspacePath, "src", "member-lifecycle.ts"),
        "utf8",
      ),
    ).resolves.toContain("base-side lifecycle policy");
    await expect(
      readFile(
        join(fixture.workspacePath, "src", "member-lifecycle.ts"),
        "utf8",
      ),
    ).resolves.toContain("worker-side lifecycle assertion");

    const commit = await adapter.commit({
      workspacePath: fixture.workspacePath,
      message: "merge: integrate reviewed target-only resolution",
      files: fixture.expectedAppliedFiles,
      identity: { name: "Integrator", email: "integrator@example.com" },
      expectedParentCommits: [fixture.targetCommit, fixture.sourceCommit],
    });
    expect(commit.parentCommits).toEqual([
      fixture.targetCommit,
      fixture.sourceCommit,
    ]);
    await expect(
      gitOutput(fixture.workspacePath, [
        "diff",
        "--name-only",
        `${commit.commitSha}^1`,
        commit.commitSha,
      ]),
    ).resolves.not.toContain("src/stop-flow.ts");
  });

  it("rejects a target-only conflict outside the approved merge scope", async () => {
    const fixture = await createTargetOnlyConflictMergeFixture();
    const adapter = new LocalGitIntegrationAdapter({
      allowedPatchRoots: [fixture.rootDir],
    });

    await expect(
      adapter.applyWorkerOutput({
        attempt: {
          targetWorkspacePath: fixture.workspacePath,
          expectedFiles: fixture.patchFiles,
          merge: {
            sourceRemote: "origin",
            sourceBranch: "base",
            sourceCommit: fixture.sourceCommit,
            expectedTargetCommit: fixture.targetCommit,
          },
        },
        workerOutput: {
          workerJobId: "unapproved-target-only-conflict-worker",
          workspacePath: fixture.workspacePath,
          patchPath: fixture.patchPath,
          patchSha256: fixture.patchSha256,
          baseCommit: fixture.targetCommit,
          changedFiles: fixture.patchFiles,
        },
      }),
    ).rejects.toThrow(
      "local_git_integration_merge_conflicts_missing_from_reviewed_scope:src/stop-flow.ts",
    );
    expect(
      await gitOutput(fixture.workspacePath, ["status", "--porcelain"]),
    ).toBe("");
  });

  it("rejects patch files omitted from immutable worker changedFiles", async () => {
    const fixture = await createTargetOnlyConflictMergeFixture();
    const adapter = new LocalGitIntegrationAdapter({
      allowedPatchRoots: [fixture.rootDir],
    });

    await expect(
      adapter.applyWorkerOutput({
        attempt: {
          targetWorkspacePath: fixture.workspacePath,
          expectedFiles: fixture.approvedFiles,
          merge: {
            sourceRemote: "origin",
            sourceBranch: "base",
            sourceCommit: fixture.sourceCommit,
            expectedTargetCommit: fixture.targetCommit,
          },
        },
        workerOutput: {
          workerJobId: "mismatched-target-only-patch-worker",
          workspacePath: fixture.workspacePath,
          patchPath: fixture.patchPath,
          patchSha256: fixture.patchSha256,
          baseCommit: fixture.targetCommit,
          changedFiles: ["src/service.ts"],
        },
      }),
    ).rejects.toThrow("local_git_integration_merge_resolution_set_mismatch");
    expect(
      await gitOutput(fixture.workspacePath, ["status", "--porcelain"]),
    ).toBe("");
  });
});
