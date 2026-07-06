import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import {
  LocalFileRunEventStore,
  LocalFileWorkerAccountCapacityStore,
  LocalFileWorkerControlInboxStore,
  LocalControlledAgentStateStore,
} from "@vioxen/subscription-runtime/store-local-file";
import {
  AccessBoundary,
  ControlledAgentProcessOwnerKind,
  ControlledAgentRunStatus,
  InMemoryActiveAttemptRegistry,
  NetworkAccessMode,
  ProjectControlAuditEventType,
  RunEventProviderKind,
  RunEventType,
  makeRunEvent,
  projectScopedControllerToolNames,
  type WorkerControlDeliveryReceipt,
} from "@vioxen/subscription-runtime/worker-core";
import {
  buildCodexGoalBrief,
  createCodexGoalMcpServer,
  projectControllerPendingGuidancePromptContext,
} from "../codex-goal-mcp";

const execFileAsync = promisify(execFile);

describe("codex goal MCP server", () => {
  it("renders bounded controller guidance context without exposing sensitive values", () => {
    const context = projectControllerPendingGuidancePromptContext({
      pendingCount: 7,
      deliverableSignals: Array.from({ length: 6 }, (_, index) => ({
        signal: {
          createdAt: new Date(`2026-07-06T10:0${index}:00.000Z`),
          createdBy: index === 5 ? "operator" : "orchestrator",
          priority: index === 5 ? "high" : "normal",
          body: index === 5
            ? `Refill S10 workers with token ${"a".repeat(48)} and keep capacity high.`
            : `Guidance ${index}`,
        },
      })),
    });

    expect(context).toContain("Pending controller guidance from durable inbox");
    expect(context).toContain("pendingCount=7 deliverableCount=6");
    expect(context).toContain("operator/high");
    expect(context).toContain("[redacted]");
    expect(context).not.toContain("a".repeat(48));
    expect(context).toContain("1 older deliverable guidance item(s) omitted");
  });

  it("registers the project integration tool surface from its feature module", async () => {
    const server = createCodexGoalMcpServer();
    const client = new Client({
      name: "subscription-runtime-test",
      version: "0.0.0",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);

      const toolResult = await client.listTools();
      const tools = (toolResult as {
        readonly tools?: readonly {
          readonly name?: string;
          readonly inputSchema?: {
            readonly properties?: Record<string, unknown>;
          };
        }[];
      }).tools ?? [];
      const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));

      for (const name of [
        "codex_goal_project_open_integration_attempt",
        "codex_goal_project_apply_worker_output",
        "codex_goal_project_run_required_checks",
        "codex_goal_project_commit_approved_changes",
        "codex_goal_project_push_approved_commit",
        "codex_goal_project_reject_integration_attempt",
      ]) {
        expect(toolsByName.has(name)).toBe(true);
      }

      expect(
        toolsByName.get("codex_goal_project_open_integration_attempt")
          ?.inputSchema?.properties,
      ).toMatchObject({
        registryRootDir: expect.any(Object),
        controllerJobId: expect.any(Object),
        requiredChecks: expect.any(Object),
        confirmOpen: expect.any(Object),
      });
      expect(
        toolsByName.get("codex_goal_project_commit_approved_changes")
          ?.inputSchema?.properties,
      ).toMatchObject({
        message: expect.any(Object),
        allowedPathPrefixes: expect.any(Object),
        requiredCheckIds: expect.any(Object),
        confirmCommit: expect.any(Object),
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("treats restricted tmux probes as unavailable instead of throwing", async () => {
    const calls: string[][] = [];
    const available = await hasTmux((args) => {
      calls.push([...args]);
      if (args[0] === "-V") return Promise.resolve();
      throw new Error("tmux new-session not permitted");
    });

    expect(available).toBe(false);
    expect(calls).toEqual([
      ["-V"],
      expect.arrayContaining(["new-session"]),
      expect.arrayContaining(["kill-session"]),
    ]);
  });

  it("flags alive workers with stale logs as silent-stale", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-silent-stale-"));
    const logPath = join(root, "task.log");
    const promptPath = join(root, "prompt.md");
    const staleLogTime = new Date(Date.now() - 10_000);
    try {
      await writeFile(logPath, "");
      await writeFile(promptPath, "Do a sandbox task.\n");
      await utimes(logPath, staleLogTime, staleLogTime);

      const brief = await buildCodexGoalBrief({
        jobId: "job-silent-stale",
        launch: {
          cwd: root,
          logPath,
          cliCommand: ["subscription-runtime-codex-goal"],
          config: {
            jobRootDir: root,
            authRootDir: root,
            workspacePath: root,
            promptPath,
            taskId: "task",
            accounts: [{ name: "account-a" }],
          },
        },
        status: {
          tmuxAlive: true,
          resultExists: false,
          workspaceDirty: false,
          changedFiles: [],
          logPath,
          logExists: true,
          logUpdatedAt: staleLogTime.toISOString(),
          logByteLength: 0,
          recommendedAction: "wait_for_worker",
          warnings: [],
        },
        accounts: [{
          name: "account-a",
          authJsonPath: join(root, "account-a", "auth.json"),
          status: "ready",
          warnings: [],
          safeMessage: "account-a is ready",
        }],
        staleAfterMs: 1_000,
        tailLines: 20,
      });

      expect(brief).toMatchObject({
        isStale: true,
        silentStale: true,
        logByteLength: 0,
        safeToContinue: false,
        nextBestTool: "manual_review",
        nextBestReason: "silent_stale_worker",
        nextBestCommand: "manual_review_silent_stale_worker",
      });
      expect(String(brief.text)).toContain("silentStale true");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("flags alive heartbeat-only workers with no output for manual review", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-heartbeat-only-"));
    const promptPath = join(root, "prompt.md");
    const progressPath = join(root, "task.progress.json");
    try {
      await writeFile(promptPath, "Do a sandbox task.\n");
      await writeFile(progressPath, `${JSON.stringify({
        schemaVersion: 1,
        taskId: "task",
        status: "running",
        updatedAt: new Date(Date.now() - 130_000).toISOString(),
        pid: process.pid,
      })}\n`);

      const brief = await buildCodexGoalBrief({
        jobId: "job-heartbeat-only",
        launch: {
          cwd: root,
          logPath: join(root, "task.log"),
          cliCommand: ["subscription-runtime-codex-goal"],
          config: {
            jobRootDir: root,
            authRootDir: root,
            workspacePath: root,
            promptPath,
            taskId: "task",
            accounts: [{ name: "account-a" }],
            progressPath,
          },
        },
        status: {
          tmuxAlive: true,
          resultExists: false,
          workspaceDirty: false,
          changedFiles: [],
          logPath: join(root, "task.log"),
          logExists: false,
          logByteLength: 0,
          progressPath,
          progressExists: true,
          progressStatus: "running",
          progressUpdatedAt: new Date().toISOString(),
          progressHeartbeatAgeMs: 130_000,
          recommendedAction: "wait_for_worker",
          warnings: [],
        },
        accounts: [{
          name: "account-a",
          authJsonPath: join(root, "account-a", "auth.json"),
          status: "ready",
          warnings: [],
          safeMessage: "account-a is ready",
        }],
        staleAfterMs: 600_000,
        tailLines: 20,
      });

      expect(brief).toMatchObject({
        isStale: false,
        silentStale: false,
        heartbeatOnlyNoOutput: true,
        safeToContinue: false,
        nextBestTool: "manual_review",
        nextBestReason: "heartbeat_only_no_output",
      });
      expect(String(brief.text)).toContain("heartbeatOnlyNoOutput true");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("exposes stale base revision facts in brief when a target commit is provided", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-base-revision-"));
    const promptPath = join(root, "prompt.md");
    const resultPath = join(root, "task.latest-result.json");
    const patchPath = join(root, "task.preserved.patch");
    try {
      await mkdir(root, { recursive: true });
      await writeFile(promptPath, "Do a sandbox task.\n");
      await writeFile(patchPath, "diff --git a/src/a.ts b/src/a.ts\n");
      await writeFile(resultPath, `${JSON.stringify({
        status: "partial",
        changedFiles: ["src/a.ts"],
        evidence: ["patch_preserved"],
        blockers: ["worker_stopped_before_result"],
        nextAction: "preserve_patch",
        details: {
          baseCommit: "abc1234",
        },
        artifacts: [{
          kind: "patch",
          path: patchPath,
          byteLength: 42,
        }],
        updatedAt: new Date().toISOString(),
      })}\n`);

      const brief = await buildCodexGoalBrief({
        jobId: "job-base-revision",
        launch: {
          cwd: root,
          logPath: join(root, "task.log"),
          cliCommand: ["subscription-runtime-codex-goal"],
          config: {
            jobRootDir: root,
            authRootDir: root,
            workspacePath: root,
            promptPath,
            taskId: "task",
            accounts: [{ name: "account-a" }],
            outputPath: resultPath,
          },
        },
        status: {
          tmuxAlive: false,
          resultExists: true,
          resultPath,
          resultStatus: "partial",
          workspaceDirty: true,
          changedFiles: ["src/a.ts"],
          logPath: join(root, "task.log"),
          logExists: false,
          logByteLength: 0,
          recommendedAction: "inspect_dirty_failure",
          warnings: [],
        },
        accounts: [{
          name: "account-a",
          authJsonPath: join(root, "account-a", "auth.json"),
          status: "ready",
          warnings: [],
          safeMessage: "account-a is ready",
        }],
        staleAfterMs: 60_000,
        tailLines: 20,
        targetCommit: "def5678",
      });

      expect(brief.baseRevision).toMatchObject({
        status: "needs_rebase_check",
        workerBaseCommit: "abc1234",
        targetCommit: "def5678",
      });
      expect(brief.statusView).toMatchObject({
        baseCommit: "abc1234",
        targetCommit: "def5678",
        baseStatus: "needs_rebase_check",
      });
      expect(brief.handoffPatchPath).toBe(patchPath);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("flags executor-started runners with fresh heartbeat but no output", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-executor-started-no-output-"));
    const promptPath = join(root, "prompt.md");
    const progressPath = join(root, "task.progress.json");
    const logPath = join(root, "task.log");
    const oldLogTime = new Date(Date.now() - 130_000);
    try {
      await writeFile(promptPath, "Do a sandbox task.\n");
      await writeFile(logPath, "");
      await utimes(logPath, oldLogTime, oldLogTime);
      await writeFile(progressPath, `${JSON.stringify({
        schemaVersion: 1,
        taskId: "task",
        status: "running",
        updatedAt: new Date().toISOString(),
        pid: process.pid,
      })}\n`);

      const brief = await buildCodexGoalBrief({
        jobId: "job-executor-started-no-output",
        launch: {
          cwd: root,
          logPath,
          cliCommand: ["subscription-runtime-codex-goal"],
          config: {
            jobRootDir: root,
            authRootDir: root,
            workspacePath: root,
            promptPath,
            taskId: "task",
            accounts: [{ name: "account-a" }],
            progressPath,
          },
        },
        status: {
          tmuxAlive: true,
          resultExists: false,
          workspaceDirty: false,
          changedFiles: [],
          logPath,
          logExists: true,
          logUpdatedAt: oldLogTime.toISOString(),
          logByteLength: 0,
          progressPath,
          progressExists: true,
          progressStatus: "running",
          progressUpdatedAt: new Date().toISOString(),
          progressHeartbeatAgeMs: 10_000,
          progressPid: process.pid,
          progressProcessAlive: true,
          progressCpuActive: true,
          runtimeEventsExists: true,
          runtimeEventsByteLength: 850,
          lastRuntimeEvent: "executor_started",
          lastRuntimeEventAt: oldLogTime.toISOString(),
          recommendedAction: "wait_for_worker",
          warnings: [],
        },
        accounts: [{
          name: "account-a",
          authJsonPath: join(root, "account-a", "auth.json"),
          status: "ready",
          warnings: [],
          safeMessage: "account-a is ready",
        }],
        staleAfterMs: 600_000,
        tailLines: 20,
      });

      expect(brief).toMatchObject({
        isStale: false,
        silentStale: false,
        heartbeatOnlyNoOutput: true,
        safeToContinue: false,
        nextBestTool: "manual_review",
        nextBestReason: "heartbeat_only_no_output",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("exposes read-only agent run watch snapshots without control actions", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-run-watch-"));
    const registryRootDir = join(root, "registry");
    const jobRootDir = join(root, "job");
    const stateRootDir = join(root, "state");
    const authRootDir = join(root, "auth");
    const workspacePath = join(root, "workspace");
    const promptPath = join(jobRootDir, "prompt.md");
    const taskId = "sandbox-watch-task";

    try {
      await mkdir(jobRootDir, { recursive: true });
      await mkdir(workspacePath, { recursive: true });
      await execFileAsync("git", ["init"], { cwd: workspacePath });
      await writeFile(promptPath, "Observe a sandbox task.\n");
      await writeFakeAuth(authRootDir, "account-a", {
        lastRefresh: "2026-06-03T00:00:00.000Z",
      });
      await writeFile(join(jobRootDir, `${taskId}.latest-result.json`), `${JSON.stringify({
        status: "completed",
        task: { updatedAt: "2026-06-30T00:00:00.000Z" },
      })}\n`);
      await writeFile(
        join(jobRootDir, `${taskId}.log`),
        "finished with Authorization: Bearer rawBearerSecret\n",
      );

      const server = createCodexGoalMcpServer();
      const client = new Client({ name: "subscription-runtime-test", version: "0.0.0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);

      try {
        await callToolJson(client, "codex_goal_create_job", {
          registryRootDir,
          jobId: "job-observed",
          jobRootDir,
          authRootDir,
          stateRootDir,
          workspacePath,
          promptPath,
          taskId,
          accounts: ["account-a"],
          logPath: join(jobRootDir, `${taskId}.log`),
        });

        const watch = await callToolJson(client, "agent_run_watch", {
          registryRootDir,
          jobId: "job-observed",
          includeLogTail: true,
          tailLines: 5,
        });

        expect(watch).toMatchObject({
          ok: true,
          mode: "read_only",
          sideEffects: [],
          providerKind: "codex",
          summary: {
            completed: 1,
          },
        });
        const snapshots = watch.snapshots as readonly Record<string, unknown>[];
        expect(snapshots[0]).toMatchObject({
          runId: "job-observed",
          providerKind: "codex",
          status: "completed",
          readOnlyDecision: {
            kind: "review_completed",
          },
        });
        expect(JSON.stringify(watch).includes("rawBearerSecret")).toBe(false);

        const eventRootDir = join(root, "events");
        const eventStore = new LocalFileRunEventStore({ rootDir: eventRootDir });
        const foreignEvent = makeRunEvent({
          runId: "foreign-claude-run",
          type: RunEventType.Completed,
          occurredAt: "2026-07-03T00:00:00.000Z",
          source: {
            providerKind: RunEventProviderKind.Claude,
            registryRootDir,
          },
          payload: { status: "completed" },
          idempotencyParts: ["foreign-claude-run"],
        });
        await eventStore.append([foreignEvent]);
        const projected = await callToolJson(client, "agent_run_project_events", {
          registryRootDir,
          jobId: "job-observed",
          eventRootDir,
          hostId: "test-host",
        });

        expect(projected).toMatchObject({
          ok: true,
          mode: "project_events",
          sideEffects: ["append_run_events", "write_projection_state"],
          providerKind: "codex",
          appendedCount: expect.any(Number),
          projectedRuns: [
            expect.objectContaining({
              runId: "job-observed",
              status: "completed",
            }),
          ],
        });
        expect((projected.appendedCount as number)).toBeGreaterThan(0);
        const projectedEvents = projected.events as readonly Record<string, unknown>[];
        expect(projectedEvents.map((event) => event.runId)).not.toContain(
          "foreign-claude-run",
        );
        expect(
          projectedEvents.every((event) =>
            (event.source as { providerKind?: unknown }).providerKind === "codex"
          ),
        ).toBe(true);
        expect(JSON.stringify(projected).includes("rawBearerSecret")).toBe(false);

        const events = await callToolJson(client, "agent_run_events", {
          registryRootDir,
          jobId: "job-observed",
          eventRootDir,
          type: "run.completed",
        });

        expect(events).toMatchObject({
          ok: true,
          mode: "read_only",
          sideEffects: [],
          returnedEvents: 1,
          events: [
            expect.objectContaining({
              runId: "job-observed",
              type: "run.completed",
              source: expect.objectContaining({
                providerKind: "codex",
                hostId: "test-host",
              }),
            }),
          ],
        });
        expect(JSON.stringify(events).includes("rawBearerSecret")).toBe(false);

        const state = await callToolJson(client, "agent_run_state", {
          registryRootDir,
          jobId: "job-observed",
          eventRootDir,
        });

        expect(state).toMatchObject({
          ok: true,
          mode: "read_only_state",
          sideEffects: [],
          providerKind: "codex",
          runId: "job-observed",
          readModels: {
            safety: {
              safeToContinue: false,
              reviewOnly: true,
            },
            outcome: {
              status: "completed",
            },
          },
        });
        expect(JSON.stringify(state).includes("rawBearerSecret")).toBe(false);

        const compactionPlan = await callToolJson(
          client,
          "agent_run_event_compaction_plan",
          {
            registryRootDir,
            eventRootDir,
            keepLatestEventsPerRun: 1,
          },
        );

        expect(compactionPlan).toMatchObject({
          ok: true,
          mode: "compaction_plan",
          sideEffects: [],
          eventRootDir,
          policy: {
            keepLatestEventsPerRun: 1,
          },
          plan: {
            schemaVersion: 1,
            retainedLineCount: expect.any(Number),
            removableLineCount: expect.any(Number),
          },
        });

        const compactWithoutConfirm = await callToolJson(
          client,
          "agent_run_event_compact",
          {
            registryRootDir,
            eventRootDir,
            keepLatestEventsPerRun: 1,
          },
        );

        expect(compactWithoutConfirm).toMatchObject({
          ok: false,
          mode: "compact_events",
          sideEffects: [],
          reason: "confirm_compact_required",
        });

        const compact = await callToolJson(client, "agent_run_event_compact", {
          registryRootDir,
          eventRootDir,
          keepLatestEventsPerRun: 1,
          confirmCompact: true,
        });

        expect(compact).toMatchObject({
          ok: true,
          mode: "compact_events",
          sideEffects: ["rewrite_run_event_log", "rewrite_delivery_cursors"],
          result: {
            compacted: expect.any(Boolean),
            retainedLineCount: expect.any(Number),
            removableLineCount: expect.any(Number),
          },
        });
      } finally {
        await client.close();
        await server.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects unsupported edit modes in codex goal job tools", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "subscription-runtime-mcp-permission-"),
    );
    const server = createCodexGoalMcpServer();
    const client = new Client({
      name: "subscription-runtime-test",
      version: "0.0.0",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);

      const result = await callToolJson(client, "codex_goal_create_job", {
        registryRootDir: join(root, "registry"),
        jobId: "job-permission",
        jobRootDir: join(root, "job"),
        authRootDir: join(root, "auth"),
        workspacePath: join(root, "workspace"),
        promptPath: join(root, "job", "prompt.md"),
        taskId: "task-permission",
        accounts: ["account-a"],
        editMode: "danger-full-access",
      });

      expect(result).toMatchObject({ ok: false });
      expect(String(result.error)).toContain(
        "Use providerSandboxMode",
      );
    } finally {
      await client.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("round-trips access boundary fields through codex_goal_create_job", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-mcp-access-"));
    const server = createCodexGoalMcpServer();
    const client = new Client({
      name: "subscription-runtime-test",
      version: "0.0.0",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);

      const result = await callToolJson(client, "codex_goal_create_job", {
        registryRootDir: join(root, "registry"),
        jobId: "infinity-context-access-v1",
        jobRootDir: join(root, "job"),
        authRootDir: join(root, "auth"),
        workspacePath: join(root, "workspace"),
        promptPath: join(root, "job", "prompt.md"),
        taskId: "infinity-context-access-v1",
        accounts: ["account-a"],
        accessBoundary: AccessBoundary.IsolatedWorkspaceWrite,
        projectAccessScope: {
          projectId: "infinity-context",
          workspaceRoots: [join(root, "workspace")],
          jobIdPrefixes: ["infinity-context-"],
        },
        networkAccess: NetworkAccessMode.Restricted,
      });

      expect(result).toMatchObject({
        ok: true,
        manifest: {
          accessBoundary: AccessBoundary.IsolatedWorkspaceWrite,
          projectAccessScope: {
            projectId: "infinity-context",
            workspaceRoots: [join(root, "workspace")],
            jobIdPrefixes: ["infinity-context-"],
          },
          networkAccess: NetworkAccessMode.Restricted,
        },
      });
    } finally {
      await client.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("lets a project-scoped controller create an isolated child job through broker policy", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-project-control-"));
    const registryRootDir = join(root, "worker-jobs", "registry");
    const controllerJobRoot = join(root, "worker-jobs", "infinity-context-controller-v1");
    const controllerWorkspace = join(root, "workspaces", "infinity-context-controller");
    const childWorkspace = join(root, "worktrees", "infinity-context-child-v1");
    const childJobRoot = join(root, "worker-jobs", "infinity-context-child-v1");
    const server = createCodexGoalMcpServer();
    const client = new Client({
      name: "subscription-runtime-test",
      version: "0.0.0",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);

      await callToolJson(client, "codex_goal_create_job", {
        registryRootDir,
        jobId: "infinity-context-controller-v1",
        jobRootDir: controllerJobRoot,
        authRootDir: join(root, "auth"),
        workspacePath: controllerWorkspace,
        promptPath: join(controllerJobRoot, "prompt.md"),
        taskId: "infinity-context-controller-v1",
        accounts: ["account-a"],
        accessBoundary: AccessBoundary.ProjectScopedControl,
        networkAccess: NetworkAccessMode.Restricted,
        projectAccessScope: {
          projectId: "infinity-context",
          workspaceRoots: [join(root, "workspaces")],
          worktreeRoots: [join(root, "worktrees")],
          registryRoot: registryRootDir,
          jobIdPrefixes: ["infinity-context-"],
          tmuxSessionPrefixes: ["infinity-context-"],
          allowedAccountIds: ["account-a"],
        },
      });

      const created = await callToolJson(client, "codex_goal_project_create_job", {
        registryRootDir,
        controllerJobId: "infinity-context-controller-v1",
        jobId: "infinity-context-child-v1",
        jobRootDir: childJobRoot,
        authRootDir: join(root, "auth"),
        workspacePath: childWorkspace,
        promptPath: join(childJobRoot, "prompt.md"),
        taskId: "infinity-context-child-v1",
        accounts: ["account-a"],
        workerRole: "reviewer",
        confirmCreate: true,
      });

      expect(created).toMatchObject({
        ok: true,
        mode: "project_control_create_job",
        controllerJobId: "infinity-context-controller-v1",
        manifest: {
          jobId: "infinity-context-child-v1",
          accessBoundary: AccessBoundary.IsolatedWorkspaceWrite,
          networkAccess: NetworkAccessMode.Restricted,
          tags: expect.arrayContaining(["worker-role-reviewer"]),
          projectAccessScope: {
            projectId: "infinity-context",
            isolatedWorkspaceRoot: childWorkspace,
            workspaceRoots: [childWorkspace],
          },
        },
      });
      const audit = await readProjectControlAudit(
        controllerJobRoot,
        "infinity-context-controller-v1",
      );
      expect(audit.some((event) => auditDecision(event).allowed === true)).toBe(true);
    } finally {
      await client.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("defaults project-control child jobs to the ready account pool", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-project-accounts-"));
    const registryRootDir = join(root, "worker-jobs", "registry");
    const authRootDir = join(root, "auth");
    const controllerJobRoot = join(root, "worker-jobs", "infinity-context-controller-v1");
    const controllerWorkspace = join(root, "workspaces", "infinity-context-controller");
    const childWorkspace = join(root, "worktrees", "infinity-context-child-v1");
    const childJobRoot = join(root, "worker-jobs", "infinity-context-child-v1");
    const server = createCodexGoalMcpServer();
    const client = new Client({
      name: "subscription-runtime-test",
      version: "0.0.0",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);
      await writeFakeAuth(authRootDir, "account-a", {
        lastRefresh: new Date().toISOString(),
      });
      await writeFakeAuth(authRootDir, "account-b", {
        lastRefresh: new Date().toISOString(),
      });

      await callToolJson(client, "codex_goal_create_job", {
        registryRootDir,
        jobId: "infinity-context-controller-v1",
        jobRootDir: controllerJobRoot,
        authRootDir,
        workspacePath: controllerWorkspace,
        promptPath: join(controllerJobRoot, "prompt.md"),
        taskId: "infinity-context-controller-v1",
        accounts: ["account-a"],
        accessBoundary: AccessBoundary.ProjectScopedControl,
        networkAccess: NetworkAccessMode.Restricted,
        projectAccessScope: {
          projectId: "infinity-context",
          workspaceRoots: [join(root, "workspaces")],
          worktreeRoots: [join(root, "worktrees")],
          registryRoot: registryRootDir,
          jobIdPrefixes: ["infinity-context-"],
          tmuxSessionPrefixes: ["infinity-context-"],
          allowedAccountIds: ["account-a", "account-b"],
        },
      });

      const created = await callToolJson(client, "codex_goal_project_create_job", {
        registryRootDir,
        controllerJobId: "infinity-context-controller-v1",
        jobId: "infinity-context-child-v1",
        jobRootDir: childJobRoot,
        authRootDir,
        workspacePath: childWorkspace,
        promptPath: join(childJobRoot, "prompt.md"),
        taskId: "infinity-context-child-v1",
        accounts: ["account-a"],
        confirmCreate: true,
      });

      expect(created).toMatchObject({
        ok: true,
        manifest: {
          accounts: ["account-a", "account-b"],
        },
      });
    } finally {
      await client.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("repairs project child manifest accounts through the brokered repair tool", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-project-manifest-repair-"));
    const registryRootDir = join(root, "worker-jobs", "registry");
    const authRootDir = join(root, "auth");
    const controllerJobRoot = join(root, "worker-jobs", "infinity-context-controller-v1");
    const controllerWorkspace = join(root, "workspaces", "infinity-context-controller");
    const childWorkspace = join(root, "worktrees", "infinity-context-child-v1");
    const childJobRoot = join(root, "worker-jobs", "infinity-context-child-v1");
    const server = createCodexGoalMcpServer();
    const client = new Client({
      name: "subscription-runtime-test",
      version: "0.0.0",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);
      await writeFakeAuth(authRootDir, "account-a", {
        lastRefresh: new Date().toISOString(),
      });

      await callToolJson(client, "codex_goal_create_job", {
        registryRootDir,
        jobId: "infinity-context-controller-v1",
        jobRootDir: controllerJobRoot,
        authRootDir,
        workspacePath: controllerWorkspace,
        promptPath: join(controllerJobRoot, "prompt.md"),
        taskId: "infinity-context-controller-v1",
        accounts: ["account-a"],
        accessBoundary: AccessBoundary.ProjectScopedControl,
        networkAccess: NetworkAccessMode.Restricted,
        projectAccessScope: {
          projectId: "infinity-context",
          workspaceRoots: [join(root, "workspaces")],
          worktreeRoots: [join(root, "worktrees")],
          registryRoot: registryRootDir,
          jobIdPrefixes: ["infinity-context-"],
          tmuxSessionPrefixes: ["infinity-context-"],
          allowedAccountIds: ["account-a", "account-b"],
        },
      });

      const created = await callToolJson(client, "codex_goal_project_create_job", {
        registryRootDir,
        controllerJobId: "infinity-context-controller-v1",
        jobId: "infinity-context-child-v1",
        jobRootDir: childJobRoot,
        authRootDir,
        workspacePath: childWorkspace,
        promptPath: join(childJobRoot, "prompt.md"),
        taskId: "infinity-context-child-v1",
        accounts: ["account-a"],
        confirmCreate: true,
      });
      expect(created).toMatchObject({
        ok: true,
        manifest: { accounts: ["account-a"] },
      });

      await writeFakeAuth(authRootDir, "account-b", {
        lastRefresh: new Date().toISOString(),
      });
      const preview = await callToolJson(client, "brokered_project_manifest_repair", {
        registryRootDir,
        controllerJobId: "infinity-context-controller-v1",
        jobId: "infinity-context-child-v1",
      });
      expect(preview).toMatchObject({
        ok: false,
        reason: "confirm_repair_required",
        proposedPatch: { accounts: ["account-a", "account-b"] },
      });

      const repaired = await callToolJson(client, "brokered_project_manifest_repair", {
        registryRootDir,
        controllerJobId: "infinity-context-controller-v1",
        jobId: "infinity-context-child-v1",
        confirmRepair: true,
      });
      expect(repaired).toMatchObject({
        ok: true,
        manifest: { accounts: ["account-a", "account-b"] },
      });

      const denied = await callToolJson(client, "brokered_project_manifest_repair", {
        registryRootDir,
        controllerJobId: "infinity-context-controller-v1",
        jobId: "infinity-context-child-v1",
        accounts: ["account-c"],
        confirmRepair: true,
      });
      expect(denied).toMatchObject({
        ok: false,
        error: "project_control_repair_account_outside_scope",
      });
    } finally {
      await client.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("updates controller consumed-output ledger roots through scoped repair only", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-controller-scope-repair-"));
    const registryRootDir = join(root, "worker-jobs", "registry");
    const controllerJobRoot = join(root, "worker-jobs", "infinity-context-controller-v1");
    const controllerWorkspace = join(root, "workspaces", "infinity-context-controller");
    const controlRoot = join(root, "control");
    const ledgerRoot = join(controlRoot, "dirty-worktree-drain");
    const baseScope = {
      projectId: "infinity-context",
      readRoots: [controlRoot, join(root, "workspaces")],
      workspaceRoots: [join(root, "workspaces")],
      worktreeRoots: [join(root, "worktrees")],
      registryRoot: registryRootDir,
      deniedRoots: [join(root, "secrets")],
      jobIdPrefixes: ["infinity-context-"],
      tmuxSessionPrefixes: ["infinity-context-"],
      allowedAccountIds: ["account-a"],
    };
    const server = createCodexGoalMcpServer();
    const client = new Client({
      name: "subscription-runtime-test",
      version: "0.0.0",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);

      await callToolJson(client, "codex_goal_create_job", {
        registryRootDir,
        jobId: "infinity-context-controller-v1",
        jobRootDir: controllerJobRoot,
        authRootDir: join(root, "auth"),
        workspacePath: controllerWorkspace,
        promptPath: join(controllerJobRoot, "prompt.md"),
        taskId: "infinity-context-controller-v1",
        accounts: ["account-a"],
        accessBoundary: AccessBoundary.ProjectScopedControl,
        networkAccess: NetworkAccessMode.Restricted,
        projectAccessScope: baseScope,
      });

      const proposedScope = {
        ...baseScope,
        consumedOutputLedgerRoots: [ledgerRoot],
      };
      const preview = await callToolJson(
        client,
        "codex_goal_project_update_controller_scope",
        {
          registryRootDir,
          controllerJobId: "infinity-context-controller-v1",
          projectAccessScope: proposedScope,
        },
      );
      expect(preview).toMatchObject({
        ok: false,
        reason: "confirm_update_required",
        proposedConsumedOutputLedgerRoots: [ledgerRoot],
      });

      const updated = await callToolJson(
        client,
        "codex_goal_project_update_controller_scope",
        {
          registryRootDir,
          controllerJobId: "infinity-context-controller-v1",
          projectAccessScope: proposedScope,
          confirmUpdate: true,
        },
      );
      expect(updated).toMatchObject({
        ok: true,
        manifest: {
          projectAccessScope: {
            consumedOutputLedgerRoots: [ledgerRoot],
          },
        },
      });

      const widened = await callToolJson(
        client,
        "codex_goal_project_update_controller_scope",
        {
          registryRootDir,
          controllerJobId: "infinity-context-controller-v1",
          projectAccessScope: {
            ...proposedScope,
            readRoots: [...baseScope.readRoots, "/outside"],
          },
          confirmUpdate: true,
        },
      );
      expect(widened).toMatchObject({
        ok: false,
        error: "project_control_scope_readRoots_repair_denied",
      });
    } finally {
      await client.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("denies generic start for project-scoped controller jobs", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-project-generic-start-"));
    const registryRootDir = join(root, "worker-jobs", "registry");
    const controllerJobRoot = join(root, "worker-jobs", "infinity-context-controller-v1");
    const controllerWorkspace = join(root, "workspaces", "infinity-context-controller");
    const server = createCodexGoalMcpServer();
    const client = new Client({
      name: "subscription-runtime-test",
      version: "0.0.0",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);

      const result = await callToolJson(client, "codex_goal_start", {
        registryRootDir,
        jobId: "infinity-context-controller-v1",
        jobRootDir: controllerJobRoot,
        authRootDir: join(root, "auth"),
        workspacePath: controllerWorkspace,
        promptPath: join(controllerJobRoot, "prompt.md"),
        taskId: "infinity-context-controller-v1",
        accounts: ["account-a"],
        accessBoundary: AccessBoundary.ProjectScopedControl,
        networkAccess: NetworkAccessMode.Restricted,
        projectAccessScope: {
          projectId: "infinity-context",
          workspaceRoots: [join(root, "workspaces")],
          worktreeRoots: [join(root, "worktrees")],
          registryRoot: registryRootDir,
          jobIdPrefixes: ["infinity-context-"],
          tmuxSessionPrefixes: ["infinity-context-"],
          allowedAccountIds: ["account-a"],
        },
        confirmStart: true,
      });

      expect(result).toMatchObject({
        ok: false,
        reason: "project_control_broker_required",
        requiredTool: "codex_goal_project_controller_start",
      });
    } finally {
      await client.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("denies generic updates for project-owned job manifests", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-project-generic-update-"));
    const registryRootDir = join(root, "worker-jobs", "registry");
    const controllerJobRoot = join(root, "worker-jobs", "infinity-context-controller-v1");
    const controllerWorkspace = join(root, "workspaces", "infinity-context-controller");
    const server = createCodexGoalMcpServer();
    const client = new Client({
      name: "subscription-runtime-test",
      version: "0.0.0",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);

      await callToolJson(client, "codex_goal_create_job", {
        registryRootDir,
        jobId: "infinity-context-controller-v1",
        jobRootDir: controllerJobRoot,
        authRootDir: join(root, "auth"),
        workspacePath: controllerWorkspace,
        promptPath: join(controllerJobRoot, "prompt.md"),
        taskId: "infinity-context-controller-v1",
        accounts: ["account-a"],
        accessBoundary: AccessBoundary.ProjectScopedControl,
        networkAccess: NetworkAccessMode.Restricted,
        projectAccessScope: {
          projectId: "infinity-context",
          workspaceRoots: [join(root, "workspaces")],
          worktreeRoots: [join(root, "worktrees")],
          registryRoot: registryRootDir,
          jobIdPrefixes: ["infinity-context-"],
          tmuxSessionPrefixes: ["infinity-context-"],
          allowedAccountIds: ["account-a"],
        },
      });

      const result = await callToolJson(client, "codex_goal_update_job", {
        registryRootDir,
        jobId: "infinity-context-controller-v1",
        description: "operator mutation should be brokered",
      });

      expect(result).toMatchObject({
        ok: false,
        reason: "project_control_broker_required",
        requiredTool: "brokered_project_manifest_repair",
      });
    } finally {
      await client.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("denies generic child creation when an existing controller owns the scope", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-project-generic-child-"));
    const registryRootDir = join(root, "worker-jobs", "registry");
    const controllerJobRoot = join(root, "worker-jobs", "infinity-context-controller-v1");
    const sourceWorkspacePath = join(root, "workspaces", "infinity-context-main");
    const childWorkspace = join(root, "worktrees", "infinity-context-memory-child-v1");
    const childJobRoot = join(root, "worker-jobs", "infinity-context-memory-child-v1");
    const server = createCodexGoalMcpServer();
    const client = new Client({
      name: "subscription-runtime-test",
      version: "0.0.0",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);

      await callToolJson(client, "codex_goal_create_job", {
        registryRootDir,
        jobId: "infinity-context-controller-v1",
        jobRootDir: controllerJobRoot,
        authRootDir: join(root, "auth"),
        workspacePath: sourceWorkspacePath,
        promptPath: join(controllerJobRoot, "prompt.md"),
        taskId: "infinity-context-controller-v1",
        accounts: ["account-a"],
        accessBoundary: AccessBoundary.ProjectScopedControl,
        networkAccess: NetworkAccessMode.Restricted,
        projectAccessScope: {
          projectId: "infinity-context",
          workspaceRoots: [sourceWorkspacePath],
          worktreeRoots: [join(root, "worktrees")],
          registryRoot: registryRootDir,
          jobIdPrefixes: ["infinity-context-"],
          tmuxSessionPrefixes: ["infinity-context-"],
          allowedAccountIds: ["account-a"],
        },
      });

      const result = await callToolJson(client, "codex_goal_create_job", {
        registryRootDir,
        jobId: "infinity-context-memory-child-v1",
        jobRootDir: childJobRoot,
        authRootDir: join(root, "auth"),
        workspacePath: childWorkspace,
        promptPath: join(childJobRoot, "prompt.md"),
        taskId: "infinity-context-memory-child-v1",
        accounts: ["account-a"],
        networkAccess: NetworkAccessMode.Restricted,
      });

      expect(result).toMatchObject({
        ok: false,
        reason: "project_control_broker_required",
        controllerJobId: "infinity-context-controller-v1",
        requiredTool: "codex_goal_project_create_job",
      });
    } finally {
      await client.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("denies generic lifecycle for legacy project-like jobs after controller adoption", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-project-legacy-generic-"));
    const registryRootDir = join(root, "worker-jobs", "registry");
    const controllerJobRoot = join(root, "worker-jobs", "infinity-context-controller-v1");
    const sourceWorkspacePath = join(root, "workspaces", "infinity-context-main");
    const legacyWorkspace = join(root, "worktrees", "infinity-context-memory-legacy-v1");
    const legacyJobRoot = join(root, "worker-jobs", "infinity-context-memory-legacy-v1");
    const server = createCodexGoalMcpServer();
    const client = new Client({
      name: "subscription-runtime-test",
      version: "0.0.0",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);

      await callToolJson(client, "codex_goal_create_job", {
        registryRootDir,
        jobId: "infinity-context-memory-legacy-v1",
        jobRootDir: legacyJobRoot,
        authRootDir: join(root, "auth"),
        workspacePath: legacyWorkspace,
        promptPath: join(legacyJobRoot, "prompt.md"),
        taskId: "infinity-context-memory-legacy-v1",
        accounts: ["account-a"],
        networkAccess: NetworkAccessMode.Restricted,
      });
      await callToolJson(client, "codex_goal_create_job", {
        registryRootDir,
        jobId: "infinity-context-controller-v1",
        jobRootDir: controllerJobRoot,
        authRootDir: join(root, "auth"),
        workspacePath: sourceWorkspacePath,
        promptPath: join(controllerJobRoot, "prompt.md"),
        taskId: "infinity-context-controller-v1",
        accounts: ["account-a"],
        accessBoundary: AccessBoundary.ProjectScopedControl,
        networkAccess: NetworkAccessMode.Restricted,
        projectAccessScope: {
          projectId: "infinity-context",
          workspaceRoots: [sourceWorkspacePath],
          worktreeRoots: [join(root, "worktrees")],
          registryRoot: registryRootDir,
          jobIdPrefixes: ["infinity-context-"],
          tmuxSessionPrefixes: ["infinity-context-"],
          allowedAccountIds: ["account-a"],
        },
      });

      const update = await callToolJson(client, "codex_goal_update_job", {
        registryRootDir,
        jobId: "infinity-context-memory-legacy-v1",
        description: "legacy mutation should go through broker",
      });
      expect(update).toMatchObject({
        ok: false,
        reason: "project_control_broker_required",
        requiredTool: "brokered_project_manifest_repair",
      });
      const continued = await callToolJson(client, "codex_goal_continue", {
        registryRootDir,
        jobId: "infinity-context-memory-legacy-v1",
        confirmContinue: true,
      });
      expect(continued).toMatchObject({
        ok: false,
        reason: "project_control_broker_required",
        requiredTool: "codex_goal_project_start",
      });
      const reviewed = await callToolJson(client, "codex_goal_mark_reviewed", {
        registryRootDir,
        jobId: "infinity-context-memory-legacy-v1",
      });
      expect(reviewed).toMatchObject({
        ok: false,
        reason: "project_control_broker_required",
        requiredTool: "codex_goal_project_mark_reviewed",
      });
    } finally {
      await client.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("denies project start when an existing child manifest uses an account outside scope", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-project-start-account-"));
    const registryRootDir = join(root, "worker-jobs", "registry");
    const controllerJobRoot = join(root, "worker-jobs", "infinity-context-controller-v1");
    const sourceWorkspacePath = join(root, "workspaces", "infinity-context-main");
    const childWorkspace = join(root, "worktrees", "infinity-context-memory-child-v1");
    const childJobRoot = join(root, "worker-jobs", "infinity-context-memory-child-v1");
    const server = createCodexGoalMcpServer();
    const client = new Client({
      name: "subscription-runtime-test",
      version: "0.0.0",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await mkdir(sourceWorkspacePath, { recursive: true });
      await gitInitRepository(sourceWorkspacePath);
      await writeFile(join(sourceWorkspacePath, "README.md"), "base\n");
      await git(sourceWorkspacePath, ["add", "README.md"]);
      await git(sourceWorkspacePath, ["commit", "-m", "test: base"]);
      await mkdir(childWorkspace, { recursive: true });
      await gitInitRepository(childWorkspace);
      await writeFile(join(childWorkspace, "README.md"), "child\n");
      await git(childWorkspace, ["add", "README.md"]);
      await git(childWorkspace, ["commit", "-m", "test: child base"]);
      await mkdir(childJobRoot, { recursive: true });
      await writeFile(join(childJobRoot, "prompt.md"), "child task\n");

      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);

      await callToolJson(client, "codex_goal_create_job", {
        registryRootDir,
        jobId: "infinity-context-memory-child-v1",
        jobRootDir: childJobRoot,
        authRootDir: join(root, "auth"),
        workspacePath: childWorkspace,
        promptPath: join(childJobRoot, "prompt.md"),
        taskId: "infinity-context-memory-child-v1",
        accounts: ["account-b"],
        accessBoundary: AccessBoundary.IsolatedWorkspaceWrite,
        networkAccess: NetworkAccessMode.Restricted,
        projectAccessScope: {
          projectId: "infinity-context",
          isolatedWorkspaceRoot: childWorkspace,
          workspaceRoots: [childWorkspace],
        },
      });
      await callToolJson(client, "codex_goal_create_job", {
        registryRootDir,
        jobId: "infinity-context-controller-v1",
        jobRootDir: controllerJobRoot,
        authRootDir: join(root, "auth"),
        workspacePath: sourceWorkspacePath,
        promptPath: join(controllerJobRoot, "prompt.md"),
        taskId: "infinity-context-controller-v1",
        accounts: ["account-a"],
        accessBoundary: AccessBoundary.ProjectScopedControl,
        networkAccess: NetworkAccessMode.Restricted,
        projectAccessScope: {
          projectId: "infinity-context",
          workspaceRoots: [sourceWorkspacePath],
          worktreeRoots: [join(root, "worktrees")],
          registryRoot: registryRootDir,
          jobIdPrefixes: ["infinity-context-"],
          tmuxSessionPrefixes: ["infinity-context-"],
          allowedAccountIds: ["account-a"],
        },
      });

      await expect(callToolJson(client, "codex_goal_project_start", {
        registryRootDir,
        controllerJobId: "infinity-context-controller-v1",
        jobId: "infinity-context-memory-child-v1",
        confirmStart: true,
        skipDoctor: true,
      })).resolves.toMatchObject({
        ok: false,
        error: "project_control_denied:account_denied",
      });
    } finally {
      await client.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("denies project start when a child workspace symlink resolves outside scope", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-project-start-symlink-"));
    const registryRootDir = join(root, "worker-jobs", "registry");
    const controllerJobRoot = join(root, "worker-jobs", "infinity-context-controller-v1");
    const sourceWorkspacePath = join(root, "workspaces", "infinity-context-main");
    const childWorkspace = join(root, "worktrees", "infinity-context-memory-child-v1");
    const outsideChildTarget = join(root, "outside-project", "infinity-context-memory-child-v1");
    const childJobRoot = join(root, "worker-jobs", "infinity-context-memory-child-v1");
    const server = createCodexGoalMcpServer();
    const client = new Client({
      name: "subscription-runtime-test",
      version: "0.0.0",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await mkdir(sourceWorkspacePath, { recursive: true });
      await gitInitRepository(sourceWorkspacePath);
      await writeFile(join(sourceWorkspacePath, "README.md"), "base\n");
      await git(sourceWorkspacePath, ["add", "README.md"]);
      await git(sourceWorkspacePath, ["commit", "-m", "test: base"]);
      await mkdir(outsideChildTarget, { recursive: true });
      await gitInitRepository(outsideChildTarget);
      await writeFile(join(outsideChildTarget, "README.md"), "outside\n");
      await git(outsideChildTarget, ["add", "README.md"]);
      await git(outsideChildTarget, ["commit", "-m", "test: outside base"]);
      await mkdir(join(root, "worktrees"), { recursive: true });
      await symlink(outsideChildTarget, childWorkspace, "dir");
      await mkdir(childJobRoot, { recursive: true });
      await writeFile(join(childJobRoot, "prompt.md"), "child task\n");

      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);

      await callToolJson(client, "codex_goal_create_job", {
        registryRootDir,
        jobId: "infinity-context-memory-child-v1",
        jobRootDir: childJobRoot,
        authRootDir: join(root, "auth"),
        workspacePath: childWorkspace,
        promptPath: join(childJobRoot, "prompt.md"),
        taskId: "infinity-context-memory-child-v1",
        accounts: ["account-a"],
        networkAccess: NetworkAccessMode.Restricted,
      });
      await callToolJson(client, "codex_goal_create_job", {
        registryRootDir,
        jobId: "infinity-context-controller-v1",
        jobRootDir: controllerJobRoot,
        authRootDir: join(root, "auth"),
        workspacePath: sourceWorkspacePath,
        promptPath: join(controllerJobRoot, "prompt.md"),
        taskId: "infinity-context-controller-v1",
        accounts: ["account-a"],
        accessBoundary: AccessBoundary.ProjectScopedControl,
        networkAccess: NetworkAccessMode.Restricted,
        projectAccessScope: {
          projectId: "infinity-context",
          workspaceRoots: [sourceWorkspacePath],
          worktreeRoots: [join(root, "worktrees")],
          registryRoot: registryRootDir,
          jobIdPrefixes: ["infinity-context-"],
          tmuxSessionPrefixes: ["infinity-context-"],
          allowedAccountIds: ["account-a"],
        },
      });

      await expect(callToolJson(client, "codex_goal_project_start", {
        registryRootDir,
        controllerJobId: "infinity-context-controller-v1",
        jobId: "infinity-context-memory-child-v1",
        confirmStart: true,
        skipDoctor: true,
      })).resolves.toMatchObject({
        ok: false,
        error: "project_control_denied:path_outside_scope",
      });
    } finally {
      await client.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refills a project worker with one brokered worktree, prompt and job flow", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-project-refill-"));
    const registryRootDir = join(root, "worker-jobs", "registry");
    const controllerJobRoot = join(root, "worker-jobs", "infinity-context-controller-v1");
    const sourceWorkspacePath = join(root, "workspaces", "infinity-context-main");
    const childWorkspace = join(root, "worktrees", "infinity-context-memory-fastgate-v1");
    const childJobRoot = join(root, "worker-jobs", "infinity-context-memory-fastgate-v1");
    const server = createCodexGoalMcpServer();
    const client = new Client({
      name: "subscription-runtime-test",
      version: "0.0.0",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await mkdir(sourceWorkspacePath, { recursive: true });
      await gitInitRepository(sourceWorkspacePath);
      await writeFile(join(sourceWorkspacePath, "README.md"), "base\n");
      await git(sourceWorkspacePath, ["add", "README.md"]);
      await git(sourceWorkspacePath, ["commit", "-m", "test: base"]);
      await git(sourceWorkspacePath, [
        "update-ref",
        "refs/remotes/origin/main",
        "HEAD",
      ]);

      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);

      await callToolJson(client, "codex_goal_create_job", {
        registryRootDir,
        jobId: "infinity-context-controller-v1",
        jobRootDir: controllerJobRoot,
        authRootDir: join(root, "auth"),
        workspacePath: sourceWorkspacePath,
        promptPath: join(controllerJobRoot, "prompt.md"),
        taskId: "infinity-context-controller-v1",
        accounts: ["account-a"],
        accessBoundary: AccessBoundary.ProjectScopedControl,
        networkAccess: NetworkAccessMode.Restricted,
        projectAccessScope: {
          projectId: "infinity-context",
          workspaceRoots: [sourceWorkspacePath],
          worktreeRoots: [join(root, "worktrees")],
          registryRoot: registryRootDir,
          jobIdPrefixes: ["infinity-context-"],
          tmuxSessionPrefixes: ["infinity-context-"],
          allowedAccountIds: ["account-a"],
        },
      });

      const result = await callToolJson(client, "codex_goal_project_refill_worker", {
        registryRootDir,
        controllerJobId: "infinity-context-controller-v1",
        jobId: "infinity-context-memory-fastgate-v1",
        jobRootDir: childJobRoot,
        authRootDir: join(root, "auth"),
        sourceWorkspacePath,
        workspacePath: childWorkspace,
        promptBody: "Run a focused memory fastgate and report cleanly.\n",
        taskId: "infinity-context-memory-fastgate-v1",
        accounts: ["account-a"],
        workerRole: "fastgate",
        startWorker: false,
        confirmRefill: true,
      });

      expect(result).toMatchObject({
        ok: true,
        mode: "project_control_refill_worker",
        controllerJobId: "infinity-context-controller-v1",
        workerRole: "fastgate",
        jobId: "infinity-context-memory-fastgate-v1",
        targetJobId: "infinity-context-memory-fastgate-v1",
        startSkipped: true,
        baseBranch: "origin/main",
        manifest: {
          accessBoundary: AccessBoundary.IsolatedWorkspaceWrite,
          reasoningEffort: "high",
          serviceTier: "fast",
          networkAccess: NetworkAccessMode.Restricted,
          tags: expect.arrayContaining([
            "project-control-refill",
            "worker-role-fastgate",
          ]),
        },
      });
      await expect(readFile(join(childJobRoot, "prompt.md"), "utf8")).resolves.toBe(
        "Run a focused memory fastgate and report cleanly.\n",
      );
      await expect(access(join(childWorkspace, "README.md"))).resolves.toBeUndefined();
      const retry = await callToolJson(client, "codex_goal_project_refill_worker", {
        registryRootDir,
        controllerJobId: "infinity-context-controller-v1",
        jobId: "infinity-context-memory-fastgate-v1",
        jobRootDir: childJobRoot,
        authRootDir: join(root, "auth"),
        sourceWorkspacePath,
        workspacePath: childWorkspace,
        promptBody: "Run a focused memory fastgate and report cleanly.\n",
        taskId: "infinity-context-memory-fastgate-v1",
        accounts: ["account-a"],
        workerRole: "fastgate",
        startWorker: false,
        confirmRefill: true,
      });
      expect(retry).toMatchObject({
        ok: true,
        worktree: { status: "noop" },
        createJob: { status: "noop" },
      });
      const audit = await readProjectControlAudit(
        controllerJobRoot,
        "infinity-context-controller-v1",
      );
      expect(policyAuditDecisions(audit).map((decision) => decision.operation)).toEqual([
        "create_worktree",
        "create_job",
        "use_account",
      ]);
      expect(audit.some((event) =>
        event.type === "project_control.admission_decision_recorded"
      )).toBe(true);
      const genericContinue = await callToolJson(client, "codex_goal_continue", {
        registryRootDir,
        jobId: "infinity-context-memory-fastgate-v1",
        confirmContinue: true,
      });
      expect(genericContinue).toMatchObject({
        ok: false,
        reason: "project_control_broker_required",
        requiredTool: "codex_goal_project_start",
      });
      const genericStop = await callToolJson(client, "codex_goal_stop", {
        registryRootDir,
        jobId: "infinity-context-memory-fastgate-v1",
        confirmStop: true,
      });
      expect(genericStop).toMatchObject({
        ok: false,
        reason: "project_control_broker_required",
        requiredTool: "codex_goal_project_stop",
      });
      const genericReview = await callToolJson(client, "codex_goal_mark_reviewed", {
        registryRootDir,
        jobId: "infinity-context-memory-fastgate-v1",
      });
      expect(genericReview).toMatchObject({
        ok: false,
        reason: "project_control_broker_required",
        requiredTool: "codex_goal_project_mark_reviewed",
      });
    } finally {
      await client.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stops no-tmux project workers as noop when no direct pid exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-project-stop-no-tmux-"));
    const registryRootDir = join(root, "worker-jobs", "registry");
    const authRootDir = join(root, "auth");
    const controllerJobRoot = join(root, "worker-jobs", "infinity-context-controller-v1");
    const controllerWorkspace = join(root, "workspaces", "infinity-context-controller");
    const childWorkspace = join(root, "worktrees", "infinity-context-child-v1");
    const childJobRoot = join(root, "worker-jobs", "infinity-context-child-v1");
    const childTaskId = "infinity-context-child-v1";
    const server = createCodexGoalMcpServer();
    const client = new Client({
      name: "subscription-runtime-test",
      version: "0.0.0",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await mkdir(controllerWorkspace, { recursive: true });
      await mkdir(childWorkspace, { recursive: true });
      await execFileAsync("git", ["init"], { cwd: childWorkspace });
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);

      await callToolJson(client, "codex_goal_create_job", {
        registryRootDir,
        jobId: "infinity-context-controller-v1",
        jobRootDir: controllerJobRoot,
        authRootDir,
        workspacePath: controllerWorkspace,
        promptPath: join(controllerJobRoot, "prompt.md"),
        taskId: "infinity-context-controller-v1",
        accounts: ["account-a"],
        accessBoundary: AccessBoundary.ProjectScopedControl,
        networkAccess: NetworkAccessMode.Restricted,
        projectAccessScope: {
          projectId: "infinity-context",
          workspaceRoots: [join(root, "workspaces")],
          worktreeRoots: [join(root, "worktrees")],
          registryRoot: registryRootDir,
          jobIdPrefixes: ["infinity-context-"],
          tmuxSessionPrefixes: ["infinity-context-"],
          allowedAccountIds: ["account-a"],
        },
      });
      await callToolJson(client, "codex_goal_project_create_job", {
        registryRootDir,
        controllerJobId: "infinity-context-controller-v1",
        jobId: "infinity-context-child-v1",
        jobRootDir: childJobRoot,
        authRootDir,
        workspacePath: childWorkspace,
        promptPath: join(childJobRoot, "prompt.md"),
        taskId: childTaskId,
        accounts: ["account-a"],
        workerRole: "reviewer",
        confirmCreate: true,
      });
      await removeStoredTmuxSession(registryRootDir, "infinity-context-child-v1");

      const preview = await callToolJson(client, "codex_goal_project_stop", {
        registryRootDir,
        controllerJobId: "infinity-context-controller-v1",
        jobId: "infinity-context-child-v1",
      });
      expect(preview).toMatchObject({
        ok: false,
        reason: "confirm_stop_required",
        stopCommand: "no direct process pid",
      });
      expect(preview).not.toHaveProperty("tmuxSession");

      const stopped = await callToolJson(client, "codex_goal_project_stop", {
        registryRootDir,
        controllerJobId: "infinity-context-controller-v1",
        jobId: "infinity-context-child-v1",
        confirmStop: true,
      });
      expect(stopped).toMatchObject({
        ok: true,
        mode: "project_control_stop",
        jobId: "infinity-context-child-v1",
        result: {
          status: "noop",
          resourceId: "no direct process pid",
          safeMessage: "Worker has no direct process pid to stop.",
        },
      });
      expect(stopped).not.toHaveProperty("tmuxSession");
      const stopEvent = JSON.parse(await readFile(String(stopped.stopEventPath), "utf8"));
      expect(stopEvent).toMatchObject({
        jobId: "infinity-context-child-v1",
        taskId: childTaskId,
        stopCommand: "no direct process pid",
        forceStop: false,
      });
      expect(stopEvent).not.toHaveProperty("tmuxSession");
    } finally {
      await client.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not stop fresh no-tmux project workers without force", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-project-stop-fresh-"));
    const registryRootDir = join(root, "worker-jobs", "registry");
    const authRootDir = join(root, "auth");
    const controllerJobRoot = join(root, "worker-jobs", "infinity-context-controller-v1");
    const controllerWorkspace = join(root, "workspaces", "infinity-context-controller");
    const childWorkspace = join(root, "worktrees", "infinity-context-child-v1");
    const childJobRoot = join(root, "worker-jobs", "infinity-context-child-v1");
    const childTaskId = "infinity-context-child-v1";
    const server = createCodexGoalMcpServer();
    const client = new Client({
      name: "subscription-runtime-test",
      version: "0.0.0",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await mkdir(controllerWorkspace, { recursive: true });
      await mkdir(childWorkspace, { recursive: true });
      await execFileAsync("git", ["init"], { cwd: childWorkspace });
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);

      await callToolJson(client, "codex_goal_create_job", {
        registryRootDir,
        jobId: "infinity-context-controller-v1",
        jobRootDir: controllerJobRoot,
        authRootDir,
        workspacePath: controllerWorkspace,
        promptPath: join(controllerJobRoot, "prompt.md"),
        taskId: "infinity-context-controller-v1",
        accounts: ["account-a"],
        accessBoundary: AccessBoundary.ProjectScopedControl,
        networkAccess: NetworkAccessMode.Restricted,
        projectAccessScope: {
          projectId: "infinity-context",
          workspaceRoots: [join(root, "workspaces")],
          worktreeRoots: [join(root, "worktrees")],
          registryRoot: registryRootDir,
          jobIdPrefixes: ["infinity-context-"],
          tmuxSessionPrefixes: ["infinity-context-"],
          allowedAccountIds: ["account-a"],
        },
      });
      await callToolJson(client, "codex_goal_project_create_job", {
        registryRootDir,
        controllerJobId: "infinity-context-controller-v1",
        jobId: "infinity-context-child-v1",
        jobRootDir: childJobRoot,
        authRootDir,
        workspacePath: childWorkspace,
        promptPath: join(childJobRoot, "prompt.md"),
        taskId: childTaskId,
        accounts: ["account-a"],
        workerRole: "reviewer",
        confirmCreate: true,
      });
      await removeStoredTmuxSession(registryRootDir, "infinity-context-child-v1");
      await mkdir(childJobRoot, { recursive: true });
      await writeFile(join(childJobRoot, `${childTaskId}.progress.json`), `${JSON.stringify({
        schemaVersion: 1,
        taskId: childTaskId,
        status: "running",
        updatedAt: new Date().toISOString(),
      })}\n`);

      const stopped = await callToolJson(client, "codex_goal_project_stop", {
        registryRootDir,
        controllerJobId: "infinity-context-controller-v1",
        jobId: "infinity-context-child-v1",
        confirmStop: true,
      });
      expect(stopped).toMatchObject({
        ok: false,
        reason: "worker_not_silent_stale_or_heartbeat_only_no_output",
        requiredOverride: "forceStop",
        stopCommand: "no direct process pid",
        brief: {
          workerAlive: true,
          heartbeatOnlyNoOutput: false,
        },
      });
      expect(stopped).not.toHaveProperty("tmuxSession");
    } finally {
      await client.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks producer refill but allows reviewer drain when orphan dirty output exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-project-admission-"));
    const registryRootDir = join(root, "worker-jobs", "registry");
    const controllerJobRoot = join(root, "worker-jobs", "infinity-context-controller-v1");
    const workspaceRoot = join(root, "workspaces");
    const legacyWorkspaceRoot = join(root, "legacy-workspaces");
    const realLegacyWorkspaceRoot = join(root, "real-legacy-workspaces");
    const sourceWorkspacePath = join(workspaceRoot, "infinity-context-main");
    const orphanWorkspace = join(realLegacyWorkspaceRoot, "infinity-context-memory-old-v1");
    const observedOrphanWorkspace = join(legacyWorkspaceRoot, "infinity-context-memory-old-v1");
    const linkedOrphanTarget = join(root, "linked-workspaces", "infinity-context-memory-linked-target-v1");
    const linkedOrphanWorkspace = join(legacyWorkspaceRoot, "infinity-context-memory-linked-v1");
    const brokenWorkspace = join(legacyWorkspaceRoot, "infinity-context-memory-broken-v1");
    const producerWorkspace = join(root, "worktrees", "infinity-context-memory-producer-v1");
    const reviewerWorkspace = join(root, "worktrees", "infinity-context-memory-reviewer-v1");
    const server = createCodexGoalMcpServer();
    const client = new Client({
      name: "subscription-runtime-test",
      version: "0.0.0",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await mkdir(sourceWorkspacePath, { recursive: true });
      await gitInitRepository(sourceWorkspacePath);
      await writeFile(join(sourceWorkspacePath, "README.md"), "base\n");
      await git(sourceWorkspacePath, ["add", "README.md"]);
      await git(sourceWorkspacePath, ["commit", "-m", "test: base"]);
      await git(sourceWorkspacePath, [
        "update-ref",
        "refs/remotes/origin/main",
        "HEAD",
      ]);

      await mkdir(orphanWorkspace, { recursive: true });
      await gitInitRepository(orphanWorkspace);
      await writeFile(join(orphanWorkspace, "memory.py"), "value = 1\n");
      await git(orphanWorkspace, ["add", "memory.py"]);
      await git(orphanWorkspace, ["commit", "-m", "test: orphan base"]);
      await writeFile(join(orphanWorkspace, "memory.py"), "value = 2\n");
      await mkdir(legacyWorkspaceRoot, { recursive: true });
      await symlink(orphanWorkspace, observedOrphanWorkspace);
      await mkdir(linkedOrphanTarget, { recursive: true });
      await gitInitRepository(linkedOrphanTarget);
      await writeFile(join(linkedOrphanTarget, "linked.py"), "value = 1\n");
      await git(linkedOrphanTarget, ["add", "linked.py"]);
      await git(linkedOrphanTarget, ["commit", "-m", "test: linked orphan base"]);
      await writeFile(join(linkedOrphanTarget, "linked.py"), "value = 2\n");
      await symlink(linkedOrphanTarget, linkedOrphanWorkspace, "dir");
      await mkdir(brokenWorkspace, { recursive: true });
      await writeFile(
        join(brokenWorkspace, ".git"),
        `gitdir: ${join(root, "missing-gitdir")}\n`,
      );

      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);

      await callToolJson(client, "codex_goal_create_job", {
        registryRootDir,
        jobId: "infinity-context-controller-v1",
        jobRootDir: controllerJobRoot,
        authRootDir: join(root, "auth"),
        workspacePath: sourceWorkspacePath,
        promptPath: join(controllerJobRoot, "prompt.md"),
        taskId: "infinity-context-controller-v1",
        accounts: ["account-a"],
        accessBoundary: AccessBoundary.ProjectScopedControl,
        networkAccess: NetworkAccessMode.Restricted,
        projectAccessScope: {
          projectId: "infinity-context",
          workspaceRoots: [workspaceRoot],
          worktreeRoots: [join(root, "worktrees")],
          observedWorkspaceRoots: [legacyWorkspaceRoot],
          registryRoot: registryRootDir,
          jobIdPrefixes: ["infinity-context-"],
          tmuxSessionPrefixes: ["infinity-context-"],
          allowedAccountIds: ["account-a"],
        },
      });

      const snapshot = await callToolJson(
        client,
        "codex_goal_project_admission_snapshot",
        {
          registryRootDir,
          controllerJobId: "infinity-context-controller-v1",
          operation: "create_job",
          workerRole: "producer",
        },
      );
      expect(snapshot).toMatchObject({
        ok: true,
        decision: {
          allowed: false,
          reason: "output_debt_present",
        },
        snapshot: {
          counts: {
            orphanLegacyWorkspaces: 2,
            unreadableWorkspaces: 1,
          },
        },
      });

      const producer = await callToolJson(client, "codex_goal_project_refill_worker", {
        registryRootDir,
        controllerJobId: "infinity-context-controller-v1",
        jobId: "infinity-context-memory-producer-v1",
        jobRootDir: join(root, "worker-jobs", "infinity-context-memory-producer-v1"),
        authRootDir: join(root, "auth"),
        sourceWorkspacePath,
        workspacePath: producerWorkspace,
        promptPath: join(root, "worker-jobs", "infinity-context-memory-producer-v1", "prompt.md"),
        promptBody: "Produce a memory improvement.\n",
        taskId: "infinity-context-memory-producer-v1",
        accounts: ["account-a"],
        workerRole: "producer",
        startWorker: false,
        confirmRefill: true,
      });
      expect(producer).toMatchObject({
        ok: false,
        error: "project_control_admission_denied:output_debt_present",
      });
      const directProducer = await callToolJson(client, "codex_goal_project_create_job", {
        registryRootDir,
        controllerJobId: "infinity-context-controller-v1",
        jobId: "infinity-context-memory-direct-producer-v1",
        jobRootDir: join(root, "worker-jobs", "infinity-context-memory-direct-producer-v1"),
        authRootDir: join(root, "auth"),
        workspacePath: join(root, "worktrees", "infinity-context-memory-direct-producer-v1"),
        promptPath: join(
          root,
          "worker-jobs",
          "infinity-context-memory-direct-producer-v1",
          "prompt.md",
        ),
        taskId: "infinity-context-memory-direct-producer-v1",
        accounts: ["account-a"],
        workerRole: "producer",
        confirmCreate: true,
      });
      expect(directProducer).toMatchObject({
        ok: false,
        error: "project_control_admission_denied:output_debt_present",
      });
      await expect(access(
        join(root, "worker-jobs", "registry", "infinity-context-memory-direct-producer-v1"),
      )).rejects.toThrow();
      const directWorktreePath = join(
        root,
        "worktrees",
        "infinity-context-memory-direct-worktree-v1",
      );
      const directWorktree = await callToolJson(
        client,
        "codex_goal_project_create_worktree",
        {
          registryRootDir,
          controllerJobId: "infinity-context-controller-v1",
          sourceWorkspacePath,
          path: directWorktreePath,
          baseBranch: "origin/main",
          workerRole: "producer",
          confirmCreateWorktree: true,
        },
      );
      expect(directWorktree).toMatchObject({
        ok: false,
        error: "project_control_admission_denied:output_debt_present",
      });
      await expect(access(directWorktreePath)).rejects.toThrow();

      const reviewer = await callToolJson(client, "codex_goal_project_refill_worker", {
        registryRootDir,
        controllerJobId: "infinity-context-controller-v1",
        jobId: "infinity-context-memory-reviewer-v1",
        jobRootDir: join(root, "worker-jobs", "infinity-context-memory-reviewer-v1"),
        authRootDir: join(root, "auth"),
        sourceWorkspacePath,
        workspacePath: reviewerWorkspace,
        promptPath: join(root, "worker-jobs", "infinity-context-memory-reviewer-v1", "prompt.md"),
        promptBody: "Review and drain old memory output.\n",
        taskId: "infinity-context-memory-reviewer-v1",
        accounts: ["account-a"],
        workerRole: "reviewer",
        startWorker: false,
        confirmRefill: true,
      });
      expect(reviewer).toMatchObject({
        ok: true,
        workerRole: "reviewer",
        startSkipped: true,
      });

      const legacyTarget = await callToolJson(client, "codex_goal_project_refill_worker", {
        registryRootDir,
        controllerJobId: "infinity-context-controller-v1",
        jobId: "infinity-context-memory-reviewer-legacy-v1",
        jobRootDir: join(root, "worker-jobs", "infinity-context-memory-reviewer-legacy-v1"),
        authRootDir: join(root, "auth"),
        sourceWorkspacePath,
        workspacePath: join(legacyWorkspaceRoot, "infinity-context-memory-reviewer-legacy-v1"),
        promptPath: join(
          root,
          "worker-jobs",
          "infinity-context-memory-reviewer-legacy-v1",
          "prompt.md",
        ),
        promptBody: "Review and drain old memory output.\n",
        taskId: "infinity-context-memory-reviewer-legacy-v1",
        accounts: ["account-a"],
        workerRole: "reviewer",
        startWorker: false,
        confirmRefill: true,
      });
      expect(legacyTarget).toMatchObject({
        ok: false,
        error: "project_control_workspace_outside_scope",
      });
    } finally {
      await client.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("admits producer refill when dirty legacy output has valid consumed ledger evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-consumed-output-"));
    const registryRootDir = join(root, "worker-jobs", "registry");
    const controllerJobRoot = join(root, "worker-jobs", "infinity-context-controller-v1");
    const workspaceRoot = join(root, "workspaces");
    const legacyWorkspaceRoot = join(root, "legacy-workspaces");
    const sourceWorkspacePath = join(workspaceRoot, "infinity-context-main");
    const orphanWorkspace = join(legacyWorkspaceRoot, "infinity-context-memory-old-v1");
    const ledgerRoot = join(root, "dirty-worktree-drain");
    const backupRoot = join(root, "dirty-worktree-backups");
    const producerWorkspace = join(root, "worktrees", "infinity-context-memory-producer-v1");
    const server = createCodexGoalMcpServer();
    const client = new Client({
      name: "subscription-runtime-test",
      version: "0.0.0",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await mkdir(sourceWorkspacePath, { recursive: true });
      await gitInitRepository(sourceWorkspacePath);
      await writeFile(join(sourceWorkspacePath, "README.md"), "base\n");
      await git(sourceWorkspacePath, ["add", "README.md"]);
      await git(sourceWorkspacePath, ["commit", "-m", "test: base"]);
      await git(sourceWorkspacePath, [
        "update-ref",
        "refs/remotes/origin/main",
        "HEAD",
      ]);

      await mkdir(orphanWorkspace, { recursive: true });
      await gitInitRepository(orphanWorkspace);
      await writeFile(join(orphanWorkspace, "memory.py"), "value = 1\n");
      await git(orphanWorkspace, ["add", "memory.py"]);
      await git(orphanWorkspace, ["commit", "-m", "test: orphan base"]);
      await writeFile(join(orphanWorkspace, "memory.py"), "value = 2\n");

      await mkdir(join(ledgerRoot, "items"), { recursive: true });
      await mkdir(backupRoot, { recursive: true });
      const statusPath = join(backupRoot, "infinity-context-memory-old-v1.status.txt");
      const patchPath = join(backupRoot, "infinity-context-memory-old-v1.patch");
      await writeFile(statusPath, " M memory.py\n");
      await writeFile(patchPath, "diff --git a/memory.py b/memory.py\n");
      await writeFile(
        join(ledgerRoot, "items", "infinity-context-memory-old-v1.json"),
        `${JSON.stringify({
          jobId: "infinity-context-memory-old-v1",
          status: "duplicate",
          closedAt: "2026-07-06T00:00:00.000Z",
          backup: {
            workspace: orphanWorkspace,
            statusPath,
            patchPath,
          },
        }, null, 2)}\n`,
      );

      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);

      await callToolJson(client, "codex_goal_create_job", {
        registryRootDir,
        jobId: "infinity-context-controller-v1",
        jobRootDir: controllerJobRoot,
        authRootDir: join(root, "auth"),
        workspacePath: sourceWorkspacePath,
        promptPath: join(controllerJobRoot, "prompt.md"),
        taskId: "infinity-context-controller-v1",
        accounts: ["account-a"],
        accessBoundary: AccessBoundary.ProjectScopedControl,
        networkAccess: NetworkAccessMode.Restricted,
        projectAccessScope: {
          projectId: "infinity-context",
          workspaceRoots: [workspaceRoot],
          worktreeRoots: [join(root, "worktrees")],
          observedWorkspaceRoots: [legacyWorkspaceRoot],
          consumedOutputLedgerRoots: [ledgerRoot],
          registryRoot: registryRootDir,
          jobIdPrefixes: ["infinity-context-"],
          tmuxSessionPrefixes: ["infinity-context-"],
          allowedAccountIds: ["account-a"],
        },
      });

      const snapshot = await callToolJson(
        client,
        "codex_goal_project_admission_snapshot",
        {
          registryRootDir,
          controllerJobId: "infinity-context-controller-v1",
          operation: "create_job",
          workerRole: "producer",
        },
      );
      expect(snapshot).toMatchObject({
        ok: true,
        decision: {
          allowed: true,
          reason: "allowed",
        },
        snapshot: {
          counts: {
            orphanLegacyWorkspaces: 0,
            consumedDirtyWorkspaces: 1,
            incompleteConsumedOutputRecords: 0,
          },
        },
      });

      const producer = await callToolJson(client, "codex_goal_project_refill_worker", {
        registryRootDir,
        controllerJobId: "infinity-context-controller-v1",
        jobId: "infinity-context-memory-producer-v1",
        jobRootDir: join(root, "worker-jobs", "infinity-context-memory-producer-v1"),
        authRootDir: join(root, "auth"),
        sourceWorkspacePath,
        workspacePath: producerWorkspace,
        promptPath: join(root, "worker-jobs", "infinity-context-memory-producer-v1", "prompt.md"),
        promptBody: "Produce a memory improvement.\n",
        taskId: "infinity-context-memory-producer-v1",
        accounts: ["account-a"],
        workerRole: "producer",
        startWorker: false,
        confirmRefill: true,
      });
      expect(producer).toMatchObject({
        ok: true,
        workerRole: "producer",
        startSkipped: true,
      });
    } finally {
      await client.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks producer refill when terminal consumed ledger evidence is incomplete", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-incomplete-output-"));
    const registryRootDir = join(root, "worker-jobs", "registry");
    const controllerJobRoot = join(root, "worker-jobs", "infinity-context-controller-v1");
    const workspaceRoot = join(root, "workspaces");
    const legacyWorkspaceRoot = join(root, "legacy-workspaces");
    const sourceWorkspacePath = join(workspaceRoot, "infinity-context-main");
    const orphanWorkspace = join(legacyWorkspaceRoot, "infinity-context-memory-old-v1");
    const ledgerRoot = join(root, "dirty-worktree-drain");
    const backupRoot = join(root, "dirty-worktree-backups");
    const server = createCodexGoalMcpServer();
    const client = new Client({
      name: "subscription-runtime-test",
      version: "0.0.0",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await mkdir(sourceWorkspacePath, { recursive: true });
      await gitInitRepository(sourceWorkspacePath);
      await writeFile(join(sourceWorkspacePath, "README.md"), "base\n");
      await git(sourceWorkspacePath, ["add", "README.md"]);
      await git(sourceWorkspacePath, ["commit", "-m", "test: base"]);
      await git(sourceWorkspacePath, [
        "update-ref",
        "refs/remotes/origin/main",
        "HEAD",
      ]);

      await mkdir(orphanWorkspace, { recursive: true });
      await gitInitRepository(orphanWorkspace);
      await writeFile(join(orphanWorkspace, "memory.py"), "value = 1\n");
      await git(orphanWorkspace, ["add", "memory.py"]);
      await git(orphanWorkspace, ["commit", "-m", "test: orphan base"]);
      await writeFile(join(orphanWorkspace, "memory.py"), "value = 2\n");

      await mkdir(join(ledgerRoot, "items"), { recursive: true });
      await mkdir(backupRoot, { recursive: true });
      const statusPath = join(backupRoot, "infinity-context-memory-old-v1.status.txt");
      await writeFile(statusPath, " M memory.py\n");
      await writeFile(
        join(ledgerRoot, "items", "infinity-context-memory-old-v1.json"),
        `${JSON.stringify({
          jobId: "infinity-context-memory-old-v1",
          status: "duplicate",
          closedAt: "2026-07-06T00:00:00.000Z",
          backup: {
            workspace: orphanWorkspace,
            statusPath,
          },
          notes: [{ status: "duplicate", text: "output already represented" }],
        }, null, 2)}\n`,
      );

      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);

      await callToolJson(client, "codex_goal_create_job", {
        registryRootDir,
        jobId: "infinity-context-controller-v1",
        jobRootDir: controllerJobRoot,
        authRootDir: join(root, "auth"),
        workspacePath: sourceWorkspacePath,
        promptPath: join(controllerJobRoot, "prompt.md"),
        taskId: "infinity-context-controller-v1",
        accounts: ["account-a"],
        accessBoundary: AccessBoundary.ProjectScopedControl,
        networkAccess: NetworkAccessMode.Restricted,
        projectAccessScope: {
          projectId: "infinity-context",
          workspaceRoots: [workspaceRoot],
          worktreeRoots: [join(root, "worktrees")],
          observedWorkspaceRoots: [legacyWorkspaceRoot],
          consumedOutputLedgerRoots: [ledgerRoot],
          registryRoot: registryRootDir,
          jobIdPrefixes: ["infinity-context-"],
          tmuxSessionPrefixes: ["infinity-context-"],
          allowedAccountIds: ["account-a"],
        },
      });

      const snapshot = await callToolJson(
        client,
        "codex_goal_project_admission_snapshot",
        {
          registryRootDir,
          controllerJobId: "infinity-context-controller-v1",
          operation: "create_job",
          workerRole: "producer",
        },
      );
      expect(snapshot).toMatchObject({
        ok: true,
        decision: {
          allowed: false,
          reason: "output_debt_present",
        },
        snapshot: {
          counts: {
            orphanLegacyWorkspaces: 0,
            consumedDirtyWorkspaces: 0,
            incompleteConsumedOutputRecords: 1,
          },
        },
      });

      const producer = await callToolJson(client, "codex_goal_project_refill_worker", {
        registryRootDir,
        controllerJobId: "infinity-context-controller-v1",
        jobId: "infinity-context-memory-producer-v1",
        jobRootDir: join(root, "worker-jobs", "infinity-context-memory-producer-v1"),
        authRootDir: join(root, "auth"),
        sourceWorkspacePath,
        workspacePath: join(root, "worktrees", "infinity-context-memory-producer-v1"),
        promptPath: join(root, "worker-jobs", "infinity-context-memory-producer-v1", "prompt.md"),
        promptBody: "Produce a memory improvement.\n",
        taskId: "infinity-context-memory-producer-v1",
        accounts: ["account-a"],
        workerRole: "producer",
        startWorker: false,
        confirmRefill: true,
      });
      expect(producer).toMatchObject({
        ok: false,
        error: "project_control_admission_denied:output_debt_present",
      });
    } finally {
      await client.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rolls back a newly created refill worktree when prompt materialization fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-refill-rollback-"));
    const registryRootDir = join(root, "worker-jobs", "registry");
    const controllerJobRoot = join(root, "worker-jobs", "infinity-context-controller-v1");
    const sourceWorkspacePath = join(root, "workspaces", "infinity-context-main");
    const childWorkspace = join(root, "worktrees", "infinity-context-memory-producer-v1");
    const childJobRoot = join(root, "worker-jobs", "infinity-context-memory-producer-v1");
    const server = createCodexGoalMcpServer();
    const client = new Client({
      name: "subscription-runtime-test",
      version: "0.0.0",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await mkdir(sourceWorkspacePath, { recursive: true });
      await gitInitRepository(sourceWorkspacePath);
      await writeFile(join(sourceWorkspacePath, "README.md"), "base\n");
      await git(sourceWorkspacePath, ["add", "README.md"]);
      await git(sourceWorkspacePath, ["commit", "-m", "test: base"]);
      await git(sourceWorkspacePath, [
        "update-ref",
        "refs/remotes/origin/main",
        "HEAD",
      ]);
      await mkdir(childJobRoot, { recursive: true });
      await writeFile(join(childJobRoot, "prompt.md"), "old prompt\n");

      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);

      await callToolJson(client, "codex_goal_create_job", {
        registryRootDir,
        jobId: "infinity-context-controller-v1",
        jobRootDir: controllerJobRoot,
        authRootDir: join(root, "auth"),
        workspacePath: sourceWorkspacePath,
        promptPath: join(controllerJobRoot, "prompt.md"),
        taskId: "infinity-context-controller-v1",
        accounts: ["account-a"],
        accessBoundary: AccessBoundary.ProjectScopedControl,
        networkAccess: NetworkAccessMode.Restricted,
        projectAccessScope: {
          projectId: "infinity-context",
          workspaceRoots: [sourceWorkspacePath],
          worktreeRoots: [join(root, "worktrees")],
          registryRoot: registryRootDir,
          jobIdPrefixes: ["infinity-context-"],
          tmuxSessionPrefixes: ["infinity-context-"],
          allowedAccountIds: ["account-a"],
        },
      });

      await expect(callToolJson(client, "codex_goal_project_refill_worker", {
        registryRootDir,
        controllerJobId: "infinity-context-controller-v1",
        jobId: "infinity-context-memory-producer-v1",
        jobRootDir: childJobRoot,
        authRootDir: join(root, "auth"),
        sourceWorkspacePath,
        workspacePath: childWorkspace,
        promptBody: "new prompt\n",
        taskId: "infinity-context-memory-producer-v1",
        accounts: ["account-a"],
        workerRole: "producer",
        startWorker: false,
        confirmRefill: true,
      })).resolves.toMatchObject({
        ok: false,
        error: expect.stringContaining("project_control_existing_prompt_mismatch"),
      });

      await expect(access(childWorkspace)).rejects.toThrow();
      await expect(readFile(join(childJobRoot, "prompt.md"), "utf8")).resolves.toBe(
        "old prompt\n",
      );
    } finally {
      await client.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves the original refill error when rollback removes an empty job root", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-refill-rollback-"));
    const registryRootDir = join(root, "worker-jobs", "registry");
    const controllerJobRoot = join(root, "worker-jobs", "infinity-context-controller-v1");
    const sourceWorkspacePath = join(root, "workspaces", "infinity-context");
    const childWorkspace = join(root, "worktrees", "infinity-context-memory-producer-v1");
    const childJobRoot = join(root, "worker-jobs", "infinity-context-memory-producer-v1");
    const server = createCodexGoalMcpServer();
    const client = new Client({
      name: "subscription-runtime-test",
      version: "0.0.0",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await mkdir(sourceWorkspacePath, { recursive: true });
      await gitInitRepository(sourceWorkspacePath);
      await writeFile(join(sourceWorkspacePath, "README.md"), "base\n");
      await git(sourceWorkspacePath, ["add", "README.md"]);
      await git(sourceWorkspacePath, ["commit", "-m", "test: base"]);
      await git(sourceWorkspacePath, [
        "update-ref",
        "refs/remotes/origin/main",
        "HEAD",
      ]);

      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);

      await callToolJson(client, "codex_goal_create_job", {
        registryRootDir,
        jobId: "infinity-context-controller-v1",
        jobRootDir: controllerJobRoot,
        authRootDir: join(root, "auth"),
        workspacePath: sourceWorkspacePath,
        promptPath: join(controllerJobRoot, "prompt.md"),
        taskId: "infinity-context-controller-v1",
        accounts: ["account-a"],
        accessBoundary: AccessBoundary.ProjectScopedControl,
        networkAccess: NetworkAccessMode.Restricted,
        projectAccessScope: {
          projectId: "infinity-context",
          workspaceRoots: [sourceWorkspacePath],
          worktreeRoots: [join(root, "worktrees")],
          registryRoot: registryRootDir,
          jobIdPrefixes: ["infinity-context-"],
          tmuxSessionPrefixes: ["infinity-context-"],
          allowedAccountIds: ["account-a"],
        },
      });

      const result = await callToolJson(client, "codex_goal_project_refill_worker", {
        registryRootDir,
        controllerJobId: "infinity-context-controller-v1",
        jobId: "infinity-context-memory-producer-v1",
        jobRootDir: childJobRoot,
        authRootDir: join(root, "auth"),
        sourceWorkspacePath,
        workspacePath: childWorkspace,
        promptBody: "Produce a memory improvement.\n",
        taskId: "infinity-context-memory-producer-v1",
        accounts: ["account-b"],
        workerRole: "producer",
        startWorker: false,
        confirmRefill: true,
      });

      expect(result).toMatchObject({ ok: false });
      expect(String(result.error ?? result.reason ?? "")).toContain("project_control");
      expect(String(result.error ?? result.reason ?? "")).not.toContain("EISDIR");
      await expect(access(childWorkspace)).rejects.toThrow();
      await expect(access(join(childJobRoot, "prompt.md"))).rejects.toThrow();
    } finally {
      await client.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks stored producer start when output debt appears after job creation", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-start-admission-"));
    const registryRootDir = join(root, "worker-jobs", "registry");
    const controllerJobRoot = join(root, "worker-jobs", "infinity-context-controller-v1");
    const sourceWorkspacePath = join(root, "workspaces", "infinity-context-main");
    const observedWorkspaceRoot = join(root, "legacy-workspaces");
    const orphanWorkspace = join(observedWorkspaceRoot, "infinity-context-memory-old-v1");
    const childJobRoot = join(root, "worker-jobs", "infinity-context-memory-producer-v1");
    const childWorkspace = join(root, "worktrees", "infinity-context-memory-producer-v1");
    const server = createCodexGoalMcpServer();
    const client = new Client({
      name: "subscription-runtime-test",
      version: "0.0.0",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await mkdir(sourceWorkspacePath, { recursive: true });
      await gitInitRepository(sourceWorkspacePath);
      await writeFile(join(sourceWorkspacePath, "README.md"), "base\n");
      await git(sourceWorkspacePath, ["add", "README.md"]);
      await git(sourceWorkspacePath, ["commit", "-m", "test: base"]);
      await git(sourceWorkspacePath, [
        "update-ref",
        "refs/remotes/origin/main",
        "HEAD",
      ]);

      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);

      await callToolJson(client, "codex_goal_create_job", {
        registryRootDir,
        jobId: "infinity-context-controller-v1",
        jobRootDir: controllerJobRoot,
        authRootDir: join(root, "auth"),
        workspacePath: sourceWorkspacePath,
        promptPath: join(controllerJobRoot, "prompt.md"),
        taskId: "infinity-context-controller-v1",
        accounts: ["account-a"],
        accessBoundary: AccessBoundary.ProjectScopedControl,
        networkAccess: NetworkAccessMode.Restricted,
        projectAccessScope: {
          projectId: "infinity-context",
          workspaceRoots: [sourceWorkspacePath],
          worktreeRoots: [join(root, "worktrees")],
          observedWorkspaceRoots: [observedWorkspaceRoot],
          registryRoot: registryRootDir,
          jobIdPrefixes: ["infinity-context-"],
          tmuxSessionPrefixes: ["infinity-context-"],
          allowedAccountIds: ["account-a"],
        },
      });

      await expect(callToolJson(client, "codex_goal_project_refill_worker", {
        registryRootDir,
        controllerJobId: "infinity-context-controller-v1",
        jobId: "infinity-context-memory-producer-v1",
        jobRootDir: childJobRoot,
        authRootDir: join(root, "auth"),
        sourceWorkspacePath,
        workspacePath: childWorkspace,
        promptBody: "Produce a memory improvement.\n",
        taskId: "infinity-context-memory-producer-v1",
        accounts: ["account-a"],
        tmuxSession: "infinity-context-memory-producer-v1",
        workerRole: "producer",
        startWorker: false,
        confirmRefill: true,
      })).resolves.toMatchObject({
        ok: true,
        startSkipped: true,
      });

      await mkdir(orphanWorkspace, { recursive: true });
      await gitInitRepository(orphanWorkspace);
      await writeFile(join(orphanWorkspace, "memory.py"), "value = 1\n");
      await git(orphanWorkspace, ["add", "memory.py"]);
      await git(orphanWorkspace, ["commit", "-m", "test: orphan base"]);
      await writeFile(join(orphanWorkspace, "memory.py"), "value = 2\n");

      const start = await callToolJson(client, "codex_goal_project_start", {
        registryRootDir,
        controllerJobId: "infinity-context-controller-v1",
        jobId: "infinity-context-memory-producer-v1",
        forceStart: true,
        confirmStart: true,
      });
      expect(start).toMatchObject({
        ok: false,
        error: "project_control_admission_denied:output_debt_present",
      });
      const audit = await readProjectControlAudit(
        controllerJobRoot,
        "infinity-context-controller-v1",
      );
      expect(audit.some((event) =>
        event.type === ProjectControlAuditEventType.AdmissionDecisionRecorded &&
        auditDecision(event).allowed === false
      )).toBe(true);
    } finally {
      await client.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to start a stored project worker when its prompt file is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-start-no-prompt-"));
    const registryRootDir = join(root, "worker-jobs", "registry");
    const controllerJobRoot = join(root, "worker-jobs", "infinity-context-controller-v1");
    const childJobRoot = join(root, "worker-jobs", "infinity-context-memory-reviewer-v1");
    const childWorkspace = join(root, "worktrees", "infinity-context-memory-reviewer-v1");
    const sourceWorkspacePath = join(root, "workspaces", "infinity-context-main");
    const server = createCodexGoalMcpServer();
    const client = new Client({
      name: "subscription-runtime-test",
      version: "0.0.0",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await mkdir(sourceWorkspacePath, { recursive: true });
      await gitInitRepository(sourceWorkspacePath);
      await writeFile(join(sourceWorkspacePath, "README.md"), "base\n");
      await git(sourceWorkspacePath, ["add", "README.md"]);
      await git(sourceWorkspacePath, ["commit", "-m", "test: base"]);
      await git(sourceWorkspacePath, [
        "update-ref",
        "refs/remotes/origin/main",
        "HEAD",
      ]);

      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);

      await callToolJson(client, "codex_goal_create_job", {
        registryRootDir,
        jobId: "infinity-context-controller-v1",
        jobRootDir: controllerJobRoot,
        authRootDir: join(root, "auth"),
        workspacePath: sourceWorkspacePath,
        promptPath: join(controllerJobRoot, "prompt.md"),
        taskId: "infinity-context-controller-v1",
        accounts: ["account-a"],
        accessBoundary: AccessBoundary.ProjectScopedControl,
        networkAccess: NetworkAccessMode.Restricted,
        projectAccessScope: {
          projectId: "infinity-context",
          workspaceRoots: [sourceWorkspacePath],
          worktreeRoots: [join(root, "worktrees")],
          registryRoot: registryRootDir,
          jobIdPrefixes: ["infinity-context-"],
          tmuxSessionPrefixes: ["infinity-context-"],
          allowedAccountIds: ["account-a"],
        },
      });
      await expect(callToolJson(client, "codex_goal_project_refill_worker", {
        registryRootDir,
        controllerJobId: "infinity-context-controller-v1",
        jobId: "infinity-context-memory-reviewer-v1",
        jobRootDir: childJobRoot,
        authRootDir: join(root, "auth"),
        sourceWorkspacePath,
        workspacePath: childWorkspace,
        promptBody: "Review memory output.\n",
        taskId: "infinity-context-memory-reviewer-v1",
        accounts: ["account-a"],
        tmuxSession: "infinity-context-memory-reviewer-v1",
        workerRole: "reviewer",
        startWorker: false,
        confirmRefill: true,
      })).resolves.toMatchObject({ ok: true });
      await rm(join(childJobRoot, "prompt.md"), { force: true });

      await expect(callToolJson(client, "codex_goal_project_start", {
        registryRootDir,
        controllerJobId: "infinity-context-controller-v1",
        jobId: "infinity-context-memory-reviewer-v1",
        forceStart: true,
        confirmStart: true,
      })).resolves.toMatchObject({
        ok: false,
        reason: "project_control_prompt_missing_before_start",
        mode: "project_control_start",
      });
    } finally {
      await client.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("builds a fail-closed controlled-agent launch plan for project controllers", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-controller-plan-"));
    const registryRootDir = join(root, "worker-jobs", "registry");
    const controllerJobRoot = join(root, "worker-jobs", "infinity-context-controller-v1");
    const server = createCodexGoalMcpServer();
    const client = new Client({
      name: "subscription-runtime-test",
      version: "0.0.0",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);

      await callToolJson(client, "codex_goal_create_job", {
        registryRootDir,
        jobId: "infinity-context-controller-v1",
        jobRootDir: controllerJobRoot,
        authRootDir: join(root, "auth"),
        workspacePath: join(root, "workspaces", "controller"),
        promptPath: join(controllerJobRoot, "prompt.md"),
        taskId: "infinity-context-controller-v1",
        accounts: ["account-a"],
        accessBoundary: AccessBoundary.ProjectScopedControl,
        networkAccess: NetworkAccessMode.Restricted,
        projectAccessScope: {
          projectId: "infinity-context",
          workspaceRoots: [join(root, "workspaces")],
          worktreeRoots: [join(root, "worktrees")],
          registryRoot: registryRootDir,
          jobIdPrefixes: ["infinity-context-"],
          tmuxSessionPrefixes: ["infinity-context-"],
          allowedAccountIds: ["account-a"],
        },
      });

      const defaultPlan = await callToolJson(
        client,
        "codex_goal_project_controller_launch_plan",
        {
          registryRootDir,
          controllerJobId: "infinity-context-controller-v1",
        },
      );
      expect(defaultPlan).toMatchObject({
        ok: true,
        mode: "project_controller_launch_plan",
        controllerJobId: "infinity-context-controller-v1",
        status: "ready",
        rawShellMode: "disabled-by-provider",
      });
      expect(defaultPlan.allowedTools).toEqual(projectScopedControllerToolNames());

      const denyOnlyPlan = await callToolJson(
        client,
        "codex_goal_project_controller_launch_plan",
        {
          registryRootDir,
          controllerJobId: "infinity-context-controller-v1",
          rawShellMode: "sandboxed-deny-rules-only",
        },
      );
      expect(denyOnlyPlan).toMatchObject({
        ok: false,
        mode: "project_controller_launch_plan",
        controllerJobId: "infinity-context-controller-v1",
        status: "blocked",
        reason: "provider_cannot_disable_raw_shell",
      });

      const readyPlan = await callToolJson(
        client,
        "codex_goal_project_controller_launch_plan",
        {
          registryRootDir,
          controllerJobId: "infinity-context-controller-v1",
          rawShellMode: "disabled-by-provider",
          stateDir: join(root, "controller-state"),
          mcpArgs: ["--stdio"],
        },
      );
      expect(readyPlan).toMatchObject({
        ok: true,
        mode: "project_controller_launch_plan",
        controllerJobId: "infinity-context-controller-v1",
        status: "ready",
        rawShellMode: "disabled-by-provider",
        session: {
          identity: {
            controllerJobId: "infinity-context-controller-v1",
            projectId: "infinity-context",
          },
        },
      });
      expect(readyPlan.allowedTools).toEqual(projectScopedControllerToolNames());
      expect(String(readyPlan.configToml)).toContain("enabled_tools");
      expect(String(readyPlan.configToml)).not.toContain("danger-full-access");
      expect(String(readyPlan.rulesText)).toContain('pattern = ["git"]');

      const claudePlan = await callToolJson(
        client,
        "codex_goal_project_controller_launch_plan",
        {
          registryRootDir,
          controllerJobId: "infinity-context-controller-v1",
          providerKind: "claude",
          stateDir: join(root, "controller-state"),
          mcpArgs: ["--stdio"],
        },
      );
      expect(claudePlan).toMatchObject({
        ok: true,
        mode: "project_controller_launch_plan",
        providerKind: "claude",
        controllerJobId: "infinity-context-controller-v1",
        sessionId: "infinity-context-controller-v1:controlled-agent:claude",
        status: "ready",
        strictMcpConfig: true,
      });
      expect((claudePlan.allowedTools as readonly string[]).every((tool) =>
        tool.startsWith("mcp__subscription_runtime_project_control__")
      )).toBe(true);
      expect(claudePlan.disallowedTools).toEqual(
        expect.arrayContaining(["Bash", "Edit", "Write", "Read"]),
      );

      const blockedStart = await callToolJson(
        client,
        "codex_goal_project_controller_start",
        {
          registryRootDir,
          controllerJobId: "infinity-context-controller-v1",
        },
      );
      expect(blockedStart).toMatchObject({
        ok: false,
        error: "project_control_controller_auth_root_scope_required",
      });

      const blockedWithoutScopedAuth = await callToolJson(
        client,
        "codex_goal_project_controller_start",
        {
          registryRootDir,
          controllerJobId: "infinity-context-controller-v1",
          rawShellMode: "disabled-by-provider",
          stateDir: join(root, "controller-state"),
        },
      );
      expect(blockedWithoutScopedAuth).toMatchObject({
        ok: false,
        error: "project_control_controller_auth_root_scope_required",
      });

      const missingStatus = await callToolJson(
        client,
        "codex_goal_project_controller_status",
        {
          registryRootDir,
          controllerJobId: "infinity-context-controller-v1",
          stateDir: join(root, "controller-state"),
        },
      );
      expect(missingStatus).toMatchObject({
        ok: false,
        mode: "project_controller_status",
        reason: "session_missing",
        liveController: {
          providerRunnerAttached: false,
          live: false,
          ownerMatches: false,
        },
      });

      const stateDir = join(root, "controller-state");
      const sessionId = "infinity-context-controller-v1:controlled-agent";
      const store = new LocalControlledAgentStateStore({ rootDir: stateDir });
      const owner = {
        schemaVersion: 1 as const,
        ownerId: "old-owner",
        kind: ControlledAgentProcessOwnerKind.DurableMcp,
        pid: 1111,
        hostname: "old-host",
        runtimeVersion: "0.1.0-old",
        runtimeSha: "old-sha",
        startedAt: "2026-07-05T10:00:00.000Z",
        heartbeatAt: "2026-07-05T10:00:00.000Z",
      };
      await store.saveSession({
        schemaVersion: 1,
        sessionId,
        identity: {
          controllerJobId: "infinity-context-controller-v1",
          projectId: "infinity-context",
          providerKind: RunEventProviderKind.Codex,
        },
        stateDir,
        status: ControlledAgentRunStatus.Running,
        activeRunId: "run-old",
        owner,
        createdAt: "2026-07-05T10:00:00.000Z",
        updatedAt: "2026-07-05T10:00:00.000Z",
        toolSurface: {
          boundary: AccessBoundary.ProjectScopedControl,
          allowedTools: [],
          deniedRawCapabilities: [],
        },
      });
      await store.saveRun({
        schemaVersion: 1,
        runId: "run-old",
        sessionId,
        controllerJobId: "infinity-context-controller-v1",
        providerKind: RunEventProviderKind.Codex,
        status: ControlledAgentRunStatus.Running,
        owner,
        startedAt: "2026-07-05T10:00:00.000Z",
        updatedAt: "2026-07-05T10:00:00.000Z",
      });

      const persistedOnlyStatus = await callToolJson(
        client,
        "codex_goal_project_controller_status",
        {
          registryRootDir,
          controllerJobId: "infinity-context-controller-v1",
          stateDir,
        },
      );
      expect(persistedOnlyStatus).toMatchObject({
        ok: true,
        mode: "project_controller_status",
        reason: "provider_status_unavailable",
        liveController: {
          providerRunnerAttached: false,
          live: false,
          ownerMatches: false,
          persistedOwner: {
            ownerId: "old-owner",
            runtimeSha: "old-sha",
          },
          persistedStatus: "running",
        },
      });
    } finally {
      await client.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("lets project controllers consume only their own pending guidance", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-controller-guidance-"));
    const registryRootDir = join(root, "worker-jobs", "registry");
    const authRootDir = join(root, "auth");
    const controllerJobRoot = join(root, "worker-jobs", "infinity-context-controller-v1");
    const childJobRoot = join(root, "worker-jobs", "infinity-context-child-v1");
    const server = createCodexGoalMcpServer();
    const client = new Client({
      name: "subscription-runtime-test",
      version: "0.0.0",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);

      const controllerCreate = await callToolJson(client, "codex_goal_create_job", {
        registryRootDir,
        jobId: "infinity-context-controller-v1",
        jobRootDir: controllerJobRoot,
        authRootDir,
        workspacePath: join(root, "workspaces", "controller"),
        promptPath: join(controllerJobRoot, "prompt.md"),
        taskId: "infinity-context-controller-v1",
        accounts: ["account-a"],
        accessBoundary: AccessBoundary.ProjectScopedControl,
        networkAccess: NetworkAccessMode.Restricted,
        projectAccessScope: {
          projectId: "infinity-context",
          workspaceRoots: [join(root, "workspaces")],
          worktreeRoots: [join(root, "worktrees")],
          registryRoot: registryRootDir,
          jobIdPrefixes: ["infinity-context-"],
          tmuxSessionPrefixes: ["infinity-context-"],
          allowedAccountIds: ["account-a"],
        },
      });
      expect(controllerCreate).toMatchObject({ ok: true });
      const childCreate = await callToolJson(client, "codex_goal_project_create_job", {
        registryRootDir,
        controllerJobId: "infinity-context-controller-v1",
        jobId: "infinity-context-child-v1",
        jobRootDir: childJobRoot,
        authRootDir,
        workspacePath: join(root, "worktrees", "infinity-context-child-v1"),
        promptPath: join(childJobRoot, "prompt.md"),
        taskId: "infinity-context-child-v1",
        accounts: ["account-a"],
        logPath: join(childJobRoot, "infinity-context-child-v1.log"),
        confirmCreate: true,
      });
      expect(childCreate).toMatchObject({ ok: true });

      await callToolJson(client, "codex_goal_control_enqueue", {
        registryRootDir,
        jobId: "infinity-context-controller-v1",
        intent: "guidance",
        body: "Stop spawning broad feature-owned workers; drain memory backlog first.",
        idempotencyKey: "controller-memory-guidance",
      });
      await callToolJson(client, "codex_goal_control_enqueue", {
        registryRootDir,
        jobId: "infinity-context-child-v1",
        intent: "guidance",
        body: "Child worker guidance must remain pending.",
        idempotencyKey: "child-guidance",
      });

      const consumed = await callToolJson(
        client,
        "codex_goal_project_controller_consume_guidance",
        {
          registryRootDir,
          controllerJobId: "infinity-context-controller-v1",
          deliveryAttemptId: "controller-loop-1",
        },
      );

      expect(consumed).toMatchObject({
        ok: true,
        mode: "project_controller_consume_guidance",
        controllerJobId: "infinity-context-controller-v1",
        deliveryAttemptId: "controller-loop-1",
        consumedCount: 1,
        decision: {
          pendingCount: 0,
          deliverableCount: 0,
        },
      });
      expect(String(consumed.message)).toContain("drain memory backlog first");

      const controllerSignals = await callToolJson(client, "codex_goal_control_list", {
        registryRootDir,
        jobId: "infinity-context-controller-v1",
      });
      expect(controllerSignals.signals).toMatchObject([
        {
          state: "delivered",
          latestReceipt: {
            state: "delivered",
            deliveryAttemptId: "controller-loop-1",
          },
        },
      ]);

      const childDecision = await callToolJson(client, "codex_goal_control_decision", {
        registryRootDir,
        jobId: "infinity-context-child-v1",
      });
      expect(childDecision).toMatchObject({
        ok: true,
        decision: {
          pendingCount: 1,
          deliverableCount: 1,
        },
      });
    } finally {
      await client.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed when a Claude project controller lacks a scoped session artifact", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-controller-claude-"));
    const registryRootDir = join(root, "worker-jobs", "registry");
    const controllerJobRoot = join(root, "worker-jobs", "infinity-context-controller-v1");
    const authRootDir = join(root, "auth");
    const server = createCodexGoalMcpServer();
    const client = new Client({
      name: "subscription-runtime-test",
      version: "0.0.0",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);

      await callToolJson(client, "codex_goal_create_job", {
        registryRootDir,
        jobId: "infinity-context-controller-v1",
        jobRootDir: controllerJobRoot,
        authRootDir,
        workspacePath: join(root, "workspaces", "controller"),
        promptPath: join(controllerJobRoot, "prompt.md"),
        taskId: "infinity-context-controller-v1",
        accounts: ["account-a"],
        accessBoundary: AccessBoundary.ProjectScopedControl,
        networkAccess: NetworkAccessMode.Restricted,
        projectAccessScope: {
          projectId: "infinity-context",
          workspaceRoots: [join(root, "workspaces")],
          worktreeRoots: [join(root, "worktrees")],
          registryRoot: registryRootDir,
          authRoot: authRootDir,
          jobIdPrefixes: ["infinity-context-"],
          tmuxSessionPrefixes: ["infinity-context-"],
          allowedAccountIds: ["account-a"],
        },
      });

      const missingPath = await callToolJson(
        client,
        "codex_goal_project_controller_start",
        {
          registryRootDir,
          controllerJobId: "infinity-context-controller-v1",
          providerKind: "claude",
        },
      );
      expect(missingPath).toMatchObject({
        ok: false,
        error: "project_control_controller_session_artifact_path_required",
      });

      const outsidePath = await callToolJson(
        client,
        "codex_goal_project_controller_start",
        {
          registryRootDir,
          controllerJobId: "infinity-context-controller-v1",
          providerKind: "claude",
          sessionArtifactPath: join(root, "outside-session.json"),
        },
      );
      expect(outsidePath).toMatchObject({
        ok: false,
        error: "project_control_controller_session_artifact_outside_scope",
      });
    } finally {
      await client.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects project-control child jobs outside controller job and account scope", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-project-deny-"));
    const registryRootDir = join(root, "worker-jobs", "registry");
    const controllerJobRoot = join(root, "worker-jobs", "infinity-context-controller-v1");
    const server = createCodexGoalMcpServer();
    const client = new Client({
      name: "subscription-runtime-test",
      version: "0.0.0",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);

      await callToolJson(client, "codex_goal_create_job", {
        registryRootDir,
        jobId: "infinity-context-controller-v1",
        jobRootDir: controllerJobRoot,
        authRootDir: join(root, "auth"),
        workspacePath: join(root, "workspaces", "controller"),
        promptPath: join(controllerJobRoot, "prompt.md"),
        taskId: "infinity-context-controller-v1",
        accounts: ["account-a"],
        accessBoundary: AccessBoundary.ProjectScopedControl,
        networkAccess: NetworkAccessMode.Restricted,
        projectAccessScope: {
          projectId: "infinity-context",
          workspaceRoots: [join(root, "workspaces")],
          worktreeRoots: [join(root, "worktrees")],
          registryRoot: registryRootDir,
          jobIdPrefixes: ["infinity-context-"],
          tmuxSessionPrefixes: ["infinity-context-"],
          allowedAccountIds: ["account-a"],
        },
      });

      const foreignJob = await callToolJson(client, "codex_goal_project_create_job", {
        registryRootDir,
        controllerJobId: "infinity-context-controller-v1",
        jobId: "quanta-child-v1",
        jobRootDir: join(root, "worker-jobs", "infinity-context-disguised"),
        authRootDir: join(root, "auth"),
        workspacePath: join(root, "worktrees", "infinity-context-disguised"),
        promptPath: join(root, "worker-jobs", "infinity-context-disguised", "prompt.md"),
        taskId: "quanta-child-v1",
        accounts: ["account-a"],
        tmuxSession: "infinity-context-disguised",
        confirmCreate: true,
      });
      expect(foreignJob).toMatchObject({
        ok: false,
        error: "project_control_denied:job_prefix_denied",
      });

      const foreignAccount = await callToolJson(client, "codex_goal_project_create_job", {
        registryRootDir,
        controllerJobId: "infinity-context-controller-v1",
        jobId: "infinity-context-account-denied-v1",
        jobRootDir: join(root, "worker-jobs", "infinity-context-account-denied-v1"),
        authRootDir: join(root, "auth"),
        workspacePath: join(root, "worktrees", "infinity-context-account-denied-v1"),
        promptPath: join(root, "worker-jobs", "infinity-context-account-denied-v1", "prompt.md"),
        taskId: "infinity-context-account-denied-v1",
        accounts: ["account-b"],
        confirmCreate: true,
      });
      expect(foreignAccount).toMatchObject({
        ok: false,
        error: "project_control_denied:account_denied",
      });

      const audit = await readProjectControlAudit(
        controllerJobRoot,
        "infinity-context-controller-v1",
      );
      expect(policyAuditDecisions(audit).map((decision) => decision.reason)).toEqual([
        "job_prefix_denied",
        "allowed",
        "account_denied",
      ]);
    } finally {
      await client.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs project-scoped worktree, integration and push operations through broker policy", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-project-git-"));
    const registryRootDir = join(root, "worker-jobs", "registry");
    const controllerJobRoot = join(root, "worker-jobs", "infinity-context-controller-v1");
    const sourceWorkspacePath = join(root, "workspaces", "infinity-context-main");
    const worktreePath = join(root, "worktrees", "infinity-context-integration");
    const remotePath = join(root, "remote.git");
    const server = createCodexGoalMcpServer();
    const client = new Client({
      name: "subscription-runtime-test",
      version: "0.0.0",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await mkdir(sourceWorkspacePath, { recursive: true });
      await gitInitRepository(sourceWorkspacePath);
      await writeFile(join(sourceWorkspacePath, "base.txt"), "base\n");
      await git(sourceWorkspacePath, ["add", "base.txt"]);
      await git(sourceWorkspacePath, ["commit", "-m", "test: base"]);
      await git(sourceWorkspacePath, ["branch", "integration-target"]);
      await git(sourceWorkspacePath, ["checkout", "-b", "feature/source-change"]);
      await writeFile(join(sourceWorkspacePath, "feature.txt"), "feature\n");
      await git(sourceWorkspacePath, ["add", "feature.txt"]);
      await git(sourceWorkspacePath, ["commit", "-m", "test: feature"]);
      const commitSha = await gitStdout(sourceWorkspacePath, ["rev-parse", "HEAD"]);
      await git(sourceWorkspacePath, ["checkout", "main"]);
      await execFileAsync("git", ["init", "--bare", remotePath]);
      await git(sourceWorkspacePath, ["remote", "add", "origin", remotePath]);

      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);

      await callToolJson(client, "codex_goal_create_job", {
        registryRootDir,
        jobId: "infinity-context-controller-v1",
        jobRootDir: controllerJobRoot,
        authRootDir: join(root, "auth"),
        workspacePath: sourceWorkspacePath,
        promptPath: join(controllerJobRoot, "prompt.md"),
        taskId: "infinity-context-controller-v1",
        accounts: ["account-a"],
        accessBoundary: AccessBoundary.ProjectScopedControl,
        networkAccess: NetworkAccessMode.Restricted,
        projectAccessScope: {
          projectId: "infinity-context",
          workspaceRoots: [sourceWorkspacePath],
          worktreeRoots: [join(root, "worktrees")],
          registryRoot: registryRootDir,
          jobIdPrefixes: ["infinity-context-"],
          tmuxSessionPrefixes: ["infinity-context-"],
          allowedBranches: ["integration-target"],
          allowedGitRemotes: ["origin"],
        },
      });

      await expect(callToolJson(client, "codex_goal_project_create_worktree", {
        registryRootDir,
        controllerJobId: "infinity-context-controller-v1",
        sourceWorkspacePath,
        path: worktreePath,
        baseBranch: "integration-target",
        confirmCreateWorktree: true,
      })).resolves.toMatchObject({
        ok: true,
        mode: "project_control_create_worktree",
      });

      await expect(callToolJson(client, "codex_goal_project_integrate_commit", {
        registryRootDir,
        controllerJobId: "infinity-context-controller-v1",
        workspacePath: worktreePath,
        branch: "integration-target",
        commitSha: commitSha.trim(),
        confirmIntegrate: true,
      })).resolves.toMatchObject({
        ok: true,
        mode: "project_control_integrate_commit",
      });

      await expect(callToolJson(client, "codex_goal_project_push_branch", {
        registryRootDir,
        controllerJobId: "infinity-context-controller-v1",
        workspacePath: worktreePath,
        branch: "integration-target",
        remote: "origin",
        confirmPush: true,
      })).resolves.toMatchObject({
        ok: true,
        mode: "project_control_push_branch",
      });

      await expect(callToolJson(client, "codex_goal_project_push_branch", {
        registryRootDir,
        controllerJobId: "infinity-context-controller-v1",
        workspacePath: worktreePath,
        branch: "integration-target",
        remote: "upstream",
        confirmPush: true,
      })).resolves.toMatchObject({
        ok: false,
        error: "project_control_denied:remote_denied",
      });

      await expect(callToolJson(client, "codex_goal_project_push_branch", {
        registryRootDir,
        controllerJobId: "infinity-context-controller-v1",
        workspacePath: worktreePath,
        branch: "integration-target",
        remote: "origin",
        force: true,
        confirmPush: true,
      })).resolves.toMatchObject({
        ok: false,
        error: "project_control_denied:force_push_denied",
      });

      const pushedSha = await execFileAsync("git", [
        "--git-dir",
        remotePath,
        "rev-parse",
        "refs/heads/integration-target",
      ]);
      expect(pushedSha.stdout.trim()).toBe(commitSha.trim());
      const audit = await readProjectControlAudit(
        controllerJobRoot,
        "infinity-context-controller-v1",
      );
      expect(policyAuditDecisions(audit).map((decision) => decision.operation)).toEqual([
        "create_worktree",
        "integrate_commit",
        "push_branch",
        "push_branch",
        "push_branch",
      ]);
      expect(policyAuditDecisions(audit).map((decision) => decision.reason)).toEqual([
        "allowed",
        "allowed",
        "allowed",
        "remote_denied",
        "force_push_denied",
      ]);
    } finally {
      await client.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs project integration lifecycle tools through policy and local adapters", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-project-integration-"));
    const registryRootDir = join(root, "worker-jobs", "registry");
    const controllerJobRoot = join(root, "worker-jobs", "infinity-context-controller-v1");
    const workspacePath = join(root, "workspaces", "infinity-context-main");
    const remotePath = join(root, "remote.git");
    const server = createCodexGoalMcpServer();
    const client = new Client({
      name: "subscription-runtime-test",
      version: "0.0.0",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await mkdir(join(workspacePath, "src"), { recursive: true });
      await gitInitRepository(workspacePath);
      await writeFile(join(workspacePath, "src", "memory.ts"), "export const value = 1;\n");
      await git(workspacePath, ["add", "."]);
      await git(workspacePath, ["commit", "-m", "test: base"]);
      await execFileAsync("git", ["init", "--bare", remotePath]);
      await git(workspacePath, ["remote", "add", "origin", remotePath]);
      await git(workspacePath, ["checkout", "-b", "infinity-context-worker-v1"]);
      await writeFile(join(workspacePath, "src", "memory.ts"), "export const value = 2;\n");
      await git(workspacePath, ["add", "."]);
      await git(workspacePath, ["commit", "-m", "fix: worker output"]);
      const workerCommitSha = (await gitStdout(workspacePath, ["rev-parse", "HEAD"])).trim();
      await git(workspacePath, ["checkout", "main"]);

      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);

      await callToolJson(client, "codex_goal_create_job", {
        registryRootDir,
        jobId: "infinity-context-controller-v1",
        jobRootDir: controllerJobRoot,
        authRootDir: join(root, "auth"),
        workspacePath,
        promptPath: join(controllerJobRoot, "prompt.md"),
        taskId: "infinity-context-controller-v1",
        accounts: ["account-a"],
        accessBoundary: AccessBoundary.ProjectScopedControl,
        networkAccess: NetworkAccessMode.Restricted,
        projectAccessScope: {
          projectId: "infinity-context",
          workspaceRoots: [workspacePath],
          registryRoot: registryRootDir,
          jobIdPrefixes: ["infinity-context-"],
          tmuxSessionPrefixes: ["infinity-context-"],
          allowedBranches: ["main"],
          allowedGitRemotes: ["origin"],
        },
      });

      await expect(callToolJson(client, "codex_goal_project_open_integration_attempt", {
        registryRootDir,
        controllerJobId: "infinity-context-controller-v1",
        attemptId: "attempt-1",
        workerJobId: "infinity-context-worker-v1",
        workerWorkspacePath: workspacePath,
        workerCommitSha,
        targetWorkspacePath: workspacePath,
        targetBranch: "main",
        targetRemote: "origin",
        changedFiles: ["src/memory.ts"],
        approvedFiles: ["src/memory.ts"],
        allowedPathPrefixes: ["src"],
        requiredCheckIds: ["check:unit"],
        requiredChecks: [{
          checkId: "check:unit",
          command: [process.execPath, "-e", "process.exit(0)"],
        }],
        confirmOpen: true,
      })).resolves.toMatchObject({
        ok: true,
        mode: "project_integration_open_attempt",
        attempt: {
          status: "opened",
          expectedFiles: ["src/memory.ts"],
        },
      });

      await expect(callToolJson(client, "codex_goal_project_apply_worker_output", {
        registryRootDir,
        controllerJobId: "infinity-context-controller-v1",
        attemptId: "attempt-1",
        confirmApply: true,
      })).resolves.toMatchObject({
        ok: true,
        mode: "project_integration_apply_worker_output",
        attempt: {
          status: "applied",
        },
      });

      await expect(callToolJson(client, "codex_goal_project_run_required_checks", {
        registryRootDir,
        controllerJobId: "infinity-context-controller-v1",
        attemptId: "attempt-1",
        confirmRunChecks: true,
      })).resolves.toMatchObject({
        ok: true,
        mode: "project_integration_run_required_checks",
        attempt: {
          status: "checks_passed",
        },
      });

      const committed = await callToolJson(client, "codex_goal_project_commit_approved_changes", {
        registryRootDir,
        controllerJobId: "infinity-context-controller-v1",
        attemptId: "attempt-1",
        message: "fix(memory): integrate worker output",
        allowedPathPrefixes: ["src"],
        requiredCheckIds: ["check:unit"],
        confirmCommit: true,
      });
      expect(committed).toMatchObject({
        ok: true,
        mode: "project_integration_commit_approved_changes",
        attempt: {
          status: "commit_created",
        },
      });
      const commitSha = (((committed.attempt as Record<string, unknown>)
        .commitCandidate as Record<string, unknown>).commitSha);
      expect(String(commitSha)).toMatch(/^[a-f0-9]{40}$/);

      await expect(callToolJson(client, "codex_goal_project_push_approved_commit", {
        registryRootDir,
        controllerJobId: "infinity-context-controller-v1",
        attemptId: "attempt-1",
        confirmPush: true,
      })).resolves.toMatchObject({
        ok: true,
        mode: "project_integration_push_approved_commit",
        attempt: {
          status: "pushed",
        },
      });

      const pushedSha = await execFileAsync("git", [
        "--git-dir",
        remotePath,
        "rev-parse",
        "refs/heads/main",
      ]);
      expect(pushedSha.stdout.trim()).toBe(commitSha);
    } finally {
      await client.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("creates a job manifest when starting a detached worker", async () => {
    if (!(await hasTmux())) return;
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-start-job-"));
    const registryRootDir = join(root, "registry");
    const jobRootDir = join(root, "job");
    const authRootDir = join(root, "auth");
    const workspacePath = join(root, "workspace");
    const promptPath = join(jobRootDir, "prompt.md");
    const taskId = "sandbox-start-task";
    const jobId = "job-started";
    const tmuxSession = `subscription-runtime-start-job-${process.pid}-${Date.now()}`;

    try {
      await mkdir(jobRootDir, { recursive: true });
      await mkdir(workspacePath, { recursive: true });
      await writeFile(promptPath, "Return a tiny JSON status.\n");
      await writeFakeAuth(authRootDir, "account-a", {
        lastRefresh: "2026-06-03T00:00:00.000Z",
      });

      const server = createCodexGoalMcpServer();
      const client = new Client({ name: "subscription-runtime-test", version: "0.0.0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);

      try {
        const start = await callToolJson(client, "codex_goal_start", {
          registryRootDir,
          jobId,
          jobRootDir,
          authRootDir,
          workspacePath,
          promptPath,
          taskId,
          accounts: ["account-a"],
          tmuxSession,
          codexBinaryPath: "/bin/echo",
          requireGitWorkspace: false,
          skipDoctor: true,
          confirmStart: true,
          taskTimeoutMs: 1_000,
          maxAccountCycles: 1,
          outputFormat: "json",
        });

        expect(start).toMatchObject({
          ok: true,
          registryRootDir,
          jobId,
          taskId,
          tmuxSession,
        });

        const job = await callToolJson(client, "codex_goal_get_job", {
          registryRootDir,
          jobId,
        });

        expect(job).toMatchObject({
          ok: true,
          registryRootDir,
          manifest: {
            jobId,
            jobRootDir,
            authRootDir,
            workspacePath,
            promptPath,
            taskId,
            accounts: ["account-a"],
            tmuxSession,
            codexBinaryPath: "/bin/echo",
            requireGitWorkspace: false,
            outputFormat: "json",
          },
        });
      } finally {
        await execFileAsync("tmux", ["kill-session", "-t", tmuxSession]).catch(() => undefined);
        await client.close();
        await server.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("creates missing jobRoot before doctoring a start request", async () => {
    if (!(await hasTmux())) return;
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-start-missing-jobroot-"));
    const registryRootDir = join(root, "registry");
    const jobRootDir = join(root, "missing-job");
    const authRootDir = join(root, "auth");
    const workspacePath = join(root, "workspace");
    const promptPath = join(root, "prompt.md");
    const taskId = "sandbox-start-missing-jobroot";
    const jobId = "job-start-missing-jobroot";
    const tmuxSession = `subscription-runtime-start-missing-jobroot-${process.pid}-${Date.now()}`;

    try {
      await mkdir(workspacePath, { recursive: true });
      await execFileAsync("git", ["init"], { cwd: workspacePath });
      await writeFile(promptPath, "Return a tiny JSON status.\n");
      await writeFakeAuth(authRootDir, "account-a", {
        lastRefresh: "2026-06-03T00:00:00.000Z",
      });

      const server = createCodexGoalMcpServer();
      const client = new Client({ name: "subscription-runtime-test", version: "0.0.0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);

      try {
        const start = await callToolJson(client, "codex_goal_start", {
          registryRootDir,
          jobId,
          jobRootDir,
          authRootDir,
          workspacePath,
          promptPath,
          taskId,
          accounts: ["account-a"],
          tmuxSession,
          codexBinaryPath: "/bin/echo",
          requireGitWorkspace: false,
          confirmStart: true,
          taskTimeoutMs: 1_000,
          maxAccountCycles: 1,
          outputFormat: "json",
        });

        if (!start.ok) {
          throw new Error(JSON.stringify(start, null, 2));
        }
        expect(start).toMatchObject({
          ok: true,
          registryRootDir,
          jobId,
          taskId,
          tmuxSession,
        });
        await access(jobRootDir);
      } finally {
        await execFileAsync("tmux", ["kill-session", "-t", tmuxSession]).catch(() => undefined);
        await client.close();
        await server.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the job manifest when confirmed start fails doctor", async () => {
    if (!(await hasTmux())) return;
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-start-doctor-fails-"));
    const registryRootDir = join(root, "registry");
    const jobRootDir = join(root, "job");
    const authRootDir = join(root, "auth");
    const workspacePath = join(root, "workspace");
    const promptPath = join(jobRootDir, "prompt.md");
    const taskId = "sandbox-start-doctor-fails";
    const jobId = "job-start-doctor-fails";
    const tmuxSession = `subscription-runtime-start-doctor-fails-${process.pid}-${Date.now()}`;

    try {
      await mkdir(jobRootDir, { recursive: true });
      await mkdir(workspacePath, { recursive: true });
      await execFileAsync("git", ["init"], { cwd: workspacePath });
      await writeFile(promptPath, "Return a tiny JSON status.\n");

      const server = createCodexGoalMcpServer();
      const client = new Client({ name: "subscription-runtime-test", version: "0.0.0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);

      try {
        const start = await callToolJson(client, "codex_goal_start", {
          registryRootDir,
          jobId,
          jobRootDir,
          authRootDir,
          workspacePath,
          promptPath,
          taskId,
          accounts: ["account-a"],
          tmuxSession,
          codexBinaryPath: "/bin/echo",
          requireGitWorkspace: false,
          confirmStart: true,
          taskTimeoutMs: 1_000,
          maxAccountCycles: 1,
          outputFormat: "json",
        });

        expect(start).toMatchObject({
          ok: false,
          reason: "doctor_failed",
        });

        const job = await callToolJson(client, "codex_goal_get_job", {
          registryRootDir,
          jobId,
        });

        expect(job).toMatchObject({
          ok: true,
          manifest: {
            jobId,
            jobRootDir,
            authRootDir,
            workspacePath,
            promptPath,
            taskId,
            accounts: ["account-a"],
            tmuxSession,
          },
        });
      } finally {
        await client.close();
        await server.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("exposes Claude run watch snapshots through provider-neutral MCP", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-claude-run-watch-"));
    const stateRootDir = join(root, "state");
    const workspacePath = join(root, "workspace");
    const runArtifactsRootDir = join(stateRootDir, "claude-run-artifacts");

    try {
      await mkdir(workspacePath, { recursive: true });
      await execFileAsync("git", ["init"], { cwd: workspacePath });
      await writeFile(join(workspacePath, "dirty.txt"), "dirty\n");
      await writeClaudeRunArtifacts({
        rootDir: runArtifactsRootDir,
        runId: "claude-watch-run",
        providerInstanceId: "claude-main",
        workerId: "claude-worker-a",
        configDir: join(root, "config"),
        workspacePath,
      });

      const server = createCodexGoalMcpServer();
      const client = new Client({ name: "subscription-runtime-test", version: "0.0.0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);

      try {
        const watch = await callToolJson(client, "agent_run_watch", {
          providerKind: "claude",
          stateRootDir,
          jobId: "claude-watch-run",
          includeChangedFiles: true,
          includeLogTail: true,
        });

        expect(watch).toMatchObject({
          ok: true,
          mode: "read_only",
          sideEffects: [],
          providerKind: "claude",
          summary: {
            completed: 1,
          },
        });
        const snapshots = watch.snapshots as readonly Record<string, unknown>[];
        expect(snapshots[0]).toMatchObject({
          runId: "claude-watch-run",
          providerKind: "claude",
          status: "completed",
          workspace: {
            dirty: true,
            changedFilesCount: 1,
          },
          result: {
            exists: true,
            status: "completed",
          },
          readOnlyDecision: {
            kind: "review_completed",
          },
        });
        expect(JSON.stringify(watch).includes("claude-oauth-secret")).toBe(false);

        const eventRootDir = join(root, "events");
        const projected = await callToolJson(client, "agent_run_project_events", {
          providerKind: "claude",
          stateRootDir,
          eventRootDir,
          jobId: "claude-watch-run",
          hostId: "test-host",
        });

        expect(projected).toMatchObject({
          ok: true,
          mode: "project_events",
          sideEffects: ["append_run_events", "write_projection_state"],
          providerKind: "claude",
          appendedCount: expect.any(Number),
          projectedRuns: [
            expect.objectContaining({
              runId: "claude-watch-run",
              status: "completed",
            }),
          ],
        });
        expect((projected.appendedCount as number)).toBeGreaterThan(0);
        expect(JSON.stringify(projected).includes("claude-oauth-secret")).toBe(false);
      } finally {
        await client.close();
        await server.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports unsupported provider run watch as read-only without side effects", async () => {
    const server = createCodexGoalMcpServer();
    const client = new Client({ name: "subscription-runtime-test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    try {
      const watch = await callToolJson(client, "agent_run_watch", {
        providerKind: "local",
      });

      expect(watch).toMatchObject({
        ok: false,
        mode: "read_only",
        sideEffects: [],
        providerKind: "local",
        supportedProviderKinds: ["codex", "claude"],
        reason: "provider_observation_not_implemented",
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("keeps missing explicit run observations read-only and structured", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-run-watch-missing-"));
    const server = createCodexGoalMcpServer();
    const client = new Client({ name: "subscription-runtime-test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    try {
      const watch = await callToolJson(client, "agent_run_watch", {
        registryRootDir: join(root, "registry"),
        jobId: "missing-job",
      });

      expect(watch).toMatchObject({
        ok: false,
        mode: "read_only",
        sideEffects: [],
        providerKind: "codex",
        summary: {
          unknown: 1,
          manualReview: 1,
          warnings: 1,
        },
      });
      const snapshots = watch.snapshots as readonly Record<string, unknown>[];
      expect(snapshots[0]).toMatchObject({
        runId: "missing-job",
        status: "unknown",
        liveness: "unknown",
        readOnlyDecision: {
          kind: "manual_review_required",
          reason: "run_observation_failed",
        },
      });
      expect(watch).toMatchObject({
        observationFailures: [{
          runId: "missing-job",
        }],
      });
    } finally {
      await client.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("observes explicit Codex artifact roots when the registry manifest is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-run-watch-orphan-"));
    const runArtifactsRootDir = join(root, "runs");
    const jobId = "orphan-job";
    const jobRootDir = join(runArtifactsRootDir, jobId);
    const server = createCodexGoalMcpServer();
    const client = new Client({ name: "subscription-runtime-test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    try {
      await mkdir(jobRootDir, { recursive: true });
      await writeFile(join(jobRootDir, "worker.log"), "");
      await writeFile(join(jobRootDir, "progress.json"), `${JSON.stringify({
        schemaVersion: 1,
        taskId: jobId,
        updatedAt: new Date().toISOString(),
        pid: process.pid,
        status: "running",
      })}\n`);

      const watch = await callToolJson(client, "codex_goal_run_watch", {
        registryRootDir: join(root, "registry"),
        runArtifactsRootDir,
        jobId,
        staleAfterMs: 60_000,
        includeLogTail: true,
      });

      expect(watch).toMatchObject({
        ok: true,
        mode: "read_only",
        sideEffects: [],
        providerKind: "codex",
        summary: {
          manualReview: 1,
        },
      });
      const snapshots = watch.snapshots as readonly Record<string, unknown>[];
      expect(snapshots[0]).toMatchObject({
        runId: jobId,
        providerKind: "codex",
        liveness: "dead",
        logs: {
          exists: true,
          path: join(jobRootDir, "worker.log"),
        },
        artifacts: expect.arrayContaining([
          expect.objectContaining({
            kind: "progress",
            path: join(jobRootDir, "progress.json"),
            exists: true,
          }),
        ]),
        readOnlyDecision: {
          kind: "manual_review_required",
          reason: "missing_job_manifest",
        },
      });
      const warnings = snapshots[0]!.warnings as readonly Record<string, unknown>[];
      expect(warnings.map((warning) => warning.code)).toContain("codex_orphan_artifact_run");
      expect(watch).not.toHaveProperty("observationFailures");
    } finally {
      await client.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("records an audit event when stopping a sandbox tmux worker", async () => {
    if (!(await hasTmux())) return;
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-stop-event-"));
    const registryRootDir = join(root, "registry");
    const jobRootDir = join(root, "job");
    const stateRootDir = join(root, "state");
    const authRootDir = join(root, "auth");
    const workspacePath = join(root, "workspace");
    const promptPath = join(jobRootDir, "prompt.md");
    const taskId = "sandbox-stop-task";
    const tmuxSession = `subscription-runtime-stop-${process.pid}-${Date.now()}`;

    try {
      await mkdir(jobRootDir, { recursive: true });
      await mkdir(workspacePath, { recursive: true });
      await execFileAsync("git", ["init"], { cwd: workspacePath });
      await writeFile(promptPath, "Do a sandbox task.\n");
      await writeFakeAuth(authRootDir, "account-a", {
        lastRefresh: "2026-06-03T00:00:00.000Z",
      });
      await execFileAsync("tmux", [
        "new-session",
        "-d",
        "-s",
        tmuxSession,
        "-c",
        root,
        "sleep 300",
      ]);

      const server = createCodexGoalMcpServer();
      const client = new Client({ name: "subscription-runtime-test", version: "0.0.0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);

      try {
        await callToolJson(client, "codex_goal_create_job", {
          registryRootDir,
          jobId: "job-stop",
          jobRootDir,
          authRootDir,
          stateRootDir,
          workspacePath,
          promptPath,
          taskId,
          accounts: ["account-a"],
          logPath: join(jobRootDir, `${taskId}.log`),
          tmuxSession,
        });

        const stopped = await callToolJson(client, "codex_goal_stop", {
          registryRootDir,
          jobId: "job-stop",
          confirmStop: true,
          forceStop: true,
        });

        expect(stopped).toMatchObject({
          ok: true,
          mode: "stop",
          jobId: "job-stop",
          tmuxSession,
        });
        const stopEventPath = String(stopped.stopEventPath);
        expect(stopEventPath).toContain(`${taskId}.stop-event.json`);
        const stopEvent = JSON.parse(await readFile(stopEventPath, "utf8"));
        expect(stopEvent).toMatchObject({
          schemaVersion: 1,
          jobId: "job-stop",
          taskId,
          tmuxSession,
          forceStop: true,
          reason: "manual_force_stop",
        });
        expect(JSON.stringify(stopEvent)).not.toContain("refresh-secret");
        expect(JSON.stringify(stopEvent)).not.toContain("access-secret");
      } finally {
        await client.close();
        await server.close();
      }
    } finally {
      await execFileAsync("tmux", ["kill-session", "-t", tmuxSession]).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("allows confirmed stop for heartbeat-only no-output sandbox workers", async () => {
    if (!(await hasTmux())) return;
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-stop-heartbeat-"));
    const registryRootDir = join(root, "registry");
    const jobRootDir = join(root, "job");
    const stateRootDir = join(root, "state");
    const authRootDir = join(root, "auth");
    const workspacePath = join(root, "workspace");
    const promptPath = join(jobRootDir, "prompt.md");
    const taskId = "sandbox-stop-heartbeat-task";
    const tmuxSession = `subscription-runtime-stop-heartbeat-${process.pid}-${Date.now()}`;

    try {
      await mkdir(jobRootDir, { recursive: true });
      await mkdir(workspacePath, { recursive: true });
      await execFileAsync("git", ["init"], { cwd: workspacePath });
      await writeFile(promptPath, "Do a sandbox task.\n");
      await writeFakeAuth(authRootDir, "account-a", {
        lastRefresh: "2026-06-03T00:00:00.000Z",
      });
      await execFileAsync("tmux", [
        "new-session",
        "-d",
        "-s",
        tmuxSession,
        "-c",
        root,
        "sleep 300",
      ]);
      await writeFile(join(jobRootDir, `${taskId}.progress.json`), `${JSON.stringify({
        schemaVersion: 1,
        taskId,
        status: "running",
        updatedAt: new Date(Date.now() - 130_000).toISOString(),
        // Intentionally omit pid: heartbeat-only workers can have fresh progress without
        // a runtime pid, and stop/reconcile must still classify that shape safely.
      })}\n`);

      const server = createCodexGoalMcpServer();
      const client = new Client({ name: "subscription-runtime-test", version: "0.0.0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);

      try {
        await callToolJson(client, "codex_goal_create_job", {
          registryRootDir,
          jobId: "job-stop-heartbeat",
          jobRootDir,
          authRootDir,
          stateRootDir,
          workspacePath,
          promptPath,
          taskId,
          accounts: ["account-a"],
          logPath: join(jobRootDir, `${taskId}.log`),
          tmuxSession,
        });

        const decision = await callToolJson(client, "codex_goal_decision", {
          registryRootDir,
          jobId: "job-stop-heartbeat",
        });
        expect(decision).toMatchObject({
          decision: {
            action: "manual_review_heartbeat_only_no_output",
            safeToContinue: false,
          },
        });

        const stopped = await callToolJson(client, "codex_goal_stop", {
          registryRootDir,
          jobId: "job-stop-heartbeat",
          confirmStop: true,
        });

        expect(stopped).toMatchObject({
          ok: true,
          mode: "stop",
          jobId: "job-stop-heartbeat",
          tmuxSession,
        });
        const stopEvent = JSON.parse(await readFile(String(stopped.stopEventPath), "utf8"));
        expect(stopEvent).toMatchObject({
          forceStop: false,
          reason: "heartbeat_only_no_output",
          brief: {
            heartbeatOnlyNoOutput: true,
          },
        });
        const stoppedProgress = JSON.parse(
          await readFile(join(jobRootDir, `${taskId}.progress.json`), "utf8"),
        );
        expect(stoppedProgress).toMatchObject({
          taskId,
          status: "stopped",
        });
      } finally {
        await client.close();
        await server.close();
      }
    } finally {
      await execFileAsync("tmux", ["kill-session", "-t", tmuxSession]).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("marks planned maintenance pauses as continuable without runtime reconciliation", async () => {
    if (!(await hasTmux())) return;
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-maintenance-pause-"));
    const registryRootDir = join(root, "registry");
    const jobRootDir = join(root, "job");
    const stateRootDir = join(root, "state");
    const authRootDir = join(root, "auth");
    const workspacePath = join(root, "workspace");
    const promptPath = join(jobRootDir, "prompt.md");
    const taskId = "sandbox-maintenance-task";
    const jobId = "job-maintenance";
    const tmuxSession = `subscription-runtime-maintenance-${process.pid}-${Date.now()}`;
    const outputPath = join(jobRootDir, `${taskId}.latest-result.json`);
    const codexSlow = join(root, "codex-slow.sh");

    try {
      await mkdir(jobRootDir, { recursive: true });
      await mkdir(workspacePath, { recursive: true });
      await execFileAsync("git", ["init"], { cwd: workspacePath });
      await writeFile(promptPath, "Do a sandbox task.\n");
      await writeFile(codexSlow, "#!/bin/sh\nsleep 30\n");
      await chmod(codexSlow, 0o700);
      await writeFakeAuth(authRootDir, "account-a", {
        lastRefresh: "2026-06-03T00:00:00.000Z",
      });
      await execFileAsync("tmux", [
        "new-session",
        "-d",
        "-s",
        tmuxSession,
        "-c",
        root,
        "sleep 300",
      ]);

      const server = createCodexGoalMcpServer();
      const client = new Client({ name: "subscription-runtime-test", version: "0.0.0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);

      try {
        await callToolJson(client, "codex_goal_create_job", {
          registryRootDir,
          jobId,
          jobRootDir,
          authRootDir,
          stateRootDir,
          workspacePath,
          promptPath,
          taskId,
          accounts: ["account-a"],
          outputPath,
          logPath: join(jobRootDir, `${taskId}.log`),
          tmuxSession,
          codexBinaryPath: codexSlow,
          requireGitWorkspace: true,
        });

        const paused = await callToolJson(client, "codex_goal_maintenance_pause", {
          registryRootDir,
          jobId,
          confirmPause: true,
          reason: "resize",
        });

        expect(paused).toMatchObject({
          ok: true,
          mode: "maintenance_pause",
          jobId,
          taskId,
          tmuxSession,
        });
        const progress = JSON.parse(
          await readFile(join(jobRootDir, `${taskId}.progress.json`), "utf8"),
        );
        expect(progress).toMatchObject({
          taskId,
          status: "maintenance_paused",
          reason: "resize",
        });
        const marker = JSON.parse(await readFile(String(paused.maintenancePausePath), "utf8"));
        expect(marker).toMatchObject({
          schemaVersion: 1,
          jobId,
          taskId,
          tmuxSession,
          forcePause: false,
          reason: "resize",
        });
        expect(JSON.stringify(marker)).not.toContain("refresh-secret");
        expect(JSON.stringify(marker)).not.toContain("access-secret");

        const brief = await callToolJson(client, "codex_goal_brief", {
          registryRootDir,
          jobId,
        });
        expect(brief.brief).toMatchObject({
          safeToContinue: true,
          maintenancePaused: true,
          lifecycleMarkerTypes: ["maintenance_pause"],
          nextBestTool: "codex_goal_continue",
        });

        const decision = await callToolJson(client, "codex_goal_decision", {
          registryRootDir,
          jobId,
        });
        expect(decision.decision).toMatchObject({
          action: "continue",
          safeToContinue: true,
          safeToOperate: true,
        });

        const continued = await callToolJson(client, "codex_goal_continue", {
          registryRootDir,
          jobId,
          confirmContinue: true,
          skipDoctor: true,
        });
        expect(continued).toMatchObject({
          ok: true,
          mode: "continue",
          jobId,
          tmuxSession,
        });
        await expect(access(outputPath)).rejects.toThrow();
      } finally {
        await execFileAsync("tmux", ["kill-session", "-t", tmuxSession]).catch(() => undefined);
        await client.close();
        await server.close();
      }
    } finally {
      await execFileAsync("tmux", ["kill-session", "-t", tmuxSession]).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("exposes worker control inbox tools for stored Codex goal jobs", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-control-mcp-"));
    const registryRootDir = join(root, "registry");
    const jobRootDir = join(root, "job");
    const stateRootDir = join(root, "state");
    const authRootDir = join(root, "auth");
    const workspacePath = join(root, "workspace");
    const promptPath = join(jobRootDir, "prompt.md");
    const taskId = "sandbox-control-task";

    try {
      await mkdir(jobRootDir, { recursive: true });
      await mkdir(workspacePath, { recursive: true });
      await execFileAsync("git", ["init"], { cwd: workspacePath });
      await writeFile(promptPath, "Do a sandbox task.\n");
      await writeFakeAuth(authRootDir, "account-a", {
        lastRefresh: "2026-06-03T00:00:00.000Z",
      });

      const server = createCodexGoalMcpServer();
      const client = new Client({ name: "subscription-runtime-test", version: "0.0.0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);

      try {
        await callToolJson(client, "codex_goal_create_job", {
          registryRootDir,
          jobId: "job-control",
          jobRootDir,
          authRootDir,
          stateRootDir,
          workspacePath,
          promptPath,
          taskId,
          accounts: ["account-a"],
          logPath: join(jobRootDir, `${taskId}.log`),
        });

        const enqueued = await callToolJson(client, "codex_goal_control_enqueue", {
          registryRootDir,
          jobId: "job-control",
          intent: "guidance",
          body: "Prefer targeted tests before full benchmark.",
          idempotencyKey: "guidance-targeted-tests",
          callerKind: "agent",
          callerId: "lead-agent",
        });

        expect(enqueued).toMatchObject({
          ok: true,
          jobId: "job-control",
          taskId,
          signal: {
            idempotencyKey: "guidance-targeted-tests",
            createdBy: "agent",
          },
          decision: {
            safeToContinue: true,
            deliverableCount: 1,
          },
        });
        expect(JSON.stringify(enqueued).includes("Prefer targeted tests")).toBe(false);

        const listed = await callToolJson(client, "codex_goal_control_list", {
          registryRootDir,
          jobId: "job-control",
        });
        const signals = listed.signals as readonly Record<string, unknown>[];
        expect(signals).toHaveLength(1);
        expect(signals[0]).toMatchObject({
          state: "pending",
          deliverable: true,
        });
        expect(JSON.stringify(signals[0])).toContain("guidance-targeted-tests");
        expect(
          JSON.stringify(signals[0]).includes("Prefer targeted tests"),
        ).toBe(false);

        const decision = await callToolJson(client, "codex_goal_control_decision", {
          registryRootDir,
          jobId: "job-control",
        });
        expect(decision).toMatchObject({
          ok: true,
          decision: {
            safeToContinue: true,
            pendingCount: 1,
            deliverableCount: 1,
          },
        });

        const signalId = String(
          (signals[0]?.signal as { readonly signalId: string } | undefined)?.signalId,
        );
        expect(signalId).toMatch(/\S/);
        const controlStore = new LocalFileWorkerControlInboxStore({
          rootDir: stateRootDir,
        });
        await controlStore.tryClaimDelivery?.(workerControlReceipt({
          signalId,
          target: { jobId: "job-control" },
          deliveryAttemptId: "attempt-crashed",
          createdAt: new Date(Date.now() - 10 * 60 * 1000),
        }));

        const accepted = await callToolJson(client, "codex_goal_control_reconcile", {
          registryRootDir,
          jobId: "job-control",
        });
        expect(accepted).toMatchObject({
          ok: true,
          report: {
            acceptedCount: 1,
            repairedCount: 0,
          },
        });

        const repaired = await callToolJson(client, "codex_goal_control_reconcile", {
          registryRootDir,
          jobId: "job-control",
          repair: true,
          acceptedStaleAfterMs: 60_000,
        });
        expect(repaired).toMatchObject({
          ok: true,
          report: {
            acceptedCount: 0,
            pendingCount: 1,
            deliverableCount: 1,
            repairedCount: 1,
            repairedSignalIds: [signalId],
          },
        });
      } finally {
        await client.close();
        await server.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("exposes first-class guidance send with safe next-point fallback", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-guidance-mcp-"));
    const registryRootDir = join(root, "registry");
    const jobRootDir = join(root, "job");
    const stateRootDir = join(root, "state");
    const authRootDir = join(root, "auth");
    const workspacePath = join(root, "workspace");
    const promptPath = join(jobRootDir, "prompt.md");

    try {
      await mkdir(jobRootDir, { recursive: true });
      await mkdir(workspacePath, { recursive: true });
      await execFileAsync("git", ["init"], { cwd: workspacePath });
      await writeFile(promptPath, "Do a sandbox task.\n");
      await writeFakeAuth(authRootDir, "account-a", {
        lastRefresh: "2026-06-03T00:00:00.000Z",
      });

      const server = createCodexGoalMcpServer();
      const client = new Client({ name: "subscription-runtime-test", version: "0.0.0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);

      try {
        await callToolJson(client, "codex_goal_create_job", {
          registryRootDir,
          jobId: "job-guidance",
          jobRootDir,
          authRootDir,
          stateRootDir,
          workspacePath,
          promptPath,
          taskId: "sandbox-guidance-task",
          accounts: ["account-a"],
          logPath: join(jobRootDir, "sandbox-guidance-task.log"),
        });

        const sent = await callToolJson(client, "codex_goal_send_guidance", {
          registryRootDir,
          jobId: "job-guidance",
          message: "Stop broad verification and inspect the targeted recall slice.",
          callerKind: "agent",
          callerId: "lead-agent",
          idempotencyKey: "guidance-urgent-001",
        });

        expect(sent).toMatchObject({
          ok: true,
          jobId: "job-guidance",
          taskId: "sandbox-guidance-task",
          status: "accepted_as_next_safe_point",
          signal: {
            idempotencyKey: "guidance-urgent-001",
            intent: "guidance",
            deliveryMode: "interrupt_then_continue",
            createdBy: "agent",
          },
          decision: {
            safeToContinue: true,
            pendingCount: 1,
            deliverableCount: 1,
          },
        });
        expect(JSON.stringify(sent).includes("targeted recall slice")).toBe(false);
      } finally {
        await client.close();
        await server.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("interrupts a locally registered active attempt through first-class guidance", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-guidance-active-mcp-"));
    const registryRootDir = join(root, "registry");
    const jobRootDir = join(root, "job");
    const stateRootDir = join(root, "state");
    const authRootDir = join(root, "auth");
    const workspacePath = join(root, "workspace");
    const promptPath = join(jobRootDir, "prompt.md");
    const taskId = "sandbox-guidance-active-task";
    const activeAttemptRegistry = new InMemoryActiveAttemptRegistry();
    const abortController = new AbortController();

    try {
      await mkdir(jobRootDir, { recursive: true });
      await mkdir(workspacePath, { recursive: true });
      await execFileAsync("git", ["init"], { cwd: workspacePath });
      await writeFile(promptPath, "Do a sandbox task.\n");
      await writeFakeAuth(authRootDir, "account-a", {
        lastRefresh: "2026-06-03T00:00:00.000Z",
      });

      const server = createCodexGoalMcpServer({ activeAttemptRegistry });
      const client = new Client({ name: "subscription-runtime-test", version: "0.0.0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);

      try {
        await callToolJson(client, "codex_goal_create_job", {
          registryRootDir,
          jobId: "job-guidance-active",
          jobRootDir,
          authRootDir,
          stateRootDir,
          workspacePath,
          promptPath,
          taskId,
          accounts: ["account-a"],
          logPath: join(jobRootDir, `${taskId}.log`),
        });
        const lease = activeAttemptRegistry.register({
          taskId,
          attemptNumber: 1,
          provider: "codex",
          workspacePath,
          target: {
            jobId: "job-guidance-active",
            taskId,
            workspaceId: workspacePath,
            attemptId: `${taskId}:attempt-1`,
          },
          startedAt: new Date("2026-06-30T00:00:00.000Z"),
          abortController,
        });

        const sent = await callToolJson(client, "codex_goal_send_guidance", {
          registryRootDir,
          jobId: "job-guidance-active",
          message: "Stop broad verification and inspect the targeted recall slice.",
          callerKind: "agent",
          callerId: "lead-agent",
          idempotencyKey: "guidance-active-001",
        });

        expect(sent).toMatchObject({
          ok: true,
          jobId: "job-guidance-active",
          taskId,
          status: "interrupted",
          signal: {
            idempotencyKey: "guidance-active-001",
            deliveryMode: "interrupt_then_continue",
          },
        });
        const signal = sent.signal as { readonly signalId: string };
        expect(abortController.signal.aborted).toBe(true);
        expect(abortController.signal.reason).toMatchObject({
          code: "runtime_controlled_interrupt",
          signalId: signal.signalId,
          requestedBy: "lead-agent",
        });
        expect(JSON.stringify(sent).includes("targeted recall slice")).toBe(false);
        lease.release();
      } finally {
        await client.close();
        await server.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks overview continuation hints when multiple jobs share one workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-workspace-conflict-"));
    const registryRootDir = join(root, "registry");
    const authRootDir = join(root, "auth");
    const workspacePath = join(root, "workspace");
    const jobRootA = join(root, "job-a");
    const jobRootB = join(root, "job-b");

    try {
      await mkdir(jobRootA, { recursive: true });
      await mkdir(jobRootB, { recursive: true });
      await mkdir(workspacePath, { recursive: true });
      await execFileAsync("git", ["init"], { cwd: workspacePath });
      await writeFile(join(jobRootA, "prompt.md"), "Do sandbox task A.\n");
      await writeFile(join(jobRootB, "prompt.md"), "Do sandbox task B.\n");
      await writeFakeAuth(authRootDir, "account-a", {
        lastRefresh: "2026-06-03T00:00:00.000Z",
      });

      const server = createCodexGoalMcpServer();
      const client = new Client({ name: "subscription-runtime-test", version: "0.0.0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);

      try {
        for (const [jobId, jobRootDir, taskId] of [
          ["job-a", jobRootA, "task-a"],
          ["job-b", jobRootB, "task-b"],
        ] as const) {
          await callToolJson(client, "codex_goal_create_job", {
            registryRootDir,
            jobId,
            jobRootDir,
            authRootDir,
            workspacePath,
            promptPath: join(jobRootDir, "prompt.md"),
            taskId,
            accounts: ["account-a"],
            tmuxSession: `${jobId}-worker`,
          });
        }

        const overview = await callToolJson(client, "codex_goal_overview", {
          registryRootDir,
        });

        expect(overview).toMatchObject({
          ok: true,
          safeToOperate: false,
          summary: {
            workspaceConflicts: 1,
            blockedBySingleWriter: 2,
            safeToContinue: 0,
          },
        });
        expect(overview.workspaceConflicts).toEqual([
          expect.objectContaining({
            workspacePath,
            jobIds: expect.arrayContaining(["job-a", "job-b"]),
            safeToContinueJobIds: expect.arrayContaining(["job-a", "job-b"]),
            reason: "multiple_potential_writers_share_workspace",
          }),
        ]);
        const overviewJobs = overview.jobs as readonly Record<string, unknown>[];
        for (const job of overviewJobs) {
          expect(job).toMatchObject({
            blockedBySingleWriter: true,
            workspaceConflict: true,
            safeToContinue: false,
            nextBestTool: "manual_review",
            nextBestReason: "single_writer_workspace_conflict",
            nextBestCommand: "manual_review_single_writer_workspace_conflict",
          });
          expect((job.commands as Record<string, unknown>).continue).toBeUndefined();
        }

        const decision = await callToolJson(client, "codex_goal_decision", {
          registryRootDir,
          jobId: "job-a",
        });
        const decisionBody = decision.decision as Record<string, unknown>;
        expect(decisionBody).toMatchObject({
          action: "manual_review_single_writer_conflict",
          decision: "manual_review_single_writer_conflict",
          severity: "critical",
          safeToContinue: false,
          safeToOperate: false,
          nextBestTool: "manual_review",
          nextBestReason: "single_writer_workspace_conflict",
          nextBestCommand: "manual_review_single_writer_workspace_conflict",
        });
        expect(decisionBody.blockers).toEqual([
          expect.objectContaining({
            code: "single_writer_workspace_conflict",
            severity: "critical",
          }),
        ]);
        expect(String(JSON.stringify(decisionBody.commands))).not.toContain(
          "codex_goal_continue",
        );

        const filteredOverview = await callToolJson(client, "codex_goal_overview", {
          registryRootDir,
          jobIdPrefix: "job-a",
        });
        expect(filteredOverview).toMatchObject({
          ok: true,
          safeToOperate: true,
          totalJobs: 2,
          matchedJobs: 1,
          returnedJobs: 1,
          summary: {
            workspaceConflicts: 0,
            blockedBySingleWriter: 0,
          },
          workspaceConflicts: [],
        });
        expect((filteredOverview.jobs as readonly Record<string, unknown>[]).map((job) => job.jobId))
          .toEqual(["job-a"]);
        const filteredJob = (filteredOverview.jobs as readonly Record<string, unknown>[])[0];
        expect(filteredJob).not.toHaveProperty("blockedBySingleWriter");
        expect(filteredJob).not.toHaveProperty("workspaceConflict");
      } finally {
        await client.close();
        await server.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not treat reviewed stopped jobs as workspace-conflict writers", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-reviewed-conflict-"));
    const registryRootDir = join(root, "registry");
    const authRootDir = join(root, "auth");
    const workspacePath = join(root, "workspace");
    const jobRootA = join(root, "job-a");
    const jobRootB = join(root, "job-b");

    try {
      await mkdir(jobRootA, { recursive: true });
      await mkdir(jobRootB, { recursive: true });
      await mkdir(workspacePath, { recursive: true });
      await execFileAsync("git", ["init"], { cwd: workspacePath });
      await writeFile(join(jobRootA, "prompt.md"), "Do old sandbox task.\n");
      await writeFile(join(jobRootB, "prompt.md"), "Do active sandbox task.\n");
      await writeFakeAuth(authRootDir, "account-a", {
        lastRefresh: "2026-06-03T00:00:00.000Z",
      });

      const server = createCodexGoalMcpServer();
      const client = new Client({ name: "subscription-runtime-test", version: "0.0.0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);

      try {
        for (const [jobId, jobRootDir, taskId] of [
          ["job-a", jobRootA, "task-a"],
          ["job-b", jobRootB, "task-b"],
        ] as const) {
          await callToolJson(client, "codex_goal_create_job", {
            registryRootDir,
            jobId,
            jobRootDir,
            authRootDir,
            workspacePath,
            promptPath: join(jobRootDir, "prompt.md"),
            taskId,
            accounts: ["account-a"],
            tmuxSession: `${jobId}-worker`,
          });
        }
        await callToolJson(client, "codex_goal_mark_reviewed", {
          registryRootDir,
          jobId: "job-a",
          note: "superseded by job-b",
        });

        const reviewedBrief = await callToolJson(client, "codex_goal_brief", {
          registryRootDir,
          jobId: "job-a",
        });
        expect(reviewedBrief.brief).toMatchObject({
          safeToContinue: false,
          lifecycleMarkerTypes: ["review"],
          nextBestTool: "manual_review",
          nextBestReason: "reviewed_no_result",
        });

        const overview = await callToolJson(client, "codex_goal_overview", {
          registryRootDir,
        });
        expect(overview).toMatchObject({
          ok: true,
          safeToOperate: true,
          summary: {
            workspaceConflicts: 0,
            blockedBySingleWriter: 0,
          },
          workspaceConflicts: [],
        });
      } finally {
        await client.close();
        await server.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("exposes job account tools without requiring manual auth or state paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-mcp-"));
    const registryRootDir = join(root, "registry");
    const jobRootDir = join(root, "job");
    const stateRootDir = join(root, "state");
    const poolRootDir = join(root, "auth-pools");
    const authRootDir = join(poolRootDir, "live-codex-auth");
    const workspacePath = join(root, "workspace");
    const workspacePathB = join(root, "workspace-b");
    const promptPath = join(jobRootDir, "prompt.md");
    const taskId = "sandbox-task";

    try {
      await mkdir(jobRootDir, { recursive: true });
      await mkdir(workspacePath, { recursive: true });
      await mkdir(workspacePathB, { recursive: true });
      await execFileAsync("git", ["init"], { cwd: workspacePath });
      await execFileAsync("git", ["init"], { cwd: workspacePathB });
      await writeFile(promptPath, "Do a sandbox task.\n");
      await writeFakeAuth(authRootDir, "account-a", {
        lastRefresh: "2026-06-01T00:00:00.000Z",
      });
      await writeFakeAuth(authRootDir, "account-b", {
        lastRefresh: "2026-06-02T00:00:00.000Z",
      });

      const capacityStore = new LocalFileWorkerAccountCapacityStore({
        rootDir: join(stateRootDir, "worker-account-capacity"),
      });
      const cooldownUntil = new Date(Date.now() + 60_000);
      for (const accountId of ["account-a", "account-b"]) {
        capacityStore.observe({
          accountId,
          observedAt: new Date(),
          capacity: {
            availability: "cooldown",
            reason: "quota_limited",
            cooldownUntil,
          },
        });
      }

      const server = createCodexGoalMcpServer();
      const client = new Client({ name: "subscription-runtime-test", version: "0.0.0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);

      try {
        await callToolJson(client, "codex_goal_create_job", {
          registryRootDir,
          jobId: "job-a",
          description: "sandbox job",
          jobRootDir,
          authRootDir,
          stateRootDir,
          workspacePath,
          promptPath,
          taskId,
          accounts: ["account-a", "account-b", "account-c"],
          outputPath: join(jobRootDir, `${taskId}.latest-result.json`),
          logPath: join(jobRootDir, `${taskId}.log`),
          model: "gpt-5.5",
          reasoningEffort: "xhigh",
          serviceTier: "fast",
          executionEngine: "app-server-goal",
          taskTimeoutMs: 72 * 60 * 60 * 1000,
          maxAccountCycles: 3,
          requireGitWorkspace: true,
          prewarmOnStart: false,
          tmuxSession: "sandbox-task-worker",
          outputFormat: "json",
        });
        await callToolJson(client, "codex_goal_create_job", {
          registryRootDir,
          jobId: "job-b",
          description: "runtime adapter sandbox job",
          jobRootDir,
          authRootDir,
          stateRootDir,
          workspacePath: workspacePathB,
          promptPath,
          taskId: "sandbox-task-b",
          accounts: ["account-a", "account-b", "account-c"],
          outputPath: join(jobRootDir, "sandbox-task-b.latest-result.json"),
          logPath: join(jobRootDir, "sandbox-task-b.log"),
          model: "gpt-5.5",
          reasoningEffort: "xhigh",
          serviceTier: "fast",
          executionEngine: "app-server",
          taskTimeoutMs: 72 * 60 * 60 * 1000,
          maxAccountCycles: 3,
          requireGitWorkspace: true,
          prewarmOnStart: false,
          tmuxSession: "sandbox-task-worker-b",
          outputFormat: "json",
        });
        await writeFile(
          join(jobRootDir, `${taskId}.pause-request.json`),
          `${JSON.stringify({
            schemaVersion: 1,
            jobId: "job-a",
            taskId,
            requestedAt: "2026-06-29T10:00:00.000Z",
            mode: "soft_pause_only",
            note: "pause after current audit window",
          })}\n`,
        );
        await writeFile(
          join(jobRootDir, `${taskId}.review.json`),
          `${JSON.stringify({
            schemaVersion: 1,
            jobId: "job-a",
            taskId,
            reviewedAt: "2026-06-29T11:00:00.000Z",
            note: "reviewed sandbox state",
            status: { safe: true, token: "access-secret" },
          })}\n`,
        );

        const job = await callToolJson(client, "codex_goal_get_job", {
          registryRootDir,
          jobId: "job-a",
        });
        expect(job.manifest).toMatchObject({
          model: "gpt-5.5",
          reasoningEffort: "xhigh",
          serviceTier: "fast",
          executionEngine: "app-server-goal",
        });

        const brief = await callToolJson(client, "codex_goal_brief", {
          registryRootDir,
          jobId: "job-a",
        });
        const briefBody = brief.brief as Record<string, unknown>;
        expect(briefBody).toMatchObject({
          safeToContinue: false,
          hasAvailableAccount: false,
          availableDedupedAccounts: [],
          lifecycleMarkerTypes: ["review", "pause_request"],
          nextBestTool: "codex_goal_accounts_status",
        });
        expect(briefBody.lifecycleMarkers).toEqual([
          expect.objectContaining({
            type: "review",
            timestamp: "2026-06-29T11:00:00.000Z",
            note: "reviewed sandbox state",
          }),
          expect.objectContaining({
            type: "pause_request",
            timestamp: "2026-06-29T10:00:00.000Z",
            mode: "soft_pause_only",
          }),
        ]);
        expect(String(briefBody.nextBestCommand)).toContain("codex_goal_accounts_status");
        expect(String(briefBody.nextBestCommand)).toContain("job-a");
        expect(String(briefBody.nextBestCommand)).not.toContain("authRootDir");
        expect(JSON.stringify(brief)).not.toContain("access-secret");

        const decision = await callToolJson(client, "codex_goal_decision", {
          registryRootDir,
          jobId: "job-a",
        });
        const decisionBody = decision.decision as Record<string, unknown>;
        expect(decisionBody).toMatchObject({
          action: "fix_accounts",
          decision: "fix_accounts",
          severity: "blocked",
          safeToContinue: false,
          safeToOperate: true,
          nextBestTool: "codex_goal_accounts_status",
          controlSurface: {
            executionEngine: "app-server-goal",
            childWorkerSpawn: "host_control_surface_required",
            hostAuthSurfaces: [
              "github_tokens_not_inherited",
              "codex_auth_root_host_owned",
            ],
          },
        });
        const runtimeDecision = await callToolJson(client, "codex_goal_decision", {
          registryRootDir,
          jobId: "job-b",
        });
        expect(runtimeDecision.decision).toMatchObject({
          controlSurface: {
            executionEngine: "app-server",
            childWorkerSpawn: "runtime_adapter_owned",
            hostAuthSurfaces: ["provider_environment_policy_applies"],
          },
        });

        expect(decisionBody.blockers).toEqual([
          expect.objectContaining({
            code: "no_available_accounts",
            severity: "blocked",
          }),
        ]);
        expect(String(JSON.stringify(decisionBody.commands))).toContain(
          "codex_goal_accounts_status",
        );
        expect(String(JSON.stringify(decisionBody.commands))).toContain(
          "codex_goal_accounts_relogin_instructions",
        );
        expect(String(JSON.stringify(decision))).not.toContain("access-secret");

        const overview = await callToolJson(client, "codex_goal_overview", {
          registryRootDir,
        });
        expect(overview).toMatchObject({
          ok: true,
          registryRootDir,
          totalJobs: 2,
          returnedJobs: 2,
          summary: {
            running: 0,
            safeToContinue: 0,
            needsHumanRelogin: 2,
          },
        });
        const overviewJobs = overview.jobs as readonly Record<string, unknown>[];
        const overviewJobA = overviewJobs.find((job) => job.jobId === "job-a");
        expect(overviewJobA).toMatchObject({
          ok: true,
          jobId: "job-a",
          workerAlive: false,
          recommendedAction: "review_completed",
          hasAvailableAccount: false,
          lifecycleMarkerTypes: ["review", "pause_request"],
          nextBestTool: "codex_goal_accounts_status",
          activeWriterRisk: "none",
          baseRevisionStatus: "unknown",
          statusView: expect.objectContaining({
            activeWriterRisk: "none",
            safeToContinue: true,
          }),
        });
        expect(overviewJobA?.lifecycleMarkers).toEqual([
          expect.objectContaining({ type: "review" }),
          expect.objectContaining({ type: "pause_request" }),
        ]);
        expect(String((overviewJobA?.commands as Record<string, unknown>).brief))
          .toContain("registryRootDir");
        expect(JSON.stringify(overview)).not.toContain("refresh-secret");
        expect(JSON.stringify(overview)).not.toContain("access-secret");

        const handoff = await callToolJson(client, "codex_goal_handoff", {
          registryRootDir,
          jobId: "job-a",
        });
        const handoffBody = handoff.handoff as Record<string, unknown>;
        expect(String(handoffBody.text)).toContain("Codex goal handoff: job-a");
        expect(String(handoffBody.text)).toContain("subscription-runtime-codex-goal tool codex_goal_brief");
        expect(String(handoffBody.text)).toContain("Do not run two writer workers");
        expect(String(handoffBody.text)).toContain("childWorkerSpawn: host_control_surface_required");
        expect(String(handoffBody.text)).toContain("github_tokens_not_inherited");
        expect(String(handoffBody.text)).toContain("lifecycleMarkers: review, pause_request");
        expect(String(handoffBody.text)).not.toContain("refresh-secret");
        expect(String(handoffBody.text)).not.toContain("access-secret");
        expect(String(handoffBody.text)).not.toContain("secret@example.com");
        expect(handoffBody.controlSurface).toMatchObject({
          executionEngine: "app-server-goal",
          childWorkerSpawn: "host_control_surface_required",
        });
        expect(handoffBody.summary).toMatchObject({
          jobId: "job-a",
          registryRootDir,
          safeToContinue: false,
          hasAvailableAccount: false,
          lifecycleMarkerTypes: ["review", "pause_request"],
        });

        const stop = await callToolJson(client, "codex_goal_stop", {
          registryRootDir,
          jobId: "job-a",
          confirmStop: true,
        });
        expect(stop).toMatchObject({
          ok: false,
          reason: "worker_not_running",
          jobId: "job-a",
          tmuxSession: "sandbox-task-worker",
        });
        expect(String(stop.stopCommand)).toContain("tmux kill-session -t sandbox-task-worker");

        await writeFile(
          join(jobRootDir, `${taskId}.stop-event.json`),
          `${JSON.stringify({
            schemaVersion: 1,
            jobId: "job-a",
            taskId,
            stoppedAt: "2026-06-29T12:00:00.000Z",
            reason: "heartbeat_only_no_output",
            forceStop: false,
          })}\n`,
        );
        const stoppedDecision = await callToolJson(client, "codex_goal_decision", {
          registryRootDir,
          jobId: "job-a",
        });
        const stoppedDecisionBody = stoppedDecision.decision as Record<string, unknown>;
        expect(stoppedDecisionBody).toMatchObject({
          action: "manual_review_stopped_worker",
          decision: "manual_review_stopped_worker",
          severity: "blocked",
          safeToContinue: false,
          safeToOperate: true,
          nextBestTool: "codex_goal_reconcile_result",
          nextBestReason: "missing_runtime_result",
        });
        expect(stoppedDecisionBody.blockers).toEqual([
          expect.objectContaining({
            code: "stopped_worker_requires_review",
            severity: "blocked",
          }),
        ]);

        const status = await callToolJson(client, "codex_goal_accounts_status", {
          registryRootDir,
          jobId: "job-a",
        });
        expect(status).toMatchObject({
          ok: false,
          registryRootDir,
          jobId: "job-a",
          authRootDir,
          stateRootDir,
          capacityAware: true,
          count: 3,
          available: 0,
          hasAvailableAccount: false,
          summary: {
            configured: 3,
            availableDeduped: 0,
            capacityBlocked: 2,
          },
          availableDedupedAccountNames: [],
        });
        expect(
          (status.slots as readonly { readonly name: string }[]).map((slot) => slot.name),
        ).toEqual(["account-a", "account-b", "account-c"]);
        expect(
          (status.accounts as readonly { readonly name: string }[]).map((slot) => slot.name),
        ).toEqual(["account-a", "account-b", "account-c"]);
        expect(JSON.stringify(status)).not.toContain("refresh-secret");
        expect(JSON.stringify(status)).not.toContain("access-secret");
        expect(JSON.stringify(status)).not.toContain("secret@example.com");

        const pools = await callToolJson(client, "codex_goal_accounts_list_pools", {
          registryRootDir,
          jobId: "job-a",
        });
        expect(pools).toMatchObject({
          ok: true,
          registryRootDir,
          jobId: "job-a",
          poolRootDir,
          selectedAuthRootDir: authRootDir,
          stateRootDir,
          capacityAware: true,
        });
        expect(pools.pools).toEqual([
          expect.objectContaining({
            pool: "live-codex-auth",
            authRootDir,
            availableCount: 0,
            availableDedupedAccountNames: [],
          }),
        ]);

        const relogin = await callToolJson(
          client,
          "codex_goal_accounts_relogin_instructions",
          {
            registryRootDir,
            jobId: "job-a",
          },
        );
        expect(relogin).toMatchObject({
          ok: true,
          registryRootDir,
          jobId: "job-a",
          authRootDir,
          stateRootDir,
          targetAccounts: ["account-c"],
        });
        const instructionsByAccount = relogin.instructionsByAccount as
          Record<string, readonly string[]>;
        expect(instructionsByAccount["account-c"]).toContainEqual(
          expect.stringContaining("CODEX_HOME="),
        );
        expect(instructionsByAccount["account-c"]).toContainEqual(
          expect.stringContaining("codex_goal_accounts_status"),
        );

        const rawRelogin = await callToolJson(
          client,
          "codex_accounts_relogin_instructions",
          {
            authRootDir,
            account: "account-c",
          },
        );
        expect(rawRelogin.instructions).toContainEqual(
          expect.stringContaining("codex_accounts_status"),
        );
        expect(rawRelogin.instructions).not.toContainEqual(
          expect.stringContaining("codex_goal_accounts_status"),
        );

        const codexFail = join(root, "codex-fail.sh");
        await writeFile(codexFail, "#!/bin/sh\necho 'secret@example.com' >&2\nexit 1\n");
        await chmod(codexFail, 0o700);
        const liveStatus = await callToolJson(client, "codex_accounts_status", {
          authRootDir,
          accounts: ["account-a"],
          liveCheck: true,
          codexBinaryPath: codexFail,
          liveCheckTimeoutMs: 10_000,
        });
        expect(liveStatus).toMatchObject({
          ok: false,
          liveCheck: true,
          availableDedupedAccountNames: [],
        });
        expect(liveStatus.slots).toEqual([
          expect.objectContaining({
            name: "account-a",
            status: "auth_invalid",
            liveCheck: "failed",
            liveCheckSafeMessage: "codex login status failed",
          }),
        ]);
        expect(JSON.stringify(liveStatus)).not.toContain("secret@example.com");
      } finally {
        await client.close();
        await server.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function removeStoredTmuxSession(
  registryRootDir: string,
  jobId: string,
): Promise<void> {
  const manifestPath = join(registryRootDir, jobId, "job.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  delete manifest.tmuxSession;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function readProjectControlAudit(
  jobRootDir: string,
  taskId: string,
): Promise<readonly Record<string, unknown>[]> {
  const text = await readFile(
    join(jobRootDir, `${taskId}.project-control-events.jsonl`),
    "utf8",
  );
  return text.trim().split("\n").map((line) =>
    JSON.parse(line) as Record<string, unknown>
  );
}

function auditDecision(event: Record<string, unknown>): Record<string, unknown> {
  const decision = event.decision;
  return decision && typeof decision === "object" && !Array.isArray(decision)
    ? decision as Record<string, unknown>
    : {};
}

function policyAuditDecisions(
  events: readonly Record<string, unknown>[],
): readonly Record<string, unknown>[] {
  return events
    .filter((event) => event.type === ProjectControlAuditEventType.DecisionRecorded)
    .map((event) => auditDecision(event));
}

async function gitInitRepository(cwd: string): Promise<void> {
  await git(cwd, ["init"]);
  await git(cwd, ["config", "user.email", "test@example.com"]);
  await git(cwd, ["config", "user.name", "Test User"]);
  await git(cwd, ["checkout", "-b", "main"]);
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync("git", [...args], { cwd });
}

async function gitStdout(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync("git", [...args], { cwd });
  return result.stdout;
}

async function callToolJson(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name, arguments: args });
  const content = (result as { readonly content?: readonly unknown[] }).content;
  const first = content?.[0] as
    | { readonly type?: string; readonly text?: string }
    | undefined;
  if (first?.type !== "text") throw new Error("expected text MCP response");
  return JSON.parse(first.text ?? "{}") as Record<string, unknown>;
}

type TmuxExec = (args: readonly string[]) => Promise<void>;

async function hasTmux(execTmux: TmuxExec = execTmuxCommand): Promise<boolean> {
  const session = `subscription-runtime-tmux-probe-${process.pid}-${Date.now()}`;
  try {
    await execTmux(["-V"]);
    await execTmux(["new-session", "-d", "-s", session, "sleep 60"]);
    return true;
  } catch {
    return false;
  } finally {
    try {
      await execTmux(["kill-session", "-t", session]);
    } catch {
      // Cleanup is best-effort: restricted CI may deny tmux session operations.
    }
  }
}

async function execTmuxCommand(args: readonly string[]): Promise<void> {
  await execFileAsync("tmux", [...args], { timeout: 2_000 });
}

async function writeFakeAuth(
  authRootDir: string,
  account: string,
  options: { readonly lastRefresh: string },
) {
  const accountDir = join(authRootDir, account);
  await mkdir(accountDir, { recursive: true });
  await writeFile(
    join(accountDir, "auth.json"),
    `${JSON.stringify({
      auth_mode: "chatgpt",
      last_refresh: options.lastRefresh,
      tokens: {
        refresh_token: "refresh-secret",
        access_token: "access-secret",
        id_token: fakeJwt({
          email: "secret@example.com",
          sub: "oauth-sub-secret",
          "https://api.openai.com/auth": {
            chatgpt_account_id: "chatgpt-account-secret",
            chatgpt_user_id: "chatgpt-user-secret",
          },
        }),
        expiry: Math.floor(Date.now() / 1000) + 3600,
      },
    })}\n`,
  );
}

async function writeClaudeRunArtifacts(input: {
  readonly rootDir: string;
  readonly runId: string;
  readonly providerInstanceId: string;
  readonly workerId: string;
  readonly configDir: string;
  readonly workspacePath: string;
}): Promise<void> {
  const now = "2026-06-30T00:00:00.000Z";
  const runDir = join(input.rootDir, hashRunId(input.runId));
  await mkdir(runDir, { recursive: true });
  await writeFile(
    join(runDir, "manifest.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      providerKind: "claude",
      runId: input.runId,
      createdAt: now,
      updatedAt: now,
      providerInstanceId: input.providerInstanceId,
      workerId: input.workerId,
      configDir: input.configDir,
      workspacePath: input.workspacePath,
    }, null, 2)}\n`,
  );
  await writeFile(
    join(runDir, "progress.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      runId: input.runId,
      status: "completed",
      updatedAt: now,
      pid: process.pid,
      providerRunId: "provider-run-a",
      providerSessionId: "provider-session-a",
    }, null, 2)}\n`,
  );
  await writeFile(
    join(runDir, "result.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      runId: input.runId,
      status: "completed",
      updatedAt: now,
      outputTextPreview: "completed with redacted output",
      telemetry: {
        providerRunId: "provider-run-a",
        providerSessionId: "provider-session-a",
      },
    }, null, 2)}\n`,
  );
  await writeFile(
    join(runDir, "run.log"),
    `${JSON.stringify({
      occurredAt: now,
      event: "run.completed",
      providerRunId: "provider-run-a",
      providerSessionId: "provider-session-a",
    })}\n`,
  );
}

function hashRunId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function fakeJwt(claims: Readonly<Record<string, unknown>>): string {
  return [
    base64UrlJson({ alg: "none", typ: "JWT" }),
    base64UrlJson(claims),
    "",
  ].join(".");
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8")
    .toString("base64url");
}

function workerControlReceipt(input: {
  readonly signalId: string;
  readonly target: { readonly jobId: string };
  readonly deliveryAttemptId: string;
  readonly createdAt: Date;
}): WorkerControlDeliveryReceipt {
  return {
    schemaVersion: 1,
    receiptId: `${input.deliveryAttemptId}-receipt`,
    signalId: input.signalId,
    target: input.target,
    state: "accepted",
    createdAt: input.createdAt,
    deliveryAttemptId: input.deliveryAttemptId,
    metadata: {},
  };
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}
