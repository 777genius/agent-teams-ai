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

type TestJsonSchema = {
  readonly type?: string;
  readonly const?: unknown;
  readonly enum?: readonly unknown[];
  readonly minItems?: number;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean | TestJsonSchema;
  readonly properties?: Readonly<Record<string, TestJsonSchema>>;
  readonly items?: TestJsonSchema;
  readonly anyOf?: readonly TestJsonSchema[];
};

describe("codex goal MCP server", () => {
  it("refills a project worker with one brokered worktree, prompt and job flow", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-project-refill-"));
    const registryRootDir = join(root, "worker-jobs", "registry");
    const controllerJobRoot = join(root, "worker-jobs", "infinity-context-controller-v1");
    const sourceWorkspacePath = join(root, "workspaces", "infinity-context-main");
    const childWorkspace = join(root, "worktrees", "infinity-context-memory-fastgate-v1");
    const childJobRoot = join(root, "worker-jobs", "infinity-context-memory-fastgate-v1");
    const childBranch = "test/infinity-context-memory-fastgate-v1";
    const server = createCodexGoalMcpServer();
    const client = new Client({
      name: "subscription-runtime-test",
      version: "0.0.0",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await mkdir(sourceWorkspacePath, { recursive: true });
      await gitInitRepository(sourceWorkspacePath);
      await writeFile(join(sourceWorkspacePath, "README.md"), "base\n");
      await writeFile(join(sourceWorkspacePath, "controller.md"), "controller\n");
      await writeFile(join(sourceWorkspacePath, "lane.md"), "lane\n");
      await mkdir(join(sourceWorkspacePath, "sandbox"));
      await writeFile(join(sourceWorkspacePath, "sandbox", ".keep"), "");
      await writeFile(join(sourceWorkspacePath, "package.json"), JSON.stringify({
        packageManager: "npm@11.0.0",
        scripts: {
          test: "vitest run",
          lint: "eslint .",
        },
      }));
      await writeFile(join(sourceWorkspacePath, "package-lock.json"), JSON.stringify({
        lockfileVersion: 3,
        packages: {},
      }));
      await git(sourceWorkspacePath, [
        "add",
        "README.md",
        "controller.md",
        "lane.md",
        "sandbox/.keep",
        "package.json",
        "package-lock.json",
      ]);
      await git(sourceWorkspacePath, ["commit", "-m", "test: base"]);
      const phaseStartSha = (await gitStdout(
        sourceWorkspacePath,
        ["rev-parse", "HEAD"],
      )).trim();
      await git(sourceWorkspacePath, [
        "update-ref",
        "refs/remotes/origin/main",
        "HEAD",
      ]);
      await git(sourceWorkspacePath, ["branch", childBranch, phaseStartSha]);

      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);

      await callToolJson(client, "codex_goal_create_job", {
        registryRootDir,
        jobId: "infinity-context-controller-v1",
        jobRootDir: controllerJobRoot,
        authRootDir: join(root, "auth"),
        workspacePath: sourceWorkspacePath,
        promptPath: join(controllerJobRoot, "prompt.md"),
        taskId: "infinity-context-controller-v1",
        accounts: ["account-a"],
        accessBoundary: AccessBoundary.ProjectScopedControl,
        networkAccess: NetworkAccessMode.Restricted,
        projectAccessScope: {
          projectId: "infinity-context",
          workspaceRoots: [sourceWorkspacePath],
          worktreeRoots: [join(root, "worktrees")],
          registryRoot: registryRootDir,
          authRoot: join(root, "auth"),
          jobIdPrefixes: ["infinity-context-"],
          tmuxSessionPrefixes: ["infinity-context-"],
          allowedBranches: ["main", "HEAD", "test/infinity-context-*"],
          allowedGitRemotes: ["origin"],
          allowedAccountIds: ["account-a"],
          deniedRoots: [join(root, "real-user-project")],
          preStartAdmission: {
            required: true,
            mode: "serial-builtin",
          },
        },
      });

      const builtinAdmission = {
        mode: "serial-builtin",
        contract: {
          kind: "worker-launch",
          format: 1,
          canonicalSha: phaseStartSha,
          baseSha: phaseStartSha,
          phaseStartSha,
          packetRevision: "phase-01-s0-r1",
          controllerPacket: "controller.md",
          lanePacket: "lane.md",
          phaseId: "phase-01",
          laneId: "p1-s0",
          inputPatchHash: createHash("sha256").update("").digest("hex"),
          reviewKind: "implementation",
          ownedPaths: ["src/example.ts"],
          mandatoryDocs: ["README.md", "controller.md", "lane.md"],
          mandatoryScripts: [],
          mandatoryFixtures: [],
          requiredChecks: [{ id: "focused", cwd: "sandbox", command: "true" }],
          executionPolicy: {
            mode: "sandbox-only",
            sandboxRoot: join(childWorkspace, "sandbox"),
            forbiddenRealProjects: [join(root, "real-user-project")],
          },
        },
      };

      const result = await callToolJson(client, "codex_goal_project_refill_worker", {
        registryRootDir,
        controllerJobId: "infinity-context-controller-v1",
        jobId: "infinity-context-memory-fastgate-v1",
        sourceWorkspacePath,
        newBranch: childBranch,
        workspacePath: childWorkspace,
        promptBody: "Run a focused memory fastgate and report cleanly.\n",
        taskId: "infinity-context-memory-fastgate-v1",
        accounts: ["account-a"],
        workerRole: "fastgate",
        preStartAdmission: builtinAdmission,
        confirmPreStartAdmission: true,
        startWorker: false,
        confirmRefill: true,
      });
      if (result.ok !== true) throw new Error(JSON.stringify(result));

      expect(result).toMatchObject({
        ok: true,
        mode: "project_control_refill_worker",
        controllerJobId: "infinity-context-controller-v1",
        workerRole: "fastgate",
        jobId: "infinity-context-memory-fastgate-v1",
        targetJobId: "infinity-context-memory-fastgate-v1",
        startSkipped: true,
        baseBranch: "origin/main",
        manifest: {
          jobRootDir: childJobRoot,
          authRootDir: join(root, "auth"),
          accessBoundary: AccessBoundary.IsolatedWorkspaceWrite,
          reasoningEffort: "high",
          serviceTier: "default",
          networkAccess: NetworkAccessMode.Restricted,
          tags: expect.arrayContaining([
            "project-control-refill",
            "worker-role-fastgate",
          ]),
          projectPreStartAdmission: {
            mode: "serial-builtin",
          },
        },
        dependencyPreflight: {
          status: "deps_missing",
          packageManager: {
            name: "npm",
            source: "packageManager",
            versionSpec: "npm@11.0.0",
            lockfilePath: join(childWorkspace, "package-lock.json"),
          },
          nodeModulesPath: join(childWorkspace, "node_modules"),
          nodeModulesExists: false,
          diagnosticPath: join(childJobRoot, "dependency-preflight.json"),
          installCommand: `npm ci --prefer-offline --cache ${
            join(root, "worker-jobs", ".dependency-cache", "npm-cache")
          }`,
        },
      });
      await expect(readFile(join(childJobRoot, "prompt.md"), "utf8")).resolves.toBe(
        "Run a focused memory fastgate and report cleanly.\n",
      );
      const materializedContract = JSON.parse(await readFile(
        join(childJobRoot, "pre-start-admission", "contract.json"),
        "utf8",
      ));
      expect(materializedContract).toMatchObject({
        kind: "worker-launch",
        format: 1,
        jobId: "infinity-context-memory-fastgate-v1",
        workerId: "infinity-context-memory-fastgate-v1",
        jobRoot: childJobRoot,
        workspaceRoot: childWorkspace,
        registryStatus: "queued",
        revision: 0,
        retryCount: 0,
        supersedes: null,
        workKey: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      const materializedState = JSON.parse(await readFile(
        join(childJobRoot, "pre-start-admission", "state.json"),
        "utf8",
      ));
      expect(materializedState).toMatchObject({
        maxRetries: 0,
        maxInFlight: 1,
        records: [{ workKey: materializedContract.workKey, status: "queued" }],
      });
      const admissionReceipt = JSON.parse(await readFile(
        join(childJobRoot, "pre-start-admission", "receipt.json"),
        "utf8",
      ));
      expect(admissionReceipt).toMatchObject({
        validatorKind: "builtin",
        workKey: materializedContract.workKey,
      });
      await expect(access(join(childWorkspace, "README.md"))).resolves.toBeUndefined();
      const dependencyPreflight = JSON.parse(
        await readFile(join(childJobRoot, "dependency-preflight.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(dependencyPreflight).toMatchObject({
        status: "deps_missing",
        nodeModulesPath: join(childWorkspace, "node_modules"),
        cacheRoot: join(root, "worker-jobs", ".dependency-cache"),
      });
      const retry = await callToolJson(client, "codex_goal_project_refill_worker", {
        registryRootDir,
        controllerJobId: "infinity-context-controller-v1",
        jobId: "infinity-context-memory-fastgate-v1",
        jobRootDir: childJobRoot,
        authRootDir: join(root, "auth"),
        sourceWorkspacePath,
        workspacePath: childWorkspace,
        promptBody: "Run a focused memory fastgate and report cleanly.\n",
        taskId: "infinity-context-memory-fastgate-v1",
        accounts: ["account-a"],
        workerRole: "fastgate",
        preStartAdmission: builtinAdmission,
        confirmPreStartAdmission: true,
        startWorker: false,
        confirmRefill: true,
      });
      if (retry.ok !== true) throw new Error(JSON.stringify(retry));
      expect(retry).toMatchObject({
        ok: true,
        worktree: { status: "noop" },
        createJob: { status: "noop" },
      });
      await writeFile(join(sourceWorkspacePath, "after-phase-start.md"), "new head\n");
      await git(sourceWorkspacePath, ["add", "after-phase-start.md"]);
      await git(sourceWorkspacePath, ["commit", "-m", "test: advance source head"]);
      const mismatchedSourceWorkspace = join(
        root,
        "worktrees",
        "infinity-context-source-mismatch-v1",
      );
      const mismatchedSourceJobRoot = join(
        root,
        "worker-jobs",
        "infinity-context-source-mismatch-v1",
      );
      const sourceMismatch = await callToolJson(
        client,
        "codex_goal_project_refill_worker",
        {
          registryRootDir,
          controllerJobId: "infinity-context-controller-v1",
          jobId: "infinity-context-source-mismatch-v1",
          jobRootDir: mismatchedSourceJobRoot,
          authRootDir: join(root, "auth"),
          sourceWorkspacePath,
          workspacePath: mismatchedSourceWorkspace,
          sourceRef: "HEAD",
          promptBody: "mismatched source must not create resources\n",
          taskId: "infinity-context-source-mismatch-v1",
          accounts: ["account-a"],
          workerRole: "fastgate",
          preStartAdmission: builtinAdmission,
          confirmPreStartAdmission: true,
          startWorker: false,
          executionMode: "bounded",
          confirmRefill: true,
        },
      );
      expect(sourceMismatch).toEqual({
        ok: false,
        error: "project_control_pre_start_source_revision_mismatch",
      });
      await expect(access(mismatchedSourceWorkspace)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(access(mismatchedSourceJobRoot)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(
        access(join(controllerJobRoot, "project-control-operations")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      const existingBranchMismatch = "test/infinity-context-existing-branch-mismatch-v1";
      await git(sourceWorkspacePath, ["branch", existingBranchMismatch, "HEAD"]);
      const branchMismatchWorkspace = join(root, "worktrees", existingBranchMismatch);
      const branchMismatchJobRoot = join(root, "worker-jobs", existingBranchMismatch);
      const branchMismatch = await callToolJson(
        client,
        "codex_goal_project_refill_worker",
        {
          registryRootDir,
          controllerJobId: "infinity-context-controller-v1",
          jobId: "infinity-context-existing-branch-mismatch-v1",
          jobRootDir: branchMismatchJobRoot,
          authRootDir: join(root, "auth"),
          sourceWorkspacePath,
          newBranch: existingBranchMismatch,
          workspacePath: branchMismatchWorkspace,
          promptBody: "mismatched existing branch must not create resources\n",
          taskId: "infinity-context-existing-branch-mismatch-v1",
          accounts: ["account-a"],
          workerRole: "fastgate",
          preStartAdmission: {
            ...builtinAdmission,
            contract: {
              ...builtinAdmission.contract,
              executionPolicy: {
                ...builtinAdmission.contract.executionPolicy,
                sandboxRoot: join(branchMismatchWorkspace, "sandbox"),
              },
            },
          },
          confirmPreStartAdmission: true,
          startWorker: false,
          confirmRefill: true,
        },
      );
      expect(branchMismatch).toEqual({
        ok: false,
        error: "project_control_existing_worktree_revision_mismatch; rollback=worktree",
      });
      const rejectedWorkspace = join(root, "worktrees", "infinity-context-invalid-v1");
      const rejectedJobRoot = join(root, "worker-jobs", "infinity-context-invalid-v1");
      const rejected = await callToolJson(client, "codex_goal_project_refill_worker", {
        registryRootDir,
        controllerJobId: "infinity-context-controller-v1",
        jobId: "infinity-context-invalid-v1",
        jobRootDir: rejectedJobRoot,
        authRootDir: join(root, "auth"),
        sourceWorkspacePath,
        workspacePath: rejectedWorkspace,
        promptBody: "invalid binding must not create resources\n",
        taskId: "infinity-context-invalid-v1",
        accounts: ["account-a"],
        workerRole: "fastgate",
        preStartAdmission: {
          ...builtinAdmission,
          contract: { ...builtinAdmission.contract, jobId: "wrong-job" },
        },
        confirmPreStartAdmission: true,
        startWorker: false,
        confirmRefill: true,
      });
      expect(rejected).toEqual({
        ok: false,
        error: "project_control_pre_start_builtin_materialization_jobId_mismatch",
      });
      await expect(access(rejectedWorkspace)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(rejectedJobRoot)).rejects.toMatchObject({ code: "ENOENT" });
      const audit = await readProjectControlAudit(
        controllerJobRoot,
        "infinity-context-controller-v1",
      );
      expect(policyAuditDecisions(audit).map((decision) => decision.operation)).toEqual([
        "create_worktree", "create_worktree",
        "create_job", "use_account",
        "create_worktree",
        "create_worktree",
        "create_worktree",
        "create_worktree",
        "create_worktree",
      ]);
      expect(audit.some((event) =>
        event.type === "project_control.admission_decision_recorded"
      )).toBe(true);
      const genericContinue = await callToolJson(client, "codex_goal_continue", {
        registryRootDir,
        jobId: "infinity-context-memory-fastgate-v1",
        confirmContinue: true,
      });
      expect(genericContinue).toMatchObject({
        ok: false,
        reason: "project_control_broker_required",
        requiredTool: "codex_goal_project_start",
      });
      const genericStop = await callToolJson(client, "codex_goal_stop", {
        registryRootDir,
        jobId: "infinity-context-memory-fastgate-v1",
        confirmStop: true,
      });
      expect(genericStop).toMatchObject({
        ok: false,
        reason: "project_control_broker_required",
        requiredTool: "codex_goal_project_stop",
      });
      const genericReview = await callToolJson(client, "codex_goal_mark_reviewed", {
        registryRootDir,
        jobId: "infinity-context-memory-fastgate-v1",
      });
      expect(genericReview).toMatchObject({
        ok: false,
        reason: "project_control_broker_required",
        requiredTool: "codex_goal_project_mark_reviewed",
      });
    } finally {
      await client.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("advertises and preserves branch fields for bounded project refill", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-project-refill-bounded-"));
    const registryRootDir = join(root, "worker-jobs", "registry");
    const controllerJobRoot = join(root, "worker-jobs", "infinity-context-controller-v1");
    const sourceWorkspacePath = join(root, "workspaces", "infinity-context-main");
    const childWorkspace = join(root, "worktrees", "infinity-context-memory-fastgate-v1");
    const childJobRoot = join(root, "worker-jobs", "infinity-context-memory-fastgate-v1");
    const fakeRunnerPath = join(root, "fake-operation-runner.mjs");
    const server = createCodexGoalMcpServer();
    const client = new Client({
      name: "subscription-runtime-test",
      version: "0.0.0",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const previousRunnerPath =
      process.env.SUBSCRIPTION_RUNTIME_PROJECT_CONTROL_OPERATION_CLI_PATH;

    try {
      await mkdir(sourceWorkspacePath, { recursive: true });
      await writeFile(fakeRunnerPath, `
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
const index = process.argv.indexOf("--operation-file");
const operationFilePath = process.argv[index + 1];
const operation = JSON.parse(await readFile(operationFilePath, "utf8"));
const now = new Date().toISOString();
operation.status = "completed";
operation.runningAt = operation.runningAt ?? now;
operation.completedAt = now;
operation.updatedAt = now;
operation.runner = {
  hostname: "fake-runner",
  pid: process.pid,
  command: process.argv,
  startedAt: now
};
operation.result = {
  ok: true,
  mode: "fake_bounded_refill",
  jobId: operation.targetJobId,
  executionMode: operation.args.executionMode,
  sourceRef: operation.args.sourceRef,
  newBranch: operation.args.newBranch
};
await mkdir(dirname(operation.resultPath), { recursive: true });
await writeFile(operation.resultPath, JSON.stringify(operation.result, null, 2) + "\\n");
await writeFile(operationFilePath, JSON.stringify(operation, null, 2) + "\\n");
`);
      process.env.SUBSCRIPTION_RUNTIME_PROJECT_CONTROL_OPERATION_CLI_PATH = fakeRunnerPath;

      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);

      const tools = await client.listTools();
      const refillTool = tools.tools.find(
        (tool) => tool.name === "codex_goal_project_refill_worker",
      );
      expect(refillTool?.inputSchema.properties).toMatchObject({
        sourceRef: expect.any(Object),
        newBranch: expect.any(Object),
      });
      const refillSchema = refillTool?.inputSchema.properties
        ?.preStartAdmission as TestJsonSchema;
      const builtinSchema = refillSchema.anyOf?.find(
        (candidate) => candidate.properties?.mode?.const === "serial-builtin",
      );
      expect(builtinSchema).toMatchObject({
        type: "object",
        required: ["mode", "contract"],
        additionalProperties: false,
      });
      const contractSchema = builtinSchema?.properties?.contract;
      const declarativeFields = [
        "kind",
        "format",
        "canonicalSha",
        "baseSha",
        "phaseStartSha",
        "packetRevision",
        "controllerPacket",
        "lanePacket",
        "phaseId",
        "laneId",
        "inputPatchHash",
        "reviewKind",
        "ownedPaths",
        "mandatoryDocs",
        "mandatoryScripts",
        "mandatoryFixtures",
        "requiredChecks",
        "executionPolicy",
      ];
      const materializedFields = [
        "jobId",
        "workerId",
        "revision",
        "retryCount",
        "workKey",
        "supersedes",
        "registryStatus",
        "jobRoot",
        "workspaceRoot",
        "promptPath",
      ];
      expect(contractSchema?.required).toEqual(declarativeFields);
      expect(Object.keys(contractSchema?.properties ?? {}).sort()).toEqual(
        [...declarativeFields, ...materializedFields].sort(),
      );
      expect(contractSchema).toMatchObject({
        type: "object",
        additionalProperties: false,
        properties: {
          kind: { type: "string", const: "worker-launch" },
          format: { type: "number", const: 1 },
          reviewKind: {
            type: "string",
            enum: ["implementation", "review", "remediation"],
          },
          requiredChecks: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              required: ["id", "cwd", "command"],
              additionalProperties: false,
            },
          },
          executionPolicy: {
            type: "object",
            required: ["mode", "sandboxRoot", "forbiddenRealProjects"],
            additionalProperties: false,
            properties: {
              mode: { type: "string", const: "sandbox-only" },
            },
          },
        },
      });
      expect(builtinSchema?.properties?.state).toMatchObject({
        type: "object",
        required: ["schemaVersion", "maxRetries", "maxInFlight", "records"],
        additionalProperties: false,
      });
      expect(JSON.stringify(refillSchema)).not.toContain("worker-start-v1");
      expect(JSON.stringify(refillSchema)).not.toContain("contractSchema");

      await callToolJson(client, "codex_goal_create_job", {
        registryRootDir,
        jobId: "infinity-context-controller-v1",
        jobRootDir: controllerJobRoot,
        authRootDir: join(root, "auth"),
        workspacePath: sourceWorkspacePath,
        promptPath: join(controllerJobRoot, "prompt.md"),
        taskId: "infinity-context-controller-v1",
        accounts: ["account-a"],
        accessBoundary: AccessBoundary.ProjectScopedControl,
        networkAccess: NetworkAccessMode.Restricted,
        projectAccessScope: {
          projectId: "infinity-context",
          workspaceRoots: [sourceWorkspacePath],
          worktreeRoots: [join(root, "worktrees")],
          registryRoot: registryRootDir,
          jobIdPrefixes: ["infinity-context-"],
          tmuxSessionPrefixes: ["infinity-context-"],
          allowedAccountIds: ["account-a"],
        },
      });

      const result = await callToolJson(client, "codex_goal_project_refill_worker", {
        registryRootDir,
        controllerJobId: "infinity-context-controller-v1",
        jobId: "infinity-context-memory-fastgate-v1",
        jobRootDir: childJobRoot,
        authRootDir: join(root, "auth"),
        sourceWorkspacePath,
        workspacePath: childWorkspace,
        sourceRef: "main",
        newBranch: "refactor/infinity-context-memory-fastgate-v1",
        promptBody: "Run bounded refill.\n",
        taskId: "infinity-context-memory-fastgate-v1",
        accounts: ["account-a"],
        workerRole: "fastgate",
        confirmRefill: true,
      });

      expect(result).toMatchObject({
        ok: true,
        mode: "project_control_refill_worker_operation_started",
        executionMode: "bounded",
        operationStatusTool: "codex_goal_project_operation_status",
        targetJobId: "infinity-context-memory-fastgate-v1",
      });
      expect(result.operation).not.toHaveProperty("args");

      let status: Record<string, unknown> | undefined;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        status = await callToolJson(client, "codex_goal_project_operation_status", {
          registryRootDir,
          controllerJobId: "infinity-context-controller-v1",
          operationId: result.operationId,
          includeResult: true,
        });
        if ((status.operation as { status?: string } | undefined)?.status === "completed") {
          break;
        }
        await sleep(25);
      }

      expect(status).toMatchObject({
        ok: true,
        mode: "project_control_operation_status",
        operation: {
          status: "completed",
          targetJobId: "infinity-context-memory-fastgate-v1",
          result: {
            ok: true,
            mode: "fake_bounded_refill",
            jobId: "infinity-context-memory-fastgate-v1",
            executionMode: "sync",
            sourceRef: "main",
            newBranch: "refactor/infinity-context-memory-fastgate-v1",
          },
        },
      });
      expect(status?.operation).not.toHaveProperty("args");
    } finally {
      if (previousRunnerPath === undefined) {
        delete process.env.SUBSCRIPTION_RUNTIME_PROJECT_CONTROL_OPERATION_CLI_PATH;
      } else {
        process.env.SUBSCRIPTION_RUNTIME_PROJECT_CONTROL_OPERATION_CLI_PATH =
          previousRunnerPath;
      }
      await client.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("filters missing explicit refill accounts before creating the child manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-project-refill-accounts-"));
    const registryRootDir = join(root, "worker-jobs", "registry");
    const authRootDir = join(root, "auth");
    const controllerJobRoot = join(root, "worker-jobs", "infinity-context-controller-v1");
    const sourceWorkspacePath = join(root, "workspaces", "infinity-context-main");
    const childWorkspace = join(root, "worktrees", "infinity-context-child-v1");
    const childJobRoot = join(root, "worker-jobs", "infinity-context-child-v1");
    const server = createCodexGoalMcpServer();
    const client = new Client({
      name: "subscription-runtime-test",
      version: "0.0.0",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await mkdir(sourceWorkspacePath, { recursive: true });
      await gitInitRepository(sourceWorkspacePath);
      await writeFile(join(sourceWorkspacePath, "README.md"), "base\n");
      await git(sourceWorkspacePath, ["add", "README.md"]);
      await git(sourceWorkspacePath, ["commit", "-m", "test: base"]);
      await git(sourceWorkspacePath, [
        "update-ref",
        "refs/remotes/origin/main",
        "HEAD",
      ]);
      await writeFakeAuth(authRootDir, "account-a", {
        lastRefresh: new Date().toISOString(),
      });

      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);

      await callToolJson(client, "codex_goal_create_job", {
        registryRootDir,
        jobId: "infinity-context-controller-v1",
        jobRootDir: controllerJobRoot,
        authRootDir,
        workspacePath: sourceWorkspacePath,
        promptPath: join(controllerJobRoot, "prompt.md"),
        taskId: "infinity-context-controller-v1",
        accounts: ["account-a"],
        accessBoundary: AccessBoundary.ProjectScopedControl,
        networkAccess: NetworkAccessMode.Restricted,
        projectAccessScope: {
          projectId: "infinity-context",
          workspaceRoots: [sourceWorkspacePath],
          worktreeRoots: [join(root, "worktrees")],
          registryRoot: registryRootDir,
          jobIdPrefixes: ["infinity-context-"],
          tmuxSessionPrefixes: ["infinity-context-"],
          allowedAccountIds: ["account-missing", "account-a"],
        },
      });

      const result = await callToolJson(client, "codex_goal_project_refill_worker", {
        registryRootDir,
        controllerJobId: "infinity-context-controller-v1",
        jobId: "infinity-context-child-v1",
        jobRootDir: childJobRoot,
        authRootDir,
        sourceWorkspacePath,
        workspacePath: childWorkspace,
        promptBody: "Run a focused child worker and report cleanly.\n",
        taskId: "infinity-context-child-v1",
        accounts: ["account-missing", "account-a"],
        workerRole: "producer",
        startWorker: false,
        confirmRefill: true,
      });

      expect(result).toMatchObject({
        ok: true,
        manifest: {
          accounts: ["account-a"],
        },
      });
    } finally {
      await client.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stops no-tmux project workers as noop when no direct pid exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-project-stop-no-tmux-"));
    const registryRootDir = join(root, "worker-jobs", "registry");
    const authRootDir = join(root, "auth");
    const controllerJobRoot = join(root, "worker-jobs", "infinity-context-controller-v1");
    const controllerWorkspace = join(root, "workspaces", "infinity-context-controller");
    const childWorkspace = join(root, "worktrees", "infinity-context-child-v1");
    const childJobRoot = join(root, "worker-jobs", "infinity-context-child-v1");
    const childTaskId = "infinity-context-child-v1";
    const server = createCodexGoalMcpServer();
    const client = new Client({
      name: "subscription-runtime-test",
      version: "0.0.0",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await mkdir(controllerWorkspace, { recursive: true });
      await mkdir(childWorkspace, { recursive: true });
      await execFileAsync("git", ["init"], { cwd: childWorkspace });
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);

      await callToolJson(client, "codex_goal_create_job", {
        registryRootDir,
        jobId: "infinity-context-controller-v1",
        jobRootDir: controllerJobRoot,
        authRootDir,
        workspacePath: controllerWorkspace,
        promptPath: join(controllerJobRoot, "prompt.md"),
        taskId: "infinity-context-controller-v1",
        accounts: ["account-a"],
        accessBoundary: AccessBoundary.ProjectScopedControl,
        networkAccess: NetworkAccessMode.Restricted,
        projectAccessScope: {
          projectId: "infinity-context",
          workspaceRoots: [join(root, "workspaces")],
          worktreeRoots: [join(root, "worktrees")],
          registryRoot: registryRootDir,
          jobIdPrefixes: ["infinity-context-"],
          tmuxSessionPrefixes: ["infinity-context-"],
          allowedAccountIds: ["account-a"],
        },
      });
      await callToolJson(client, "codex_goal_project_create_job", {
        registryRootDir,
        controllerJobId: "infinity-context-controller-v1",
        jobId: "infinity-context-child-v1",
        jobRootDir: childJobRoot,
        authRootDir,
        workspacePath: childWorkspace,
        promptPath: join(childJobRoot, "prompt.md"),
        taskId: childTaskId,
        accounts: ["account-a"],
        workerRole: "reviewer",
        confirmCreate: true,
      });
      await removeStoredTmuxSession(registryRootDir, "infinity-context-child-v1");

      const preview = await callToolJson(client, "codex_goal_project_stop", {
        registryRootDir,
        controllerJobId: "infinity-context-controller-v1",
        jobId: "infinity-context-child-v1",
      });
      expect(preview).toMatchObject({
        ok: false,
        reason: "confirm_stop_required",
        stopCommand: "no direct process pid",
      });
      expect(preview).not.toHaveProperty("tmuxSession");

      const stopped = await callToolJson(client, "codex_goal_project_stop", {
        registryRootDir,
        controllerJobId: "infinity-context-controller-v1",
        jobId: "infinity-context-child-v1",
        confirmStop: true,
      });
      expect(stopped).toMatchObject({
        ok: true,
        mode: "project_control_stop",
        jobId: "infinity-context-child-v1",
        result: {
          status: "noop",
          resourceId: "no direct process pid",
          safeMessage: "Worker has no direct process pid to stop.",
        },
      });
      expect(stopped).not.toHaveProperty("tmuxSession");
      const stopEvent = JSON.parse(await readFile(String(stopped.stopEventPath), "utf8"));
      expect(stopEvent).toMatchObject({
        jobId: "infinity-context-child-v1",
        taskId: childTaskId,
        stopCommand: "no direct process pid",
        forceStop: false,
      });
      expect(stopEvent).not.toHaveProperty("tmuxSession");
    } finally {
      await client.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not stop fresh no-tmux project workers without force", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-project-stop-fresh-"));
    const registryRootDir = join(root, "worker-jobs", "registry");
    const authRootDir = join(root, "auth");
    const controllerJobRoot = join(root, "worker-jobs", "infinity-context-controller-v1");
    const controllerWorkspace = join(root, "workspaces", "infinity-context-controller");
    const childWorkspace = join(root, "worktrees", "infinity-context-child-v1");
    const childJobRoot = join(root, "worker-jobs", "infinity-context-child-v1");
    const childTaskId = "infinity-context-child-v1";
    const server = createCodexGoalMcpServer();
    const client = new Client({
      name: "subscription-runtime-test",
      version: "0.0.0",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await mkdir(controllerWorkspace, { recursive: true });
      await mkdir(childWorkspace, { recursive: true });
      await execFileAsync("git", ["init"], { cwd: childWorkspace });
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);

      await callToolJson(client, "codex_goal_create_job", {
        registryRootDir,
        jobId: "infinity-context-controller-v1",
        jobRootDir: controllerJobRoot,
        authRootDir,
        workspacePath: controllerWorkspace,
        promptPath: join(controllerJobRoot, "prompt.md"),
        taskId: "infinity-context-controller-v1",
        accounts: ["account-a"],
        accessBoundary: AccessBoundary.ProjectScopedControl,
        networkAccess: NetworkAccessMode.Restricted,
        projectAccessScope: {
          projectId: "infinity-context",
          workspaceRoots: [join(root, "workspaces")],
          worktreeRoots: [join(root, "worktrees")],
          registryRoot: registryRootDir,
          jobIdPrefixes: ["infinity-context-"],
          tmuxSessionPrefixes: ["infinity-context-"],
          allowedAccountIds: ["account-a"],
        },
      });
      await callToolJson(client, "codex_goal_project_create_job", {
        registryRootDir,
        controllerJobId: "infinity-context-controller-v1",
        jobId: "infinity-context-child-v1",
        jobRootDir: childJobRoot,
        authRootDir,
        workspacePath: childWorkspace,
        promptPath: join(childJobRoot, "prompt.md"),
        taskId: childTaskId,
        accounts: ["account-a"],
        workerRole: "reviewer",
        confirmCreate: true,
      });
      await removeStoredTmuxSession(registryRootDir, "infinity-context-child-v1");
      await mkdir(childJobRoot, { recursive: true });
      await writeFile(join(childJobRoot, `${childTaskId}.progress.json`), `${JSON.stringify({
        schemaVersion: 1,
        taskId: childTaskId,
        status: "running",
        updatedAt: new Date().toISOString(),
      })}\n`);

      const stopped = await callToolJson(client, "codex_goal_project_stop", {
        registryRootDir,
        controllerJobId: "infinity-context-controller-v1",
        jobId: "infinity-context-child-v1",
        confirmStop: true,
      });
      expect(stopped).toMatchObject({
        ok: false,
        reason: "worker_not_silent_stale_or_heartbeat_only_no_output",
        requiredOverride: "forceStop",
        stopCommand: "no direct process pid",
        brief: {
          workerAlive: true,
          heartbeatOnlyNoOutput: false,
        },
      });
      expect(stopped).not.toHaveProperty("tmuxSession");
    } finally {
      await client.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
