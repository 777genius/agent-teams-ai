import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { StableWorkerWorkspace } from "../temp-workspace";

describe("StableWorkerWorkspace", () => {
  it("disposes an owned workspace under the allowed root", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "stable-workspace-state-"));
    const workspacePath = join(stateRoot, "workspaces", "slot-a");
    const workspace = new StableWorkerWorkspace(workspacePath, {
      allowedRootDir: stateRoot,
    });

    try {
      const handle = await workspace.create();
      await writeFile(join(handle.path, "canary.txt"), "safe", "utf8");
      await workspace.dispose();
      await expect(access(workspacePath)).rejects.toThrow();
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it("refuses to dispose a path outside the allowed root", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "stable-workspace-state-"));
    const outsideRoot = await mkdtemp(join(tmpdir(), "stable-workspace-outside-"));
    const canaryPath = join(outsideRoot, "canary.txt");
    const workspace = new StableWorkerWorkspace(outsideRoot, {
      allowedRootDir: stateRoot,
    });
    await writeFile(canaryPath, "safe", "utf8");

    try {
      await expect(workspace.dispose()).rejects.toThrow(
        "stable_worker_workspace_delete_outside_allowed_root",
      );
      await expect(access(canaryPath)).resolves.toBeUndefined();
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });
});
