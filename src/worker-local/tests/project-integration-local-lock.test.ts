import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { LocalWorkspaceIntegrationLock } from "../index";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

describe("local project integration workspace lock", () => {
  it("fails closed on contention and can be retried after release", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "integration-lock-"));
    tempRoots.push(rootDir);
    const workspacePath = join(rootDir, "workspace");
    await mkdir(workspacePath);
    const locks = new LocalWorkspaceIntegrationLock({
      rootDir: join(rootDir, "locks"),
    });
    const first = await locks.acquire({ workspacePath, owner: "checks" });

    await expect(locks.acquire({ workspacePath, owner: "reject" }))
      .rejects.toMatchObject({ code: "safe_execution_workspace_locked" });

    await locks.release(first);
    const retry = await locks.acquire({ workspacePath, owner: "reject" });
    expect(retry).toMatchObject({
      workspacePath: await realpath(workspacePath),
      owner: "reject",
    });
    await locks.release(retry);
  });
});
