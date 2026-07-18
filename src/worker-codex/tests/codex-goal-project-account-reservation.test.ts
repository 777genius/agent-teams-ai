import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  InMemoryAttemptJournal,
  InMemoryWorkerAccountCapacityStore,
  InMemoryWorkerAccountLeaseStore,
} from "@vioxen/subscription-runtime/worker-core";
import type { CodexGoalJobManifest } from "../codex-goal-jobs";
import type { CodexGoalLaunchInput } from "../codex-goal-ops";
import {
  codexProjectContinuationReservationInput,
  codexProjectAccountLeaseMode,
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
  it("selects another shared account after account_unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-account-excluded-"));
    roots.push(root);
    const capacityStore = new InMemoryWorkerAccountCapacityStore();
    const scoped = fixture(root, "job-1");
    const deps = {
      capacityStore,
      leaseMode: "shared" as const,
      now: new Date("2026-07-13T00:00:00.000Z"),
    };
    const first = await reserveCodexProjectAccount({ ...scoped, deps });
    const journal = new InMemoryAttemptJournal();
    await recordUnavailableAttempt(journal, first.accountId);
    const continuation = await codexProjectContinuationReservationInput({
      status: {
        recommendedAction: "continue_after_capacity",
        resultReason: "account_unavailable",
      },
      launch: scoped.launch,
      journal,
    });
    await expect(codexProjectContinuationReservationInput({
      status: {
        recommendedAction: "continue_after_capacity",
        resultReason: "account_unavailable",
        progressAttemptCount: 0,
      },
      launch: scoped.launch,
      journal,
    })).rejects.toThrow("project_control_continuation_attempt_history_mismatch");
    const continued = await reserveCodexProjectAccount({
      ...scoped,
      ...continuation,
      deps,
    });

    expect(continued.accountId).not.toBe(first.accountId);
    expect(continued.launch.config.accounts.map((item) => item.name)).toEqual([
      continued.accountId,
    ]);
    expect(continued.launch.config.maxAccountCycles).toBe(2);
  });

  it("releases an excluded exclusive reservation before selecting another account", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-account-reselected-"));
    roots.push(root);
    const capacityStore = new InMemoryWorkerAccountCapacityStore();
    const leaseStore = new InMemoryWorkerAccountLeaseStore();
    const now = new Date("2026-07-13T00:00:00.000Z");
    const scoped = fixture(root, "job-1");
    const deps = {
      capacityStore,
      leaseStore,
      leaseMode: "exclusive" as const,
      now,
    };
    const first = await reserveCodexProjectAccount({ ...scoped, deps });
    const continued = await reserveCodexProjectAccount({
      ...scoped,
      excludedAccountIds: [first.accountId],
      continuation: { previousAttemptCount: 1 },
      deps,
    });

    expect(continued.accountId).not.toBe(first.accountId);
    await expect(leaseStore.acquire({
      accountId: first.accountId,
      ownerId: "independent-job",
      ttlMs: 60_000,
      now,
    })).resolves.toMatchObject({ status: "granted" });
  });

  it("grants one brokered continuation after a single account recovers", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-account-exhausted-"));
    roots.push(root);
    const now = new Date("2026-07-13T00:00:00.000Z");
    const scoped = singleAccountFixture(root, "job-1");
    const bounded = {
      ...scoped,
      launch: {
        ...scoped.launch,
        config: { ...scoped.launch.config, maxAccountCycles: 1 },
      },
    };
    const deps = {
      capacityStore: new InMemoryWorkerAccountCapacityStore(),
      leaseMode: "shared" as const,
      now,
    };
    const first = await reserveCodexProjectAccount({ ...bounded, deps });
    const continued = await reserveCodexProjectAccount({
      ...bounded,
      excludedAccountIds: [first.accountId],
      continuation: { previousAttemptCount: 1 },
      deps: { ...deps, now: new Date(now.getTime() + 60_000) },
    });

    expect(continued.accountId).toBe(first.accountId);
    expect(continued.launch.config.accounts).toEqual([{ name: "account-a" }]);
    expect(continued.launch.config.maxAccountCycles).toBe(2);
  });

  it("shares an account across concurrent jobs by default", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-account-shared-"));
    roots.push(root);
    const capacityStore = new InMemoryWorkerAccountCapacityStore();
    const leaseStore = new InMemoryWorkerAccountLeaseStore();
    const now = new Date("2026-07-13T00:00:00.000Z");
    const deps = { capacityStore, leaseStore, now, leaseMode: "shared" as const };
    const first = singleAccountFixture(root, "job-1");
    const second = singleAccountFixture(root, "job-2");

    const firstSelection = await reserveCodexProjectAccount({ ...first, deps });
    const secondSelection = await reserveCodexProjectAccount({ ...second, deps });

    expect(firstSelection).toMatchObject({ mode: "shared", accountId: "account-a" });
    expect(secondSelection).toMatchObject({ mode: "shared", accountId: "account-a" });
    await expect(leaseStore.acquire({
      accountId: "account-a",
      ownerId: "independent-job",
      ttlMs: 60_000,
      now,
    })).resolves.toMatchObject({ status: "granted" });
    await expect(releaseCodexProjectAccount({
      ...first,
      reason: "shared jobs have no lease",
      deps: { leaseStore, now },
    })).resolves.toBe(false);
  });

  it("keeps exclusive account leases behind an explicit feature flag", () => {
    expect(codexProjectAccountLeaseMode({})).toBe("shared");
    expect(codexProjectAccountLeaseMode({
      SUBSCRIPTION_RUNTIME_PROJECT_ACCOUNT_EXCLUSIVE_LEASES: "0",
    })).toBe("shared");
    expect(codexProjectAccountLeaseMode({
      SUBSCRIPTION_RUNTIME_PROJECT_ACCOUNT_EXCLUSIVE_LEASES: "1",
    })).toBe("exclusive");
    expect(() => codexProjectAccountLeaseMode({
      SUBSCRIPTION_RUNTIME_PROJECT_ACCOUNT_EXCLUSIVE_LEASES: "true",
    })).toThrow("project_control_account_exclusive_leases_flag_invalid");
  });

  it("reserves before launch, is reentrant and fences concurrent jobs", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-account-reservation-"));
    roots.push(root);
    const capacityStore = new InMemoryWorkerAccountCapacityStore();
    const leaseStore = new InMemoryWorkerAccountLeaseStore();
    const now = new Date("2026-07-13T00:00:00.000Z");
    const deps = {
      capacityStore,
      leaseStore,
      now,
      leaseMode: "exclusive" as const,
    };
    const first = fixture(root, "job-1");
    const second = fixture(root, "job-2", "high");

    const firstReservation = await reserveCodexProjectAccount({ ...first, deps });
    const secondReservation = await reserveCodexProjectAccount({ ...second, deps });
    const firstReplay = await reserveCodexProjectAccount({ ...first, deps });
    expect(firstReservation.mode).toBe("exclusive");
    expect(firstReplay.mode).toBe("exclusive");
    if (firstReservation.mode !== "exclusive" || firstReplay.mode !== "exclusive") {
      throw new Error("exclusive_reservation_expected");
    }

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
    expect(thirdReservation.mode).toBe("exclusive");
    if (thirdReservation.mode !== "exclusive") {
      throw new Error("exclusive_reservation_expected");
    }
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
    const deps = {
      capacityStore,
      leaseStore,
      now,
      leaseMode: "exclusive" as const,
    };
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
    expect(successor.mode).toBe("exclusive");
    if (successor.mode !== "exclusive") {
      throw new Error("exclusive_reservation_expected");
    }
    expect(successor.fencingToken).toBeGreaterThan(1);
    await expect(releaseCodexProjectAccount({
      ...scoped,
      reason: "successor_cleanup",
      deps: { leaseStore, now },
    })).resolves.toBe(true);
  });
});

function singleAccountFixture(
  root: string,
  jobId: string,
): ReturnType<typeof fixture> {
  const value = fixture(root, jobId);
  return {
    manifest: { ...value.manifest, accounts: ["account-a"] },
    launch: {
      ...value.launch,
      config: {
        ...value.launch.config,
        accounts: [{ name: "account-a" }],
      },
    },
  };
}

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

async function recordUnavailableAttempt(
  journal: InMemoryAttemptJournal,
  accountId: string,
): Promise<void> {
  const now = new Date("2026-07-13T00:00:00.000Z");
  await journal.startTask({
    taskId: "job-1-task",
    workspaceRunId: "workspace-run",
    workspacePath: "/workspace",
    effectMode: "workspace_patch",
    provider: "codex",
    now,
  });
  await journal.appendAttempt({
    taskId: "job-1-task",
    attempt: {
      taskId: "job-1-task",
      attemptNumber: 1,
      accountId,
      provider: "codex",
      startedAt: now,
      finishedAt: now,
      status: "blocked",
      failureReason: "account_unavailable",
      workspaceDirtyBefore: true,
      workspaceDirtyAfter: true,
      changedFiles: [],
    },
    now,
  });
  await journal.markPartial({
    taskId: "job-1-task",
    status: "waiting_capacity",
    reason: "account_unavailable",
    now,
  });
}
