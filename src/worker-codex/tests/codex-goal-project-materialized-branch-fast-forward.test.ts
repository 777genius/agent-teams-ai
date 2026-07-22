import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { fastForwardMaterializedWorktreeBranch } from "../application/project-control/codex-goal-project-git";
import {
  git,
  gitInitRepository,
  gitStdout,
} from "./codex-goal-mcp-test-support";

describe("materialized project branch fast-forward", () => {
  it("rejects an injected branch change before merge without advancing stale files", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "subscription-runtime-materialized-branch-race-"),
    );
    const sourceWorkspacePath = join(root, "source");
    const targetWorkspacePath = join(root, "worktrees", "target");
    const divergentWorkspacePath = join(root, "worktrees", "divergent");
    const branch = "fix/materialized-target";
    try {
      await mkdir(sourceWorkspacePath, { recursive: true });
      await gitInitRepository(sourceWorkspacePath);
      await writeFile(join(sourceWorkspacePath, "base.md"), "base\n");
      await git(sourceWorkspacePath, ["add", "base.md"]);
      await git(sourceWorkspacePath, ["commit", "-m", "test: base"]);
      const baseSha = (
        await gitStdout(sourceWorkspacePath, ["rev-parse", "HEAD"])
      ).trim();
      await git(sourceWorkspacePath, ["branch", branch, baseSha]);

      await writeFile(join(sourceWorkspacePath, "next.md"), "next\n");
      await git(sourceWorkspacePath, ["add", "next.md"]);
      await git(sourceWorkspacePath, ["commit", "-m", "test: next"]);
      const nextSha = (
        await gitStdout(sourceWorkspacePath, ["rev-parse", "HEAD"])
      ).trim();

      await mkdir(join(root, "worktrees"), { recursive: true });
      await git(sourceWorkspacePath, [
        "worktree",
        "add",
        "-b",
        "test/divergent",
        divergentWorkspacePath,
        baseSha,
      ]);
      await writeFile(join(divergentWorkspacePath, "divergent.md"), "race\n");
      await git(divergentWorkspacePath, ["add", "divergent.md"]);
      await git(divergentWorkspacePath, ["commit", "-m", "test: divergent"]);
      const divergentSha = (
        await gitStdout(divergentWorkspacePath, ["rev-parse", "HEAD"])
      ).trim();
      await git(sourceWorkspacePath, [
        "worktree",
        "remove",
        divergentWorkspacePath,
      ]);
      await git(sourceWorkspacePath, [
        "worktree",
        "add",
        targetWorkspacePath,
        branch,
      ]);

      await expect(
        fastForwardMaterializedWorktreeBranch({
          workspacePath: targetWorkspacePath,
          branch,
          expectedCurrentRevision: baseSha,
          expectedNextRevision: nextSha,
          beforeFastForwardForTest: async () => {
            await git(sourceWorkspacePath, [
              "update-ref",
              `refs/heads/${branch}`,
              divergentSha,
              baseSha,
            ]);
          },
        }),
      ).rejects.toThrow("project_control_existing_branch_revision_changed");
      await expect(
        gitStdout(targetWorkspacePath, ["rev-parse", "HEAD"]),
      ).resolves.toBe(`${divergentSha}\n`);
      await expect(
        access(join(targetWorkspacePath, "next.md")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        access(join(targetWorkspacePath, "divergent.md")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
