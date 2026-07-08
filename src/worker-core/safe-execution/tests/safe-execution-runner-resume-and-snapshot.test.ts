import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DefaultWorkspaceSnapshotter,
  NodeSafeExecutionRuntime,
  NodeSafeExecutionWorkspaceAccess,
} from "../../../worker-local/safe-execution";
import { afterEach, describe, expect, it } from "vitest";
import {
  InMemoryAttemptJournal,
  InMemoryWorkspaceLockStore,
  SafeExecutionRunner,
  SubscriptionWorkerError,
  defaultSafeExecutionErrorClassifier,
  type WorkspaceSnapshot,
} from "../../index";
import {
  cleanupTemporaryPaths,
  execFileAsync,
  gitWorkspace,
  tempPath,
  type PromptJob,
  type PromptResult,
} from "./safe-execution-test-support";

describe("SafeExecutionRunner resumed tasks and snapshots", () => {
  const cleanupPaths: string[] = [];

  afterEach(async () => {
    await cleanupTemporaryPaths(cleanupPaths);
  });

  it("resumes clean waiting_capacity work with a continuation packet after capacity returns", async () => {
    const workspacePath = await gitWorkspace(
      cleanupPaths,
      "safe-execution-resume-capacity-",
    );
    const journal = new InMemoryAttemptJournal();
    const firstRunner = new SafeExecutionRunner({
      ...nodeSafeExecutionAdapters(),
      lockStore: new InMemoryWorkspaceLockStore(),
      journal,
    });

    const first = await firstRunner.run({
      taskId: "task-resume-capacity",
      workspace: { mode: "existing_locked", path: workspacePath },
      effectMode: "workspace_patch",
      provider: "codex",
      pool: {
        async run(): Promise<PromptResult> {
          throw new SubscriptionWorkerError(
            "subscription_worker_pool_capacity_unavailable",
            "Worker pool has no available accounts.",
            {
              details: {
                availability: "quota_exhausted:2",
                reasons: "quota_limited:2",
                waitUntil: "2026-06-01T01:00:00.000Z",
              },
            },
          );
        },
      },
      job: { prompt: "Implement capacity-resume feature.", workspacePath },
      originalPrompt: "Implement capacity-resume feature.",
      policy: { maxAttempts: 1 },
    });

    expect(first.status).toBe("waiting_capacity");
    expect(first.attempts).toHaveLength(1);
    expect(first.task.lastFailureReason).toBe("capacity_unavailable");

    let resumedPrompt = "";
    const secondRunner = new SafeExecutionRunner({
      ...nodeSafeExecutionAdapters(),
      lockStore: new InMemoryWorkspaceLockStore(),
      journal,
    });
    const resumed = await secondRunner.run({
      taskId: "task-resume-capacity",
      workspace: { mode: "existing_locked", path: workspacePath },
      effectMode: "workspace_patch",
      provider: "codex",
      pool: {
        async run(job: PromptJob): Promise<PromptResult> {
          resumedPrompt = job.prompt;
          await writeFile(join(job.workspacePath, "capacity.txt"), "done\n");
          return { output: "capacity returned" };
        },
      },
      job: { prompt: "Implement capacity-resume feature.", workspacePath },
      originalPrompt: "Implement capacity-resume feature.",
      policy: { maxAttempts: 2 },
    });

    expect(resumed.status).toBe("completed");
    expect(resumed.attempts).toHaveLength(2);
    expect(resumedPrompt).toContain("Continue the same task");
    expect(resumedPrompt).toContain(
      "Previous attempt stopped because: capacity_unavailable",
    );
    expect(await readFile(join(workspacePath, "capacity.txt"), "utf8")).toBe(
      "done\n",
    );
  }, 15_000);

  it("classifies raw Codex app-server goal blocks before unknown_error", () => {
    const processFailure = Object.assign(
      new Error("node_process_runner_failed:1:codex_app_server_goal_blocked"),
      {
        exitCode: 1,
        stdout: "",
        stderr: "codex_app_server_goal_blocked",
      },
    );

    expect(defaultSafeExecutionErrorClassifier(processFailure)).toMatchObject({
      reason: "capacity_unavailable",
      safeMessage: "Codex app-server goal backend is temporarily blocked.",
      retryable: true,
      details: {
        exitCode: "1",
        stderrTail: "codex_app_server_goal_blocked",
        rawCause: expect.stringContaining("codex_app_server_goal_blocked"),
      },
    });
  });

  it("classifies invalid auth from wrapped plain error causes", () => {
    const authFailure = new Error(
      "node_process_runner_failed:1: HTTP error: 401 Unauthorized. " +
        "refresh_token_invalidated: Your session has ended. Please log out and sign in again.",
    );
    const poolFailure = new SubscriptionWorkerError(
      "subscription_worker_pool_slot_failed",
      "Worker pool slot failed to run a task.",
      {
        cause: authFailure,
        details: { workerId: "worker-a", slotIndex: "0" },
      },
    );

    expect(defaultSafeExecutionErrorClassifier(poolFailure)).toEqual({
      reason: "account_unavailable",
      safeMessage: "Provider account session is unavailable.",
      retryable: true,
    });
  });

  it("preserves unknown runtime failure cause metadata", () => {
    const providerFailure = new SubscriptionWorkerError(
      "subscription_worker_run_failed",
      "Codex runtime failed.",
      {
        details: {
          reason: "unknown_runtime_failure",
          exitCode: "7",
          stderrTail: "forced fallback failure",
          rawCause: "codex_json_exec_failed:7:forced fallback failure",
        },
      },
    );

    expect(defaultSafeExecutionErrorClassifier(providerFailure)).toMatchObject({
      reason: "unknown_error",
      safeMessage: "Codex runtime failed.",
      retryable: true,
      details: {
        reason: "unknown_runtime_failure",
        exitCode: "7",
        stderrTail: "forced fallback failure",
        rawCause: "codex_json_exec_failed:7:forced fallback failure",
      },
    });
  });

  it("marks retryable partial work when no continuation job can be built", async () => {
    const workspacePath = await gitWorkspace(
      cleanupPaths,
      "safe-execution-no-continuation-",
    );
    const journal = new InMemoryAttemptJournal();
    let runs = 0;
    const runner = new SafeExecutionRunner({
      ...nodeSafeExecutionAdapters(),
      lockStore: new InMemoryWorkspaceLockStore(),
      journal,
    });

    const result = await runner.run({
      taskId: "task-no-continuation",
      workspace: { mode: "existing_locked", path: workspacePath },
      effectMode: "workspace_patch",
      provider: "codex",
      pool: {
        async run(job: {
          readonly workspacePath: string;
        }): Promise<PromptResult> {
          runs += 1;
          await writeFile(join(job.workspacePath, "partial.txt"), "partial\n");
          throw new SubscriptionWorkerError(
            "subscription_worker_run_failed",
            "Quota limited.",
            { details: { reason: "quota_limited" } },
          );
        },
      },
      job: { workspacePath },
      originalPrompt: "finish no-continuation task",
      policy: { maxAttempts: 2 },
    });

    if (result.status !== "partial") throw new Error("expected partial");
    expect(result.reason).toBe("quota_limited");
    expect(result.safeMessage).toContain("continuationJobFactory");
    expect(result.task.status).toBe("partial");
    expect(
      (await journal.readTask({ taskId: "task-no-continuation" }))?.status,
    ).toBe("partial");
    expect(result.attempts).toHaveLength(1);
    expect(runs).toBe(1);
  }, 15_000);

  it("keeps a resumed partial task partial when no continuation job can be built", async () => {
    const workspacePath = await gitWorkspace(
      cleanupPaths,
      "safe-execution-resume-no-continuation-",
    );
    const journal = new InMemoryAttemptJournal();
    const firstRunner = new SafeExecutionRunner({
      ...nodeSafeExecutionAdapters(),
      lockStore: new InMemoryWorkspaceLockStore(),
      journal,
    });
    await firstRunner.run({
      taskId: "task-resume-no-continuation",
      workspace: { mode: "existing_locked", path: workspacePath },
      effectMode: "workspace_patch",
      provider: "codex",
      pool: {
        async run(job: PromptJob): Promise<PromptResult> {
          await writeFile(join(job.workspacePath, "partial.txt"), "partial\n");
          throw new SubscriptionWorkerError(
            "subscription_worker_run_failed",
            "Quota limited.",
            { details: { reason: "quota_limited" } },
          );
        },
      },
      job: { prompt: "make partial", workspacePath },
      originalPrompt: "make partial",
      policy: { maxAttempts: 1 },
    });

    let resumedRuns = 0;
    const secondRunner = new SafeExecutionRunner({
      ...nodeSafeExecutionAdapters(),
      lockStore: new InMemoryWorkspaceLockStore(),
      journal,
    });
    const result = await secondRunner.run({
      taskId: "task-resume-no-continuation",
      workspace: { mode: "existing_locked", path: workspacePath },
      effectMode: "workspace_patch",
      provider: "codex",
      pool: {
        async run(): Promise<PromptResult> {
          resumedRuns += 1;
          return { output: "should not run" };
        },
      },
      job: { workspacePath },
      originalPrompt: "make partial",
      policy: { maxAttempts: 2 },
    });

    if (result.status !== "partial") throw new Error("expected partial");
    expect(result.reason).toBe("quota_limited");
    expect(result.safeMessage).toContain("continuationJobFactory");
    expect(result.task.status).toBe("partial");
    expect(result.attempts).toHaveLength(1);
    expect(resumedRuns).toBe(0);
  }, 15_000);

  it("does not rerun an interrupted running task with unrecorded workspace changes", async () => {
    const workspacePath = await gitWorkspace(
      cleanupPaths,
      "safe-execution-interrupted-dirty-",
    );
    const journal = new InMemoryAttemptJournal();
    await journal.startTask({
      taskId: "task-interrupted-dirty",
      workspaceRunId: "workspace:interrupted",
      workspacePath,
      effectMode: "workspace_patch",
      provider: "codex",
      now: new Date("2026-05-31T00:00:00.000Z"),
    });
    await writeFile(join(workspacePath, "worker-output.txt"), "partial\n");

    let runs = 0;
    const runner = new SafeExecutionRunner({
      ...nodeSafeExecutionAdapters(),
      lockStore: new InMemoryWorkspaceLockStore(),
      journal,
    });
    const result = await runner.run({
      taskId: "task-interrupted-dirty",
      workspace: { mode: "existing_locked", path: workspacePath },
      effectMode: "workspace_patch",
      provider: "codex",
      pool: {
        async run(): Promise<PromptResult> {
          runs += 1;
          return { output: "should not run" };
        },
      },
      job: { prompt: "finish interrupted task", workspacePath },
      originalPrompt: "finish interrupted task",
      policy: { maxAttempts: 1 },
    });

    if (result.status !== "partial") throw new Error("expected partial");
    expect(result.reason).toBe("unknown_error");
    expect(result.safeMessage).toContain("interrupted running task");
    expect(result.task.status).toBe("partial");
    expect(result.attempts).toHaveLength(0);
    expect(result.failureDetails).toMatchObject({
      workspaceMode: "git",
      changedFileCount: "1",
      changedFiles: "worker-output.txt",
    });
    expect(runs).toBe(0);
  });

  it("resumes a partial task from the attempt journal with a continuation packet", async () => {
    const workspacePath = await gitWorkspace(
      cleanupPaths,
      "safe-execution-journal-",
    );
    const journal = new InMemoryAttemptJournal();
    const firstRunner = new SafeExecutionRunner({
      ...nodeSafeExecutionAdapters(),
      lockStore: new InMemoryWorkspaceLockStore(),
      journal,
    });
    await firstRunner.run({
      taskId: "task-journal",
      workspace: { mode: "existing_locked", path: workspacePath },
      effectMode: "workspace_patch",
      provider: "codex",
      pool: {
        async run(job: PromptJob): Promise<PromptResult> {
          await writeFile(join(job.workspacePath, "journal.txt"), "partial\n");
          throw new SubscriptionWorkerError(
            "subscription_worker_run_failed",
            "Quota limited.",
            { details: { reason: "quota_limited" } },
          );
        },
      },
      job: { prompt: "finish journal task", workspacePath },
      originalPrompt: "finish journal task",
      policy: { maxAttempts: 1 },
    });

    let resumedPrompt = "";
    const secondRunner = new SafeExecutionRunner({
      ...nodeSafeExecutionAdapters(),
      lockStore: new InMemoryWorkspaceLockStore(),
      journal,
    });
    const result = await secondRunner.run({
      taskId: "task-journal",
      workspace: { mode: "existing_locked", path: workspacePath },
      effectMode: "workspace_patch",
      provider: "codex",
      pool: {
        async run(job: PromptJob): Promise<PromptResult> {
          resumedPrompt = job.prompt;
          await writeFile(join(job.workspacePath, "journal.txt"), "done\n");
          return { output: "resumed" };
        },
      },
      job: { prompt: "finish journal task", workspacePath },
      originalPrompt: "finish journal task",
      policy: { maxAttempts: 2 },
    });

    expect(result.status).toBe("completed");
    expect(result.attempts).toHaveLength(2);
    expect(resumedPrompt).toContain("Continue the same task");
    expect(resumedPrompt).toContain(
      "Previous attempt stopped because: quota_limited",
    );
    expect(await readFile(join(workspacePath, "journal.txt"), "utf8")).toBe(
      "done\n",
    );
  }, 15_000);

  it("uses only safe read-only git snapshot commands", async () => {
    const workspacePath = await tempPath(
      cleanupPaths,
      "safe-execution-git-commands-",
    );
    const logPath = join(workspacePath, "git.log");
    const fakeGitPath = join(workspacePath, "fake-git.cjs");
    await writeFile(
      fakeGitPath,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "const args = process.argv.slice(2);",
        "fs.appendFileSync(process.env.GIT_COMMAND_LOG, args.join(' ') + '\\n');",
        "if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') { fs.writeSync(1, 'true\\n'); process.exit(0); }",
        "if (args[0] === 'rev-parse' && args[1] === 'HEAD^{tree}') { fs.writeSync(1, 'tree-hash\\n'); process.exit(0); }",
        "if (args[0] === 'status') { fs.writeSync(1, ' M tracked.txt\\0'); process.exit(0); }",
        "if (args[0] === 'diff' && args.includes('--name-only')) { fs.writeSync(1, 'tracked.txt\\n'); process.exit(0); }",
        "if (args[0] === 'diff' && args.includes('--stat')) { fs.writeSync(1, ' tracked.txt | 1 +\\n'); process.exit(0); }",
        "if (args[0] === 'diff') { fs.writeSync(1, 'diff --git a/tracked.txt b/tracked.txt\\n'); process.exit(0); }",
        "process.exit(1);",
        "",
      ].join("\n"),
      { encoding: "utf8", mode: 0o700 },
    );
    await chmod(fakeGitPath, 0o700);
    const original = process.env.GIT_COMMAND_LOG;
    process.env.GIT_COMMAND_LOG = logPath;
    try {
      const snapshotter = new DefaultWorkspaceSnapshotter({
        gitBinaryPath: fakeGitPath,
      });
      const snapshot = await snapshotter.capture({
        workspacePath,
        includeDiff: true,
      });
      expect(snapshot.changedFiles).toEqual(["tracked.txt"]);
    } finally {
      if (original === undefined) {
        delete process.env.GIT_COMMAND_LOG;
      } else {
        process.env.GIT_COMMAND_LOG = original;
      }
    }

    const commands = (await readFile(logPath, "utf8")).trim().split("\n");
    expect(commands).toEqual([
      "rev-parse --is-inside-work-tree --show-prefix --show-toplevel",
      "status --porcelain=v1 -z --untracked-files=all -- .",
      "rev-parse HEAD^{tree}",
      "diff --relative --name-only --no-ext-diff -- .",
      "diff --relative --cached --name-only --no-ext-diff -- .",
      "diff --relative --stat --no-ext-diff -- .",
      "diff --relative --cached --stat --no-ext-diff -- .",
      "diff --relative --numstat --no-ext-diff -- .",
      "diff --relative --cached --numstat --no-ext-diff -- .",
      "diff --relative --no-ext-diff -- .",
      "diff --relative --cached --no-ext-diff -- .",
    ]);
    expect(commands.join("\n")).not.toMatch(/\b(reset|clean|checkout|apply)\b/);
  });

  it("does not report a full filesystem snapshot as worker-changed files", async () => {
    const workspacePath = await tempPath(
      cleanupPaths,
      "safe-execution-filesystem-delta-",
    );
    const snapshots: WorkspaceSnapshot[] = [
      {
        mode: "filesystem",
        workspacePath,
        capturedAt: new Date("2026-01-01T00:00:00.000Z"),
        dirty: false,
        changedFiles: [".claude/settings.json", ".worktrees/old/file.ts"],
        fingerprint: "before",
        summary: "before filesystem scan",
      },
      {
        mode: "filesystem",
        workspacePath,
        capturedAt: new Date("2026-01-01T00:00:01.000Z"),
        dirty: true,
        changedFiles: [
          ".claude/settings.json",
          ".worktrees/old/file.ts",
          "src/worker-output.ts",
        ],
        fingerprint: "after",
        summary: "after filesystem scan",
      },
    ];
    let captureCount = 0;

    const runner = new SafeExecutionRunner({
      ...nodeSafeExecutionAdapters(),
      lockStore: new InMemoryWorkspaceLockStore(),
      journal: new InMemoryAttemptJournal(),
      snapshotter: {
        async capture(): Promise<WorkspaceSnapshot> {
          return snapshots[Math.min(captureCount++, snapshots.length - 1)]!;
        },
      },
    });

    const result = await runner.run({
      taskId: "task-filesystem-delta",
      workspace: { mode: "existing_locked", path: workspacePath },
      effectMode: "workspace_patch",
      provider: "codex",
      pool: {
        async run(): Promise<PromptResult> {
          return { output: "done" };
        },
      },
      job: { prompt: "make scoped change", workspacePath },
      originalPrompt: "make scoped change",
      policy: { maxAttempts: 1 },
    });

    if (result.status !== "completed") throw new Error("expected completed");
    expect(result.attempts[0]?.changedFiles).toEqual(["src/worker-output.ts"]);
  });

  it("does not report pre-existing git changes as worker-changed files", async () => {
    const workspacePath = await tempPath(
      cleanupPaths,
      "safe-execution-git-delta-",
    );
    const snapshots: WorkspaceSnapshot[] = [
      {
        mode: "git",
        workspacePath,
        capturedAt: new Date("2026-01-01T00:00:00.000Z"),
        dirty: true,
        changedFiles: ["src/pre-existing.ts"],
        fingerprint: "before",
        summary: "before git status",
      },
      {
        mode: "git",
        workspacePath,
        capturedAt: new Date("2026-01-01T00:00:01.000Z"),
        dirty: true,
        changedFiles: ["src/pre-existing.ts", "src/worker-output.ts"],
        fingerprint: "after",
        summary: "after git status",
      },
    ];
    let captureCount = 0;

    const runner = new SafeExecutionRunner({
      ...nodeSafeExecutionAdapters(),
      lockStore: new InMemoryWorkspaceLockStore(),
      journal: new InMemoryAttemptJournal(),
      snapshotter: {
        async capture(): Promise<WorkspaceSnapshot> {
          return snapshots[Math.min(captureCount++, snapshots.length - 1)]!;
        },
      },
    });

    const result = await runner.run({
      taskId: "task-git-delta",
      workspace: { mode: "existing_locked", path: workspacePath },
      effectMode: "workspace_patch",
      provider: "codex",
      pool: {
        async run(): Promise<PromptResult> {
          return { output: "done" };
        },
      },
      job: { prompt: "make scoped change", workspacePath },
      originalPrompt: "make scoped change",
      policy: { maxAttempts: 1 },
    });

    if (result.status !== "completed") throw new Error("expected completed");
    expect(result.attempts[0]?.changedFiles).toEqual(["src/worker-output.ts"]);
  });

  it("records structured usage and observed patch LoC on completed attempts", async () => {
    const workspacePath = await tempPath(cleanupPaths, "safe-execution-stats-");
    const snapshots: WorkspaceSnapshot[] = [
      {
        mode: "git",
        workspacePath,
        capturedAt: new Date("2026-01-01T00:00:00.000Z"),
        dirty: false,
        changedFiles: [],
        diffNumstat: [],
        fingerprint: "before",
        summary: "before git status",
      },
      {
        mode: "git",
        workspacePath,
        capturedAt: new Date("2026-01-01T00:00:01.000Z"),
        dirty: true,
        changedFiles: ["src/worker-output.ts"],
        diffNumstat: [
          {
            path: "src/worker-output.ts",
            additions: 12,
            deletions: 3,
          },
        ],
        fingerprint: "after",
        summary: "after git status",
      },
    ];
    let captureCount = 0;

    const runner = new SafeExecutionRunner({
      ...nodeSafeExecutionAdapters(),
      lockStore: new InMemoryWorkspaceLockStore(),
      journal: new InMemoryAttemptJournal(),
      snapshotter: {
        async capture(): Promise<WorkspaceSnapshot> {
          return snapshots[Math.min(captureCount++, snapshots.length - 1)]!;
        },
      },
    });

    const result = await runner.run({
      taskId: "task-stats",
      workspace: { mode: "existing_locked", path: workspacePath },
      effectMode: "workspace_patch",
      provider: "codex",
      pool: {
        async run(): Promise<{
          readonly output: string;
          readonly usage: {
            readonly inputTokens: number;
            readonly outputTokens: number;
            readonly totalTokens: number;
          };
        }> {
          return {
            output: "done",
            usage: {
              inputTokens: 100,
              outputTokens: 25,
              totalTokens: 125,
            },
          };
        },
      },
      job: { prompt: "make scoped change", workspacePath },
      originalPrompt: "make scoped change",
      policy: { maxAttempts: 1 },
      summarizeResult: (value) => value.output,
      attemptUsage: (value) => value.usage,
    });

    if (result.status !== "completed") throw new Error("expected completed");
    expect(result.attempts[0]?.usage).toEqual({
      inputTokens: 100,
      outputTokens: 25,
      totalTokens: 125,
    });
    expect(result.attempts[0]?.usageSource).toBe("provider_structured");
    expect(result.attempts[0]?.patch).toEqual({
      additions: 12,
      deletions: 3,
      source: "git_numstat_delta",
    });
  });

  it("uses delta when snapshot modes change during an attempt", async () => {
    const workspacePath = await tempPath(
      cleanupPaths,
      "safe-execution-mixed-delta-",
    );
    const snapshots: WorkspaceSnapshot[] = [
      {
        mode: "filesystem",
        workspacePath,
        capturedAt: new Date("2026-01-01T00:00:00.000Z"),
        dirty: false,
        changedFiles: [".worktrees/old/file.ts", "src/pre-existing.ts"],
        fingerprint: "before",
        summary: "before filesystem scan",
      },
      {
        mode: "git",
        workspacePath,
        capturedAt: new Date("2026-01-01T00:00:01.000Z"),
        dirty: true,
        changedFiles: ["src/pre-existing.ts", "src/worker-output.ts"],
        fingerprint: "after",
        summary: "after git status",
      },
    ];
    let captureCount = 0;

    const runner = new SafeExecutionRunner({
      ...nodeSafeExecutionAdapters(),
      lockStore: new InMemoryWorkspaceLockStore(),
      journal: new InMemoryAttemptJournal(),
      snapshotter: {
        async capture(): Promise<WorkspaceSnapshot> {
          return snapshots[Math.min(captureCount++, snapshots.length - 1)]!;
        },
      },
    });

    const result = await runner.run({
      taskId: "task-mixed-delta",
      workspace: { mode: "existing_locked", path: workspacePath },
      effectMode: "workspace_patch",
      provider: "codex",
      pool: {
        async run(): Promise<PromptResult> {
          return { output: "done" };
        },
      },
      job: { prompt: "make scoped change", workspacePath },
      originalPrompt: "make scoped change",
      policy: { maxAttempts: 1 },
    });

    if (result.status !== "completed") throw new Error("expected completed");
    expect(result.attempts[0]?.changedFiles).toEqual(["src/worker-output.ts"]);
  });

  it("scopes git snapshots to the requested workspace subdirectory", async () => {
    const repoPath = await tempPath(cleanupPaths, "safe-execution-git-scope-");
    await execFileAsync("git", ["init"], { cwd: repoPath });
    await mkdir(join(repoPath, "app"), { recursive: true });
    await mkdir(join(repoPath, "other"), { recursive: true });
    await writeFile(join(repoPath, "app", "inside.txt"), "base\n", "utf8");
    await writeFile(join(repoPath, "app", "old name.txt"), "base\n", "utf8");
    await writeFile(join(repoPath, "other", "outside.txt"), "base\n", "utf8");
    await writeFile(join(repoPath, "app", "delete name.txt"), "base\n", "utf8");
    await writeFile(
      join(repoPath, "other", "outside old name.txt"),
      "base\n",
      "utf8",
    );
    await execFileAsync("git", ["add", "."], { cwd: repoPath });
    await execFileAsync(
      "git",
      [
        "-c",
        "user.name=Subscription Runtime Tests",
        "-c",
        "user.email=tests@example.com",
        "commit",
        "-m",
        "Initial commit",
      ],
      { cwd: repoPath },
    );

    await writeFile(join(repoPath, "app", "inside.txt"), "changed\n", "utf8");
    await writeFile(join(repoPath, "app", "new.txt"), "new\n", "utf8");
    await writeFile(join(repoPath, "app", "new file.txt"), "new\n", "utf8");
    await mkdir(join(repoPath, "app", "nested"), { recursive: true });
    await writeFile(
      join(repoPath, "app", "nested", "untracked.txt"),
      "new\n",
      "utf8",
    );
    await writeFile(join(repoPath, "app", "staged.txt"), "staged\n", "utf8");
    await rm(join(repoPath, "app", "delete name.txt"));
    await writeFile(
      join(repoPath, "other", "outside.txt"),
      "changed\n",
      "utf8",
    );
    await execFileAsync("git", ["mv", "app/old name.txt", "app/new name.txt"], {
      cwd: repoPath,
    });
    await execFileAsync(
      "git",
      ["mv", "other/outside old name.txt", "other/outside new name.txt"],
      { cwd: repoPath },
    );
    await execFileAsync("git", ["add", "app/staged.txt", "other/outside.txt"], {
      cwd: repoPath,
    });

    const snapshot = await new DefaultWorkspaceSnapshotter().capture({
      workspacePath: join(repoPath, "app"),
      includeDiff: true,
    });

    expect(snapshot.changedFiles).toEqual([
      "delete name.txt",
      "inside.txt",
      "nested/untracked.txt",
      "new file.txt",
      "new name.txt",
      "new.txt",
      "staged.txt",
    ]);
    expect(snapshot.summary).toBe("Git workspace has 7 changed file(s).");
    expect(snapshot.diffStat).toContain("inside.txt");
    expect(snapshot.diffStat).toContain("staged.txt");
    expect(snapshot.diffStat).not.toContain("outside.txt");
    expect(snapshot.shortDiff).toContain(
      "diff --git a/inside.txt b/inside.txt",
    );
    expect(snapshot.shortDiff).toContain(
      "diff --git a/staged.txt b/staged.txt",
    );
    expect(snapshot.shortDiff).not.toContain("outside.txt");
  }, 15_000);

  it("fingerprints git snapshots using the requested workspace subtree", async () => {
    const repoPath = await tempPath(
      cleanupPaths,
      "safe-execution-git-tree-scope-",
    );
    await execFileAsync("git", ["init"], { cwd: repoPath });
    await mkdir(join(repoPath, "app"), { recursive: true });
    await mkdir(join(repoPath, "other"), { recursive: true });
    await writeFile(join(repoPath, "app", "inside.txt"), "base\n", "utf8");
    await writeFile(join(repoPath, "other", "outside.txt"), "base\n", "utf8");
    await execFileAsync("git", ["add", "."], { cwd: repoPath });
    await execFileAsync(
      "git",
      [
        "-c",
        "user.name=Subscription Runtime Tests",
        "-c",
        "user.email=tests@example.com",
        "commit",
        "-m",
        "Initial commit",
      ],
      { cwd: repoPath },
    );

    const snapshotter = new DefaultWorkspaceSnapshotter();
    const before = await snapshotter.capture({
      workspacePath: join(repoPath, "app"),
    });

    await writeFile(
      join(repoPath, "other", "outside.txt"),
      "outside\n",
      "utf8",
    );
    await execFileAsync("git", ["add", "other/outside.txt"], {
      cwd: repoPath,
    });
    await execFileAsync(
      "git",
      [
        "-c",
        "user.name=Subscription Runtime Tests",
        "-c",
        "user.email=tests@example.com",
        "commit",
        "-m",
        "Outside commit",
      ],
      { cwd: repoPath },
    );
    const afterOutsideCommit = await snapshotter.capture({
      workspacePath: join(repoPath, "app"),
    });

    await writeFile(join(repoPath, "app", "inside.txt"), "inside\n", "utf8");
    await execFileAsync("git", ["add", "app/inside.txt"], { cwd: repoPath });
    await execFileAsync(
      "git",
      [
        "-c",
        "user.name=Subscription Runtime Tests",
        "-c",
        "user.email=tests@example.com",
        "commit",
        "-m",
        "Inside commit",
      ],
      { cwd: repoPath },
    );
    const afterInsideCommit = await snapshotter.capture({
      workspacePath: join(repoPath, "app"),
    });

    expect(before.dirty).toBe(false);
    expect(afterOutsideCommit.dirty).toBe(false);
    expect(afterInsideCommit.dirty).toBe(false);
    expect(afterOutsideCommit.fingerprint).toBe(before.fingerprint);
    expect(afterInsideCommit.fingerprint).not.toBe(before.fingerprint);
  }, 15_000);
});

function nodeSafeExecutionAdapters() {
  return {
    snapshotter: new DefaultWorkspaceSnapshotter(),
    workspaceAccess: new NodeSafeExecutionWorkspaceAccess(),
    runtime: new NodeSafeExecutionRuntime(),
  };
}
