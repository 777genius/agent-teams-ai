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

describe("codex goal MCP project-control server", () => {
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
        status: "running",
        liveness: "alive",
        process: {
          supervisor: "direct",
          alive: true,
          aliveReason: "pid",
          pid: process.pid,
        },
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
});
