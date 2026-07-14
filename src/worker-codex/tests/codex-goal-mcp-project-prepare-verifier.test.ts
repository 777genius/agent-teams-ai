import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import {
  AccessBoundary,
  NetworkAccessMode,
  type ProjectAccessScope,
} from "@vioxen/subscription-runtime/worker-core";
import { materializeCodexGoalHandoffArtifacts } from "../codex-goal-handoff-artifacts";
import {
  codexGoalJobManifestPath,
  parseCodexGoalJobManifest,
} from "../codex-goal-jobs";
import { createCodexGoalMcpServer } from "../codex-goal-mcp";
import { assertProjectPreStartAdmissionLaunchBinding } from "../application/project-control/codex-goal-project-pre-start-admission";
import {
  callToolJson,
  git,
  gitInitRepository,
  gitStdout,
} from "./codex-goal-mcp-test-support";

describe("project verifier preparation", () => {
  it.each(["sync", "bounded"] as const)(
    "uses remote HEAD when the local tracking ref is stale (%s)",
    async (executionMode) => {
      const root = await mkdtemp(join(tmpdir(), "verifier-remote-head-"));
      const registryRootDir = join(root, "worker-jobs", "registry");
      const controllerJobRoot = join(root, "worker-jobs", "controller");
      const producerJobRoot = join(root, "worker-jobs", "producer");
      const sourceWorkspacePath = join(root, "workspaces", "canonical");
      const producerWorkspacePath = join(root, "worktrees", "producer");
      const verifierWorkspacePath = join(root, "worktrees", "verifier");
      const remotePath = join(root, "remote.git");
      const server = createCodexGoalMcpServer();
      const client = new Client({ name: "test", version: "0.0.0" });
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      const previousRunnerPath =
        process.env.SUBSCRIPTION_RUNTIME_PROJECT_CONTROL_OPERATION_CLI_PATH;

      try {
        await git(root, ["init", "--bare", remotePath]);
        await mkdir(sourceWorkspacePath, { recursive: true });
        await gitInitRepository(sourceWorkspacePath);
        await Promise.all([
          writeFile(join(sourceWorkspacePath, "README.md"), "base\n"),
          writeFile(join(sourceWorkspacePath, "controller.md"), "controller\n"),
          writeFile(join(sourceWorkspacePath, "lane.md"), "lane\n"),
          writeFile(join(sourceWorkspacePath, "feature.txt"), "base\n"),
          mkdir(join(sourceWorkspacePath, "checks")),
        ]);
        await writeFile(join(sourceWorkspacePath, "checks", ".keep"), "");
        await git(sourceWorkspacePath, ["add", "."]);
        await git(sourceWorkspacePath, ["commit", "-m", "test: base"]);
        const producerBase = await revision(sourceWorkspacePath);
        await git(sourceWorkspacePath, ["remote", "add", "origin", remotePath]);
        await git(sourceWorkspacePath, ["push", "-u", "origin", "HEAD:main"]);

        await git(root, ["clone", sourceWorkspacePath, producerWorkspacePath]);
        await git(producerWorkspacePath, [
          "config",
          "user.email",
          "test@example.com",
        ]);
        await git(producerWorkspacePath, ["config", "user.name", "Test User"]);
        await writeFile(
          join(producerWorkspacePath, "feature.txt"),
          "producer\n",
        );
        const handoff = await materializeCodexGoalHandoffArtifacts({
          workerJobId: "project-producer",
          taskId: "project-producer",
          workspacePath: producerWorkspacePath,
          jobRootDir: producerJobRoot,
        });
        if (!handoff) throw new Error("expected producer handoff");

        await writeFile(join(sourceWorkspacePath, "router.md"), "current\n");
        await git(sourceWorkspacePath, ["add", "router.md"]);
        await git(sourceWorkspacePath, [
          "commit",
          "-m",
          "docs: advance canonical",
        ]);
        const canonicalSha = await revision(sourceWorkspacePath);
        await git(sourceWorkspacePath, ["push", "origin", "HEAD:main"]);
        await git(sourceWorkspacePath, [
          "update-ref",
          "refs/remotes/origin/main",
          producerBase,
        ]);

        if (executionMode === "bounded") {
          const fakeRunnerPath = join(root, "fake-operation-runner.mjs");
          await writeFile(
            fakeRunnerPath,
            `#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
const file = process.argv[process.argv.indexOf("--operation-file") + 1];
const operation = JSON.parse(await readFile(file, "utf8"));
const now = new Date().toISOString();
operation.status = "completed";
operation.runningAt = now;
operation.completedAt = now;
operation.updatedAt = now;
operation.result = { ok: true, mode: "fake_verifier_operation" };
await writeFile(file, JSON.stringify(operation, null, 2) + "\\n");
`,
          );
          await chmod(fakeRunnerPath, 0o755);
          process.env.SUBSCRIPTION_RUNTIME_PROJECT_CONTROL_OPERATION_CLI_PATH =
            fakeRunnerPath;
        }

        await Promise.all([
          server.connect(serverTransport),
          client.connect(clientTransport),
        ]);
        await createProducerJob({
          client,
          root,
          registryRootDir,
          producerJobRoot,
          producerWorkspacePath,
        });
        await createControllerJob({
          client,
          root,
          registryRootDir,
          controllerJobRoot,
          sourceWorkspacePath,
        });

        if (executionMode === "sync") {
          await expect(
            prepareVerifier({
              client,
              root,
              registryRootDir,
              sourceWorkspacePath,
              verifierWorkspacePath,
              producerBase,
              canonicalSha,
              patchSha256: handoff.manifest.artifacts.patch.sha256,
              executionMode,
              jobId: "project-denied-verifier",
              baseBranch: "blocked/main",
            }),
          ).rejects.toThrow(/project_control_denied:remote_denied/);
        }

        const result = await prepareVerifier({
          client,
          root,
          registryRootDir,
          sourceWorkspacePath,
          verifierWorkspacePath,
          producerBase,
          canonicalSha,
          patchSha256: handoff.manifest.artifacts.patch.sha256,
          executionMode,
        });

        expect(result).toMatchObject({
          ok: true,
          mode: "project_control_prepare_verifier",
        });
        if (executionMode === "sync") {
          expect(result).toMatchObject({
            worktree: { status: "applied" },
            startSkipped: true,
            canonicalRemoteHead: { oid: canonicalSha },
          });
          expect(await revision(verifierWorkspacePath)).toBe(canonicalSha);
          const verifierManifest = parseCodexGoalJobManifest(
            JSON.parse(
              await readFile(
                codexGoalJobManifestPath({
                  registryRootDir,
                  jobId: "project-verifier",
                }),
                "utf8",
              ),
            ),
          );
          const scope = projectScope({
            root,
            registryRootDir,
            sourceWorkspacePath,
          });
          await expect(
            assertProjectPreStartAdmissionLaunchBinding({
              manifest: verifierManifest,
              scope,
              workspaceMode: "admitted_input_patch",
            }),
          ).resolves.toBeUndefined();

          await writeFile(
            join(verifierWorkspacePath, "feature.txt"),
            "unstaged drift\n",
          );
          await expect(
            assertProjectPreStartAdmissionLaunchBinding({
              manifest: verifierManifest,
              scope,
              workspaceMode: "admitted_input_patch",
            }),
          ).rejects.toThrow(
            "project_control_pre_start_launch_binding_mismatch",
          );

          await writeFile(
            join(verifierWorkspacePath, "feature.txt"),
            "producer\n",
          );
          await writeFile(
            join(verifierWorkspacePath, "UNTRACKED.txt"),
            "untracked drift\n",
          );
          await expect(
            assertProjectPreStartAdmissionLaunchBinding({
              manifest: verifierManifest,
              scope,
              workspaceMode: "admitted_input_patch",
            }),
          ).rejects.toThrow(
            "project_control_pre_start_launch_binding_mismatch",
          );
        } else {
          expect(result).toMatchObject({
            executionMode: "bounded",
            operationId: expect.any(String),
          });
        }
      } finally {
        if (previousRunnerPath === undefined) {
          delete process.env
            .SUBSCRIPTION_RUNTIME_PROJECT_CONTROL_OPERATION_CLI_PATH;
        } else {
          process.env.SUBSCRIPTION_RUNTIME_PROJECT_CONTROL_OPERATION_CLI_PATH =
            previousRunnerPath;
        }
        await Promise.allSettled([client.close(), server.close()]);
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});

async function createProducerJob(input: {
  readonly client: Client;
  readonly root: string;
  readonly registryRootDir: string;
  readonly producerJobRoot: string;
  readonly producerWorkspacePath: string;
}): Promise<void> {
  const result = await callToolJson(input.client, "codex_goal_create_job", {
    registryRootDir: input.registryRootDir,
    jobId: "project-producer",
    jobRootDir: input.producerJobRoot,
    authRootDir: join(input.root, "auth"),
    workspacePath: input.producerWorkspacePath,
    promptPath: join(input.producerJobRoot, "prompt.md"),
    taskId: "project-producer",
    accounts: ["account-a"],
    accessBoundary: AccessBoundary.IsolatedWorkspaceWrite,
    networkAccess: NetworkAccessMode.Restricted,
    projectAccessScope: {
      projectId: "project",
      workspaceRoots: [input.producerWorkspacePath],
      isolatedWorkspaceRoot: input.producerWorkspacePath,
      registryRoot: input.registryRootDir,
      authRoot: join(input.root, "auth"),
      allowedAccountIds: ["account-a"],
      deniedRoots: [join(input.root, "real-user-project")],
    },
  });
  if (result.ok !== true) throw new Error(JSON.stringify(result));
}

async function createControllerJob(input: {
  readonly client: Client;
  readonly root: string;
  readonly registryRootDir: string;
  readonly controllerJobRoot: string;
  readonly sourceWorkspacePath: string;
}): Promise<void> {
  const result = await callToolJson(input.client, "codex_goal_create_job", {
    registryRootDir: input.registryRootDir,
    jobId: "project-controller",
    jobRootDir: input.controllerJobRoot,
    authRootDir: join(input.root, "auth"),
    workspacePath: input.sourceWorkspacePath,
    promptPath: join(input.controllerJobRoot, "prompt.md"),
    taskId: "project-controller",
    accounts: ["account-a"],
    accessBoundary: AccessBoundary.ProjectScopedControl,
    networkAccess: NetworkAccessMode.Restricted,
    projectAccessScope: projectScope(input),
  });
  if (result.ok !== true) throw new Error(JSON.stringify(result));
}

function projectScope(input: {
  readonly root: string;
  readonly registryRootDir: string;
  readonly sourceWorkspacePath: string;
}): ProjectAccessScope {
  return {
    projectId: "project",
    workspaceRoots: [input.sourceWorkspacePath],
    worktreeRoots: [join(input.root, "worktrees")],
    registryRoot: input.registryRootDir,
    authRoot: join(input.root, "auth"),
    jobIdPrefixes: ["project-"],
    tmuxSessionPrefixes: ["project-"],
    allowedBranches: ["main", "origin/main", "review/*"],
    allowedGitRemotes: ["origin"],
    allowedAccountIds: ["account-a"],
    deniedRoots: [join(input.root, "real-user-project")],
    preStartAdmission: { required: true, mode: "serial-builtin" },
  };
}

async function prepareVerifier(input: {
  readonly client: Client;
  readonly root: string;
  readonly registryRootDir: string;
  readonly sourceWorkspacePath: string;
  readonly verifierWorkspacePath: string;
  readonly producerBase: string;
  readonly canonicalSha: string;
  readonly patchSha256: string;
  readonly executionMode: "sync" | "bounded";
  readonly jobId?: string;
  readonly baseBranch?: string;
}): Promise<Record<string, unknown>> {
  const jobId = input.jobId ?? "project-verifier";
  const response = await input.client.callTool({
    name: "codex_goal_project_prepare_verifier",
    arguments: {
      registryRootDir: input.registryRootDir,
      controllerJobId: "project-controller",
      producerJobId: "project-producer",
      jobId,
      taskId: jobId,
      sourceWorkspacePath: input.sourceWorkspacePath,
      baseBranch: input.baseBranch ?? "origin/main",
      newBranch: "review/verifier",
      workspacePath: input.verifierWorkspacePath,
      promptBody: "Review immutable producer output.\n",
      accounts: ["account-a"],
      workerRole: "reviewer",
      preStartAdmission: {
        mode: "serial-builtin",
        contract: {
          kind: "worker-launch",
          format: 1,
          canonicalSha: input.canonicalSha,
          baseSha: input.producerBase,
          phaseStartSha: input.canonicalSha,
          packetRevision: "review-r1",
          controllerPacket: "controller.md",
          lanePacket: "lane.md",
          phaseId: "phase-01",
          laneId: "review",
          inputPatchHash: input.patchSha256,
          reviewKind: "review",
          ownedPaths: ["feature.txt"],
          mandatoryDocs: ["README.md", "controller.md", "lane.md"],
          mandatoryScripts: [],
          mandatoryFixtures: [],
          requiredChecks: [
            {
              id: "focused",
              cwd: "checks",
              command: "cd .. && git diff --check",
            },
          ],
          executionPolicy: {
            mode: "sandbox-only",
            sandboxRoot: input.verifierWorkspacePath,
            forbiddenRealProjects: [join(input.root, "real-user-project")],
          },
        },
      },
      confirmPreStartAdmission: true,
      startWorker: false,
      executionMode: input.executionMode,
      confirmRefill: true,
    },
  });
  const text = (
    response as { readonly content?: readonly { readonly text?: string }[] }
  ).content?.[0]?.text;
  if (!text?.startsWith("{")) throw new Error(text ?? "missing response");
  const result = JSON.parse(text) as Record<string, unknown>;
  if (result.ok !== true) throw new Error(JSON.stringify(result));
  return result;
}

async function revision(workspacePath: string): Promise<string> {
  return (await gitStdout(workspacePath, ["rev-parse", "HEAD"])).trim();
}
