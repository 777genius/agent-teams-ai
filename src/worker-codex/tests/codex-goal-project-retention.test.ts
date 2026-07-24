import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import {
  projectScopedControllerToolNames,
  type ProjectAccessScope,
} from "@vioxen/subscription-runtime/worker-core";
import { createCodexGoalMcpServer } from "../codex-goal-mcp";
import {
  projectRetentionTerminalEvidenceForConsumedStatus,
  projectRetentionWorktreeRemoveArgs,
  resolveProjectRetentionCanonicalCommit,
} from "../codex-goal-project-retention";
import {
  projectControlWorkspaceLocks,
  withProjectWorkspaceLockIfPresent,
  withValidatedProjectWorkspaceLock,
} from "../codex-goal-project-workspace-lock";
import {
  createOrReuseProjectControlOperation,
  projectControlOperationsRoot,
} from "../project-control-operation-lifecycle";

const execFileAsync = promisify(execFile);

describe("project retention git command", () => {
  it("registers the cleanup tool in the MCP server and controller allowlist", async () => {
    const client = new Client({
      name: "project-retention-test",
      version: "0.0.0",
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const server = createCodexGoalMcpServer();
    try {
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain(
        "codex_goal_project_cleanup_worktrees",
      );
      expect(projectScopedControllerToolNames()).toContain(
        "codex_goal_project_cleanup_worktrees",
      );
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("uses git worktree remove without a force flag", () => {
    const args = projectRetentionWorktreeRemoveArgs({
      canonicalWorkspacePath: "/project/source",
      workspacePath: "/project/worktrees/worker-1",
    });

    expect(args).toEqual([
      "-C",
      "/project/source",
      "worktree",
      "remove",
      "/project/worktrees/worker-1",
    ]);
    expect(args).not.toContain("--force");
    expect(args).not.toContain("-f");
  });

  it("binds cleanup to the authoritative controller HEAD and rejects caller drift", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-retention-head-"));
    try {
      await git(root, ["init"]);
      await git(root, ["config", "user.name", "Retention Test"]);
      await git(root, ["config", "user.email", "retention@example.invalid"]);
      await writeFile(join(root, "README.md"), "canonical\n");
      await git(root, ["add", "README.md"]);
      await git(root, ["commit", "-m", "test: seed canonical"]);
      const head = await git(root, ["rev-parse", "HEAD"]);

      await expect(resolveProjectRetentionCanonicalCommit({
        canonicalWorkspacePath: root,
      })).resolves.toBe(head);
      await expect(resolveProjectRetentionCanonicalCommit({
        canonicalWorkspacePath: root,
        expectedCanonicalCommit: "f".repeat(40),
      })).rejects.toThrow(
        "project_retention_expected_canonical_commit_mismatch",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts only valid consumed-output ledger statuses as terminal evidence", () => {
    expect(projectRetentionTerminalEvidenceForConsumedStatus("completed"))
      .toBeUndefined();
    expect(projectRetentionTerminalEvidenceForConsumedStatus("integrated"))
      .toBe("consumed");
    expect(
      projectRetentionTerminalEvidenceForConsumedStatus("reviewed_no_change"),
    ).toBe("reviewed");
    expect(
      projectRetentionTerminalEvidenceForConsumedStatus("failed_no_output"),
    ).toBe("failed_no_output");
  });

  it("prevents operation publication between retention reinspection and removal", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-retention-race-"));
    const workspacePath = join(root, "worktrees", "worker-1");
    const registryRootDir = join(root, "worker-jobs", "registry");
    const operationsRootDir = projectControlOperationsRoot(
      join(root, "worker-jobs", "controller"),
    );
    const locks = projectControlWorkspaceLocks(registryRootDir);
    const scope: ProjectAccessScope = {
      projectId: "project-1",
      registryRoot: registryRootDir,
      workspaceRoots: [join(root, "workspaces")],
      worktreeRoots: [join(root, "worktrees")],
    };
    let releaseRetention!: () => void;
    const retentionMayFinish = new Promise<void>((resolve) => {
      releaseRetention = resolve;
    });
    let retentionEntered!: () => void;
    const retentionDidEnter = new Promise<void>((resolve) => {
      retentionEntered = resolve;
    });
    try {
      await mkdir(workspacePath, { recursive: true });
      const retention = withValidatedProjectWorkspaceLock({
        locks,
        scope,
        requestedWorkspacePath: workspacePath,
        owner: "project-retention:controller:worker-1",
        effect: async () => {
          retentionEntered();
          await retentionMayFinish;
        },
      });
      await retentionDidEnter;

      await expect(withProjectWorkspaceLockIfPresent({
        locks,
        scope,
        requestedWorkspacePath: workspacePath,
        owner: "project-operation-create:controller:worker-1",
        effect: async () =>
          await createOrReuseProjectControlOperation({
            operationsRootDir,
            controllerJobId: "controller",
            toolName: "codex_goal_project_refill_worker",
            args: { executionMode: "sync" },
            targetJobId: "worker-1",
          }),
      })).rejects.toMatchObject({ code: "safe_execution_workspace_locked" });
      await expect(access(operationsRootDir)).rejects.toMatchObject({
        code: "ENOENT",
      });

      releaseRetention();
      await retention;
    } finally {
      releaseRetention?.();
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd });
  return result.stdout.trim();
}
