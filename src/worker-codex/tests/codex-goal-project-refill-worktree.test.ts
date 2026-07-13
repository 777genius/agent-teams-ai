import { access, mkdir, mkdtemp, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type {
  ProjectAccessScope,
  ProjectControlBroker,
  ProjectControlOperationResult,
} from "@vioxen/subscription-runtime/worker-core";
import {
  AccessBoundary,
  NetworkAccessMode,
} from "@vioxen/subscription-runtime/worker-core";
import { createCodexGoalMcpServer } from "../codex-goal-mcp";
import { resolveBoundProjectWorktreeSource } from "../codex-goal-mcp-project-broker";
import { createOrReuseProjectWorktree } from "../application/project-control/codex-goal-project-refill";
import type { CodexGoalProjectCreateWorktreeInput } from "../application/project-control/codex-goal-project-control-contracts";
import {
  git,
  gitInitRepository,
  gitStdout,
  callToolJson,
} from "./codex-goal-mcp-test-support";

type Fixture = {
  readonly root: string;
  readonly sourceWorkspacePath: string;
  readonly phaseStartSha: string;
};

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "subscription-runtime-project-worktree-"));
  const sourceWorkspacePath = join(root, "source");
  await mkdir(sourceWorkspacePath, { recursive: true });
  await gitInitRepository(sourceWorkspacePath);
  await writeFile(join(sourceWorkspacePath, "README.md"), "base\n");
  await git(sourceWorkspacePath, ["add", "README.md"]);
  await git(sourceWorkspacePath, ["commit", "-m", "test: base"]);
  const phaseStartSha = (await gitStdout(
    sourceWorkspacePath,
    ["rev-parse", "HEAD"],
  )).trim();
  await git(sourceWorkspacePath, [
    "update-ref",
    "refs/remotes/origin/main",
    phaseStartSha,
  ]);
  return { root, sourceWorkspacePath, phaseStartSha };
}

function createInput(
  fixture: Fixture,
  path: string,
  newBranch: string,
): CodexGoalProjectCreateWorktreeInput {
  return {
    sourceWorkspacePath: fixture.sourceWorkspacePath,
    expectedSourceRealPath: fixture.sourceWorkspacePath,
    path,
    expectedRevision: fixture.phaseStartSha,
    baseBranch: "origin/main",
    newBranch,
  };
}

function createScope(fixture: Fixture): ProjectAccessScope {
  return {
    projectId: "test-project",
    workspaceRoots: [fixture.sourceWorkspacePath],
    worktreeRoots: [join(fixture.root, "worktrees")],
  };
}

function brokerWithCreate(
  createWorktree: (
    input: CodexGoalProjectCreateWorktreeInput,
  ) => Promise<ProjectControlOperationResult>,
): ProjectControlBroker {
  return { createWorktree } as ProjectControlBroker;
}

function applied(path: string): ProjectControlOperationResult {
  return { status: "applied", resourceId: path };
}

describe("project refill worktree identity", () => {
  it("rejects source symlink substitution after revision resolution", async () => {
    const fixture = await createFixture();
    const outside = await mkdtemp(join(tmpdir(), "subscription-runtime-outside-source-"));
    const sourceLink = join(fixture.root, "source-link");
    try {
      await symlink(fixture.sourceWorkspacePath, sourceLink);
      const expectedSourceRealPath = await realpath(sourceLink);
      await unlink(sourceLink);
      await symlink(outside, sourceLink);

      await expect(resolveBoundProjectWorktreeSource({
        sourceWorkspacePath: sourceLink,
        expectedSourceRealPath,
        scope: createScope(fixture),
      })).rejects.toThrow("project_control_source_workspace_real_path_changed");
    } finally {
      await rm(outside, { recursive: true, force: true });
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("materializes and then reuses the exact branch and source revision", async () => {
    const fixture = await createFixture();
    const path = join(fixture.root, "worktrees", "exact");
    const branch = "fix/exact";
    const input = createInput(fixture, path, branch);
    try {
      await git(fixture.sourceWorkspacePath, ["branch", branch, fixture.phaseStartSha]);
      const created = await createOrReuseProjectWorktree({
        scope: createScope(fixture),
        createWorktreeInput: input,
        broker: brokerWithCreate(async () => {
          await git(fixture.sourceWorkspacePath, ["worktree", "add", path, branch]);
          return applied(path);
        }),
      });
      expect(created).toMatchObject({ created: true, result: { status: "applied" } });

      let brokerCalls = 0;
      const reused = await createOrReuseProjectWorktree({
        scope: createScope(fixture),
        createWorktreeInput: input,
        broker: brokerWithCreate(async () => {
          brokerCalls += 1;
          return { status: "noop", resourceId: path };
        }),
      });
      expect(reused).toMatchObject({ created: false, result: { status: "noop" } });
      expect(brokerCalls).toBe(1);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects an existing clean worktree on a different branch", async () => {
    const fixture = await createFixture();
    const path = join(fixture.root, "worktrees", "wrong-branch");
    try {
      await git(fixture.sourceWorkspacePath, [
        "worktree",
        "add",
        "-b",
        "fix/wrong",
        path,
        fixture.phaseStartSha,
      ]);
      await expect(createOrReuseProjectWorktree({
        scope: createScope(fixture),
        createWorktreeInput: createInput(fixture, path, "fix/expected"),
        broker: brokerWithCreate(async () => ({ status: "noop", resourceId: path })),
      })).rejects.toThrow("project_control_existing_worktree_branch_mismatch");
      await expect(access(path)).resolves.toBeUndefined();
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("removes a newly materialized worktree at the wrong source revision", async () => {
    const fixture = await createFixture();
    const path = join(fixture.root, "worktrees", "wrong-revision");
    const branch = "fix/wrong-revision";
    try {
      await writeFile(join(fixture.sourceWorkspacePath, "later.md"), "later\n");
      await git(fixture.sourceWorkspacePath, ["add", "later.md"]);
      await git(fixture.sourceWorkspacePath, ["commit", "-m", "test: later"]);
      await git(fixture.sourceWorkspacePath, ["branch", branch, "HEAD"]);

      await expect(createOrReuseProjectWorktree({
        scope: createScope(fixture),
        createWorktreeInput: createInput(fixture, path, branch),
        broker: brokerWithCreate(async () => {
          await git(fixture.sourceWorkspacePath, ["worktree", "add", path, branch]);
          return applied(path);
        }),
      })).rejects.toThrow(
        "project_control_existing_worktree_revision_mismatch; rollback=worktree",
      );
      await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("does not swallow a create failure when a clean path appeared", async () => {
    const fixture = await createFixture();
    const path = join(fixture.root, "worktrees", "raced");
    const branch = "fix/raced";
    try {
      await expect(createOrReuseProjectWorktree({
        scope: createScope(fixture),
        createWorktreeInput: createInput(fixture, path, branch),
        broker: brokerWithCreate(async () => {
          await git(fixture.sourceWorkspacePath, [
            "worktree",
            "add",
            "-b",
            branch,
            path,
            fixture.phaseStartSha,
          ]);
          throw new Error("materialization_failed_after_path_appeared");
        }),
      })).rejects.toThrow("materialization_failed_after_path_appeared");

      const retry = await createOrReuseProjectWorktree({
        scope: createScope(fixture),
        createWorktreeInput: createInput(fixture, path, branch),
        broker: brokerWithCreate(async () => ({ status: "noop", resourceId: path })),
      });
      expect(retry).toMatchObject({ created: false, result: { status: "noop" } });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("propagates Git rejection when the requested branch is already in use", async () => {
    const fixture = await createFixture();
    const firstPath = join(fixture.root, "worktrees", "first");
    const secondPath = join(fixture.root, "worktrees", "second");
    const branch = "fix/in-use";
    try {
      await git(fixture.sourceWorkspacePath, [
        "worktree",
        "add",
        "-b",
        branch,
        firstPath,
        fixture.phaseStartSha,
      ]);
      await expect(createOrReuseProjectWorktree({
        scope: createScope(fixture),
        createWorktreeInput: createInput(fixture, secondPath, branch),
        broker: brokerWithCreate(async () => {
          await git(fixture.sourceWorkspacePath, [
            "worktree",
            "add",
            secondPath,
            branch,
          ]);
          return applied(secondPath);
        }),
      })).rejects.toThrow(/already checked out|used by worktree/);
      await expect(access(secondPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("denies realpath escapes before inspecting an untrusted source repository", async () => {
    const fixture = await createFixture();
    const registryRootDir = join(fixture.root, "worker-jobs", "registry");
    const controllerJobRoot = join(fixture.root, "worker-jobs", "controller");
    const worktreeRoot = join(fixture.root, "worktrees");
    const outsideRoot = join(fixture.root, "outside-project");
    const escapedTarget = join(worktreeRoot, "escaped-target");
    const server = createCodexGoalMcpServer();
    const client = new Client({ name: "worktree-scope-test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await mkdir(outsideRoot, { recursive: true });
      await mkdir(worktreeRoot, { recursive: true });
      await symlink(outsideRoot, escapedTarget);
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);
      await callToolJson(client, "codex_goal_create_job", {
        registryRootDir,
        jobId: "scope-controller",
        jobRootDir: controllerJobRoot,
        workspacePath: fixture.sourceWorkspacePath,
        promptPath: join(controllerJobRoot, "prompt.md"),
        taskId: "scope-controller",
        accounts: ["account-a"],
        accessBoundary: AccessBoundary.ProjectScopedControl,
        networkAccess: NetworkAccessMode.Restricted,
        projectAccessScope: {
          projectId: "scope-test",
          workspaceRoots: [fixture.sourceWorkspacePath],
          worktreeRoots: [worktreeRoot],
          registryRoot: registryRootDir,
          jobIdPrefixes: ["scope-"],
          tmuxSessionPrefixes: ["scope-"],
          allowedBranches: ["main"],
        },
      });

      const preview = await callToolJson(
        client,
        "codex_goal_project_create_worktree",
        {
          registryRootDir,
          controllerJobId: "scope-controller",
          sourceWorkspacePath: outsideRoot,
          path: join(worktreeRoot, "preview"),
          baseBranch: "main",
          confirmCreateWorktree: false,
        },
      );
      expect(preview).toMatchObject({
        ok: false,
        reason: "confirm_create_worktree_required",
      });

      const escaped = await callToolJson(
        client,
        "codex_goal_project_create_worktree",
        {
          registryRootDir,
          controllerJobId: "scope-controller",
          sourceWorkspacePath: fixture.sourceWorkspacePath,
          path: escapedTarget,
          baseBranch: "main",
          confirmCreateWorktree: true,
        },
      );
      expect(escaped).toEqual({
        ok: false,
        error: "project_control_denied:path_outside_scope",
      });
    } finally {
      await client.close();
      await server.close();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});
