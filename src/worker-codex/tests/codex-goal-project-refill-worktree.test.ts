import { createHash } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
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
import { captureGitWorkspacePatch } from "../codex-goal-runtime-result-io";
import {
  fastForwardExistingProjectWorktree,
  resolveBoundProjectWorktreeSource,
} from "../codex-goal-mcp-project-broker";
import { createOrReuseProjectWorktree } from "../application/project-control/codex-goal-project-refill";
import type { CodexGoalProjectCreateWorktreeInput } from "../application/project-control/codex-goal-project-control-contracts";
import {
  stagedPatchSha256,
  stagedPatchSha256ForRevision,
} from "../application/project-control/codex-goal-project-git";
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

async function createFastForwardInput(
  fixture: Fixture,
  path: string,
  branch: string,
  expectedRevision: string,
  expectedCurrentRevision: string,
): Promise<CodexGoalProjectCreateWorktreeInput> {
  return {
    ...createInput(fixture, path, branch),
    sourceRef: branch,
    expectedRealPath: await realpath(path),
    expectedRevision,
    sourceRevisionPinned: true,
    fastForwardExisting: { expectedCurrentRevision },
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
  it("creates a public broker worktree at the pinned remote head without moving the tracking ref", async () => {
    const fixture = await createFixture();
    const remotePath = join(fixture.root, "remote.git");
    const publisherPath = join(fixture.root, "publisher");
    const registryRootDir = join(fixture.root, "worker-jobs", "registry");
    const controllerJobRoot = join(fixture.root, "worker-jobs", "controller");
    const worktreeRoot = join(fixture.root, "worktrees");
    const pinnedWorktree = join(worktreeRoot, "pinned-source");
    const server = createCodexGoalMcpServer();
    const client = new Client({ name: "pinned-worktree-test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await git(fixture.root, ["init", "--bare", remotePath]);
      await git(fixture.sourceWorkspacePath, ["remote", "add", "origin", remotePath]);
      await git(fixture.sourceWorkspacePath, ["push", "origin", "HEAD:main"]);
      const staleTrackingRevision = (await gitStdout(
        fixture.sourceWorkspacePath,
        ["rev-parse", "origin/main"],
      )).trim();
      await git(fixture.root, ["clone", remotePath, publisherPath]);
      await git(publisherPath, ["config", "user.email", "test@example.com"]);
      await git(publisherPath, ["config", "user.name", "Runtime Test"]);
      await git(publisherPath, ["switch", "main"]);
      await writeFile(join(publisherPath, "remote.md"), "remote source\n");
      await git(publisherPath, ["add", "remote.md"]);
      await git(publisherPath, ["commit", "-m", "test: advance remote"]);
      await git(publisherPath, ["push", "origin", "HEAD:main"]);
      const expectedSourceCommit = (await gitStdout(publisherPath, [
        "rev-parse",
        "HEAD",
      ])).trim();

      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);
      await callToolJson(client, "codex_goal_create_job", {
        registryRootDir,
        jobId: "pinned-controller",
        jobRootDir: controllerJobRoot,
        workspacePath: fixture.sourceWorkspacePath,
        promptPath: join(controllerJobRoot, "prompt.md"),
        taskId: "pinned-controller",
        accounts: ["account-a"],
        accessBoundary: AccessBoundary.ProjectScopedControl,
        networkAccess: NetworkAccessMode.Restricted,
        projectAccessScope: {
          projectId: "pinned-test",
          workspaceRoots: [fixture.sourceWorkspacePath],
          worktreeRoots: [worktreeRoot],
          registryRoot: registryRootDir,
          jobIdPrefixes: ["pinned-"],
          tmuxSessionPrefixes: ["pinned-"],
          allowedBranches: ["main"],
        },
      });

      const result = await callToolJson(
        client,
        "codex_goal_project_create_worktree",
        {
          registryRootDir,
          controllerJobId: "pinned-controller",
          sourceWorkspacePath: fixture.sourceWorkspacePath,
          path: pinnedWorktree,
          baseBranch: "main",
          expectedSourceCommit,
          confirmCreateWorktree: true,
        },
      );
      expect(result).toMatchObject({ ok: true });
      expect((await gitStdout(pinnedWorktree, ["rev-parse", "HEAD"])).trim()).toBe(
        expectedSourceCommit,
      );
      expect((await gitStdout(
        fixture.sourceWorkspacePath,
        ["rev-parse", "origin/main"],
      )).trim()).toBe(staleTrackingRevision);
    } finally {
      await client.close();
      await server.close();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

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

  it.each([
    {
      name: "accepts an old staged patch after unrelated target advance",
      advance: "unrelated" as const,
      expectedError: undefined,
    },
    {
      name: "rejects an old staged patch after touched-path target drift",
      advance: "touched" as const,
      expectedError: "project_control_input_patch_changed_paths_advanced",
    },
    {
      name: "rejects an old staged patch on a non-ancestor target",
      advance: "non-ancestor" as const,
      expectedError: "project_control_input_patch_base_not_ancestor",
    },
  ])("$name", async ({ advance, expectedError }) => {
    const fixture = await createReusableInputPatchFixture(advance);
    try {
      const reuse = createOrReuseProjectWorktree({
        scope: fixture.scope,
        createWorktreeInput: fixture.input,
        broker: brokerWithCreate(async () => ({
          status: "noop",
          resourceId: fixture.input.path,
        })),
      });
      if (expectedError) {
        await expect(reuse).rejects.toThrow(expectedError);
      } else {
        await expect(reuse).resolves.toMatchObject({
          created: false,
          result: { status: "noop" },
        });
      }
      await expect(access(fixture.input.path)).resolves.toBeUndefined();
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("preserves both exact changed paths when Git could detect a staged rename", async () => {
    const fixture = await createFixture();
    const producerPath = join(fixture.root, "worktrees", "rename-producer");
    const targetPath = join(fixture.root, "worktrees", "rename-target");
    const patchPath = join(fixture.root, "rename.patch");
    const producerBranch = "fix/rename-producer";
    const targetBranch = "fix/rename-target";
    try {
      await writeFile(join(fixture.sourceWorkspacePath, "old-name.ts"), "export const value = 1;\n");
      await git(fixture.sourceWorkspacePath, ["add", "old-name.ts"]);
      await git(fixture.sourceWorkspacePath, ["commit", "-m", "test: add rename source"]);
      const baseCommit = (
        await gitStdout(fixture.sourceWorkspacePath, ["rev-parse", "HEAD"])
      ).trim();
      await git(fixture.sourceWorkspacePath, [
        "worktree",
        "add",
        "-b",
        producerBranch,
        producerPath,
        baseCommit,
      ]);
      await git(producerPath, ["mv", "old-name.ts", "new-name.ts"]);
      const patch = await gitStdout(producerPath, [
        "diff",
        "--cached",
        "--binary",
        "--no-renames",
        "HEAD",
        "--",
      ]);
      await writeFile(patchPath, patch);
      await git(fixture.sourceWorkspacePath, [
        "worktree",
        "add",
        "-b",
        targetBranch,
        targetPath,
        baseCommit,
      ]);
      await git(targetPath, ["apply", "--index", "--binary", patchPath]);
      const exactPatchSha256 = createHash("sha256").update(patch).digest("hex");
      await expect(stagedPatchSha256(targetPath)).resolves.toBe(exactPatchSha256);
      await expect(stagedPatchSha256ForRevision({
        workspacePath: targetPath,
        revision: baseCommit,
        patchPath,
      })).resolves.toBe(exactPatchSha256);

      await expect(createOrReuseProjectWorktree({
        scope: createScope(fixture),
        createWorktreeInput: {
          ...createInput(fixture, targetPath, targetBranch),
          expectedRealPath: await realpath(targetPath),
          expectedRevision: baseCommit,
          inputPatch: {
            path: patchPath,
            sha256: exactPatchSha256,
            stagedSha256: exactPatchSha256,
            baseCommit,
            changedPaths: ["old-name.ts", "new-name.ts"],
          },
        },
        broker: brokerWithCreate(async () => ({
          status: "noop",
          resourceId: targetPath,
        })),
      })).resolves.toMatchObject({
        created: false,
        result: { status: "noop" },
      });
      await expect(gitStdout(targetPath, [
        "diff",
        "--cached",
        "--name-only",
        "--no-renames",
        "HEAD",
        "--",
      ])).resolves.toBe("new-name.ts\nold-name.ts\n");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("removes only a broker-created staged worktree after post-create validation fails", async () => {
    const fixture = await createFixture();
    const producerPath = join(fixture.root, "worktrees", "rollback-producer");
    const createdPath = join(fixture.root, "worktrees", "rollback-created");
    const existingPath = join(fixture.root, "worktrees", "rollback-existing");
    const patchPath = join(fixture.root, "rollback.patch");
    const createdBranch = "fix/rollback-created";
    const existingBranch = "fix/rollback-existing";
    try {
      await git(fixture.sourceWorkspacePath, [
        "worktree",
        "add",
        "-b",
        "fix/rollback-producer",
        producerPath,
        fixture.phaseStartSha,
      ]);
      await writeFile(join(producerPath, "README.md"), "staged input\n");
      await git(producerPath, ["add", "README.md"]);
      const patch = await gitStdout(producerPath, [
        "diff",
        "--cached",
        "--binary",
        "--no-renames",
        "HEAD",
        "--",
      ]);
      await writeFile(patchPath, patch);
      const mismatchedInputPatch = {
        path: patchPath,
        sha256: createHash("sha256").update(patch).digest("hex"),
        stagedSha256: "f".repeat(64),
        baseCommit: fixture.phaseStartSha,
        changedPaths: ["README.md"],
      };

      await expect(createOrReuseProjectWorktree({
        scope: createScope(fixture),
        createWorktreeInput: {
          ...createInput(fixture, createdPath, createdBranch),
          inputPatch: mismatchedInputPatch,
        },
        broker: brokerWithCreate(async () => {
          await git(fixture.sourceWorkspacePath, [
            "worktree",
            "add",
            "-b",
            createdBranch,
            createdPath,
            fixture.phaseStartSha,
          ]);
          await git(createdPath, ["apply", "--cached", "--binary", patchPath]);
          return applied(createdPath);
        }),
      })).rejects.toThrow(
        "project_control_existing_worktree_input_patch_mismatch; rollback=worktree",
      );
      await expect(access(createdPath)).rejects.toMatchObject({ code: "ENOENT" });

      await git(fixture.sourceWorkspacePath, [
        "worktree",
        "add",
        "-b",
        existingBranch,
        existingPath,
        fixture.phaseStartSha,
      ]);
      await git(existingPath, ["apply", "--cached", "--binary", patchPath]);
      await expect(createOrReuseProjectWorktree({
        scope: createScope(fixture),
        createWorktreeInput: {
          ...createInput(fixture, existingPath, existingBranch),
          expectedRealPath: await realpath(existingPath),
          inputPatch: mismatchedInputPatch,
        },
        broker: brokerWithCreate(async () => applied(existingPath)),
      })).rejects.toThrow("project_control_existing_worktree_input_patch_mismatch");
      await expect(access(existingPath)).resolves.toBeUndefined();
      await expect(gitStdout(existingPath, ["diff", "--cached", "--name-only"])).resolves.toBe(
        "README.md\n",
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("fast-forwards an existing clean branch to a pinned descendant", async () => {
    const fixture = await createFixture();
    const path = join(fixture.root, "worktrees", "fast-forward");
    const branch = "fix/fast-forward";
    try {
      await git(fixture.sourceWorkspacePath, ["branch", branch, fixture.phaseStartSha]);
      await git(fixture.sourceWorkspacePath, ["worktree", "add", path, branch]);
      await writeFile(join(fixture.sourceWorkspacePath, "later.md"), "later\n");
      await git(fixture.sourceWorkspacePath, ["add", "later.md"]);
      await git(fixture.sourceWorkspacePath, ["commit", "-m", "test: later"]);
      const laterSha = (await gitStdout(
        fixture.sourceWorkspacePath,
        ["rev-parse", "HEAD"],
      )).trim();

      await expect(fastForwardExistingProjectWorktree({
        scope: createScope(fixture),
        input: await createFastForwardInput(
          fixture,
          path,
          branch,
          laterSha,
          fixture.phaseStartSha,
        ),
      })).resolves.toBe(true);
      await expect(gitStdout(path, ["rev-parse", "HEAD"])).resolves.toBe(`${laterSha}\n`);
      await expect(gitStdout(path, ["status", "--porcelain"])).resolves.toBe("");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("keeps an already-current pinned worktree idempotent", async () => {
    const fixture = await createFixture();
    const path = join(fixture.root, "worktrees", "current-fast-forward");
    const branch = "fix/current-fast-forward";
    try {
      await git(fixture.sourceWorkspacePath, ["branch", branch, fixture.phaseStartSha]);
      await git(fixture.sourceWorkspacePath, ["worktree", "add", path, branch]);
      await expect(fastForwardExistingProjectWorktree({
        scope: createScope(fixture),
        input: await createFastForwardInput(
          fixture,
          path,
          branch,
          fixture.phaseStartSha,
          fixture.phaseStartSha,
        ),
      })).resolves.toBe(false);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects a separate repository even when branch and revisions match", async () => {
    const fixture = await createFixture();
    const path = join(fixture.root, "worktrees", "foreign-repository");
    const branch = "fix/foreign-repository";
    try {
      await git(fixture.sourceWorkspacePath, ["branch", branch, fixture.phaseStartSha]);
      await mkdir(join(fixture.root, "worktrees"), { recursive: true });
      await git(fixture.root, [
        "clone",
        "--branch",
        branch,
        fixture.sourceWorkspacePath,
        path,
      ]);
      await expect(fastForwardExistingProjectWorktree({
        scope: createScope(fixture),
        input: await createFastForwardInput(
          fixture,
          path,
          branch,
          fixture.phaseStartSha,
          fixture.phaseStartSha,
        ),
      })).rejects.toThrow("project_control_existing_worktree_foreign_repository");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("disables hooks and preserves concurrent data after post-mutation verification fails", async () => {
    const fixture = await createFixture();
    const path = join(fixture.root, "worktrees", "rollback-fast-forward");
    const branch = "fix/rollback-fast-forward";
    try {
      await git(fixture.sourceWorkspacePath, ["branch", branch, fixture.phaseStartSha]);
      await git(fixture.sourceWorkspacePath, ["worktree", "add", path, branch]);
      await writeFile(join(fixture.sourceWorkspacePath, "later.md"), "later\n");
      await git(fixture.sourceWorkspacePath, ["add", "later.md"]);
      await git(fixture.sourceWorkspacePath, ["commit", "-m", "test: later"]);
      const laterSha = (await gitStdout(
        fixture.sourceWorkspacePath,
        ["rev-parse", "HEAD"],
      )).trim();
      const hooksPath = join(fixture.sourceWorkspacePath, ".git", "hooks");
      const hookMarker = join(fixture.root, "post-merge-hook-ran");
      const postMergeHook = join(hooksPath, "post-merge");
      await writeFile(postMergeHook, `#!/bin/sh\ntouch '${hookMarker}'\n`);
      await chmod(postMergeHook, 0o755);

      const fastForwardInput = await createFastForwardInput(
        fixture,
        path,
        branch,
        laterSha,
        fixture.phaseStartSha,
      );
      await expect(fastForwardExistingProjectWorktree({
        scope: createScope(fixture),
        input: fastForwardInput,
        afterFastForwardForTest: async () => {
          await writeFile(join(path, "external-race.md"), "preserve me\n");
        },
      })).rejects.toThrow(
        "project_control_existing_worktree_fast_forward_verification_failed; rollback=skipped_dirty",
      );
      await expect(gitStdout(path, ["rev-parse", "HEAD"])).resolves.toBe(
        `${laterSha}\n`,
      );
      await expect(access(join(path, "external-race.md"))).resolves.toBeUndefined();
      await expect(access(hookMarker)).rejects.toMatchObject({ code: "ENOENT" });
      await rm(join(path, "external-race.md"));
      await expect(fastForwardExistingProjectWorktree({
        scope: createScope(fixture),
        input: fastForwardInput,
      })).resolves.toBe(false);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects a dirty existing worktree before fast-forward", async () => {
    const fixture = await createFixture();
    const path = join(fixture.root, "worktrees", "dirty-fast-forward");
    const branch = "fix/dirty-fast-forward";
    try {
      await git(fixture.sourceWorkspacePath, ["branch", branch, fixture.phaseStartSha]);
      await git(fixture.sourceWorkspacePath, ["worktree", "add", path, branch]);
      await writeFile(join(path, "dirty.md"), "dirty\n");
      await expect(fastForwardExistingProjectWorktree({
        scope: createScope(fixture),
        input: await createFastForwardInput(
          fixture,
          path,
          branch,
          fixture.phaseStartSha,
          fixture.phaseStartSha,
        ),
      })).rejects.toThrow("project_control_existing_worktree_fast_forward_dirty");
      await expect(access(path)).resolves.toBeUndefined();
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects a stale expected current revision", async () => {
    const fixture = await createFixture();
    const path = join(fixture.root, "worktrees", "stale-fast-forward");
    const branch = "fix/stale-fast-forward";
    try {
      await git(fixture.sourceWorkspacePath, ["branch", branch, fixture.phaseStartSha]);
      await git(fixture.sourceWorkspacePath, ["worktree", "add", path, branch]);
      await expect(fastForwardExistingProjectWorktree({
        scope: createScope(fixture),
        input: await createFastForwardInput(
          fixture,
          path,
          branch,
          fixture.phaseStartSha,
          "f".repeat(40),
        ),
      })).rejects.toThrow(
        "project_control_existing_worktree_fast_forward_current_mismatch",
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects a non-ancestor pinned revision", async () => {
    const fixture = await createFixture();
    const path = join(fixture.root, "worktrees", "diverged-fast-forward");
    const branch = "fix/diverged-fast-forward";
    try {
      await git(fixture.sourceWorkspacePath, ["branch", branch, fixture.phaseStartSha]);
      await git(fixture.sourceWorkspacePath, ["worktree", "add", path, branch]);
      await writeFile(join(path, "branch.md"), "branch\n");
      await git(path, ["add", "branch.md"]);
      await git(path, ["commit", "-m", "test: branch"]);
      const currentSha = (await gitStdout(path, ["rev-parse", "HEAD"])).trim();
      await writeFile(join(fixture.sourceWorkspacePath, "main.md"), "main\n");
      await git(fixture.sourceWorkspacePath, ["add", "main.md"]);
      await git(fixture.sourceWorkspacePath, ["commit", "-m", "test: main"]);
      const nextSha = (await gitStdout(
        fixture.sourceWorkspacePath,
        ["rev-parse", "HEAD"],
      )).trim();

      await expect(fastForwardExistingProjectWorktree({
        scope: createScope(fixture),
        input: await createFastForwardInput(
          fixture,
          path,
          branch,
          nextSha,
          currentSha,
        ),
      })).rejects.toThrow("project_control_existing_worktree_fast_forward_non_ancestor");
      await expect(gitStdout(path, ["rev-parse", "HEAD"])).resolves.toBe(`${currentSha}\n`);
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

  it("never removes an existing worktree after an applied broker transition fails validation", async () => {
    const fixture = await createFixture();
    const path = join(fixture.root, "worktrees", "existing-applied");
    const branch = "fix/existing-applied";
    try {
      await git(fixture.sourceWorkspacePath, ["branch", branch, fixture.phaseStartSha]);
      await git(fixture.sourceWorkspacePath, ["worktree", "add", path, branch]);
      await expect(createOrReuseProjectWorktree({
        scope: createScope(fixture),
        createWorktreeInput: {
          ...createInput(fixture, path, branch),
          expectedRealPath: await realpath(path),
          expectedRevision: "f".repeat(40),
        },
        broker: brokerWithCreate(async () => applied(path)),
      })).rejects.toThrow("project_control_existing_worktree_revision_mismatch");
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

async function createReusableInputPatchFixture(
  advance: "unrelated" | "touched" | "non-ancestor",
): Promise<{
  readonly root: string;
  readonly scope: ProjectAccessScope;
  readonly input: CodexGoalProjectCreateWorktreeInput;
}> {
  const root = await mkdtemp(
    join(tmpdir(), "subscription-runtime-project-reuse-input-patch-"),
  );
  const sourceWorkspacePath = join(root, "source");
  const producerPath = join(root, "worktrees", "producer");
  const targetPath = join(root, "worktrees", "target");
  const targetBranch = `fix/reuse-${advance}`;
  const featurePath = join(sourceWorkspacePath, "feature.txt");
  await mkdir(sourceWorkspacePath, { recursive: true });
  await gitInitRepository(sourceWorkspacePath);
  await writeFile(
    featurePath,
    "line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\nline 9\nline 10\nline 11\nline 12\n",
  );
  await writeFile(join(sourceWorkspacePath, "unrelated.txt"), "base\n");
  await git(sourceWorkspacePath, ["add", "."]);
  await git(sourceWorkspacePath, ["commit", "-m", "test: patch base"]);
  const baseCommit = (
    await gitStdout(sourceWorkspacePath, ["rev-parse", "HEAD"])
  ).trim();
  await git(sourceWorkspacePath, [
    "worktree",
    "add",
    "-b",
    "test/reuse-producer",
    producerPath,
    baseCommit,
  ]);
  await writeFile(
    join(producerPath, "feature.txt"),
    "line 1\nline 2\nline 3\nline 4\nline 5\nproducer line 6\nline 7\nline 8\nline 9\nline 10\nline 11\nline 12\n",
  );
  const patch = await captureGitWorkspacePatch({ workspacePath: producerPath });
  const patchPath = join(root, "input.patch");
  await writeFile(patchPath, patch);

  let targetCommit: string;
  if (advance === "non-ancestor") {
    const baseTree = (
      await gitStdout(sourceWorkspacePath, ["rev-parse", `${baseCommit}^{tree}`])
    ).trim();
    targetCommit = (
      await gitStdout(sourceWorkspacePath, [
        "commit-tree",
        baseTree,
        "-m",
        "test: unrelated target",
      ])
    ).trim();
  } else {
    if (advance === "touched") {
      await writeFile(
        featurePath,
        "line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\nline 9\nline 10\nline 11\ncanonical line 12\n",
      );
      await git(sourceWorkspacePath, ["add", "feature.txt"]);
    } else {
      await writeFile(
        join(sourceWorkspacePath, "unrelated.txt"),
        "canonical advance\n",
      );
      await git(sourceWorkspacePath, ["add", "unrelated.txt"]);
    }
    await git(sourceWorkspacePath, [
      "commit",
      "-m",
      "test: advance patch target",
    ]);
    targetCommit = (
      await gitStdout(sourceWorkspacePath, ["rev-parse", "HEAD"])
    ).trim();
  }
  await git(sourceWorkspacePath, [
    "worktree",
    "add",
    "-b",
    targetBranch,
    targetPath,
    targetCommit,
  ]);
  await git(targetPath, ["apply", "--index", "--binary", patchPath]);
  const input: CodexGoalProjectCreateWorktreeInput = {
    sourceWorkspacePath,
    expectedSourceRealPath: await realpath(sourceWorkspacePath),
    path: targetPath,
    expectedRealPath: await realpath(targetPath),
    expectedRevision: targetCommit,
    sourceRevisionPinned: true,
    newBranch: targetBranch,
    inputPatch: {
      path: patchPath,
      sha256: createHash("sha256").update(patch).digest("hex"),
      stagedSha256: await stagedPatchSha256(targetPath),
      baseCommit,
      changedPaths: ["feature.txt"],
    },
  };
  return {
    root,
    scope: {
      projectId: "test-project",
      workspaceRoots: [sourceWorkspacePath],
      worktreeRoots: [join(root, "worktrees")],
    },
    input,
  };
}
