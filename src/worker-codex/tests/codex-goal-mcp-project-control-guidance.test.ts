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
});
