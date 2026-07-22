import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  AccessBoundary,
  NetworkAccessMode,
} from "@vioxen/subscription-runtime/worker-core";
import { createCodexGoalMcpServer } from "../codex-goal-mcp";
import {
  callToolJson,
  git,
  gitInitRepository,
  gitStdout,
} from "./codex-goal-mcp-test-support";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("project merge-bound refill", () => {
  it("documents runtime-owned source pinning for both atomic merge tools", async () => {
    const server = createCodexGoalMcpServer();
    const client = new Client({
      name: "merge-binding-schema-test",
      version: "0.0.0",
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);
      const tools = await client.listTools();
      for (const toolName of [
        "codex_goal_project_refill_worker",
        "codex_goal_project_prepare_verifier",
      ]) {
        const tool = tools.tools.find((candidate) => candidate.name === toolName);
        const mergeBinding = (
          tool?.inputSchema as {
            readonly properties?: Readonly<Record<
              string,
              { readonly description?: string }
            >>;
          } | undefined
        )?.properties?.mergeBinding;
        expect(mergeBinding?.description).toContain(
          "omitted expectedSourceCommit",
        );
        expect(mergeBinding?.description).toContain(
          "runtime resolves and pins both commits",
        );
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("rejects verifier merge conflicts before durable operation creation", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-verifier-merge-validation-"));
    roots.push(root);
    const server = createCodexGoalMcpServer();
    const client = new Client({ name: "merge-validation-test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const controllerId = "test-controller";
    const controllerRoot = join(root, "controller");
    const source = join(root, "source");
    const registry = join(root, "registry");
    const operationsRoot = join(controllerRoot, "project-control-operations");
    const admission = {
      mode: "serial-builtin" as const,
      contract: launchContract(root, join(root, "verifier")),
    };
    const mergeBinding = { sourceRemote: "origin", sourceBranch: "feature/source" };
    const conflicts = [
      {
        expectedSourceCommit: "a".repeat(40),
        message: "project_control_merge_binding_expected_source_conflict",
      },
      {
        preStartAdmission: {
          ...admission,
          contract: { ...admission.contract, canonicalSha: "b".repeat(40) },
        },
        message: "project_control_merge_binding_canonicalSha_must_be_omitted",
      },
      {
        preStartAdmission: {
          ...admission,
          contract: { ...admission.contract, phaseStartSha: "c".repeat(40) },
        },
        message: "project_control_merge_binding_phaseStartSha_must_be_omitted",
      },
      {
        preStartAdmission: {
          ...admission,
          contract: {
            ...admission.contract,
            merge: {
              sourceRemote: "origin",
              sourceBranch: "feature/source",
              sourceCommit: "d".repeat(40),
              expectedTargetCommit: "e".repeat(40),
            },
          },
        },
        message: "project_control_merge_binding_merge_override_denied",
      },
    ];
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      await mkdir(source, { recursive: true });
      await callToolJson(client, "codex_goal_create_job", {
        registryRootDir: registry,
        jobId: controllerId,
        jobRootDir: controllerRoot,
        authRootDir: join(root, "auth"),
        workspacePath: source,
        promptPath: join(controllerRoot, "prompt.md"),
        taskId: controllerId,
        accounts: ["account-a"],
        accessBoundary: AccessBoundary.ProjectScopedControl,
        networkAccess: NetworkAccessMode.Restricted,
        projectAccessScope: {
          projectId: "test",
          workspaceRoots: [source],
          worktreeRoots: [join(root, "worktrees")],
          registryRoot: registry,
          jobIdPrefixes: ["test-"],
          tmuxSessionPrefixes: ["test-"],
          allowedBranches: ["main", "feature/*"],
          allowedGitRemotes: ["origin"],
          allowedAccountIds: ["account-a"],
          preStartAdmission: { required: true, mode: "serial-builtin" },
        },
      });
      for (const { message, ...conflict } of conflicts) {
        const result = await client.callTool({
          name: "codex_goal_project_prepare_verifier",
          arguments: {
            registryRootDir: registry,
            controllerJobId: controllerId,
            mergeBinding,
            requireCanonicalRemoteHead: true,
            executionMode: "bounded",
            confirmRefill: true,
            ...conflict,
          },
        });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain(message);
      }
      await expect(access(operationsRoot)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("materializes immutable divergent parents and reuses them on retry", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-merge-refill-"));
    roots.push(root);
    const source = join(root, "source");
    const remote = join(root, "origin.git");
    const registry = join(root, "worker-jobs", "registry");
    const controllerId = "test-controller";
    const workerId = "test-merge-worker";
    const workerRoot = join(root, "worker-jobs", workerId);
    const workerWorkspace = join(root, "worktrees", workerId);
    await mkdir(source, { recursive: true });
    await gitInitRepository(source);
    await Promise.all([
      writeFile(join(source, "controller.md"), "controller\n"),
      writeFile(join(source, "lane.md"), "lane\n"),
      writeFile(join(source, "README.md"), "base\n"),
      mkdir(join(source, "sandbox")),
    ]);
    await writeFile(join(source, "sandbox", ".keep"), "");
    await git(source, ["add", "."]);
    await git(source, ["commit", "-m", "test: target"]);
    const targetCommit = (await gitStdout(source, ["rev-parse", "HEAD"])).trim();
    await git(root, ["init", "--bare", remote]);
    await git(source, ["remote", "add", "origin", remote]);
    await git(source, ["push", "origin", "main"]);
    await git(source, ["switch", "-c", "base/current"]);
    await writeFile(join(source, "source.md"), "source\n");
    await git(source, ["add", "source.md"]);
    await git(source, ["commit", "-m", "test: source"]);
    const sourceCommit = (await gitStdout(source, ["rev-parse", "HEAD"])).trim();
    await git(source, ["push", "origin", "base/current"]);
    await git(source, ["switch", "main"]);

    const server = createCodexGoalMcpServer();
    const client = new Client({ name: "merge-refill-test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      await callToolJson(client, "codex_goal_create_job", {
        registryRootDir: registry,
        jobId: controllerId,
        jobRootDir: join(root, "worker-jobs", controllerId),
        authRootDir: join(root, "auth"),
        workspacePath: source,
        promptPath: join(root, "worker-jobs", controllerId, "prompt.md"),
        taskId: controllerId,
        accounts: ["account-a"],
        accessBoundary: AccessBoundary.ProjectScopedControl,
        networkAccess: NetworkAccessMode.Restricted,
        projectAccessScope: {
          projectId: "test",
          workspaceRoots: [source],
          worktreeRoots: [join(root, "worktrees")],
          registryRoot: registry,
          authRoot: join(root, "auth"),
          jobIdPrefixes: ["test-"],
          tmuxSessionPrefixes: ["test-"],
          allowedBranches: ["main", "base/*", "test/*"],
          allowedGitRemotes: ["origin"],
          allowedAccountIds: ["account-a"],
          preStartAdmission: { required: true, mode: "serial-builtin" },
        },
      });
      const request = {
        registryRootDir: registry,
        controllerJobId: controllerId,
        jobId: workerId,
        jobRootDir: workerRoot,
        authRootDir: join(root, "auth"),
        sourceWorkspacePath: source,
        baseBranch: "main",
        requireCanonicalRemoteHead: true,
        mergeBinding: { sourceRemote: "origin", sourceBranch: "base/current" },
        newBranch: "test/merge-worker",
        workspacePath: workerWorkspace,
        promptBody: "Resolve merge.\n",
        taskId: workerId,
        accounts: ["account-a"],
        workerRole: "fastgate",
        preStartAdmission: {
          mode: "serial-builtin",
          contract: launchContract(root, workerWorkspace),
        },
        confirmPreStartAdmission: true,
        startWorker: false,
        confirmRefill: true,
      };
      const result = await callToolJson(client, "codex_goal_project_refill_worker", request);
      expect(result).toMatchObject({ ok: true, canonicalRemoteHead: { oid: targetCommit } });
      const contract = JSON.parse(await readFile(
        join(workerRoot, "pre-start-admission", "contract.json"), "utf8",
      ));
      expect(contract).toMatchObject({
        canonicalSha: targetCommit,
        phaseStartSha: targetCommit,
        merge: { sourceCommit, expectedTargetCommit: targetCommit },
      });
      const receipt = JSON.parse(await readFile(
        join(workerRoot, "pre-start-admission", "receipt.json"), "utf8",
      ));
      expect(receipt.merge).toEqual(contract.merge);
      expect(await readFile(join(workerRoot, "prompt.md"), "utf8"))
        .toContain(`- source commit: ${sourceCommit}`);
      expect(await callToolJson(client, "codex_goal_project_refill_worker", request))
        .toMatchObject({ ok: true, worktree: { status: "noop" } });
    } finally {
      await client.close();
      await server.close();
    }
  });
});

function launchContract(root: string, workspace: string) {
  return {
    kind: "worker-launch",
    format: 1,
    baseSha: "1".repeat(40),
    packetRevision: "phase-01-r1",
    controllerPacket: "controller.md",
    lanePacket: "lane.md",
    phaseId: "phase-01",
    laneId: "merge",
    inputPatchHash: null,
    reviewKind: "implementation",
    ownedPaths: ["source.md"],
    mandatoryDocs: ["controller.md", "lane.md"],
    mandatoryScripts: [],
    mandatoryFixtures: [],
    requiredChecks: [{ id: "focused", cwd: "sandbox", command: "true" }],
    executionPolicy: {
      mode: "sandbox-only",
      sandboxRoot: join(workspace, "sandbox"),
      forbiddenRealProjects: [join(root, "real")],
    },
  };
}
