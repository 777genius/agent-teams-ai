import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  LocalFileWorkerAccountCapacityStore,
  LocalFileWorkerControlInboxStore,
  LocalFileRunObservationHistoryStore,
} from "@vioxen/subscription-runtime/store-local-file";
import {
  RunObservationService,
  RunProcessAliveReason,
  WorkerControlService,
} from "@vioxen/subscription-runtime/worker-core";
import { createCodexGoalJob, type CodexGoalJobManifestInput } from "../codex-goal-jobs";
import { CodexRunObservationAdapter } from "../codex-run-observation";

const execFileAsync = promisify(execFile);

describe("CodexRunObservationAdapter", () => {
  it("normalizes stored Codex goal sources into a read-only run snapshot", async () => {
    const fixture = await createObservationFixture();
    const cooldownUntil = new Date(Date.now() + 60_000);
    new LocalFileWorkerAccountCapacityStore({
      rootDir: join(fixture.root, "state", "worker-account-capacity"),
    }).observe({
      accountId: "account-a",
      observedAt: new Date(),
      capacity: {
        availability: "cooldown",
        reason: "quota_limited",
        cooldownUntil,
      },
    });

    try {
      await writeFile(fixture.manifest.outputPath!, `${JSON.stringify({
        status: "partial",
        reason: "quota_limited",
        task: { updatedAt: "2026-06-30T00:00:00.000Z" },
      })}\n`);
      await writeFile(fixture.manifest.progressPath!, `${JSON.stringify({
        schemaVersion: 1,
        taskId: fixture.manifest.taskId,
        status: "running",
        updatedAt: new Date().toISOString(),
        pid: 12345,
        attemptCount: 2,
        currentAccount: "account-a",
      })}\n`);
      await writeFile(
        fixture.manifest.logPath!,
        [
          "$ npm test",
          "Authorization: Bearer rawBearerSecret",
          "python script.py token=raw-secret",
        ].join("\n"),
      );
      await writeFile(join(fixture.manifest.workspacePath, "changed.txt"), "dirty\n");

      const service = new RunObservationService(new CodexRunObservationAdapter({
        registryRootDir: fixture.registryRootDir,
        staleAfterMs: 600_000,
      }), {
        clock: { now: () => new Date("2026-06-30T00:01:00.000Z") },
      });
      const [snapshot] = await service.observeRuns({
        includeChangedFiles: true,
        includeLogTail: true,
        tailLines: 10,
      });

      expect(snapshot).toMatchObject({
        runId: "job-a",
        providerKind: "codex",
        status: "running",
        workspace: {
          dirty: true,
          changedFilesCount: 1,
        },
        process: {
          pid: 12345,
        },
        progress: {
          status: "running",
          attemptCount: 2,
          currentAccount: "account-a",
        },
        result: {
          exists: true,
          status: "partial",
          reason: "quota_limited",
        },
        capacity: [{
          account: "account-a",
          availability: "cooldown",
          reason: "quota_limited",
          cooldownUntil: cooldownUntil.toISOString(),
        }],
        readOnlyDecision: {
          kind: "capacity_blocked",
          reason: "account_or_capacity_unavailable",
        },
      });
      expect(snapshot?.workspace?.changedFiles).toEqual(["changed.txt"]);
      expect(snapshot?.logs?.tail).toContain("npm test");
      expect(JSON.stringify(snapshot).includes("rawBearerSecret")).toBe(false);
      expect(JSON.stringify(snapshot).includes("raw-secret")).toBe(false);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("surfaces strict done results without prescribing control actions", async () => {
    const fixture = await createObservationFixture();

    try {
      await writeFile(fixture.manifest.outputPath!, `${JSON.stringify({
        status: "done",
        changedFiles: [],
        evidence: ["sandbox completion"],
        blockers: [],
        nextAction: "review_completed",
      })}\n`);

      const snapshot = await new RunObservationService(new CodexRunObservationAdapter({
        registryRootDir: fixture.registryRootDir,
      })).observeRun({ runId: "job-a" });

      expect(snapshot).toMatchObject({
        runId: "job-a",
        status: "completed",
        classification: "productive",
        recommendedAction: "review_completed",
        readOnlyDecision: {
          kind: "review_completed",
        },
      });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("surfaces control inbox summaries without leaking signal bodies", async () => {
    const fixture = await createObservationFixture();
    const control = new WorkerControlService({
      store: new LocalFileWorkerControlInboxStore({
        rootDir: fixture.manifest.stateRootDir!,
      }),
    });

    try {
      await control.enqueueSignal({
        target: {
          jobId: fixture.manifest.jobId,
          taskId: fixture.manifest.taskId,
          workspaceId: fixture.manifest.workspacePath,
        },
        intent: "guidance",
        body: "Apply safe review guidance without leaking secret-guidance-token.",
        createdBy: "operator",
        createdAt: new Date("2026-06-30T00:00:10.000Z"),
      });

      const snapshot = await new RunObservationService(new CodexRunObservationAdapter({
        registryRootDir: fixture.registryRootDir,
      })).observeRun({ runId: "job-a" });

      expect(snapshot.controlInbox).toMatchObject({
        pendingCount: 1,
        acceptedCount: 0,
        deliverableCount: 1,
        deliveredCount: 0,
        failedCount: 0,
        blockedDeliveryCount: 0,
        safeToContinue: true,
        latestSignalAt: "2026-06-30T00:00:10.000Z",
      });
      expect(JSON.stringify(snapshot).includes("secret-guidance-token")).toBe(false);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("requires manual review when a tmux-backed run is dead without a result", async () => {
    const fixture = await createObservationFixture({
      tmuxSession: `missing-session-${process.pid}-${Date.now()}`,
    });

    try {
      const snapshot = await new RunObservationService(new CodexRunObservationAdapter({
        registryRootDir: fixture.registryRootDir,
      })).observeRun({ runId: "job-a" });

      expect(snapshot).toMatchObject({
        status: "stopped",
        liveness: "dead",
        result: {
          exists: false,
        },
        readOnlyDecision: {
          kind: "manual_review_required",
          reason: "stopped_without_terminal_result",
        },
      });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("keeps watching a fresh direct progress attempt even when an older failed result exists", async () => {
    const fixture = await createObservationFixture();

    try {
      await writeFile(fixture.manifest.outputPath!, `${JSON.stringify({
        status: "failed",
        reason: "previous_attempt_failed",
      })}\n`);
      await writeFile(fixture.manifest.progressPath!, `${JSON.stringify({
        schemaVersion: 1,
        taskId: fixture.manifest.taskId,
        status: "running",
        updatedAt: new Date().toISOString(),
      })}\n`);

      const snapshot = await new RunObservationService(new CodexRunObservationAdapter({
        registryRootDir: fixture.registryRootDir,
        staleAfterMs: 600_000,
      })).observeRun({ runId: "job-a" });

      expect(snapshot).toMatchObject({
        status: "running",
        liveness: "alive",
        process: {
          alive: true,
          aliveReason: RunProcessAliveReason.FreshProgress,
        },
        result: {
          exists: true,
          status: "failed",
          reason: "previous_attempt_failed",
        },
        readOnlyDecision: {
          kind: "keep_watching",
        },
      });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("flags a terminal result that still has live direct progress as an unsafe mismatch", async () => {
    const fixture = await createObservationFixture();

    try {
      await writeFile(fixture.manifest.outputPath!, `${JSON.stringify({
        status: "completed",
        task: { updatedAt: new Date().toISOString() },
      })}\n`);
      await writeFile(fixture.manifest.progressPath!, `${JSON.stringify({
        schemaVersion: 1,
        taskId: fixture.manifest.taskId,
        status: "running",
        updatedAt: new Date().toISOString(),
        pid: process.pid,
      })}\n`);

      const snapshot = await new RunObservationService(new CodexRunObservationAdapter({
        registryRootDir: fixture.registryRootDir,
        staleAfterMs: 600_000,
      })).observeRun({ runId: "job-a" });

      expect(snapshot).toMatchObject({
        status: "completed",
        liveness: "alive",
        process: {
          alive: true,
          aliveReason: RunProcessAliveReason.Pid,
          pid: process.pid,
        },
        readOnlyDecision: {
          kind: "unsafe_state_mismatch",
          reason: "completed_result_with_live_process",
        },
      });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("surfaces invalid progress and missing workspace warnings read-only", async () => {
    const fixture = await createObservationFixture();

    try {
      await writeFile(fixture.manifest.progressPath!, "{not-json\n");
      await rm(fixture.manifest.workspacePath, { recursive: true, force: true });

      const snapshot = await new RunObservationService(new CodexRunObservationAdapter({
        registryRootDir: fixture.registryRootDir,
      })).observeRun({ runId: "job-a" });

      expect(snapshot.progress).toMatchObject({
        staleAfterMs: 600_000,
        stale: false,
        silentStale: false,
      });
      expect(snapshot.warnings.map((warning) => warning.code)).toContain(
        "codex_status_warning",
      );
      expect(snapshot.workspace).toMatchObject({
        exists: false,
        dirty: false,
        changedFilesCount: 0,
      });
      expect(snapshot.warnings.map((warning) => warning.message).join("\n"))
        .toContain("progress file is unreadable");
      expect(snapshot.warnings.map((warning) => warning.message).join("\n"))
        .toContain("workspace_missing");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("surfaces stale stdout while a sandbox tmux worker is alive", async () => {
    if (!(await hasTmux())) return;
    const tmuxSession = `subscription-runtime-watch-${process.pid}-${Date.now()}`;
    const fixture = await createObservationFixture({ tmuxSession });

    try {
      await execFileAsync("tmux", [
        "new-session",
        "-d",
        "-s",
        tmuxSession,
        "-c",
        fixture.root,
        "sleep 300",
      ]);
      await writeFile(fixture.manifest.logPath!, "old output\n");
      const staleTime = new Date(Date.now() - 120_000);
      await utimes(fixture.manifest.logPath!, staleTime, staleTime);
      await writeFile(fixture.manifest.progressPath!, `${JSON.stringify({
        schemaVersion: 1,
        taskId: fixture.manifest.taskId,
        status: "running",
        updatedAt: new Date(Date.now() - 130_000).toISOString(),
        pid: 12345,
      })}\n`);

      const snapshot = await new RunObservationService(new CodexRunObservationAdapter({
        registryRootDir: fixture.registryRootDir,
        staleAfterMs: 1_000,
      })).observeRun({
        runId: "job-a",
        includeLogTail: true,
        tailLines: 5,
      });

      expect(snapshot).toMatchObject({
        status: "running",
        liveness: "stale",
        classification: "stale_no_progress",
        recommendedAction: "recover",
        progress: {
          status: "running",
          stale: true,
          silentStale: true,
        },
        logs: {
          staleAfterMs: 1_000,
          stale: true,
        },
        readOnlyDecision: {
          kind: "stale_needs_inspection",
        },
      });
      expect(snapshot.warnings.map((warning) => warning.code)).toContain(
        "log_stale_while_worker_alive",
      );
    } finally {
      await execFileAsync("tmux", ["kill-session", "-t", tmuxSession])
        .catch(() => undefined);
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("keeps fresh-heartbeat workers alive when only stdout is stale", async () => {
    if (!(await hasTmux())) return;
    const tmuxSession = `subscription-runtime-fresh-heartbeat-${process.pid}-${Date.now()}`;
    const fixture = await createObservationFixture({ tmuxSession });

    try {
      await execFileAsync("tmux", [
        "new-session",
        "-d",
        "-s",
        tmuxSession,
        "-c",
        fixture.root,
        "sleep 300",
      ]);
      await writeFile(fixture.manifest.logPath!, "old output\n");
      const staleTime = new Date(Date.now() - 120_000);
      await utimes(fixture.manifest.logPath!, staleTime, staleTime);
      await writeFile(fixture.manifest.progressPath!, `${JSON.stringify({
        schemaVersion: 1,
        taskId: fixture.manifest.taskId,
        status: "running",
        updatedAt: new Date().toISOString(),
        pid: process.pid,
      })}\n`);

      const snapshot = await new RunObservationService(new CodexRunObservationAdapter({
        registryRootDir: fixture.registryRootDir,
        staleAfterMs: 1_000,
      })).observeRun({
        runId: "job-a",
        includeLogTail: true,
        tailLines: 5,
      });

      expect(snapshot).toMatchObject({
        status: "running",
        liveness: "alive",
        progress: {
          status: "running",
          stale: false,
          silentStale: false,
        },
        logs: {
          staleAfterMs: 1_000,
          stale: true,
        },
      });
      expect(snapshot.recommendedAction).not.toBe("recover");
      expect(snapshot.readOnlyDecision.kind).not.toBe("stale_needs_inspection");
      expect(snapshot.warnings.map((warning) => warning.code)).toContain(
        "log_stale_while_worker_alive",
      );
    } finally {
      await execFileAsync("tmux", ["kill-session", "-t", tmuxSession])
        .catch(() => undefined);
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("flags heartbeat-only workers without result, log output or workspace changes", async () => {
    if (!(await hasTmux())) return;
    const tmuxSession = `subscription-runtime-heartbeat-only-${process.pid}-${Date.now()}`;
    const fixture = await createObservationFixture({ tmuxSession });

    try {
      await execFileAsync("tmux", [
        "new-session",
        "-d",
        "-s",
        tmuxSession,
        "-c",
        fixture.root,
        "sleep 300",
      ]);
      await writeFile(fixture.manifest.progressPath!, `${JSON.stringify({
        schemaVersion: 1,
        taskId: fixture.manifest.taskId,
        status: "running",
        updatedAt: new Date(Date.now() - 130_000).toISOString(),
        pid: 12345,
      })}\n`);

      const snapshot = await new RunObservationService(new CodexRunObservationAdapter({
        registryRootDir: fixture.registryRootDir,
        staleAfterMs: 600_000,
      })).observeRun({
        runId: "job-a",
        includeLogTail: true,
      });

      expect(snapshot).toMatchObject({
        status: "running",
        liveness: "alive",
        classification: "stale_no_progress",
        recommendedAction: "recover",
        progress: {
          status: "running",
          stale: false,
          heartbeatOnlyNoOutput: true,
        },
        result: {
          exists: false,
        },
        logs: {
          exists: false,
        },
        readOnlyDecision: {
          kind: "stale_needs_inspection",
          reason: "heartbeat_only_no_output",
        },
      });
      expect(snapshot.warnings.map((warning) => warning.code)).toContain(
        "heartbeat_only_no_output",
      );
    } finally {
      await execFileAsync("tmux", ["kill-session", "-t", tmuxSession])
        .catch(() => undefined);
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("classifies log growth between observations as productive", async () => {
    const fixture = await createObservationFixture();
    const historyStore = new LocalFileRunObservationHistoryStore({
      rootDir: join(fixture.root, "history"),
    });

    try {
      await writeFile(fixture.manifest.logPath!, "first line\n");
      const service = new RunObservationService(new CodexRunObservationAdapter({
        registryRootDir: fixture.registryRootDir,
        historyStore,
      }));

      const first = await service.observeRun({
        runId: "job-a",
        includeLogTail: true,
      });
      await writeFile(fixture.manifest.logPath!, "first line\nsecond line\n");
      const second = await service.observeRun({
        runId: "job-a",
        includeLogTail: true,
      });

      expect(first.classification).not.toBe("productive");
      expect(second).toMatchObject({
        classification: "productive",
        recommendedAction: "wait",
        logs: {
          byteLength: "first line\nsecond line\n".length,
        },
      });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});

async function createObservationFixture(options: {
  readonly tmuxSession?: string;
} = {}): Promise<{
  readonly root: string;
  readonly registryRootDir: string;
  readonly manifest: CodexGoalJobManifestInput;
}> {
  const root = await mkdtemp(join(tmpdir(), "subscription-runtime-observe-"));
  const registryRootDir = join(root, "registry");
  const jobRootDir = join(root, "job");
  const authRootDir = join(root, "auth");
  const workspacePath = join(root, "workspace");
  await mkdir(join(authRootDir, "account-a"), { recursive: true });
  await mkdir(jobRootDir, { recursive: true });
  await mkdir(workspacePath, { recursive: true });
  await execFileAsync("git", ["init"], { cwd: workspacePath });
  await writeFile(join(jobRootDir, "prompt.md"), "Observe this sandbox job.\n");
  await writeFile(
    join(authRootDir, "account-a", "auth.json"),
    `${JSON.stringify({
      auth_mode: "chatgpt",
      last_refresh: new Date().toISOString(),
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
  const manifest: CodexGoalJobManifestInput = {
    jobId: "job-a",
    description: "sandbox observation job",
    jobRootDir,
    authRootDir,
    stateRootDir: join(root, "state"),
    workspacePath,
    promptPath: join(jobRootDir, "prompt.md"),
    taskId: "task-a",
    accounts: ["account-a"],
    outputPath: join(jobRootDir, "task-a.latest-result.json"),
    progressPath: join(jobRootDir, "task-a.progress.json"),
    logPath: join(jobRootDir, "task-a.log"),
    cwd: root,
    requireGitWorkspace: true,
    ...(options.tmuxSession ? { tmuxSession: options.tmuxSession } : {}),
  };
  await createCodexGoalJob({
    registryRootDir,
    manifest,
    now: new Date("2026-06-30T00:00:00.000Z"),
  });
  return { root, registryRootDir, manifest };
}

async function hasTmux(): Promise<boolean> {
  try {
    await execFileAsync("tmux", ["-V"]);
    return true;
  } catch {
    return false;
  }
}

function fakeJwt(claims: Readonly<Record<string, unknown>>): string {
  return [
    base64UrlJson({ alg: "none", typ: "JWT" }),
    base64UrlJson(claims),
    "",
  ].join(".");
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}
