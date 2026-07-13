import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  InMemoryWorkerAccountCapacityStore,
  InMemoryWorkerAccountLeaseStore,
} from "@vioxen/subscription-runtime/worker-core";
import type { CodexGoalJobManifest } from "../codex-goal-jobs";
import type { CodexGoalLaunchInput } from "../codex-goal-ops";
import {
  releaseCodexProjectAccount,
  reserveCodexProjectAccount,
} from "../application/project-control/codex-goal-project-account-reservation";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

describe("project account reservation", () => {
  it("reserves before launch, is reentrant and fences concurrent jobs", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-account-reservation-"));
    roots.push(root);
    const capacityStore = new InMemoryWorkerAccountCapacityStore();
    const leaseStore = new InMemoryWorkerAccountLeaseStore();
    const now = new Date("2026-07-13T00:00:00.000Z");
    const deps = { capacityStore, leaseStore, now };
    const first = fixture(root, "job-1");
    const second = fixture(root, "job-2", "high");

    const firstReservation = await reserveCodexProjectAccount({ ...first, deps });
    const secondReservation = await reserveCodexProjectAccount({ ...second, deps });
    const firstReplay = await reserveCodexProjectAccount({ ...first, deps });

    expect(firstReservation.accountId).toBe("account-a");
    expect(firstReservation.launch.config.accounts.map((item) => item.name)).toEqual([
      "account-a",
    ]);
    expect(firstReservation.launch.config.maxAccountCycles).toBe(1);
    expect(secondReservation.accountId).toBe("account-b");
    expect(firstReplay).toMatchObject({
      accountId: firstReservation.accountId,
      fencingToken: firstReservation.fencingToken,
    });

    await expect(releaseCodexProjectAccount({
      ...first,
      reason: "test complete",
      deps: { leaseStore, now },
    })).resolves.toBe(true);
    const third = fixture(root, "job-3");
    const thirdReservation = await reserveCodexProjectAccount({ ...third, deps });
    expect(thirdReservation.accountId).toBe("account-a");
    expect(thirdReservation.fencingToken).toBeGreaterThan(
      firstReservation.fencingToken,
    );
  });
});

function fixture(
  root: string,
  jobId: string,
  reasoningEffort: "xhigh" | "high" = "xhigh",
): {
  readonly manifest: CodexGoalJobManifest;
  readonly launch: CodexGoalLaunchInput;
} {
  const jobRootDir = join(root, jobId);
  const manifest: CodexGoalJobManifest = {
    schemaVersion: 1,
    jobId,
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    jobRootDir,
    workspacePath: join(root, "workspace"),
    promptPath: join(jobRootDir, "prompt.md"),
    taskId: `${jobId}-task`,
    accounts: ["account-a", "account-b"],
  };
  return {
    manifest,
    launch: {
      config: {
        jobId,
        jobRootDir,
        authRootDir: join(root, "auth"),
        workspacePath: manifest.workspacePath,
        promptPath: manifest.promptPath,
        taskId: manifest.taskId,
        accounts: [{ name: "account-a" }, { name: "account-b" }],
        model: "gpt-5.6-sol",
        reasoningEffort,
        serviceTier: "fast",
        taskTimeoutMs: 60_000,
      },
      tmuxSession: `${jobId}-tmux`,
      cwd: manifest.workspacePath,
      logPath: join(jobRootDir, "worker.log"),
      cliCommand: ["node", "runtime.js"],
    },
  };
}
