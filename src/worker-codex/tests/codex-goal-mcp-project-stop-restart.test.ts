import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import {
  AccessBoundary,
  NetworkAccessMode,
} from "@vioxen/subscription-runtime/worker-core";
import { createCodexGoalMcpServer } from "../codex-goal-mcp";
import {
  callToolJson,
  removeStoredTmuxSession,
} from "./codex-goal-mcp-test-support";

const execFileAsync = promisify(execFile);

describe("project-controlled stopped worker restart", () => {
  it("keeps stopped progress dead and allows the same job to reach start validation", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-project-stop-restart-"));
    const registryRootDir = join(root, "worker-jobs", "registry");
    const authRootDir = join(root, "auth");
    const controllerJobRoot = join(root, "worker-jobs", "infinity-context-controller");
    const controllerWorkspace = join(root, "workspaces", "infinity-context-controller");
    const childWorkspace = join(root, "worktrees", "infinity-context-child");
    const childJobRoot = join(root, "worker-jobs", "infinity-context-child");
    const childTaskId = "infinity-context-child";
    const server = createCodexGoalMcpServer();
    const client = new Client({ name: "subscription-runtime-test", version: "0.0.0" });
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
        jobId: "infinity-context-controller",
        jobRootDir: controllerJobRoot,
        authRootDir,
        workspacePath: controllerWorkspace,
        promptPath: join(controllerJobRoot, "prompt.md"),
        taskId: "infinity-context-controller",
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
        controllerJobId: "infinity-context-controller",
        jobId: "infinity-context-child",
        jobRootDir: childJobRoot,
        authRootDir,
        workspacePath: childWorkspace,
        promptPath: join(childJobRoot, "prompt.md"),
        taskId: childTaskId,
        accounts: ["account-a"],
        workerRole: "reviewer",
        confirmCreate: true,
      });
      await removeStoredTmuxSession(registryRootDir, "infinity-context-child");

      const stopped = await callToolJson(client, "codex_goal_project_stop", {
        registryRootDir,
        controllerJobId: "infinity-context-controller",
        jobId: "infinity-context-child",
        confirmStop: true,
      });
      expect(stopped).toMatchObject({
        ok: true,
        mode: "project_control_stop",
        result: { status: "noop" },
      });

      const progressPath = join(childJobRoot, `${childTaskId}.progress.json`);
      const progressRaw = await readFile(progressPath, "utf8");
      expect(JSON.parse(progressRaw)).toMatchObject({
        taskId: childTaskId,
        status: "stopped",
      });
      expect(JSON.parse(progressRaw)).not.toHaveProperty("pid");

      const projected = await callToolJson(client, "codex_goal_project_events", {
        registryRootDir,
        jobId: "infinity-context-child",
      });
      expect(projected).toMatchObject({
        ok: true,
        projectedRuns: [{
          status: "stopped",
          readModels: { liveness: { status: "dead" } },
        }],
      });
      await expect(readFile(progressPath, "utf8")).resolves.toBe(progressRaw);

      await writeFile(join(childJobRoot, "prompt.md"), "Resume safely.\n");
      const restart = await callToolJson(client, "codex_goal_project_start", {
        registryRootDir,
        controllerJobId: "infinity-context-controller",
        jobId: "infinity-context-child",
        confirmStart: true,
        forceStart: true,
      });
      expect(restart).toMatchObject({
        ok: false,
        reason: "tmux_session_required",
      });
    } finally {
      await client.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
