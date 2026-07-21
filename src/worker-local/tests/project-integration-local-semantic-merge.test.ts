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

  it("applies an explicitly reviewed semantic path outside both pinned parent deltas", async () => {
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
    ).resolves.toEqual({ changedFiles: [...fixture.changedFiles].sort() });
    await expect(
      readFile(join(fixture.workspacePath, "README.md"), "utf8"),
    ).resolves.toBe("unrelated semantic edit\n");
  });

  it("rebuilds a reviewed source-changed semantic path after unrelated live drift", async () => {
    const fixture = await createSemanticMergeFixture({
      includeSourceChangedSemanticPath: true,
    });
    await git(fixture.workspacePath, ["checkout", "base"]);
    await writeFile(
      join(fixture.workspacePath, "LIVE_DRIFT.md"),
      "unrelated live drift\n",
    );
    await git(fixture.workspacePath, ["add", "LIVE_DRIFT.md"]);
    await git(fixture.workspacePath, ["commit", "-m", "feat: advance live base"]);
    await git(fixture.workspacePath, ["push", "origin", "base"]);
    await git(fixture.workspacePath, ["checkout", "main"]);
    const adapter = new LocalGitIntegrationAdapter({
      allowedPatchRoots: [fixture.rootDir],
    });

    const applied = await adapter.applyWorkerOutput({
      attempt: semanticAttempt(fixture),
      workerOutput: semanticWorkerOutput(fixture),
    });

    expect(applied.changedFiles).toContain("README.md");
    await expect(
      readFile(join(fixture.workspacePath, "README.md"), "utf8"),
    ).resolves.toBe("reviewed semantic resolution\n");
  });

  it("rejects an unapproved semantic path outside both pinned parent deltas", async () => {
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
          expectedFiles: fixture.changedFiles.filter(
            (file) => file !== "README.md",
          ),
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
      "local_git_integration_merge_patch_outside_reviewed_scope",
    );
    expect(
      (await gitOutput(fixture.workspacePath, ["rev-parse", "HEAD"])).trim(),
    ).toBe(fixture.targetCommit);
    expect(
      await gitOutput(fixture.workspacePath, ["status", "--porcelain"]),
    ).toBe("");
  });

  it("merges an unrelated source descendant as the actual second parent", async () => {
    const fixture = await createSemanticMergeFixture();
    await git(fixture.workspacePath, ["checkout", "base"]);
    await writeFile(
      join(fixture.workspacePath, "BASE_ADVANCED.md"),
      "advanced\n",
    );
    await git(fixture.workspacePath, ["add", "BASE_ADVANCED.md"]);
    await git(fixture.workspacePath, ["commit", "-m", "feat: advance base"]);
    const advancedHead = (
      await gitOutput(fixture.workspacePath, ["rev-parse", "HEAD"])
    ).trim();
    await git(fixture.workspacePath, ["push", "origin", "base"]);
    await git(fixture.workspacePath, ["checkout", "main"]);
    const adapter = new LocalGitIntegrationAdapter({
      allowedPatchRoots: [fixture.rootDir],
    });

    const applied = await adapter.applyWorkerOutput({
      attempt: semanticAttempt(fixture),
      workerOutput: semanticWorkerOutput(fixture),
    });
    expect(applied.mergeSourceCommit).toBe(advancedHead);
    expect(applied.changedFiles).toContain("BASE_ADVANCED.md");

    const commit = await adapter.commit({
      workspacePath: fixture.workspacePath,
      message: "merge: integrate semantic base policy",
      files: applied.changedFiles,
      identity: { name: "Integrator", email: "integrator@example.com" },
      expectedParentCommits: [fixture.targetCommit, advancedHead],
    });
    expect(commit.parentCommits).toEqual([
      fixture.targetCommit,
      advancedHead,
    ]);
  });

  it("rejects a source descendant that touches reviewed semantic scope", async () => {
    const fixture = await createSemanticMergeFixture();
    await git(fixture.workspacePath, ["checkout", "base"]);
    await writeFile(
      join(fixture.workspacePath, "package.json"),
      '{"policy":"advanced-base"}\n',
    );
    await git(fixture.workspacePath, ["add", "package.json"]);
    await git(fixture.workspacePath, ["commit", "-m", "feat: advance policy"]);
    await git(fixture.workspacePath, ["push", "origin", "base"]);
    await git(fixture.workspacePath, ["checkout", "main"]);
    const adapter = new LocalGitIntegrationAdapter({
      allowedPatchRoots: [fixture.rootDir],
    });

    await expect(adapter.applyWorkerOutput({
      attempt: semanticAttempt(fixture),
      workerOutput: semanticWorkerOutput(fixture),
    })).rejects.toThrow(
      "local_git_integration_merge_semantic_descendant_touched_reviewed_scope:package.json",
    );
    await expectCleanTarget(fixture.workspacePath, fixture.targetCommit);
  });

  it("rejects a source descendant that changes the reviewed conflict set", async () => {
    const fixture = await createSemanticMergeFixture();
    await writeFile(
      join(fixture.workspacePath, "CONFLICT_DRIFT.md"),
      "target\n",
    );
    await git(fixture.workspacePath, ["add", "CONFLICT_DRIFT.md"]);
    await git(fixture.workspacePath, ["commit", "-m", "feat: target drift"]);
    const advancedTarget = (
      await gitOutput(fixture.workspacePath, ["rev-parse", "HEAD"])
    ).trim();
    await git(fixture.workspacePath, ["checkout", "base"]);
    await writeFile(
      join(fixture.workspacePath, "CONFLICT_DRIFT.md"),
      "source\n",
    );
    await git(fixture.workspacePath, ["add", "CONFLICT_DRIFT.md"]);
    await git(fixture.workspacePath, ["commit", "-m", "feat: source drift"]);
    await git(fixture.workspacePath, ["push", "origin", "base"]);
    await git(fixture.workspacePath, ["checkout", "main"]);
    const adapter = new LocalGitIntegrationAdapter({
      allowedPatchRoots: [fixture.rootDir],
    });

    await expect(adapter.applyWorkerOutput({
      attempt: {
        ...semanticAttempt(fixture),
        merge: {
          ...semanticAttempt(fixture).merge,
          expectedTargetCommit: advancedTarget,
        },
      },
      workerOutput: {
        ...semanticWorkerOutput(fixture),
        baseCommit: advancedTarget,
      },
    })).rejects.toThrow(
      "local_git_integration_merge_semantic_conflict_scope_changed",
    );
    await expectCleanTarget(fixture.workspacePath, advancedTarget);
  });

  it("rejects matching conflict paths when their merge stages changed", async () => {
    const fixture = await createSemanticMergeFixture();
    await writeSemanticParentFiles(fixture.workspacePath, {
      packagePolicy: "middle",
      workflowName: "Hosted Web CI",
      workspacePackage: "middle/*",
    });
    await git(fixture.workspacePath, ["add", "."]);
    await git(fixture.workspacePath, ["commit", "-m", "feat: middle target"]);
    const middleTarget = (
      await gitOutput(fixture.workspacePath, ["rev-parse", "HEAD"])
    ).trim();
    await writeSemanticParentFiles(fixture.workspacePath, {
      packagePolicy: "target",
      workflowName: "Hosted Web CI",
      workspacePackage: "apps/*",
    });
    await git(fixture.workspacePath, ["add", "."]);
    await git(fixture.workspacePath, ["commit", "-m", "feat: final target"]);
    const finalTarget = (
      await gitOutput(fixture.workspacePath, ["rev-parse", "HEAD"])
    ).trim();

    await git(fixture.workspacePath, ["checkout", "base"]);
    await git(fixture.workspacePath, [
      "merge",
      "--no-ff",
      "--no-commit",
      middleTarget,
    ]).catch(() => undefined);
    await writeSemanticParentFiles(fixture.workspacePath, {
      packagePolicy: "base",
      workflowName: "CI",
      workspacePackage: "packages/*",
      includeSourcePolicy: true,
    });
    await git(fixture.workspacePath, ["add", "."]);
    await git(fixture.workspacePath, ["commit", "-m", "merge: retain source"]);
    await git(fixture.workspacePath, ["push", "origin", "base"]);
    await git(fixture.workspacePath, ["checkout", "main"]);
    const adapter = new LocalGitIntegrationAdapter({
      allowedPatchRoots: [fixture.rootDir],
    });

    await expect(adapter.applyWorkerOutput({
      attempt: {
        ...semanticAttempt(fixture),
        merge: {
          ...semanticAttempt(fixture).merge,
          expectedTargetCommit: finalTarget,
        },
      },
      workerOutput: {
        ...semanticWorkerOutput(fixture),
        baseCommit: finalTarget,
      },
    })).rejects.toThrow(
      "local_git_integration_merge_semantic_conflict_stages_changed",
    );
    await expectCleanTarget(fixture.workspacePath, finalTarget);
  });

  it("rejects a rewritten non-ancestor source", async () => {
    const fixture = await createSemanticMergeFixture();
    await git(fixture.workspacePath, ["checkout", "--orphan", "rewritten-base"]);
    await git(fixture.workspacePath, ["rm", "-rf", "."]);
    await writeFile(join(fixture.workspacePath, "REWRITTEN.md"), "rewritten\n");
    await git(fixture.workspacePath, ["add", "REWRITTEN.md"]);
    await git(fixture.workspacePath, ["commit", "-m", "feat: rewrite base"]);
    await git(fixture.workspacePath, ["push", "--force", "origin", "HEAD:base"]);
    await git(fixture.workspacePath, ["checkout", "main"]);
    const adapter = new LocalGitIntegrationAdapter({
      allowedPatchRoots: [fixture.rootDir],
    });

    await expect(adapter.applyWorkerOutput({
      attempt: semanticAttempt(fixture),
      workerOutput: semanticWorkerOutput(fixture),
    })).rejects.toThrow(
      "local_git_integration_merge_source_commit_not_ancestor",
    );
    await expectCleanTarget(fixture.workspacePath, fixture.targetCommit);
  });

  it("rejects when the source moves during fetch", async () => {
    const fixture = await createSemanticMergeFixture();
    const advancedHead = await createUnpushedBaseAdvance(
      fixture.workspacePath,
      "AFTER_FETCH.md",
    );
    const adapter = new MovingSourceAdapter({
      fixture,
      moveOnObservation: 2,
      advancedHead,
    });

    await expect(adapter.applyWorkerOutput({
      attempt: semanticAttempt(fixture),
      workerOutput: semanticWorkerOutput(fixture),
    })).rejects.toThrow("local_git_integration_merge_source_head_changed");
    await expectCleanTarget(fixture.workspacePath, fixture.targetCommit);
  });

  it("rejects when the source moves after compatibility probing", async () => {
    const fixture = await createSemanticMergeFixture();
    await git(fixture.workspacePath, ["checkout", "base"]);
    await writeFile(join(fixture.workspacePath, "FIRST_ADVANCE.md"), "first\n");
    await git(fixture.workspacePath, ["add", "FIRST_ADVANCE.md"]);
    await git(fixture.workspacePath, ["commit", "-m", "feat: first advance"]);
    await git(fixture.workspacePath, ["push", "origin", "base"]);
    await writeFile(join(fixture.workspacePath, "SECOND_ADVANCE.md"), "second\n");
    await git(fixture.workspacePath, ["add", "SECOND_ADVANCE.md"]);
    await git(fixture.workspacePath, ["commit", "-m", "feat: second advance"]);
    const secondHead = (
      await gitOutput(fixture.workspacePath, ["rev-parse", "HEAD"])
    ).trim();
    await git(fixture.workspacePath, ["checkout", "main"]);
    const adapter = new MovingSourceAdapter({
      fixture,
      moveOnObservation: 3,
      advancedHead: secondHead,
    });

    await expect(adapter.applyWorkerOutput({
      attempt: semanticAttempt(fixture),
      workerOutput: semanticWorkerOutput(fixture),
    })).rejects.toThrow("local_git_integration_merge_source_head_changed");
    await expectCleanTarget(fixture.workspacePath, fixture.targetCommit);
  });
});

type SemanticFixture = Awaited<ReturnType<typeof createSemanticMergeFixture>>;

function semanticAttempt(fixture: SemanticFixture) {
  return {
    targetWorkspacePath: fixture.workspacePath,
    expectedFiles: fixture.changedFiles,
    merge: {
      sourceRemote: "origin",
      sourceBranch: "base",
      sourceCommit: fixture.sourceCommit,
      expectedTargetCommit: fixture.targetCommit,
    },
  };
}

function semanticWorkerOutput(fixture: SemanticFixture) {
  return {
    workerJobId: "semantic-merge-resolution-worker",
    workspacePath: fixture.workspacePath,
    patchPath: fixture.patchPath,
    patchSha256: fixture.patchSha256,
    baseCommit: fixture.targetCommit,
    changedFiles: fixture.changedFiles,
  };
}

class MovingSourceAdapter extends LocalGitIntegrationAdapter {
  private observations = 0;

  constructor(private readonly movement: {
    readonly fixture: SemanticFixture;
    readonly moveOnObservation: number;
    readonly advancedHead: string;
  }) {
    super({ allowedPatchRoots: [movement.fixture.rootDir] });
  }

  override async remoteBranchCommit(input: {
    readonly workspacePath: string;
    readonly remote: string;
    readonly branch: string;
  }): Promise<string | null> {
    this.observations += 1;
    if (this.observations === this.movement.moveOnObservation) {
      await git(this.movement.fixture.workspacePath, [
        "push",
        "origin",
        `${this.movement.advancedHead}:base`,
      ]);
    }
    return super.remoteBranchCommit(input);
  }
}

async function createUnpushedBaseAdvance(
  workspacePath: string,
  file: string,
): Promise<string> {
  await git(workspacePath, ["checkout", "base"]);
  await writeFile(join(workspacePath, file), "advanced\n");
  await git(workspacePath, ["add", file]);
  await git(workspacePath, ["commit", "-m", "feat: advance during fetch"]);
  const advancedHead = (
    await gitOutput(workspacePath, ["rev-parse", "HEAD"])
  ).trim();
  await git(workspacePath, ["checkout", "main"]);
  return advancedHead;
}

async function writeSemanticParentFiles(
  workspacePath: string,
  input: {
    readonly packagePolicy: string;
    readonly workflowName: string;
    readonly workspacePackage: string;
    readonly includeSourcePolicy?: boolean;
  },
): Promise<void> {
  await writeFile(
    join(workspacePath, "package.json"),
    `{"policy":"${input.packagePolicy}"}\n`,
  );
  await writeFile(
    join(workspacePath, ".github", "workflows", "ci.yml"),
    `${input.workflowName === "CI" ? "name: CI" : `name: ${input.workflowName}`}\njobs:\n  test:\n    runs-on: ubuntu-latest\n${input.includeSourcePolicy ? "    timeout-minutes: 20\n" : ""}`,
  );
  await writeFile(
    join(workspacePath, "pnpm-workspace.yaml"),
    input.includeSourcePolicy
      ? `packages:\n  - ${input.workspacePackage}\nallowBuilds:\n  better-sqlite3: true\n`
      : `packages:\n  - packages/*\n  - ${input.workspacePackage}\n`,
  );
}

async function expectCleanTarget(
  workspacePath: string,
  targetCommit: string,
): Promise<void> {
  expect((await gitOutput(workspacePath, ["rev-parse", "HEAD"])).trim()).toBe(
    targetCommit,
  );
  expect(await gitOutput(workspacePath, ["status", "--porcelain"])).toBe("");
}
