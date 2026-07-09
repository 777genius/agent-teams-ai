import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  GitPatchPreserver,
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
});
