import { mkdir, mkdtemp, rm } from "node:fs/promises";
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
import {
  projectControlWorkspaceLocks,
  withValidatedProjectWorkspaceLock,
} from "../codex-goal-project-workspace-lock";

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

  it("serializes stop release against restart so a successor receipt survives", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-account-release-race-"));
    roots.push(root);
    const workspacePath = join(root, "worktrees", "shared");
    const registryRootDir = join(root, "worker-jobs", "registry");
    await mkdir(workspacePath, { recursive: true });
    const leaseStore = new InMemoryWorkerAccountLeaseStore();
    const capacityStore = new InMemoryWorkerAccountCapacityStore();
    const now = new Date("2026-07-13T00:00:00.000Z");
    const account = fixture(root, "job-1");
    const scoped = {
      ...account,
      manifest: { ...account.manifest, workspacePath },
      launch: {
        ...account.launch,
        config: { ...account.launch.config, workspacePath },
      },
    };
    const deps = { capacityStore, leaseStore, now };
    await reserveCodexProjectAccount({ ...scoped, deps });
    let allowStopRelease!: () => void;
    const stopMayRelease = new Promise<void>((resolve) => {
      allowStopRelease = resolve;
    });
    let stopEntered!: () => void;
    const stopDidEnter = new Promise<void>((resolve) => {
      stopEntered = resolve;
    });
    const locks = projectControlWorkspaceLocks(registryRootDir);
    const scope = {
      projectId: "project-a",
      workspaceRoots: [join(root, "workspaces")],
      worktreeRoots: [join(root, "worktrees")],
      registryRoot: registryRootDir,
    };
    const stop = withValidatedProjectWorkspaceLock({
      locks,
      scope,
      requestedWorkspacePath: workspacePath,
      owner: "stop:job-1",
      effect: async () => {
        stopEntered();
        await stopMayRelease;
        await releaseCodexProjectAccount({
          ...scoped,
          reason: "worker_stopped",
          deps: { leaseStore, now },
        });
      },
    });
    await stopDidEnter;

    await expect(withValidatedProjectWorkspaceLock({
      locks,
      scope,
      requestedWorkspacePath: workspacePath,
      owner: "restart:job-1",
      effect: async () => {
        await reserveCodexProjectAccount({ ...scoped, deps });
      },
    })).rejects.toMatchObject({ code: "safe_execution_workspace_locked" });
    allowStopRelease();
    await stop;

    const successor = await withValidatedProjectWorkspaceLock({
      locks,
      scope,
      requestedWorkspacePath: workspacePath,
      owner: "restart:job-1",
      effect: async () =>
        await reserveCodexProjectAccount({ ...scoped, deps }),
    });
    expect(successor.fencingToken).toBeGreaterThan(1);
    await expect(releaseCodexProjectAccount({
      ...scoped,
      reason: "successor_cleanup",
      deps: { leaseStore, now },
    })).resolves.toBe(true);
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
