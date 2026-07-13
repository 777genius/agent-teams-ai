import { describe, expect, it } from "vitest";
import { InMemoryWorkspaceLockStore } from "../../index";

describe("InMemoryWorkspaceLockStore", () => {
  it("does not let stale handles release replacement workspace locks", async () => {
    const workspacePath = "/sandbox/in-memory-workspace-lock";
    const lockStore = new InMemoryWorkspaceLockStore();
    const stale = await lockStore.acquire({
      taskId: "task-same-owner",
      workspacePath,
      ownerId: "same-owner",
      ownerPid: 9_999_999,
    });
    const replacement = await lockStore.acquire({
      taskId: "task-same-owner",
      workspacePath,
      ownerId: "same-owner",
      ownerPid: process.pid,
    });

    await stale.release();
    await expect(
      lockStore.acquire({
        taskId: "task-probe",
        workspacePath,
        ownerId: "probe-owner",
        ownerPid: process.pid,
      }),
    ).rejects.toMatchObject({
      code: "safe_execution_workspace_locked",
    });
    await replacement.release();
  });
});
