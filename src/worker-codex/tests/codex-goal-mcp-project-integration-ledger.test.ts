import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ProjectIntegrationMcpController } from "../project-integration-mcp";
import {
  projectIntegrationPushApprovedCommitWithConsumedLedger,
} from "../codex-goal-mcp-project-integration-ledger";

describe("codex goal MCP project integration ledger", () => {
  it("records consumed worker output after a successful approved push", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-goal-ledger-"));
    const workerWorkspace = join(root, "worker-workspace");
    const ledgerRoot = join(root, "ledger");
    await mkdir(workerWorkspace, { recursive: true });
    await writeFile(join(workerWorkspace, "file.txt"), "changed");
    const controller = projectIntegrationController(root, ledgerRoot);
    const commitSha = "abcdef1234567890";

    const response = await projectIntegrationPushApprovedCommitWithConsumedLedger({
      args: { attemptId: "attempt-1", confirmPush: true },
      loadController: async () => controller,
      pushApprovedCommitHandler: async () => mcpJson({
        ok: true,
        attempt: {
          attemptId: "attempt-1",
          workerOutput: {
            workerJobId: "worker/job:1",
            workspacePath: workerWorkspace,
            changedFiles: ["file.txt"],
          },
          pushAttempt: { commitSha },
        },
      }),
    });

    const body = response.structuredContent as Record<string, unknown>;
    const consumed = body.consumedOutputLedger as Record<string, unknown>;
    expect(consumed).toMatchObject({
      status: "integrated",
      commitSha,
    });
    expect(String(consumed.ledgerPath)).toContain("worker_job_1.json");

    const record = JSON.parse(await readFile(String(consumed.ledgerPath), "utf8")) as Record<string, unknown>;
    expect(record).toMatchObject({
      schemaVersion: 1,
      jobId: "worker/job:1",
      status: "integrated",
      integratedCommitSha: commitSha,
      commitSha,
      commit: commitSha,
    });
    expect(String(record.archivePath)).toContain("worker_job_1-integrated-abcdef12-");
    await expect(readFile(join(String(record.archivePath), "git-status.txt"), "utf8"))
      .resolves.toContain("git status --short");
  });

  it("leaves push responses unchanged when the controller has no consumed ledger", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-goal-ledger-"));
    const response = mcpJson({ ok: true, attempt: { attemptId: "attempt-1" } });

    await expect(projectIntegrationPushApprovedCommitWithConsumedLedger({
      args: { attemptId: "attempt-1", confirmPush: true },
      loadController: async () => projectIntegrationController(root, undefined),
      pushApprovedCommitHandler: async () => response,
    })).resolves.toBe(response);
  });
});

function projectIntegrationController(
  root: string,
  ledgerRoot: string | undefined,
): ProjectIntegrationMcpController {
  return {
    registryRootDir: join(root, "registry", "jobs"),
    controller: {
      jobId: "controller-1",
      jobRootDir: join(root, "registry", "jobs", "controller-1"),
    },
    scope: {
      projectId: "project-1",
      workspaceRoots: [join(root, "target")],
      ...(ledgerRoot ? { consumedOutputLedgerRoots: [ledgerRoot] } : {}),
    },
  };
}

function mcpJson(value: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}
