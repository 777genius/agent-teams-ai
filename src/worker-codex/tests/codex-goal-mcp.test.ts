import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
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
import {
  auditDecision,
  callToolJson,
  git,
  gitInitRepository,
  gitStdout,
  hasTmux,
  policyAuditDecisions,
  readProjectControlAudit,
  removeStoredTmuxSession,
  workerControlReceipt,
  writeClaudeRunArtifacts,
  writeFakeAuth,
} from "./codex-goal-mcp-test-support";

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

  it("advertises codexGoalObjective max length in job tool schemas", async () => {
    const server = createCodexGoalMcpServer();
    const client = new Client({
      name: "codex-goal-mcp-test",
      version: "0.0.0",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    try {
      const tools = await client.listTools();
      const createJobTool = (tools.tools ?? []).find(
        (tool) => tool.name === "codex_goal_create_job",
      );
      const objectiveSchema = (
        createJobTool?.inputSchema.properties as Record<string, unknown>
      )?.codexGoalObjective as
        | { readonly maxLength?: number; readonly description?: string }
        | undefined;

      expect(objectiveSchema).toMatchObject({
        maxLength: 4000,
        description: expect.stringContaining("max 4000 characters"),
      });
    } finally {
      await client.close();
      await server.close();
    }
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
          availability: "available",
          schedulerEligible: true,
          recommendedAction: "none",
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
          availability: "available",
          schedulerEligible: true,
          recommendedAction: "none",
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
          availability: "available",
          schedulerEligible: true,
          recommendedAction: "none",
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

  it("keeps a healthy app-server runner alive during quiet reasoning", async () => {
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
          appServerProcessAlive: true,
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
          availability: "available",
          schedulerEligible: true,
          recommendedAction: "none",
          warnings: [],
          safeMessage: "account-a is ready",
        }],
        staleAfterMs: 600_000,
        tailLines: 20,
      });

      expect(brief).toMatchObject({
        isStale: false,
        silentStale: false,
        heartbeatOnlyNoOutput: false,
        safeToContinue: false,
        nextBestTool: "codex_goal_brief",
        nextBestReason: "worker is already running",
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

  it("persists app-server startup timeout through MCP job creation", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-mcp-startup-timeout-"));
    const registryRootDir = join(root, "registry");
    const jobRootDir = join(root, "job");
    const workspacePath = join(root, "workspace");
    const promptPath = join(jobRootDir, "prompt.md");
    const server = createCodexGoalMcpServer();
    const client = new Client({
      name: "subscription-runtime-test",
      version: "0.0.0",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await mkdir(jobRootDir, { recursive: true });
      await mkdir(workspacePath, { recursive: true });
      await writeFile(promptPath, "Do a sandbox task.\n");
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);

      const created = await callToolJson(client, "codex_goal_create_job", {
        registryRootDir,
        jobId: "job-startup-timeout",
        jobRootDir,
        authRootDir: join(root, "auth"),
        workspacePath,
        promptPath,
        taskId: "task-startup-timeout",
        accounts: ["account-a"],
        appServerStartupTimeoutMs: 45_000,
      });

      expect(created).toMatchObject({ ok: true });

      const job = await callToolJson(client, "codex_goal_get_job", {
        registryRootDir,
        jobId: "job-startup-timeout",
      });

      expect(job).toMatchObject({
        ok: true,
        manifest: {
          appServerStartupTimeoutMs: 45_000,
        },
      });

      const dryRun = await callToolJson(client, "codex_goal_dry_run", {
        jobRootDir,
        authRootDir: join(root, "auth"),
        workspacePath,
        promptPath,
        taskId: "task-startup-timeout",
        accounts: ["account-a"],
        appServerStartupTimeoutMs: 45_000,
      });

      expect(dryRun).toMatchObject({
        ok: true,
        summary: {
          appServerStartupTimeoutMs: 45_000,
        },
      });
      expect(String(dryRun.noTmuxCommand)).toContain(
        "--app-server-startup-timeout-ms",
      );

      const invalidConfigPath = join(root, "invalid-startup-timeout.json");
      await writeFile(invalidConfigPath, `${JSON.stringify({
        jobRootDir,
        authRootDir: join(root, "auth"),
        workspacePath,
        promptPath,
        taskId: "task-invalid-startup-timeout",
        accounts: ["account-a"],
        appServerStartupTimeoutMs: 0,
      })}\n`);
      const invalid = await callToolJson(client, "codex_goal_dry_run", {
        configPath: invalidConfigPath,
      });

      expect(invalid).toMatchObject({
        ok: false,
        error: "appServerStartupTimeoutMs must be a positive integer",
      });
    } finally {
      await client.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
