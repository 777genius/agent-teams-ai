import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import {
  AccessBoundary,
  NetworkAccessMode,
} from "@vioxen/subscription-runtime/worker-core";
import { createCodexGoalMcpServer } from "../codex-goal-mcp";
import { captureGitWorkspacePatch } from "../codex-goal-runtime-result-io";
import {
  callToolJson,
  git,
  gitInitRepository,
  gitStdout,
  writeFakeAuth,
} from "./codex-goal-mcp-test-support";

describe("project refill adoption", () => {
  it("adopts a dirty exact-identity worktree through serial pre-start admission", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "subscription-runtime-project-refill-adoption-"),
    );
    const registryRootDir = join(root, "worker-jobs", "registry");
    const controllerJobRoot = join(
      root,
      "worker-jobs",
      "infinity-context-controller-v1",
    );
    const sourceWorkspacePath = join(
      root,
      "workspaces",
      "infinity-context-main",
    );
    const childWorkspace = join(
      root,
      "worktrees",
      "infinity-context-adoption-v1",
    );
    const childBranch = "fix/infinity-context-adoption-v1";
    const childJobRoot = join(
      root,
      "worker-jobs",
      "infinity-context-adoption-v1",
    );
    const authRootDir = join(root, "auth");
    const server = createCodexGoalMcpServer();
    const client = new Client({
      name: "subscription-runtime-test",
      version: "0.0.0",
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    try {
      await mkdir(sourceWorkspacePath, { recursive: true });
      await gitInitRepository(sourceWorkspacePath);
      await writeFile(join(sourceWorkspacePath, "README.md"), "base\n");
      await writeFile(join(sourceWorkspacePath, "controller.md"), "controller\n");
      await writeFile(join(sourceWorkspacePath, "lane.md"), "lane\n");
      await mkdir(join(sourceWorkspacePath, "sandbox"));
      await writeFile(join(sourceWorkspacePath, "sandbox", ".keep"), "");
      await git(sourceWorkspacePath, ["add", "."]);
      await git(sourceWorkspacePath, ["commit", "-m", "test: base"]);
      const baseSha = (await gitStdout(
        sourceWorkspacePath,
        ["rev-parse", "HEAD"],
      )).trim();
      await git(sourceWorkspacePath, [
        "update-ref",
        "refs/remotes/origin/main",
        baseSha,
      ]);
      await git(sourceWorkspacePath, [
        "worktree",
        "add",
        "-b",
        childBranch,
        childWorkspace,
        baseSha,
      ]);
      await writeFile(join(childWorkspace, "README.md"), "preserved dirty output\n");
      const inputPatchHash = createHash("sha256")
        .update(await captureGitWorkspacePatch({ workspacePath: childWorkspace }))
        .digest("hex");
      await writeFakeAuth(authRootDir, "account-a", {
        lastRefresh: new Date().toISOString(),
      });

      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);

      const tools = await client.listTools();
      const refillTool = tools.tools.find(
        (tool) => tool.name === "codex_goal_project_refill_worker",
      );
      const workerRoleSchema = refillTool?.inputSchema.properties
        ?.workerRole as { readonly enum?: readonly string[] } | undefined;
      expect(workerRoleSchema?.enum).toContain("adoption");

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
          authRoot: authRootDir,
          jobIdPrefixes: ["infinity-context-"],
          tmuxSessionPrefixes: ["infinity-context-"],
          allowedBranches: ["main", "HEAD", "fix/infinity-context-*"],
          allowedGitRemotes: ["origin"],
          allowedAccountIds: ["account-a"],
          deniedRoots: [join(root, "real-user-project")],
          preStartAdmission: {
            required: true,
            mode: "serial-builtin",
          },
        },
      });

      const contract = {
        kind: "worker-launch",
        format: 1,
        canonicalSha: baseSha,
        baseSha,
        phaseStartSha: baseSha,
        packetRevision: "phase-01-adoption-r1",
        controllerPacket: "controller.md",
        lanePacket: "lane.md",
        phaseId: "phase-01",
        laneId: "p1-adoption",
        inputPatchHash,
        reviewKind: "remediation",
        ownedPaths: ["README.md"],
        mandatoryDocs: ["README.md", "controller.md", "lane.md"],
        mandatoryScripts: [],
        mandatoryFixtures: [],
        requiredChecks: [
          { id: "focused", cwd: "sandbox", command: "true" },
        ],
        executionPolicy: {
          mode: "sandbox-only",
          sandboxRoot: join(childWorkspace, "sandbox"),
          forbiddenRealProjects: [join(root, "real-user-project")],
        },
      };
      const mismatched = await callToolJson(
        client,
        "codex_goal_project_refill_worker",
        {
          registryRootDir,
          controllerJobId: "infinity-context-controller-v1",
          jobId: "infinity-context-adoption-mismatch-v1",
          jobRootDir: join(
            root,
            "worker-jobs",
            "infinity-context-adoption-mismatch-v1",
          ),
          authRootDir,
          sourceWorkspacePath,
          sourceRef: "main",
          newBranch: childBranch,
          workspacePath: childWorkspace,
          promptBody: "Reject a mismatched adoption patch.\n",
          taskId: "infinity-context-adoption-mismatch-v1",
          accounts: ["account-a"],
          workerRole: "adoption",
          preStartAdmission: {
            mode: "serial-builtin",
            contract: { ...contract, inputPatchHash: "0".repeat(64) },
          },
          confirmPreStartAdmission: true,
          startWorker: false,
          dependencyBootstrap: "off",
          confirmRefill: true,
        },
      );
      expect(mismatched).toEqual({
        ok: false,
        error: "project_control_pre_start_input_patch_hash_mismatch; rollback=prompt",
      });

      const result = await callToolJson(
        client,
        "codex_goal_project_refill_worker",
        {
          registryRootDir,
          controllerJobId: "infinity-context-controller-v1",
          jobId: "infinity-context-adoption-v1",
          jobRootDir: childJobRoot,
          authRootDir,
          sourceWorkspacePath,
          sourceRef: "main",
          newBranch: childBranch,
          workspacePath: childWorkspace,
          promptBody: "Adopt and remediate preserved output.\n",
          taskId: "infinity-context-adoption-v1",
          accounts: ["account-a"],
          workerRole: "adoption",
          preStartAdmission: {
            mode: "serial-builtin",
            contract,
          },
          confirmPreStartAdmission: true,
          startWorker: false,
          dependencyBootstrap: "off",
          confirmRefill: true,
        },
      );
      if (result.ok !== true) throw new Error(JSON.stringify(result));

      expect(result).toMatchObject({
        ok: true,
        mode: "project_control_refill_worker",
        workerRole: "adoption",
        worktree: { status: "noop" },
        manifest: {
          tags: expect.arrayContaining([
            "project-control-refill",
            "worker-role-adoption",
          ]),
        },
      });
      await expect(readFile(join(childWorkspace, "README.md"), "utf8"))
        .resolves.toBe("preserved dirty output\n");
      await expect(gitStdout(childWorkspace, ["status", "--porcelain"]))
        .resolves.toContain("README.md");
    } finally {
      await client.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
