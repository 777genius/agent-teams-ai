import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  GitPatchPreserver,
  captureGitWorkspaceChangedFiles,
  createCodexGoalResultRecorder,
} from "../codex-goal-runtime-result-io";

const execFileAsync = promisify(execFile);

describe("codex goal runtime result IO", () => {
  it("writes latest-result atomically through the local writer adapter", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-result-"));
    const outputPath = join(root, "latest-result.json");
    try {
      const recorder = createCodexGoalResultRecorder({
        outputPath,
        clock: { now: () => new Date("2026-07-01T00:00:00.000Z") },
      });

      await recorder.record({
        status: "failed",
        reason: "runner_exception",
        evidence: ["runner threw"],
        blockers: ["runner_exception"],
      });

      expect(JSON.parse(await readFile(outputPath, "utf8"))).toMatchObject({
        status: "failed",
        changedFiles: [],
        evidence: ["runner threw"],
        blockers: ["runner_exception"],
        nextAction: "recover",
        updatedAt: "2026-07-01T00:00:00.000Z",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves untracked files in a git worktree without an initial commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-patch-unborn-"));
    const outputPath = join(root, "preserved.patch");
    try {
      await execFileAsync("git", ["init"], { cwd: root });
      await writeFile(join(root, "new.txt"), "new file\n");

      const artifact = await new GitPatchPreserver().preserve({
        workspacePath: root,
        outputPath,
      });

      expect(artifact).toMatchObject({
        kind: "patch",
        path: outputPath,
      });
      expect(await readFile(outputPath, "utf8")).toContain("new file");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves a trailing blank context line before an untracked file patch", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-patch-boundary-"));
    const workspacePath = join(root, "workspace");
    const outputPath = join(root, "preserved.patch");
    try {
      await mkdir(workspacePath);
      await execFileAsync("git", ["init"], { cwd: workspacePath });
      await execFileAsync("git", ["config", "user.email", "runtime-test@example.com"], {
        cwd: workspacePath,
      });
      await execFileAsync("git", ["config", "user.name", "Runtime Test"], {
        cwd: workspacePath,
      });
      await writeFile(join(workspacePath, "tracked.txt"), "before\n\n");
      await execFileAsync("git", ["add", "tracked.txt"], { cwd: workspacePath });
      await execFileAsync("git", ["commit", "-m", "test: initialize fixture"], {
        cwd: workspacePath,
      });

      await writeFile(join(workspacePath, "tracked.txt"), "after\n\n");
      await writeFile(join(workspacePath, "untracked.txt"), "new file\n");
      const { stdout: trackedPatch } = await execFileAsync(
        "git",
        ["diff", "--binary", "HEAD", "--"],
        { cwd: workspacePath },
      );
      expect(trackedPatch.endsWith(" \n")).toBe(true);

      await new GitPatchPreserver().preserve({
        workspacePath,
        outputPath,
      });

      const preservedPatch = await readFile(outputPath, "utf8");
      expect(preservedPatch).toContain("+after\n \ndiff --git a/untracked.txt");

      await execFileAsync("git", ["reset", "--hard", "HEAD"], { cwd: workspacePath });
      await rm(join(workspacePath, "untracked.txt"), { force: true });
      await execFileAsync("git", ["apply", "--check", outputPath], { cwd: workspacePath });
      await execFileAsync("git", ["apply", outputPath], { cwd: workspacePath });
      expect(await readFile(join(workspacePath, "tracked.txt"), "utf8")).toBe("after\n\n");
      expect(await readFile(join(workspacePath, "untracked.txt"), "utf8")).toBe("new file\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports net patch paths when a staged input file is moved in the worktree", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-patch-paths-"));
    try {
      await execFileAsync("git", ["init"], { cwd: root });
      await execFileAsync("git", ["config", "user.email", "runtime-test@example.com"], {
        cwd: root,
      });
      await execFileAsync("git", ["config", "user.name", "Runtime Test"], {
        cwd: root,
      });
      await writeFile(join(root, "base.txt"), "base\n");
      await execFileAsync("git", ["add", "base.txt"], { cwd: root });
      await execFileAsync("git", ["commit", "-m", "test: initialize fixture"], {
        cwd: root,
      });
      await writeFile(join(root, "rejected.txt"), "preserved output\n");
      await execFileAsync("git", ["add", "rejected.txt"], { cwd: root });
      await rename(join(root, "rejected.txt"), join(root, "accepted.txt"));

      await expect(captureGitWorkspaceChangedFiles({ workspacePath: root }))
        .resolves.toEqual(["accepted.txt"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("never stores stdout from a failed git command as patch evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-patch-git-error-"));
    const fakeGitPath = join(root, "fake-git");
    const outputPath = join(root, "preserved.patch");
    try {
      await writeFile(
        fakeGitPath,
        "#!/bin/sh\nprintf 'spawn git ENOENT\\n'\nexit 2\n",
        { mode: 0o700 },
      );

      await expect(new GitPatchPreserver({ gitBinaryPath: fakeGitPath }).preserve({
        workspacePath: root,
        outputPath,
      })).rejects.toMatchObject({ code: 2 });
      await expect(readFile(outputPath, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
