import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RunObservationService } from "@vioxen/subscription-runtime/worker-core";
import type {
  ClaudeTaskEngineInput,
  ClaudeTaskExecutionEngine,
  ClaudeTaskExecutionResult,
} from "@vioxen/subscription-runtime/provider-claude";
import {
  ClaudeRunObservationAdapter,
  FileBackendClaudeWorker,
} from "../index";

describe("ClaudeRunObservationAdapter", () => {
  it("observes completed FileBackendClaudeWorker runs from durable artifacts", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "subscription-runtime-claude-watch-"));
    const workspacePath = join(rootDir, "workspace");
    const worker = new FileBackendClaudeWorker({
      providerInstanceId: "claude-main",
      stateRootDir: rootDir,
      encryptionKey: encryptionKey(),
      workspacePath,
      workspace: new FixedWorkspace(workspacePath),
      engine: new FakeClaudeEngine({
        outputText: "answer with claude-oauth-secret",
        telemetry: {
          providerRunId: "provider-run-a",
          providerSessionId: "provider-session-a",
        },
        warnings: [],
      }),
      runArtifactHeartbeatMs: 10,
    });

    try {
      await mkdir(workspacePath, { recursive: true });
      await gitInit(workspacePath);
      await writeFile(join(workspacePath, "changed.txt"), "dirty\n");
      await worker.start();
      await worker.seedClaudeOAuth({ oauthToken: "claude-oauth-secret" });
      await worker.run({
        jobId: "job-a",
        runId: "run-a",
        prompt: "answer",
      });

      const snapshot = await new RunObservationService(new ClaudeRunObservationAdapter({
        stateRootDir: rootDir,
      })).observeRun({
        runId: "run-a",
        includeChangedFiles: true,
        includeLogTail: true,
      });

      expect(snapshot).toMatchObject({
        runId: "run-a",
        providerKind: "claude",
        status: "completed",
        liveness: "dead",
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
      expect(snapshot.workspace?.changedFiles).toEqual(["?? changed.txt"]);
      expect(snapshot.progress?.status).toBe("completed");
      expect(snapshot.progress?.currentAccount).toMatch(/^claude-oauth:[a-f0-9]+$/);
      expect(snapshot.process?.alive).toBe(true);
      expect(snapshot.logs?.tail).toContain("run.completed");
      expect(snapshot.logs?.truncated).toBe(false);
      expect(JSON.stringify(snapshot).includes("claude-oauth-secret")).toBe(false);
    } finally {
      await worker.dispose().catch(() => undefined);
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("observes failed Claude runs without prescribing recovery", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "subscription-runtime-claude-watch-"));
    const workspacePath = join(rootDir, "workspace");
    const worker = new FileBackendClaudeWorker({
      providerInstanceId: "claude-main",
      stateRootDir: rootDir,
      encryptionKey: encryptionKey(),
      workspacePath,
      workspace: new FixedWorkspace(workspacePath),
      engine: new FailingClaudeEngine(),
    });

    try {
      await mkdir(workspacePath, { recursive: true });
      await gitInit(workspacePath);
      await worker.start();
      await worker.seedClaudeOAuth({ oauthToken: "claude-oauth-secret" });
      await expect(worker.run({
        runId: "run-failed",
        prompt: "fail",
      })).rejects.toMatchObject({
        code: "subscription_worker_run_failed",
      });

      const snapshot = await new RunObservationService(new ClaudeRunObservationAdapter({
        stateRootDir: rootDir,
      })).observeRun({
        runId: "run-failed",
        includeLogTail: true,
      });

      expect(snapshot).toMatchObject({
        runId: "run-failed",
        providerKind: "claude",
        status: "failed",
        liveness: "dead",
        result: {
          exists: true,
          status: "failed",
          reason: "unknown_runtime_failure",
        },
        readOnlyDecision: {
          kind: "manual_review_required",
        },
      });
      expect(JSON.stringify(snapshot).includes("claude-oauth-secret")).toBe(false);
    } finally {
      await worker.dispose().catch(() => undefined);
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("reports missing Claude workspaces without treating them as dirty", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "subscription-runtime-claude-watch-"));
    const workspacePath = join(rootDir, "workspace");
    const worker = new FileBackendClaudeWorker({
      providerInstanceId: "claude-main",
      stateRootDir: rootDir,
      encryptionKey: encryptionKey(),
      workspacePath,
      workspace: new FixedWorkspace(workspacePath),
      engine: new FakeClaudeEngine({
        outputText: "answer",
        warnings: [],
      }),
    });

    try {
      await worker.start();
      await worker.seedClaudeOAuth({ oauthToken: "claude-oauth-secret" });
      await worker.run({
        runId: "run-missing-workspace",
        prompt: "answer",
      });
      await rm(workspacePath, { recursive: true, force: true });

      const snapshot = await new RunObservationService(new ClaudeRunObservationAdapter({
        stateRootDir: rootDir,
      })).observeRun({
        runId: "run-missing-workspace",
        includeChangedFiles: true,
      });

      expect(snapshot.workspace).toMatchObject({
        path: workspacePath,
        exists: false,
        dirty: false,
        changedFilesCount: 0,
        changedFiles: [],
        warning: "workspace_missing",
      });
      expect(snapshot.readOnlyDecision.kind).toBe("review_completed");
    } finally {
      await worker.dispose().catch(() => undefined);
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});

class FakeClaudeEngine implements ClaudeTaskExecutionEngine {
  readonly kind = "fake-claude";
  readonly capabilities = {
    supportsStreaming: true,
    supportsToolCalls: true,
    supportsUsage: true,
    supportsProviderRunId: true,
    supportsCleanup: true,
  } as const;

  constructor(private readonly result: ClaudeTaskExecutionResult) {}

  async run(input: ClaudeTaskEngineInput): Promise<ClaudeTaskExecutionResult> {
    void input;
    return this.result;
  }
}

class FailingClaudeEngine implements ClaudeTaskExecutionEngine {
  readonly kind = "fake-claude";
  readonly capabilities = {
    supportsStreaming: true,
    supportsToolCalls: true,
    supportsUsage: true,
    supportsProviderRunId: true,
    supportsCleanup: true,
  } as const;

  async run(): Promise<ClaudeTaskExecutionResult> {
    throw new Error("fake claude failure");
  }
}

class FixedWorkspace {
  readonly workspaceId = "fixed-workspace";
  readonly capabilities = {
    workspaceId: this.workspaceId,
    supportsTempDir: true,
    supportsExistingCheckout: true,
    supportsContainer: false,
  };

  constructor(private readonly path: string) {}

  async create() {
    await mkdir(this.path, { recursive: true });
    return { path: this.path };
  }
}

async function gitInit(path: string): Promise<void> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  await promisify(execFile)("git", ["init"], { cwd: path });
}

function encryptionKey(): Uint8Array {
  return new Uint8Array(Array.from({ length: 32 }, (_, index) => index + 1));
}
