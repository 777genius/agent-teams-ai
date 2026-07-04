import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import {
  LocalFileWorkerAccountCapacityStore,
  LocalFileWorkerControlInboxStore,
} from "@vioxen/subscription-runtime/store-local-file";
import {
  InMemoryActiveAttemptRegistry,
  type WorkerControlDeliveryReceipt,
} from "@vioxen/subscription-runtime/worker-core";
import {
  buildCodexGoalBrief,
  createCodexGoalMcpServer,
} from "../codex-goal-mcp";

const execFileAsync = promisify(execFile);

describe("codex goal MCP server", () => {
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
