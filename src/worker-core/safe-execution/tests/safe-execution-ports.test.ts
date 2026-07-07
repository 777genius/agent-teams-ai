import { describe, expect, it } from "vitest";

import { InMemoryAttemptJournal } from "../../safe-execution";
import type { AttemptJournal, SafeExecutionTaskRecord } from "../index";

describe("safe execution ports", () => {
  it("keeps task persistence behind the feature-owned journal port", async () => {
    const journal: AttemptJournal = new InMemoryAttemptJournal();

    const started: SafeExecutionTaskRecord = await journal.startTask({
      taskId: "task-1",
      workspaceRunId: "workspace-1",
      workspacePath: "/workspace",
      effectMode: "workspace_patch",
      provider: "codex",
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    expect(started).toMatchObject({
      taskId: "task-1",
      workspaceRunId: "workspace-1",
      status: "running",
      attempts: [],
    });

    const completed = await journal.completeTask({
      taskId: "task-1",
      result: { ok: true },
      outputSummary: "done",
      now: new Date("2026-01-01T00:01:00.000Z"),
    });

    expect(completed).toMatchObject({
      taskId: "task-1",
      status: "completed",
      result: { ok: true },
      outputSummary: "done",
    });
  });
});
