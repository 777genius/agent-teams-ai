import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  pushProjectBranch,
  resolveProjectExternalRewriteRecovery,
} from "../application/project-control/codex-goal-project-external-rewrite-recovery";
import { git, gitInitRepository, gitStdout } from "./codex-goal-mcp-test-support";

const execFileAsync = promisify(execFile);

describe("project external rewrite recovery", () => {
  it("fails closed on incomplete or stale pins and restores only an exact lease", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-rewrite-recovery-"));
    const workspacePath = join(root, "workspace");
    const remotePath = join(root, "remote.git");
    try {
      await mkdir(workspacePath, { recursive: true });
      await gitInitRepository(workspacePath);
      await writeFile(join(workspacePath, "state.txt"), "remote rewrite\n");
      await git(workspacePath, ["add", "state.txt"]);
      await git(workspacePath, ["commit", "-m", "test: remote rewrite"]);
      const expectedRemoteCommit = (await gitStdout(
        workspacePath,
        ["rev-parse", "HEAD"],
      )).trim();
      await execFileAsync("git", ["init", "--bare", remotePath]);
      await git(workspacePath, ["remote", "add", "origin", remotePath]);
      await git(workspacePath, ["push", "origin", "HEAD:refs/heads/main"]);

      await writeFile(join(workspacePath, "state.txt"), "accepted canonical\n");
      await git(workspacePath, ["add", "state.txt"]);
      await git(workspacePath, ["commit", "-m", "test: accepted canonical"]);
      const expectedLocalCommit = (await gitStdout(
        workspacePath,
        ["rev-parse", "HEAD"],
      )).trim();
      const baseInput = {
        workspacePath,
        branch: "main",
        remote: "origin",
        force: true,
        expectedRemoteCommit,
        expectedLocalCommit,
        confirmExternalRewriteRecovery: false,
      } as const;

      expect(() => resolveProjectExternalRewriteRecovery(baseInput)).toThrow(
        "project_control_confirm_external_rewrite_recovery_required",
      );
      expect(() => resolveProjectExternalRewriteRecovery({
        ...baseInput,
        expectedLocalCommit: undefined,
        confirmExternalRewriteRecovery: true,
      })).toThrow("project_control_expected_local_commit_invalid");
      await expect(pushProjectBranch({
        ...baseInput,
        expectedLocalCommit: expectedRemoteCommit,
        confirmExternalRewriteRecovery: true,
      })).rejects.toThrow("project_control_external_rewrite_local_commit_mismatch");
      await expect(pushProjectBranch({
        ...baseInput,
        expectedRemoteCommit: expectedLocalCommit,
        confirmExternalRewriteRecovery: true,
      })).rejects.toThrow("project_control_external_rewrite_remote_commit_mismatch");

      await expect(pushProjectBranch({
        ...baseInput,
        confirmExternalRewriteRecovery: true,
      })).resolves.toBeUndefined();
      const restoredRemoteCommit = (await execFileAsync("git", [
        "--git-dir",
        remotePath,
        "rev-parse",
        "refs/heads/main",
      ])).stdout.trim();
      expect(restoredRemoteCommit).toBe(expectedLocalCommit);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
