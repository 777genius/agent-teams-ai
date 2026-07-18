import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { LocalFileWorkerControlInboxStore } from "@vioxen/subscription-runtime/store-local-file";
import {
  AccessBoundary,
  NetworkAccessMode,
  SubscriptionWorkerError,
  WorkerControlService,
} from "@vioxen/subscription-runtime/worker-core";
import {
  codexGoalAccountSlots,
  codexWorkerReportSchemaName,
  codexGoalProgressPath,
  codexGoalRuntimeEventsPath,
  runCodexGoal,
  buildCodexGoalExecutorOptions,
  type CodexGoalRunConfig,
} from "../codex-goal-runner";
import {
  createLinkedGitWorktree,
  readJsonLines,
  waitForProgressStatus,
} from "./codex-goal-runner-fixtures";

const execFileAsync = promisify(execFile);

describe("codex goal runner", () => {
  it("interrupts an active executor attempt from the durable control inbox", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-goal-control-"));
    const promptPath = join(root, "prompt.md");
    const stateRootDir = join(root, "state");
    const config: CodexGoalRunConfig = {
      jobId: "job-durable-guidance",
      jobRootDir: join(root, "job"),
      stateRootDir,
      authRootDir: join(root, "auth"),
      workspacePath: join(root, "workspace"),
      promptPath,
      taskId: "task-durable-guidance",
      accounts: codexGoalAccountSlots(["account-a"]),
      outputPath: join(root, "job", "task-durable-guidance.latest-result.json"),
    };
    let startedRun: (() => void) | undefined;
    const runStarted = new Promise<void>((resolve) => {
      startedRun = resolve;
    });
    let observedAbortReason: unknown;

    try {
      await mkdir(config.jobRootDir, { recursive: true });
      await mkdir(config.workspacePath, { recursive: true });
      await writeFile(promptPath, "Finish the existing output.\n");

      const running = runCodexGoal(config, {
        createExecutor: (options) => ({
          async run() {
            if (!options.activeAttemptRegistry) {
              throw new Error("active_attempt_registry_missing");
            }
            const abortController = new AbortController();
            const lease = options.activeAttemptRegistry.register({
              taskId: config.taskId,
              attemptNumber: 1,
              provider: "codex",
              workspacePath: config.workspacePath,
              target: {
                jobId: config.jobId!,
                taskId: config.taskId,
                workspaceId: config.workspacePath,
                attemptId: `${config.taskId}:attempt-1`,
              },
              startedAt: new Date("2026-07-16T00:00:00.000Z"),
              abortController,
            });
            startedRun?.();
            await new Promise<void>((resolve) => {
              abortController.signal.addEventListener("abort", () => {
                observedAbortReason = abortController.signal.reason;
                resolve();
              }, { once: true });
            });
            lease.release();
            return {
              status: "completed",
              attempts: [],
              task: { outputText: "continued" },
            } as never;
          },
          async dispose() {},
        }),
      });

      await runStarted;
      const externalControl = new WorkerControlService({
        store: new LocalFileWorkerControlInboxStore({ rootDir: stateRootDir }),
      });
      const signal = await externalControl.enqueueSignal({
        target: {
          jobId: config.jobId!,
          taskId: config.taskId,
          workspaceId: config.workspacePath,
        },
        intent: "guidance",
        deliveryMode: "interrupt_then_continue",
        body: "Finalize the immutable output and return a strict result.",
        createdBy: "orchestrator",
      });

      await running;
      expect(observedAbortReason).toMatchObject({
        code: "runtime_controlled_interrupt",
        signalId: signal.signalId,
        requestedBy: "orchestrator",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("writes heartbeat progress while a sandbox executor is still running", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-goal-runner-"));
    const promptPath = join(root, "prompt.md");
    const config: CodexGoalRunConfig = {
      jobRootDir: join(root, "job"),
      authRootDir: join(root, "auth"),
      workspacePath: join(root, "workspace"),
      promptPath,
      taskId: "task-heartbeat",
      accounts: codexGoalAccountSlots(["account-a"]),
      outputPath: join(root, "job", "task-heartbeat.latest-result.json"),
      progressHeartbeatMs: 1000,
    };
    let releaseRun: (() => void) | undefined;
    let startedRun: (() => void) | undefined;
    const runStarted = new Promise<void>((resolve) => {
      startedRun = resolve;
    });

    try {
      await mkdir(config.jobRootDir, { recursive: true });
      await mkdir(config.workspacePath, { recursive: true });
      await writeFile(promptPath, "Do a sandbox task.\n");

      const running = runCodexGoal(config, {
        createExecutor: (options) => ({
          async run() {
            startedRun?.();
            await new Promise<void>((resolve) => {
              releaseRun = resolve;
            });
            options.observability?.count(
              "subscription_runtime.worker_account_capacity_recheck_due",
            );
            return {
              status: "completed",
              attempts: [],
              task: {
                outputText: "done",
              },
            } as never;
          },
          async dispose() {},
        }),
      });

      await runStarted;
      const runningProgress = await waitForProgressStatus(
        codexGoalProgressPath(config),
        "running",
      );
      expect(runningProgress).toMatchObject({
        schemaVersion: 1,
        taskId: "task-heartbeat",
        status: "running",
        pid: process.pid,
      });

      releaseRun?.();
      await running;

      const finalProgress = JSON.parse(
        await readFile(codexGoalProgressPath(config), "utf8"),
      ) as Record<string, unknown>;
      expect(finalProgress).toMatchObject({
        taskId: "task-heartbeat",
        status: "completed",
        resultStatus: "completed",
        attemptCount: 0,
      });
      const result = JSON.parse(await readFile(config.outputPath!, "utf8")) as
        Record<string, unknown>;
      expect(result.status).toBe("done");
      expect(result.nextAction).toBe("review_completed");

      const events = await readJsonLines(codexGoalRuntimeEventsPath(config));
      expect(events.map((event) => event.event)).toEqual([
        "runner_starting",
        "executor_started",
        "runtime_metric",
        "executor_finished",
        "runner_disposed",
      ]);
      expect(events[2]).toMatchObject({
        event: "runtime_metric",
        attributes: {
          kind: "count",
          metric: "subscription_runtime.worker_account_capacity_recheck_due",
          value: 1,
        },
      });
      expect(events.at(-1)).toMatchObject({
        schemaVersion: 1,
        taskId: "task-heartbeat",
        event: "runner_disposed",
        level: "info",
      });
    } finally {
      releaseRun?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("adds an artifact fallback instruction to Codex goal workers", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-goal-runner-"));
    const promptPath = join(root, "prompt.md");
    const config: CodexGoalRunConfig = {
      jobRootDir: join(root, "job"),
      authRootDir: join(root, "auth"),
      workspacePath: join(root, "workspace"),
      promptPath,
      taskId: "task-artifacts",
      accounts: codexGoalAccountSlots(["account-a"]),
    };

    try {
      await mkdir(config.jobRootDir, { recursive: true });
      await mkdir(config.workspacePath, { recursive: true });
      await writeFile(promptPath, "Write a report.\n");

      await runCodexGoal(config, {
        createExecutor: () => ({
          async run(input) {
            expect(input.systemPrompt).toContain("Codex goal runtime artifact rule");
            expect(input.systemPrompt).toContain("/tmp/task-artifacts-artifacts");
            expect(input.systemPrompt).toContain("do not mark the goal blocked solely");
            return {
              status: "completed",
              attempts: [],
              task: {
                outputText: "done",
              },
            } as never;
          },
          async dispose() {},
        }),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("adds linked-worktree handoff guardrails and commit preflight warnings", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-goal-linked-"));
    const promptPath = join(root, "prompt.md");
    const workspacePath = join(root, "worker");
    const config: CodexGoalRunConfig = {
      jobRootDir: join(root, "job"),
      authRootDir: join(root, "auth"),
      workspacePath,
      promptPath,
      taskId: "task-linked",
      accounts: codexGoalAccountSlots(["account-a"]),
      accessBoundary: AccessBoundary.IsolatedWorkspaceWrite,
      networkAccess: NetworkAccessMode.Restricted,
      projectAccessScope: {
        projectId: "infinity-context",
        isolatedWorkspaceRoot: workspacePath,
        workspaceRoots: [workspacePath],
      },
    };

    try {
      await mkdir(config.jobRootDir, { recursive: true });
      await createLinkedGitWorktree(root, workspacePath);
      await writeFile(
        promptPath,
        "Change the file, run tests, then git commit the changes.\n",
      );

      await runCodexGoal(config, {
        createExecutor: () => ({
          async run(input) {
            expect(input.systemPrompt).toContain("Linked git worktree sandbox rule");
            expect(input.systemPrompt).toContain("edit/test/handoff-only");
            expect(input.systemPrompt).toContain(
              "Do not run git add, git commit, or git push.",
            );
            expect(input.systemPrompt).toContain(
              "Project Integration lifecycle",
            );
            return {
              status: "completed",
              attempts: [],
              task: {
                outputText: "done",
              },
            } as never;
          },
          async dispose() {},
        }),
      });

      const events = await readJsonLines(codexGoalRuntimeEventsPath(config));
      expect(events.map((event) => event.event)).toEqual([
        "runner_starting",
        "linked_worktree_handoff_guardrail",
        "linked_worktree_commit_preflight_warning",
        "executor_started",
        "executor_finished",
        "runner_disposed",
      ]);
      expect(events.find((event) =>
        event.event === "linked_worktree_commit_preflight_warning"
      )).toMatchObject({
        level: "warning",
        attributes: {
          workspaceKind: "linked_git_worktree",
          guidance: "edit_test_handoff_only",
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not warn when a linked-worktree prompt already forbids commits", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-goal-linked-"));
    const promptPath = join(root, "prompt.md");
    const workspacePath = join(root, "worker");
    const config: CodexGoalRunConfig = {
      jobRootDir: join(root, "job"),
      authRootDir: join(root, "auth"),
      workspacePath,
      promptPath,
      taskId: "task-linked-no-warning",
      accounts: codexGoalAccountSlots(["account-a"]),
      accessBoundary: AccessBoundary.IsolatedWorkspaceWrite,
      networkAccess: NetworkAccessMode.Restricted,
      projectAccessScope: {
        projectId: "infinity-context",
        isolatedWorkspaceRoot: workspacePath,
        workspaceRoots: [workspacePath],
      },
    };

    try {
      await mkdir(config.jobRootDir, { recursive: true });
      await createLinkedGitWorktree(root, workspacePath);
      await writeFile(promptPath, "Do not commit. Leave a patch handoff.\n");

      await runCodexGoal(config, {
        createExecutor: () => ({
          async run(input) {
            expect(input.systemPrompt).toContain("Linked git worktree sandbox rule");
            return {
              status: "completed",
              attempts: [],
              task: {
                outputText: "done",
              },
            } as never;
          },
          async dispose() {},
        }),
      });

      const events = await readJsonLines(codexGoalRuntimeEventsPath(config));
      expect(events.map((event) => event.event)).toContain(
        "linked_worktree_handoff_guardrail",
      );
      expect(events.map((event) => event.event)).not.toContain(
        "linked_worktree_commit_preflight_warning",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("writes a strict latest-result when the sandbox executor throws", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-goal-fail-"));
    const promptPath = join(root, "prompt.md");
    const config: CodexGoalRunConfig = {
      jobRootDir: join(root, "job"),
      authRootDir: join(root, "auth"),
      workspacePath: join(root, "workspace"),
      promptPath,
      taskId: "task-failure",
      accounts: codexGoalAccountSlots(["account-a"]),
      outputPath: join(root, "job", "task-failure.latest-result.json"),
    };

    try {
      await mkdir(config.jobRootDir, { recursive: true });
      await mkdir(config.workspacePath, { recursive: true });
      await writeFile(promptPath, "Do a sandbox task.\n");

      await expect(runCodexGoal(config, {
        createExecutor: () => ({
          async run() {
            throw new Error("synthetic executor failure");
          },
          async dispose() {},
        }),
      })).rejects.toThrow("synthetic executor failure");

      const result = JSON.parse(await readFile(config.outputPath!, "utf8")) as
        Record<string, unknown>;
      expect(result).toMatchObject({
        status: "failed",
        changedFiles: [],
        blockers: ["runner_exception"],
        nextAction: "recover",
        reason: "runner_exception",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses optional Codex worker reports as evidence without making them authoritative", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-goal-report-"));
    const promptPath = join(root, "prompt.md");
    const config: CodexGoalRunConfig = {
      jobRootDir: join(root, "job"),
      authRootDir: join(root, "auth"),
      workspacePath: join(root, "workspace"),
      promptPath,
      taskId: "task-report",
      accounts: codexGoalAccountSlots(["account-a"]),
      outputPath: join(root, "job", "task-report.latest-result.json"),
      workerReportMode: "structured-output",
    };

    try {
      await mkdir(config.jobRootDir, { recursive: true });
      await mkdir(config.workspacePath, { recursive: true });
      await writeFile(promptPath, "Do a sandbox task.\n");

      await runCodexGoal(config, {
        createExecutor: (options) => {
          expect(options.outputSchemas).toEqual({
            [codexWorkerReportSchemaName]: expect.objectContaining({
              type: "object",
              additionalProperties: false,
            }),
          });
          return {
            async run(input) {
              expect(input.outputSchemaName).toBe(codexWorkerReportSchemaName);
              expect(input.systemPrompt).toContain("codex-worker-report schema");
              return {
                status: "completed",
                attempts: [{
                  changedFiles: ["src/runtime-result.ts"],
                }],
                task: {
                  outputSummary: "worker summary",
                },
                result: {
                  outputText: "done",
                  structuredOutput: {
                    outcome: "failed",
                    evidence: ["model evidence"],
                    blockers: ["model blocker"],
                    nextActionHint: "stop",
                    summary: "model summary",
                  },
                },
              } as never;
            },
            async dispose() {},
          };
        },
      });

      const result = JSON.parse(await readFile(config.outputPath!, "utf8")) as
        Record<string, unknown>;
      expect(result).toMatchObject({
        status: "done",
        changedFiles: ["src/runtime-result.ts"],
        nextAction: "review_completed",
      });
      expect(result.evidence).toEqual(expect.arrayContaining([
        "safe_execution_status:completed",
        "model evidence",
        "model summary",
      ]));
      expect(result.blockers).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("maps isolated workspace boundary to Codex workspace-write controls", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-goal-access-"));
    const promptPath = join(root, "prompt.md");
    const config: CodexGoalRunConfig = {
      jobRootDir: join(root, "job"),
      authRootDir: join(root, "auth"),
      workspacePath: join(root, "workspace"),
      promptPath,
      taskId: "task-access",
      accounts: codexGoalAccountSlots(["account-a"]),
      accessBoundary: AccessBoundary.IsolatedWorkspaceWrite,
      networkAccess: NetworkAccessMode.Restricted,
      projectAccessScope: {
        projectId: "infinity-context",
        isolatedWorkspaceRoot: join(root, "workspace"),
        workspaceRoots: [join(root, "workspace")],
      },
    };

    try {
      await mkdir(config.jobRootDir, { recursive: true });
      await mkdir(config.workspacePath, { recursive: true });
      await writeFile(promptPath, "Do a sandbox task.\n");

      await runCodexGoal(config, {
        createExecutor: () => ({
          async run(input) {
            expect(input.controls).toEqual({
              editMode: "allow-edits",
              providerSandboxMode: "workspace-write",
            });
            return {
              status: "completed",
              attempts: [],
              task: {
                outputText: "done",
              },
            } as never;
          },
          async dispose() {},
        }),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed for Codex access-boundary jobs without explicit restricted network", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-goal-access-"));
    const promptPath = join(root, "prompt.md");
    const config: CodexGoalRunConfig = {
      jobRootDir: join(root, "job"),
      authRootDir: join(root, "auth"),
      workspacePath: join(root, "workspace"),
      promptPath,
      taskId: "task-access-network",
      accounts: codexGoalAccountSlots(["account-a"]),
      accessBoundary: AccessBoundary.IsolatedWorkspaceWrite,
      projectAccessScope: {
        projectId: "infinity-context",
        isolatedWorkspaceRoot: join(root, "workspace"),
        workspaceRoots: [join(root, "workspace")],
      },
    };

    try {
      await mkdir(config.jobRootDir, { recursive: true });
      await mkdir(config.workspacePath, { recursive: true });
      await writeFile(promptPath, "Do a sandbox task.\n");

      await expect(runCodexGoal(config, {
        createExecutor: () => {
          throw new Error("executor should not be created");
        },
      })).rejects.toThrow(/network_access=disabled/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("threads isolated workspace command policy into worker options", () => {
    const root = "/tmp/subscription-runtime-goal-access";
    const options = buildCodexGoalExecutorOptions({
      stateRootDir: join(root, "state"),
      encryptionKey: new Uint8Array(32).fill(1),
      config: {
        jobRootDir: join(root, "job"),
        authRootDir: join(root, "auth"),
        workspacePath: join(root, "workspace"),
        promptPath: join(root, "prompt.md"),
        taskId: "task-access",
        accounts: codexGoalAccountSlots(["account-a"]),
        accessBoundary: AccessBoundary.IsolatedWorkspaceWrite,
        networkAccess: NetworkAccessMode.Restricted,
        projectAccessScope: {
          projectId: "infinity-context",
          registryRoot: join(root, "registry"),
          isolatedWorkspaceRoot: join(root, "workspace"),
          workspaceRoots: [join(root, "workspace")],
          worktreeRoots: [join(root, "worktrees")],
          allowedBranches: ["main"],
          jobIdPrefixes: ["infinity-context-"],
        },
      },
    });

    expect(options.accounts[0]?.worker.commandPolicy).toMatchObject({
      validateCommands: true,
      deniedGitSubcommands: ["push"],
    });
  });

  it("fails closed for Codex project scoped control until broker-only tools are enforced", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-goal-access-"));
    const promptPath = join(root, "prompt.md");
    const config: CodexGoalRunConfig = {
      jobRootDir: join(root, "job"),
      authRootDir: join(root, "auth"),
      workspacePath: join(root, "workspace"),
      promptPath,
      taskId: "task-project-control",
      accounts: codexGoalAccountSlots(["account-a"]),
      accessBoundary: AccessBoundary.ProjectScopedControl,
      projectAccessScope: {
        projectId: "infinity-context",
        workspaceRoots: [join(root, "workspace")],
        jobIdPrefixes: ["infinity-context-"],
      },
    };

    try {
      await mkdir(config.jobRootDir, { recursive: true });
      await mkdir(config.workspacePath, { recursive: true });
      await writeFile(promptPath, "Coordinate workers.\n");

      await expect(runCodexGoal(config, {
        createExecutor: () => {
          throw new Error("executor should not be created");
        },
      })).rejects.toThrow(/codex_goal_access_boundary_blocked/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects raw danger provider sandbox without danger access boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-goal-danger-"));
    const promptPath = join(root, "prompt.md");
    const config: CodexGoalRunConfig = {
      jobRootDir: join(root, "job"),
      authRootDir: join(root, "auth"),
      workspacePath: join(root, "workspace"),
      promptPath,
      taskId: "task-raw-danger",
      accounts: codexGoalAccountSlots(["account-a"]),
      editMode: "allow-edits",
      providerSandboxMode: "danger-full-access",
    };

    try {
      await mkdir(config.jobRootDir, { recursive: true });
      await mkdir(config.workspacePath, { recursive: true });
      await writeFile(promptPath, "Do not run unrestricted.\n");

      await expect(runCodexGoal(config, {
        createExecutor: () => {
          throw new Error("executor should not be created");
        },
      })).rejects.toThrow(/codex_goal_danger_full_access_requires_access_boundary/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves a patch artifact when the executor fails after workspace changes", async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "subscription-runtime-goal-patch-")),
    );
    const promptPath = join(root, "prompt.md");
    const workspacePath = join(root, "workspace");
    const config: CodexGoalRunConfig = {
      jobRootDir: join(root, "job"),
      authRootDir: join(root, "auth"),
      workspacePath,
      promptPath,
      taskId: "task-patch",
      accounts: codexGoalAccountSlots(["account-a"]),
      outputPath: join(root, "job", "task-patch.latest-result.json"),
    };

    try {
      await mkdir(config.jobRootDir, { recursive: true });
      await mkdir(workspacePath, { recursive: true });
      await writeFile(promptPath, "Do a sandbox task.\n");
      await execFileAsync("git", ["init"], { cwd: workspacePath });
      await execFileAsync("git", ["config", "user.email", "test@example.com"], {
        cwd: workspacePath,
      });
      await execFileAsync("git", ["config", "user.name", "Test User"], {
        cwd: workspacePath,
      });
      await writeFile(join(workspacePath, "tracked.txt"), "before\n");
      await execFileAsync("git", ["add", "tracked.txt"], { cwd: workspacePath });
      await execFileAsync("git", ["commit", "-m", "test fixture"], {
        cwd: workspacePath,
      });
      const baseCommit = (await execFileAsync("git", ["rev-parse", "HEAD"], {
        cwd: workspacePath,
      })).stdout.trim();

      await expect(runCodexGoal(config, {
        createExecutor: () => ({
          async run() {
            await writeFile(join(workspacePath, "tracked.txt"), "after\n");
            await mkdir(join(workspacePath, "new"));
            await writeFile(
              join(workspacePath, "new", "nested.txt"),
              "new file\n",
            );
            throw new Error("synthetic executor failure");
          },
          async dispose() {},
        }),
      })).rejects.toThrow("synthetic executor failure");

      const result = JSON.parse(await readFile(config.outputPath!, "utf8")) as
        Record<string, unknown>;
      expect(result).toMatchObject({
        status: "partial",
        changedFiles: ["new/nested.txt", "tracked.txt"],
        nextAction: "preserve_patch",
      });
      expect(result.details).toMatchObject({ baseCommit });
      const canonicalJobRoot = await realpath(config.jobRootDir);
      const patchArtifact = (
        result.artifacts as readonly Record<string, unknown>[]
      ).find((artifact) => artifact.kind === "patch");
      const patchPath = String(patchArtifact?.path);
      const generation = patchPath.match(
        /task-patch\.([a-f0-9]{64})\.handoff\.patch$/,
      )?.[1];
      expect(patchPath.startsWith(`${canonicalJobRoot}/`)).toBe(true);
      expect(generation).toBe(patchArtifact?.sha256);
      expect(result.evidence).toEqual(expect.arrayContaining([
        `patch_preserved:${patchPath}`,
      ]));
      expect(await readFile(patchPath, "utf8")).toContain("after");
      expect(await readFile(patchPath, "utf8")).toContain("new file");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("captures staged input plus unstaged remediation when completed attempts report no changes", async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "subscription-runtime-goal-remediation-")),
    );
    const promptPath = join(root, "prompt.md");
    const workspacePath = join(root, "workspace");
    const outputPath = join(root, "job", "task-remediation.latest-result.json");
    const config: CodexGoalRunConfig = {
      jobId: "project-remediation",
      jobRootDir: join(root, "job"),
      authRootDir: join(root, "auth"),
      workspacePath,
      promptPath,
      taskId: "task-remediation",
      accounts: codexGoalAccountSlots(["account-a"]),
      outputPath,
    };

    try {
      await mkdir(config.jobRootDir, { recursive: true });
      await mkdir(workspacePath, { recursive: true });
      await writeFile(promptPath, "Repair the admitted producer output.\n");
      await execFileAsync("git", ["init"], { cwd: workspacePath });
      await execFileAsync("git", ["config", "user.email", "test@example.com"], {
        cwd: workspacePath,
      });
      await execFileAsync("git", ["config", "user.name", "Test User"], {
        cwd: workspacePath,
      });
      await writeFile(join(workspacePath, "packet.md"), "canonical\n");
      await execFileAsync("git", ["add", "packet.md"], { cwd: workspacePath });
      await execFileAsync("git", ["commit", "-m", "fixture"], {
        cwd: workspacePath,
      });

      // The broker admits an immutable producer patch as staged input.
      await writeFile(join(workspacePath, "packet.md"), "producer\n");
      await writeFile(join(workspacePath, "new-packet.md"), "producer new\n");
      await execFileAsync("git", ["add", "packet.md", "new-packet.md"], {
        cwd: workspacePath,
      });

      await runCodexGoal(config, {
        createExecutor: () => ({
          async run() {
            // The remediation is intentionally left unstaged on top of input.
            await writeFile(join(workspacePath, "packet.md"), "remediated\n");
            await writeFile(
              join(workspacePath, "new-packet.md"),
              "producer new\nremediated\n",
            );
            expect((await execFileAsync("git", ["status", "--short"], {
              cwd: workspacePath,
            })).stdout.trim().split("\n")).toEqual([
              "AM new-packet.md",
              "MM packet.md",
            ]);
            return {
              status: "completed",
              attempts: [{ changedFiles: [] }],
              task: { outputText: "done" },
            } as never;
          },
          async dispose() {},
        }),
      });

      const result = JSON.parse(await readFile(outputPath, "utf8")) as
        Record<string, unknown>;
      expect(result).toMatchObject({
        status: "done",
        changedFiles: ["new-packet.md", "packet.md"],
        nextAction: "review_completed",
      });
      const artifacts = result.artifacts as readonly Record<string, unknown>[];
      const patchPath = String(
        artifacts.find((artifact) => artifact.kind === "patch")?.path,
      );
      const manifestPath = String(
        artifacts.find((artifact) => artifact.kind === "manifest")?.path,
      );
      const summaryPath = String(
        artifacts.find((artifact) => artifact.kind === "summary")?.path,
      );
      expect(await readFile(patchPath, "utf8")).toContain("remediated");
      expect(JSON.parse(await readFile(manifestPath, "utf8"))).toMatchObject({
        workerJobId: "project-remediation",
        changedPaths: ["new-packet.md", "packet.md"],
      });
      expect(JSON.parse(await readFile(summaryPath, "utf8"))).toMatchObject({
        changedPaths: ["new-packet.md", "packet.md"],
        changedFileCount: 2,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("records stable evidence when a completed handoff cannot be materialized", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-goal-handoff-blocked-"));
    const promptPath = join(root, "prompt.md");
    const workspacePath = join(root, "workspace");
    const config: CodexGoalRunConfig = {
      jobRootDir: join(root, "job"),
      authRootDir: join(root, "auth"),
      workspacePath,
      promptPath,
      taskId: "task-handoff-blocked",
      accounts: codexGoalAccountSlots(["account-a"]),
      outputPath: join(root, "job", "task-handoff-blocked.latest-result.json"),
    };

    try {
      await mkdir(config.jobRootDir, { recursive: true });
      await mkdir(workspacePath, { recursive: true });
      await writeFile(promptPath, "Do a sandbox task.\n");
      await execFileAsync("git", ["init"], { cwd: workspacePath });
      await execFileAsync("git", ["config", "user.email", "test@example.com"], {
        cwd: workspacePath,
      });
      await execFileAsync("git", ["config", "user.name", "Test User"], {
        cwd: workspacePath,
      });
      await writeFile(join(workspacePath, "README.md"), "fixture\n");
      await execFileAsync("git", ["add", "README.md"], { cwd: workspacePath });
      await execFileAsync("git", ["commit", "-m", "fixture"], {
        cwd: workspacePath,
      });

      await runCodexGoal(config, {
        createExecutor: () => ({
          async run() {
            await writeFile(join(workspacePath, "auth.json"), "{}\n");
            return {
              status: "completed",
              attempts: [{ changedFiles: ["auth.json"] }],
              task: { outputText: "done" },
            } as never;
          },
          async dispose() {},
        }),
      });
      const result = JSON.parse(await readFile(config.outputPath!, "utf8")) as
        Record<string, unknown>;

      expect(result).toMatchObject({
        status: "done",
        changedFiles: ["auth.json"],
        details: {
          handoffArtifactError: "handoff_sensitive_path_rejected",
        },
      });
      expect(result.evidence).toEqual(expect.arrayContaining([
        "handoff_artifact_materialization_failed:handoff_sensitive_path_rejected",
        "patch_preserve_unavailable",
      ]));
      expect(result).not.toHaveProperty("artifacts");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("records prewarm failure without misclassifying it as unknown", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-goal-prewarm-"));
    const promptPath = join(root, "prompt.md");
    const workspacePath = join(root, "workspace");
    const outputPath = join(root, "job", "task-prewarm.latest-result.json");
    const config: CodexGoalRunConfig = {
      jobRootDir: join(root, "job"),
      authRootDir: join(root, "auth"),
      workspacePath,
      promptPath,
      taskId: "task-prewarm",
      accounts: codexGoalAccountSlots(["account-a"]),
      outputPath,
    };

    try {
      await mkdir(config.jobRootDir, { recursive: true });
      await mkdir(workspacePath, { recursive: true });
      await writeFile(promptPath, "Do a synthetic task.\n");
      await expect(runCodexGoal(config, {
        createExecutor: () => ({
          async run() {
            throw new SubscriptionWorkerError(
              "subscription_worker_prewarm_failed",
              "Worker pool failed to prewarm.",
            );
          },
          async dispose() {},
        }),
      })).rejects.toThrow("Worker pool failed to prewarm");

      expect(JSON.parse(await readFile(outputPath, "utf8"))).toMatchObject({
        status: "failed",
        reason: "prewarm_failed",
        blockers: ["prewarm_failed"],
        nextAction: "recover",
        details: {
          errorCode: "subscription_worker_prewarm_failed",
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
