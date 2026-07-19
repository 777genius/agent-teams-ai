import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DefaultRedactor,
  type ProcessResult,
  type RunnerPort,
} from "@vioxen/subscription-runtime/core";
import { sessionArtifactFromCodexAuthJson } from "@vioxen/subscription-runtime/provider-codex";
import {
  AccessBoundary,
  LaunchPlanStatus,
  buildLaunchPlan,
} from "@vioxen/subscription-runtime/worker-core";
import { describe, expect, it } from "vitest";
import { createFileBackendCodexWorkerRuntime } from "../file-backend-codex-runtime-factory";
import {
  MemoryWorkerObservability,
  validAuthJson,
} from "./file-backend-codex-worker-test-support";

describe("FileBackendCodexWorker refresh bootstrap runner", () => {
  it("allows registry-local auth bootstrap without weakening the task runner", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codex-bootstrap-runner-"));
    const registryRoot = join(rootDir, "worker-jobs");
    const jobRoot = join(registryRoot, "bootstrap-runner-test-worker");
    const refreshTempRoot = join(jobRoot, "tmp");
    const workspaceRoot = join(rootDir, "workspace");
    const launchPlan = buildLaunchPlan({
      boundary: AccessBoundary.IsolatedWorkspaceWrite,
      scope: {
        projectId: "bootstrap-runner-test",
        readRoots: [rootDir],
        isolatedWorkspaceRoot: workspaceRoot,
        workspaceRoots: [workspaceRoot],
        worktreeRoots: [join(rootDir, "worktrees")],
        registryRoot,
        allowedBranches: ["main"],
        jobIdPrefixes: ["bootstrap-runner-test-"],
      },
      adapter: {
        canEnforceFilesystemPolicy: true,
        canIsolateHome: true,
        canIsolateTemp: true,
        canDisableRawShell: true,
        canBrokerProjectControl: true,
        canRestrictNetwork: true,
      },
    });
    expect(launchPlan.status).toBe(LaunchPlanStatus.Ready);
    if (launchPlan.status !== LaunchPlanStatus.Ready) {
      throw new Error("bootstrap_runner_test_launch_plan_blocked");
    }
    const baseRunner = new RecordingRefreshRunner();
    const runtimeParts = createFileBackendCodexWorkerRuntime({
      options: {
        workerId: "bootstrap-runner-test-worker",
        providerInstanceId: "codex:bootstrap-runner-test",
        stateRootDir: rootDir,
        codexBinaryPath: "codex",
        encryptionKey: new Uint8Array(32).fill(4),
        sourceEnv: {
          SUBSCRIPTION_RUNTIME_JOB_ROOT: jobRoot,
          SUBSCRIPTION_RUNTIME_TMPDIR: refreshTempRoot,
        },
        runner: baseRunner,
        commandPolicy: launchPlan.commandPolicy,
      },
      workerId: "bootstrap-runner-test-worker",
      observability: new MemoryWorkerObservability(),
      redactor: new DefaultRedactor(),
      clock: {
        now: () => new Date("2026-05-31T00:05:00.000Z"),
        monotonicMs: () => 1,
      },
    });

    try {
      await expect(runtimeParts.sessionDriver.refreshSession({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        workspace: { path: refreshTempRoot },
        runner: runtimeParts.runner,
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      })).resolves.toMatchObject({ providerState: "refreshed" });
      expect(baseRunner.runCount).toBe(1);
      expect(baseRunner.lastInput?.cwd.startsWith(refreshTempRoot)).toBe(true);
      if (!baseRunner.lastInput) {
        throw new Error("bootstrap_runner_test_input_missing");
      }

      await expect(runtimeParts.runner.run(baseRunner.lastInput)).rejects.toThrow(
        "command_policy_denied:denied_path_prefix",
      );
      expect(baseRunner.runCount).toBe(1);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});

class RecordingRefreshRunner implements RunnerPort {
  readonly runnerId = "recording-refresh-runner";
  readonly capabilities = {
    runnerId: this.runnerId,
    supportsEnvAllowlist: true,
    supportsWorkingDirectory: true,
    supportsTimeout: true,
    supportsAbortSignal: true,
    supportsOutputRedaction: true,
    supportsReadOnlySandbox: true,
    readOnlyFilesystem: true,
    platform: "node-process" as const,
  };
  runCount = 0;
  lastInput: Parameters<RunnerPort["run"]>[0] | null = null;

  async run(input: Parameters<RunnerPort["run"]>[0]): Promise<ProcessResult> {
    this.runCount += 1;
    this.lastInput = input;
    const authPath = input.env.REVIEWROUTER_CODEX_AUTH_PATH;
    if (!authPath) throw new Error("missing_auth_path");
    const auth = JSON.parse(await readFile(authPath, "utf8")) as {
      tokens: { access_token?: string; expiry?: string };
      last_refresh?: string;
    };
    auth.tokens.access_token = "access-token-refreshed";
    auth.tokens.expiry = "2026-05-31T23:00:00.000Z";
    auth.last_refresh = "2026-05-31T00:05:00.000Z";
    await writeFile(authPath, JSON.stringify(auth), "utf8");
    return { exitCode: 0, stdout: "OK", stderr: "", durationMs: 1 };
  }
}
