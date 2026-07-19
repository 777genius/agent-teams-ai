import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readControlledRuntimeInterruptionEvidence } from "../codex-goal-runtime-control-evidence";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("controlled runtime interruption evidence", () => {
  it("projects only a strict task-bound interrupt_then_continue result", async () => {
    const root = await mkdtemp(join(tmpdir(), "runtime-control-evidence-"));
    roots.push(root);
    const path = join(root, "result.json");
    const strict = {
      schemaVersion: 1,
      taskId: "task-1",
      status: "partial",
      reason: "runtime_interrupted",
      updatedAt: "2026-07-19T04:10:48.657Z",
      changedFiles: ["src/example.ts"],
      evidence: ["safe_execution_status:partial"],
      blockers: ["runtime_interrupted"],
      nextAction: "preserve_patch",
      details: {
        runtimeControl: "interrupt_then_continue",
        signalId: "signal-1",
      },
    };
    await writeFile(path, `${JSON.stringify(strict)}\n`);
    await expect(
      readControlledRuntimeInterruptionEvidence({
        resultPath: path,
        taskId: "task-1",
      }),
    ).resolves.toEqual({
      signalId: "signal-1",
      resultUpdatedAt: "2026-07-19T04:10:48.657Z",
    });

    await expect(
      readControlledRuntimeInterruptionEvidence({
        resultPath: path,
        taskId: "different-task",
      }),
    ).resolves.toBeUndefined();
    await writeFile(
      path,
      `${JSON.stringify({ ...strict, nextAction: "launch_next_slice" })}\n`,
    );
    await expect(
      readControlledRuntimeInterruptionEvidence({
        resultPath: path,
        taskId: "task-1",
      }),
    ).resolves.toBeUndefined();
    await writeFile(
      path,
      `${JSON.stringify({
        status: strict.status,
        reason: strict.reason,
        details: strict.details,
      })}\n`,
    );
    await expect(
      readControlledRuntimeInterruptionEvidence({
        resultPath: path,
        taskId: "task-1",
      }),
    ).resolves.toBeUndefined();
  });
});
