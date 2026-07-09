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
