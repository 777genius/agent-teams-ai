import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  GitPatchPreserver,
  StrictResultRecorder,
  buildRuntimeResultEnvelope,
  classifyRuntimeRunState,
  normalizeWorkerReport,
} from "../index";

const execFileAsync = promisify(execFile);

describe("runtime result protocol", () => {
  it("builds an authoritative envelope from runtime and worker-report evidence", () => {
    const envelope = buildRuntimeResultEnvelope({
      status: "done",
      provider: "codex",
      runId: "run-a",
      taskId: "task-a",
      changedFiles: ["src/a.ts", "src/a.ts"],
      evidence: ["tests passed"],
      workerReport: {
        outcome: "done",
        summary: "Implemented the task.",
        evidence: ["tests passed"],
        blockers: [],
      },
    });

      expect(envelope).toMatchObject({
        schemaVersion: 1,
        status: "done",
        changedFiles: ["src/a.ts"],
        evidence: ["tests passed", "Implemented the task."],
        blockers: [],
      nextAction: "review_completed",
      provider: "codex",
      runId: "run-a",
      taskId: "task-a",
    });
  });

  it("does not let an LLM worker report add blockers to an authoritative done result", () => {
    expect(buildRuntimeResultEnvelope({
      status: "done",
      workerReport: {
        outcome: "failed",
        blockers: ["model reported stale blocker"],
        evidence: ["model evidence"],
      },
    })).toMatchObject({
      status: "done",
      blockers: [],
      nextAction: "review_completed",
    });
  });

  it("writes latest-result atomically through the strict recorder", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-result-"));
    const outputPath = join(root, "latest-result.json");
    try {
      const recorder = new StrictResultRecorder({
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

  it("classifies actionable run states without relying on log parsing", () => {
    expect(classifyRuntimeRunState({
      status: "running",
      liveness: "stale",
      workspaceDirty: true,
      progressStale: true,
    })).toBe("stale_with_dirty_patch");

    expect(classifyRuntimeRunState({
      capacity: [{ availability: "quota_exhausted" }],
    })).toBe("auth_or_quota_blocked");

    expect(classifyRuntimeRunState({
      capacity: [{ availability: "cooldown" }],
    })).toBe("provider_capacity_unavailable");

    expect(classifyRuntimeRunState({
      status: "running",
      liveness: "alive",
      capacity: [
        { availability: "cooldown" },
        { status: "ready" },
      ],
    })).toBe("productive");

    expect(classifyRuntimeRunState({
      resultStatus: "blocked",
    })).toBe("app_server_goal_blocked");

    expect(classifyRuntimeRunState({
      status: "running",
      liveness: "stale",
      processAlive: true,
      processCpuActive: true,
      processCommand: "npm test -- --runInBand",
      progressStale: true,
      logStale: true,
    })).toBe("quiet_build");

    expect(classifyRuntimeRunState({
      status: "running",
      liveness: "stale",
      processAlive: true,
      progressStale: true,
      logStale: true,
      logGrew: true,
    })).toBe("productive");

    expect(classifyRuntimeRunState({
      status: "running",
      liveness: "alive",
      processAlive: true,
      progressStatus: "running",
      heartbeatOnlyNoOutput: true,
      resultExists: false,
      workspaceDirty: false,
      changedFilesCount: 0,
    })).toBe("stale_no_progress");
  });

  it("normalizes optional LLM worker reports but does not require them", () => {
    expect(normalizeWorkerReport({
      outcome: "partial",
      evidence: ["changed parser"],
      blockers: ["test timeout"],
      nextActionHint: "preserve patch",
      summary: "Patch is useful but not verified.",
    })).toMatchObject({
      outcome: "partial",
      evidence: ["changed parser"],
      blockers: ["test timeout"],
    });

    expect(normalizeWorkerReport("plain text")).toBeUndefined();
  });
});
