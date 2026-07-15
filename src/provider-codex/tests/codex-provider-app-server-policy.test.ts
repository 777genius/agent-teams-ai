import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DefaultRedactor,
  providerTaskSystemPromptMaxBytes,
} from "@vioxen/subscription-runtime/core";
import {
  agentDriverContract,
  providerSessionDriverContract,
} from "../../core/testing/contracts";
import type {
  ManagedRunInputRequest,
  ManagedRunRecord,
  ManagedRunResumeHandle,
  ManagedRunStorePort,
  ProcessResult,
  ProviderFailure,
  RunnerPort,
  RunnerCapabilities,
} from "@vioxen/subscription-runtime/core";
import {
  CodexCliAgentDriver,
  CodexCliProviderDriver,
  CodexCliSessionDriver,
  CodexWorkerCacheSessionMaterializer,
  CodexWorkerCacheSessionPoolMaterializer,
  CodexAppServerExecutionEngine,
  CodexJsonAgentDriver,
  PackagedCodexJsonExecutionEngine,
  buildCodexJsonExecArgs,
  classifyCodexFailure,
  codexAgentCapabilities,
  codexEnvironmentPolicy,
  codexJsonAgentCapabilities,
  codexProviderManifest,
  codexSessionCapabilities,
  defaultCodexModel,
  sessionArtifactFromCodexAuthJson,
  validateCodexSessionArtifact,
} from "../index";
import type { CodexExecutionEngine } from "../codex-json-execution-engine";
import type { CodexSessionMaterializer } from "../codex-session-materializer";
import {
  classifyCodexRuntimeFailure,
  pruneCodexChildEnv,
} from "../codex-cli-domain";
import { isTransientCodexTempCleanupError } from "../codex-cli-temp-cleanup";
import {
  extractFakePrompt,
  FakeAppServerFactory,
} from "../app-server/testing/fake-app-server";
import {
  RecordingJsonEngine,
  RecordingManagedRunStore,
  RefreshingRunner,
  SlowRecordingJsonEngine,
  StaticRunner,
  expectFencedCodexPrompt,
  refreshedAuthJson,
  validAuthJson,
} from "./codex-provider-test-support";

describe("Codex provider app-server adapter", () => {
  it("fully prewarms reusable app-server slots before the first task", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-app-warm-test-"));
    const cacheRoot = await mkdtemp(join(tmpdir(), "codex-app-warm-root-"));
    const fakeFactory = new FakeAppServerFactory();
    const driver = new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
        processFactory: fakeFactory.create,
        executionProfile: "stateless-completion",
      }),
      sessionMaterializer: new CodexWorkerCacheSessionPoolMaterializer({
        cacheKey: "provider-account:codex-warm-test",
        slots: 1,
        rootDir: cacheRoot,
      }),
      model: "gpt-test",
      reasoningEffort: "low",
      warmupPrompt: "warm slot",
    });

    try {
      const prewarm = await driver.prewarmSession({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        redactor: new DefaultRedactor(),
        workspacePath: workspace,
        runner: new StaticRunner(""),
        abortSignal: new AbortController().signal,
      });

      expect(prewarm).toMatchObject({
        reusable: true,
        engine: {
          kind: "app-server-pool",
          reusable: true,
        },
      });
      expect(fakeFactory.spawnCount).toBe(1);
      expect(fakeFactory.cwds).toEqual([prewarm.home]);
      expect(fakeFactory.prompts).toEqual(["warm slot"]);
      expect(
        fakeFactory.requests.find(
          (request) => request.method === "thread/start",
        )?.params,
      ).toMatchObject({
        baseInstructions: expect.stringContaining(
          "fast backend inference worker",
        ),
        developerInstructions: null,
        dynamicTools: [],
        environments: [],
        config: {
          web_search: "disabled",
          model_verbosity: "low",
          features: {
            apps: false,
            hooks: false,
            memories: false,
            multi_agent: false,
            shell_snapshot: false,
            skill_mcp_dependency_install: false,
          },
        },
      });
      const prewarmThreadStarts = fakeFactory.requests.filter(
        (request) => request.method === "thread/start",
      );
      expect(prewarmThreadStarts).toHaveLength(2);

      const result = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: { kind: "review", prompt: "real task" },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      expect(result).toMatchObject({
        status: "completed",
        outputText: "app-server output:real task",
      });
      expect(fakeFactory.spawnCount).toBe(1);
      expect(fakeFactory.prompts).toEqual(["warm slot", "real task"]);
      const realTaskTurn = fakeFactory.requests
        .filter((request) => request.method === "turn/start")
        .find((request) => extractFakePrompt(request.params) === "real task");
      expect(realTaskTurn?.params?.threadId).toBe("thread-2");
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });

  it("defaults direct app-server use to the previous subscription-worker profile", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-app-profile-test-"));
    const fakeFactory = new FakeAppServerFactory();
    const driver = new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
        processFactory: fakeFactory.create,
        cleanThreadPrewarm: false,
      }),
      model: "gpt-test",
      reasoningEffort: "low",
    });

    try {
      await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: { kind: "review", prompt: "profile task" },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      const threadStart = fakeFactory.requests.find(
        (request) => request.method === "thread/start",
      );
      expect(threadStart?.params).toMatchObject({
        sandbox: "read-only",
        config: {
          sandbox_mode: "read-only",
        },
        baseInstructions: null,
        developerInstructions: expect.stringContaining(
          "non-interactive subscription runtime worker",
        ),
      });
      expect(threadStart?.params?.developerInstructions).toContain(
        "strict valid JSON only",
      );
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("uses workspace-write app-server sandbox only for allow-edits Codex tasks", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-app-write-test-"));
    const fakeFactory = new FakeAppServerFactory();
    const driver = new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
        processFactory: fakeFactory.create,
        cleanThreadPrewarm: false,
      }),
      model: "gpt-test",
      reasoningEffort: "low",
    });

    try {
      await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: {
          kind: "structured-prompt",
          prompt: "edit files",
          controls: { editMode: "allow-edits" },
        },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      const threadStart = fakeFactory.requests.find(
        (request) => request.method === "thread/start",
      );
      expect(threadStart?.params).toMatchObject({
        sandbox: "workspace-write",
        config: {
          sandbox_mode: "workspace-write",
        },
      });
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("uses explicit danger-full-access provider sandbox for allow-edits Codex tasks", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-app-danger-test-"));
    const fakeFactory = new FakeAppServerFactory();
    const driver = new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
        processFactory: fakeFactory.create,
        cleanThreadPrewarm: false,
      }),
      model: "gpt-test",
      reasoningEffort: "low",
    });

    try {
      await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: {
          kind: "structured-prompt",
          prompt: "edit files without sandbox",
          controls: {
            editMode: "allow-edits",
            providerSandboxMode: "danger-full-access",
          },
        },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      const threadStart = fakeFactory.requests.find(
        (request) => request.method === "thread/start",
      );
      expect(threadStart?.params).toMatchObject({
        sandbox: "danger-full-access",
        config: {
          sandbox_mode: "danger-full-access",
        },
      });
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("adds task system prompts to app-server developer instructions", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-app-system-test-"));
    const fakeFactory = new FakeAppServerFactory();
    const driver = new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
        processFactory: fakeFactory.create,
        cleanThreadPrewarm: false,
      }),
      model: "gpt-test",
      reasoningEffort: "low",
    });

    try {
      await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: {
          kind: "review",
          prompt: "system task",
          systemPrompt: "return only the verdict",
        },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      const threadStart = fakeFactory.requests.find(
        (request) => request.method === "thread/start",
      );
      expect(threadStart?.params?.developerInstructions).toEqual(
        expect.stringContaining("non-interactive subscription runtime worker"),
      );
      expect(threadStart?.params?.developerInstructions).toEqual(
        expect.stringContaining("return only the verdict"),
      );
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("enables granular app-server approvals when command approval policy is configured", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-app-approval-policy-test-"));
    const fakeFactory = new FakeAppServerFactory();
    const driver = new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
        processFactory: fakeFactory.create,
        cleanThreadPrewarm: false,
        commandApprovalPolicy: {
          reviewCommand: () => ({ approved: true }),
        },
      }),
      model: "gpt-test",
      reasoningEffort: "low",
    });

    try {
      await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: { kind: "review", prompt: "approval policy task" },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      const expectedApprovalPolicy = {
        granular: {
          mcp_elicitations: false,
          request_permissions: false,
          rules: true,
          sandbox_approval: true,
          skill_approval: false,
        },
      };
      const threadStart = fakeFactory.requests.find(
        (request) => request.method === "thread/start",
      );
      const turnStart = fakeFactory.requests.find(
        (request) => request.method === "turn/start",
      );
      expect(threadStart?.params).toMatchObject({
        approvalPolicy: expectedApprovalPolicy,
        config: {
          approval_policy: "on-request",
        },
      });
      expect(turnStart?.params).toMatchObject({
        approvalPolicy: expectedApprovalPolicy,
        sandboxPolicy: {
          type: "readOnly",
          networkAccess: false,
        },
      });
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("sends strict workspace-write sandbox policy to app-server turns", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-app-sandbox-policy-test-"));
    const fakeFactory = new FakeAppServerFactory();
    const driver = new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
        processFactory: fakeFactory.create,
        cleanThreadPrewarm: false,
      }),
      model: "gpt-test",
      reasoningEffort: "low",
    });

    try {
      await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: {
          kind: "review",
          prompt: "workspace sandbox policy task",
          controls: { editMode: "allow-edits" },
        },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      const turnStart = fakeFactory.requests.find(
        (request) => request.method === "turn/start",
      );
      expect(turnStart?.params).toMatchObject({
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: [workspace],
          networkAccess: false,
          excludeSlashTmp: true,
          excludeTmpdirEnvVar: true,
        },
      });
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("suppresses inherited extra writable roots for scoped app-server workers", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-app-sandbox-scope-test-"));
    const fakeFactory = new FakeAppServerFactory();
    const driver = new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
        processFactory: fakeFactory.create,
        cleanThreadPrewarm: false,
        sourceEnv: {
          SUBSCRIPTION_RUNTIME_JOB_ROOT: "/var/data/jobs/scoped-worker",
          SUBSCRIPTION_RUNTIME_TMPDIR: "/var/data/jobs/scoped-worker/tmp",
          TMPDIR: "/var/data/jobs/scoped-worker/tmp/agent",
          SUBSCRIPTION_RUNTIME_CODEX_EXTRA_WRITABLE_ROOTS: "/var/data/quanta/control",
          SUBSCRIPTION_RUNTIME_CODEX_SUPPRESS_EXTRA_WRITABLE_ROOTS: "1",
        },
      }),
      model: "gpt-test",
      reasoningEffort: "low",
    });

    try {
      await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: {
          kind: "review",
          prompt: "scoped workspace sandbox policy task",
          controls: { editMode: "allow-edits" },
        },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      const threadStart = fakeFactory.requests.find(
        (request) => request.method === "thread/start",
      );
      const turnStart = fakeFactory.requests.find(
        (request) => request.method === "turn/start",
      );
      expect(threadStart?.params).toMatchObject({
        runtimeWorkspaceRoots: [workspace, "/var/data/jobs/scoped-worker/tmp/agent"],
      });
      expect(turnStart?.params).toMatchObject({
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: [workspace, "/var/data/jobs/scoped-worker/tmp/agent"],
          excludeTmpdirEnvVar: false,
        },
      });
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("denies app-server command approval requests through command approval policy", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-app-command-approval-test-"));
    const reviewedCommands: unknown[] = [];
    const fakeFactory = new FakeAppServerFactory({
      emitServerRequestOnTurn: {
        id: 9_101,
        method: "item/commandExecution/requestApproval",
        params: {
          command: "git push origin main",
          cwd: workspace,
        },
      },
    });
    const driver = new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
        processFactory: fakeFactory.create,
        cleanThreadPrewarm: false,
        commandApprovalPolicy: {
          reviewCommand: (input) => {
            reviewedCommands.push(input);
            return { approved: false, reason: "denied_git_push" };
          },
        },
      }),
      model: "gpt-test",
      reasoningEffort: "low",
    });

    try {
      const result = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: { kind: "review", prompt: "command approval task" },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      expect(reviewedCommands).toEqual([
        {
          source: "command_execution",
          commandText: "git push origin main",
          cwd: workspace,
        },
      ]);
      expect(fakeFactory.responses).toContainEqual({
        id: 9_101,
        result: { decision: "decline" },
      });
      expect(result.warnings.map((warning) => warning.code)).toContain(
        "codex_app_server_command_approval_denied",
      );
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("does not reuse prewarmed app-server threads across system prompts", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "codex-app-system-prewarm-test-"),
    );
    const cacheRoot = await mkdtemp(
      join(tmpdir(), "codex-app-system-prewarm-root-"),
    );
    const fakeFactory = new FakeAppServerFactory();
    const driver = new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
        processFactory: fakeFactory.create,
      }),
      sessionMaterializer: new CodexWorkerCacheSessionPoolMaterializer({
        cacheKey: "provider-account:codex-system-prewarm-test",
        slots: 1,
        rootDir: cacheRoot,
      }),
      model: "gpt-test",
      reasoningEffort: "low",
    });

    try {
      await driver.prewarmSession({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        redactor: new DefaultRedactor(),
        workspacePath: workspace,
        runner: new StaticRunner(""),
        abortSignal: new AbortController().signal,
      });

      await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: {
          kind: "review",
          prompt: "system task",
          systemPrompt: "return only the verdict",
        },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      const realTaskTurn = fakeFactory.requests.find(
        (request) =>
          request.method === "turn/start" &&
          extractFakePrompt(request.params) === "system task",
      );
      expect(realTaskTurn?.params?.threadId).toBe("thread-2");
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });

  it("does not fail a task when clean-thread prewarm fails", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-clean-thread-test-"));
    const cacheRoot = await mkdtemp(join(tmpdir(), "codex-clean-thread-root-"));
    const fakeFactory = new FakeAppServerFactory({
      failThreadStartNumbers: [2],
    });
    const driver = new CodexJsonAgentDriver({
      engine: new CodexAppServerExecutionEngine({
        codexBinaryPath: "/bin/codex-test",
        processFactory: fakeFactory.create,
      }),
      sessionMaterializer: new CodexWorkerCacheSessionPoolMaterializer({
        cacheKey: "provider-account:codex-clean-thread-test",
        slots: 1,
        rootDir: cacheRoot,
      }),
      model: "gpt-test",
      reasoningEffort: "low",
      warmupPrompt: "warm slot",
    });

    try {
      const prewarm = await driver.prewarmSession({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        redactor: new DefaultRedactor(),
        workspacePath: workspace,
        runner: new StaticRunner(""),
        abortSignal: new AbortController().signal,
      });

      expect((prewarm.warnings ?? []).map((warning) => warning.code)).toContain(
        "codex_app_server_clean_thread_prewarm_failed",
      );

      const result = await driver.runTask({
        session: sessionArtifactFromCodexAuthJson(validAuthJson),
        task: { kind: "review", prompt: "real task" },
        workspace: { path: workspace },
        runner: new StaticRunner(""),
        redactor: new DefaultRedactor(),
        abortSignal: new AbortController().signal,
      });

      expect(result).toMatchObject({
        status: "completed",
        outputText: "app-server output:real task",
      });
    } finally {
      await driver.dispose();
      await rm(workspace, { recursive: true, force: true });
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });
});
