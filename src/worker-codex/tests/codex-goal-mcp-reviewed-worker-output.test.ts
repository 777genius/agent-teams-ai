import { createHash } from "node:crypto";
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
import { captureGitWorkspacePatch } from "../codex-goal-runtime-result-io";
import {
  callToolJson,
  git,
  gitInitRepository,
} from "./codex-goal-mcp-test-support";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

describe("Codex project reviewed worker output", () => {
  it("captures through mark_reviewed and resolves through open_integration_attempt", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-reviewed-mcp-"));
    roots.push(root);
    const registryRootDir = join(root, "worker-jobs", "registry");
    const controllerJobId = "project-controller";
    const workerJobId = "project-worker";
    const controllerJobRoot = join(root, "worker-jobs", controllerJobId);
    const workerJobRoot = join(root, "worker-jobs", workerJobId);
    const workerWorkspacePath = join(root, "worktrees", workerJobId);
    const targetWorkspacePath = join(root, "workspaces", "canonical");
    await Promise.all([
      mkdir(workerWorkspacePath, { recursive: true }),
      mkdir(targetWorkspacePath, { recursive: true }),
    ]);
    await gitInitRepository(workerWorkspacePath);
    await gitInitRepository(targetWorkspacePath);
    await mkdir(join(workerWorkspacePath, "docs"), { recursive: true });
    await writeFile(join(workerWorkspacePath, "docs", "packet.md"), "base\n");
    await git(workerWorkspacePath, ["add", "."]);
    await git(workerWorkspacePath, ["commit", "-m", "test: base"]);
    await writeFile(join(workerWorkspacePath, "docs", "packet.md"), "accepted output\n");
    const patch = await captureGitWorkspacePatch({ workspacePath: workerWorkspacePath });

    const server = createCodexGoalMcpServer();
    const client = new Client({ name: "reviewed-output-test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);
      await callToolJson(client, "codex_goal_create_job", {
        registryRootDir,
        jobId: workerJobId,
        jobRootDir: workerJobRoot,
        authRootDir: join(root, "auth"),
        workspacePath: workerWorkspacePath,
        promptPath: join(workerJobRoot, "prompt.md"),
        taskId: workerJobId,
        accounts: ["account-a"],
        networkAccess: NetworkAccessMode.Restricted,
      });
      await callToolJson(client, "codex_goal_create_job", {
        registryRootDir,
        jobId: controllerJobId,
        jobRootDir: controllerJobRoot,
        authRootDir: join(root, "auth"),
        workspacePath: targetWorkspacePath,
        promptPath: join(controllerJobRoot, "prompt.md"),
        taskId: controllerJobId,
        accounts: ["account-a"],
        accessBoundary: AccessBoundary.ProjectScopedControl,
        networkAccess: NetworkAccessMode.Restricted,
        projectAccessScope: {
          projectId: "project",
          workspaceRoots: [targetWorkspacePath],
          worktreeRoots: [join(root, "worktrees")],
          registryRoot: registryRootDir,
          jobIdPrefixes: ["project-"],
          tmuxSessionPrefixes: ["project-"],
          allowedAccountIds: ["account-a"],
          allowedBranches: ["main"],
        },
      });

      const reviewed = await callToolJson(client, "codex_goal_project_mark_reviewed", {
        registryRootDir,
        controllerJobId,
        jobId: workerJobId,
        captureReviewedOutput: true,
        expectedPatchSha256: sha256(patch),
        reviewDecision: "approved",
        reviewedBy: controllerJobId,
        reviewReason: "Exact packet diff accepted.",
        approvedFiles: ["docs/packet.md"],
        requiredChecks: [],
        note: "ACCEPT",
      });
      expect(reviewed).toMatchObject({
        ok: true,
        mode: "project_control_mark_reviewed",
        jobId: workerJobId,
      });
      const reviewedOutputId = String(reviewed.reviewedOutputId);
      expect(reviewedOutputId).toMatch(/^[a-f0-9]{64}$/);
      await expect(
        access(join(workerJobRoot, `${workerJobId}.result.json`)),
      ).rejects.toMatchObject({ code: "ENOENT" });
      const marker = JSON.parse(
        await readFile(join(workerJobRoot, `${workerJobId}.review.json`), "utf8"),
      ) as Record<string, unknown>;
      expect(marker).toMatchObject({
        note: "ACCEPT",
        reviewedOutput: {
          reviewedOutputId,
          patchSha256: sha256(patch),
          changedFiles: ["docs/packet.md"],
        },
      });

      const preview = await callToolJson(
        client,
        "codex_goal_project_open_integration_attempt",
        {
          registryRootDir,
          controllerJobId,
          attemptId: "attempt-reviewed-output",
          reviewedOutputId,
          targetWorkspacePath,
          targetBranch: "main",
        },
      );
      expect(preview).toMatchObject({
        ok: false,
        reason: "confirm_open_required",
        attemptPreview: {
          workerOutput: {
            workerJobId,
            patchSha256: sha256(patch),
            changedFiles: ["docs/packet.md"],
          },
          reviewDecision: {
            reviewedBy: controllerJobId,
            reason: "Exact packet diff accepted.",
          },
        },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
