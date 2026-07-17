import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { LocalGitIntegrationAdapter } from "../index";
import {
  createSemanticMergeFixture,
  git,
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

describe("local semantic merge integration", () => {
  it("applies a reviewed semantic resolution within the pinned parent footprint", async () => {
    const fixture = await createSemanticMergeFixture();
    const adapter = new LocalGitIntegrationAdapter({
      allowedPatchRoots: [fixture.rootDir],
    });
    const attempt = {
      targetWorkspacePath: fixture.workspacePath,
      expectedFiles: fixture.changedFiles,
      merge: {
        sourceRemote: "origin",
        sourceBranch: "base",
        sourceCommit: fixture.sourceCommit,
        expectedTargetCommit: fixture.targetCommit,
      },
    };
    const workerOutput = {
      workerJobId: "semantic-merge-resolution-worker",
      workspacePath: fixture.workspacePath,
      patchPath: fixture.patchPath,
      patchSha256: fixture.patchSha256,
      baseCommit: fixture.targetCommit,
      changedFiles: fixture.changedFiles,
    };

    await expect(
      adapter.applyWorkerOutput({ attempt, workerOutput }),
    ).resolves.toEqual({ changedFiles: fixture.changedFiles });
    const commit = await adapter.commit({
      workspacePath: fixture.workspacePath,
      message: "merge: integrate semantic base policy",
      files: fixture.changedFiles,
      identity: { name: "Integrator", email: "integrator@example.com" },
      expectedParentCommits: [fixture.targetCommit, fixture.sourceCommit],
    });

    expect(commit.parentCommits).toEqual([
      fixture.targetCommit,
      fixture.sourceCommit,
    ]);
    await expect(
      readFile(join(fixture.workspacePath, "pnpm-workspace.yaml"), "utf8"),
    ).resolves.toContain("better-sqlite3: true");
  });

  it("rejects a semantic merge path outside both pinned parent deltas", async () => {
    const fixture = await createSemanticMergeFixture({
      includeUnrelatedPath: true,
    });
    const adapter = new LocalGitIntegrationAdapter({
      allowedPatchRoots: [fixture.rootDir],
    });

    await expect(
      adapter.applyWorkerOutput({
        attempt: {
          targetWorkspacePath: fixture.workspacePath,
          expectedFiles: fixture.changedFiles,
          merge: {
            sourceRemote: "origin",
            sourceBranch: "base",
            sourceCommit: fixture.sourceCommit,
            expectedTargetCommit: fixture.targetCommit,
          },
        },
        workerOutput: {
          workerJobId: "semantic-merge-resolution-worker",
          workspacePath: fixture.workspacePath,
          patchPath: fixture.patchPath,
          patchSha256: fixture.patchSha256,
          baseCommit: fixture.targetCommit,
          changedFiles: fixture.changedFiles,
        },
      }),
    ).rejects.toThrow(
      "local_git_integration_merge_semantic_files_outside_parent_delta:README.md",
    );
    expect(
      (await gitOutput(fixture.workspacePath, ["rev-parse", "HEAD"])).trim(),
    ).toBe(fixture.targetCommit);
    expect(
      await gitOutput(fixture.workspacePath, ["status", "--porcelain"]),
    ).toBe("");
  });

  it("rejects a semantic merge after the reviewed source head advances", async () => {
    const fixture = await createSemanticMergeFixture();
    await git(fixture.workspacePath, ["checkout", "base"]);
    await writeFile(
      join(fixture.workspacePath, "BASE_ADVANCED.md"),
      "advanced\n",
    );
    await git(fixture.workspacePath, ["add", "BASE_ADVANCED.md"]);
    await git(fixture.workspacePath, ["commit", "-m", "feat: advance base"]);
    await git(fixture.workspacePath, ["push", "origin", "base"]);
    await git(fixture.workspacePath, ["checkout", "main"]);
    const adapter = new LocalGitIntegrationAdapter({
      allowedPatchRoots: [fixture.rootDir],
    });

    await expect(
      adapter.applyWorkerOutput({
        attempt: {
          targetWorkspacePath: fixture.workspacePath,
          expectedFiles: fixture.changedFiles,
          merge: {
            sourceRemote: "origin",
            sourceBranch: "base",
            sourceCommit: fixture.sourceCommit,
            expectedTargetCommit: fixture.targetCommit,
          },
        },
        workerOutput: {
          workerJobId: "semantic-merge-resolution-worker",
          workspacePath: fixture.workspacePath,
          patchPath: fixture.patchPath,
          patchSha256: fixture.patchSha256,
          baseCommit: fixture.targetCommit,
          changedFiles: fixture.changedFiles,
        },
      }),
    ).rejects.toThrow(
      "local_git_integration_merge_semantic_source_head_mismatch",
    );
    expect(
      (await gitOutput(fixture.workspacePath, ["rev-parse", "HEAD"])).trim(),
    ).toBe(fixture.targetCommit);
    expect(
      await gitOutput(fixture.workspacePath, ["status", "--porcelain"]),
    ).toBe("");
  });
});
