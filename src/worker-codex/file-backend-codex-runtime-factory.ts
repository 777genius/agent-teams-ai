import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  createSubscriptionRuntime,
  DeterministicIdGenerator,
  type ClockPort,
  type ObservabilityPort,
  type RedactorPort,
  type RuntimeDeps,
} from "@vioxen/subscription-runtime/core";
import {
  CodexAppServerExecutionEngine,
  CodexCliAgentDriver,
  CodexCliSessionDriver,
  CodexJsonAgentDriver,
  CodexWorkerCacheSessionPoolMaterializer,
  PackagedCodexJsonExecutionEngine,
  defaultCodexModel,
} from "@vioxen/subscription-runtime/provider-codex";
import { createLocalFileBackendRuntimeAdapters } from "@vioxen/subscription-runtime/store-local-file";
import type { CommandPolicy } from "@vioxen/subscription-runtime/worker-core";
import { NodeProcessRunner } from "../worker-local/node-process-runner";
import {
  BorrowedRunTaskWorkspace,
  StableWorkerWorkspace,
} from "../worker-local/temp-workspace";
import { CommandPolicyRunner } from "./command-policy-runner";
import { codexAppServerCommandApprovalPolicy } from "./file-backend-codex-command-policy";
import { LocalFileManagedRunStore } from "./file-backend-codex-managed-run-store";
import type { FileBackendCodexWorkerOptions } from "./file-backend-codex-worker";

export type CodexWorkerExecutionEngine =
  | "app-server"
  | "app-server-goal"
  | "packaged-exec"
  | "plain-exec";

export type FileBackendCodexWorkerRuntimeParts = {
  readonly runner: RuntimeDeps["runner"];
  readonly workspace: RuntimeDeps["workspace"];
  readonly clock: ClockPort;
  readonly sessionDriver: CodexCliSessionDriver;
  readonly agentDriver: CodexJsonAgentDriver | CodexCliAgentDriver;
  readonly sessionStore: NonNullable<RuntimeDeps["sessionStore"]>;
  readonly managedRunStore: LocalFileManagedRunStore;
  readonly runtime: ReturnType<typeof createSubscriptionRuntime>;
  readonly ownedWorkspace: StableWorkerWorkspace | null;
  readonly prewarmWorkspace: RuntimeDeps["workspace"];
};

export function createFileBackendCodexWorkerRuntime(input: {
  readonly options: FileBackendCodexWorkerOptions;
  readonly workerId: string;
  readonly observability: ObservabilityPort;
  readonly redactor: RedactorPort;
  readonly clock: ClockPort;
}): FileBackendCodexWorkerRuntimeParts {
  const { options } = input;
  const runners = createWorkerRunners({
    options,
    workerId: input.workerId,
    observability: input.observability,
  });
  const runner = runners.taskRunner;
  const workspaces = createWorkerWorkspaces({
    options,
    workerId: input.workerId,
  });
  const { sessionStore, leaseStore } = createLocalFileBackendRuntimeAdapters({
    providerId: "codex",
    rootDir: join(options.stateRootDir, "sessions"),
    encryptionKey: options.encryptionKey,
    metadata: { adapter: "file-backend-codex-worker" },
  });
  const managedRunStore = new LocalFileManagedRunStore(
    join(options.stateRootDir, "managed-runs"),
  );
  const sessionDriver = new CodexCliSessionDriver({
    codexBinaryPath: options.codexBinaryPath,
    model: options.model ?? defaultCodexModel,
    ...(options.sourceEnv ? { sourceEnv: options.sourceEnv } : {}),
    refreshMode: "lazy-refresh",
    ...(runners.refreshBootstrapRunner
      ? { refreshBootstrapRunner: runners.refreshBootstrapRunner }
      : {}),
  });
  const agentDriver = createCodexAgentDriver({
    options,
    workerId: input.workerId,
    observability: input.observability,
    managedRunStore,
  });
  const runtime = createSubscriptionRuntime({
    policy: {
      custodyMode: "local-only",
      requireNoBackendPlaintext: false,
      requireWritebackBeforeTask: true,
      requireCompareAndSwap: true,
      allowInteractiveSetupInRuntime: false,
      allowedProviderIds: [sessionDriver.providerId],
      allowedAgentIds: [agentDriver.agentId],
      allowedStoreIds: [sessionStore.storeId],
      allowedRunnerIds: [runner.runnerId],
      requestedTaskMode: "structured-prompt",
      refreshPolicy: {
        minFreshMs: options.refreshFreshnessMs ?? 15 * 60 * 1000,
        refreshBeforeExpiryMs: options.refreshBeforeExpiryMs ?? 5 * 60 * 1000,
        maxSessionAgeMs: options.maxSessionAgeMs ?? 24 * 60 * 60 * 1000,
      },
    },
    sessionDriver,
    agentDriver,
    sessionStore,
    leaseStore,
    runner,
    workspace: workspaces.workspace,
    redactor: input.redactor,
    observability: input.observability,
    clock: input.clock,
    idGenerator: new DeterministicIdGenerator(),
  });
  return {
    runner,
    workspace: workspaces.workspace,
    clock: input.clock,
    sessionDriver,
    agentDriver,
    sessionStore,
    managedRunStore,
    runtime,
    ownedWorkspace: workspaces.ownedWorkspace,
    prewarmWorkspace: workspaces.prewarmWorkspace,
  };
}

function createWorkerRunners(input: {
  readonly options: FileBackendCodexWorkerOptions;
  readonly workerId: string;
  readonly observability: ObservabilityPort;
}): {
  readonly taskRunner: RuntimeDeps["runner"];
  readonly refreshBootstrapRunner?: RuntimeDeps["runner"];
} {
  const baseRunner = input.options.runner ?? new NodeProcessRunner();
  const taskRunner = input.options.commandPolicy?.validateCommands
    ? new CommandPolicyRunner(baseRunner, input.options.commandPolicy, {
        observability: input.observability,
        providerId: "codex",
        metadata: {
          workerId: input.workerId,
          providerInstanceId: input.options.providerInstanceId,
        },
      })
    : baseRunner;
  const refreshBootstrapRunner =
    input.options.commandPolicy?.validateCommands &&
    input.options.codexBinaryPath === "codex"
      ? baseRunner
      : undefined;
  return {
    taskRunner,
    ...(refreshBootstrapRunner ? { refreshBootstrapRunner } : {}),
  };
}

function createWorkerWorkspaces(input: {
  readonly options: FileBackendCodexWorkerOptions;
  readonly workerId: string;
}): {
  readonly ownedWorkspace: StableWorkerWorkspace | null;
  readonly workspace: RuntimeDeps["workspace"];
  readonly prewarmWorkspace: RuntimeDeps["workspace"];
} {
  const defaultWorkspacePath = join(
    input.options.stateRootDir,
    "workspaces",
    hashText(input.workerId),
  );
  const ownedWorkspace = input.options.workspace
    ? null
    : new StableWorkerWorkspace(defaultWorkspacePath, {
        allowedRootDir: input.options.stateRootDir,
      });
  const workspace =
    input.options.workspace ??
    (input.options.workspacePath
      ? new BorrowedRunTaskWorkspace(input.options.workspacePath, ownedWorkspace!)
      : ownedWorkspace!);
  return {
    ownedWorkspace,
    workspace,
    prewarmWorkspace: input.options.workspace ?? ownedWorkspace!,
  };
}

function createCodexAgentDriver(input: {
  readonly options: FileBackendCodexWorkerOptions;
  readonly workerId: string;
  readonly observability: ObservabilityPort;
  readonly managedRunStore: LocalFileManagedRunStore;
}): CodexJsonAgentDriver | CodexCliAgentDriver {
  const { options } = input;
  const executionEngine = options.executionEngine ?? "app-server";
  if (executionEngine === "plain-exec") {
    return new CodexCliAgentDriver({
      codexBinaryPath: options.codexBinaryPath,
      model: options.model ?? defaultCodexModel,
      ...(options.sourceEnv ? { sourceEnv: options.sourceEnv } : {}),
      ...(options.taskTimeoutMs ? { timeoutMs: options.taskTimeoutMs } : {}),
    });
  }

  const packagedExec = new PackagedCodexJsonExecutionEngine({
    codexBinaryPath: options.codexBinaryPath,
    ...(options.sourceEnv ? { sourceEnv: options.sourceEnv } : {}),
    ...(options.taskTimeoutMs ? { timeoutMs: options.taskTimeoutMs } : {}),
  });
  return new CodexJsonAgentDriver({
    engine: executionEngine === "packaged-exec"
      ? packagedExec
      : new CodexAppServerExecutionEngine({
          codexBinaryPath: options.codexBinaryPath,
          ...(options.sourceEnv ? { sourceEnv: options.sourceEnv } : {}),
          ...(options.taskTimeoutMs ? { timeoutMs: options.taskTimeoutMs } : {}),
          ...(options.appServerStartupTimeoutMs
            ? { startupTimeoutMs: options.appServerStartupTimeoutMs }
            : {}),
          ...(options.appServerProcessFactory
            ? { processFactory: options.appServerProcessFactory }
            : {}),
          ...(options.executionProfile
            ? { executionProfile: options.executionProfile }
            : {}),
          ...(options.commandPolicy?.validateCommands
            ? {
                commandApprovalPolicy: codexAppServerCommandApprovalPolicy(
                  options.commandPolicy as CommandPolicy,
                  input.observability,
                  {
                    workerId: input.workerId,
                    providerInstanceId: options.providerInstanceId,
                  },
                ),
              }
            : {}),
          cleanThreadPrewarm: options.cleanThreadPrewarm ?? true,
          goalMode: executionEngine === "app-server-goal",
          runStore: input.managedRunStore,
          ...(executionEngine === "app-server-goal"
            ? {}
            : { fallback: packagedExec }),
        }),
    sessionMaterializer: new CodexWorkerCacheSessionPoolMaterializer({
      cacheKey: `codex:${options.providerInstanceId}:${input.workerId}`,
      slots: options.sessionCacheSlots ?? 1,
      rootDir: join(options.stateRootDir, "codex-session-cache"),
    }),
    model: options.model ?? defaultCodexModel,
    reasoningEffort: options.reasoningEffort ?? "low",
    ...(options.serviceTier === undefined
      ? {}
      : { serviceTier: options.serviceTier }),
    ...(options.outputSchemas === undefined
      ? {}
      : { outputSchemas: options.outputSchemas }),
    ...(typeof options.warmupPrompt === "string"
      ? { warmupPrompt: options.warmupPrompt }
      : {}),
  });
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
