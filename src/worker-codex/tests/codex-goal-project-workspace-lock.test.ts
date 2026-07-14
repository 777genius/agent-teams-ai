import { access, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  ProjectAccessScope,
  WorkspaceLockPort,
} from "@vioxen/subscription-runtime/worker-core";
import {
  projectControlWorkspaceLocks,
  withValidatedProjectWorkspaceLock,
} from "../codex-goal-project-workspace-lock";

describe("project control workspace lock", () => {
  it("permits only one concurrent restart launch for the same canonical workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-workspace-lock-"));
    const workspace = join(root, "worktrees", "shared");
    const registryRootDir = join(root, "worker-jobs", "registry");
    const scope = projectScope(root);
    let releaseFirst!: () => void;
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstEntered!: () => void;
    const firstDidEnter = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    let active = 0;
    let maxConcurrency = 0;
    let launches = 0;
    try {
      await mkdir(workspace, { recursive: true });
      const first = withValidatedProjectWorkspaceLock({
        locks: projectControlWorkspaceLocks(registryRootDir),
        scope,
        requestedWorkspacePath: workspace,
        owner: "controller-a:job-a",
        effect: async () => {
          launches += 1;
          active += 1;
          maxConcurrency = Math.max(maxConcurrency, active);
          firstEntered();
          await firstMayFinish;
          active -= 1;
        },
      });
      await firstDidEnter;
      await expect(
        withValidatedProjectWorkspaceLock({
          locks: projectControlWorkspaceLocks(registryRootDir),
          scope,
          requestedWorkspacePath: workspace,
          owner: "controller-b:job-b",
          effect: async () => {
            launches += 1;
            active += 1;
            maxConcurrency = Math.max(maxConcurrency, active);
            active -= 1;
          },
        }),
      ).rejects.toMatchObject({ code: "safe_execution_workspace_locked" });
      expect(launches).toBe(1);
      releaseFirst();
      await first;
      await withValidatedProjectWorkspaceLock({
        locks: projectControlWorkspaceLocks(registryRootDir),
        scope,
        requestedWorkspacePath: workspace,
        owner: "controller-b:job-b",
        effect: async () => {
          launches += 1;
          active += 1;
          maxConcurrency = Math.max(maxConcurrency, active);
          active -= 1;
        },
      });
      expect(maxConcurrency).toBe(1);
      expect(launches).toBe(2);
    } finally {
      releaseFirst?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an alias retargeted after acquire and releases the lease", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-workspace-retarget-"));
    const worktreeRoot = join(root, "worktrees");
    const inside = join(worktreeRoot, "inside");
    const alias = join(worktreeRoot, "alias");
    const outside = join(root, "outside");
    let released = false;
    let effectRan = false;
    try {
      await Promise.all([
        mkdir(join(inside, "node_modules"), { recursive: true }),
        mkdir(join(outside, "node_modules"), { recursive: true }),
      ]);
      await symlink(inside, alias, "dir");
      const locks: WorkspaceLockPort = {
        async acquire(input) {
          await rm(alias);
          await symlink(outside, alias, "dir");
          return {
            lockId: "lease-1",
            workspacePath: input.workspacePath,
            owner: input.owner,
          };
        },
        async release() {
          released = true;
        },
      };
      await expect(
        withValidatedProjectWorkspaceLock({
          locks,
          scope: projectScope(root),
          requestedWorkspacePath: alias,
          owner: "controller:job",
          effect: async () => {
            effectRan = true;
          },
        }),
      ).rejects.toThrow(/project_control_workspace_real_path_/);
      expect(effectRan).toBe(false);
      expect(released).toBe(true);
      await expect(access(join(outside, "node_modules"))).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function projectScope(root: string): ProjectAccessScope {
  return {
    projectId: "project-a",
    workspaceRoots: [join(root, "workspaces")],
    worktreeRoots: [join(root, "worktrees")],
    registryRoot: join(root, "worker-jobs", "registry"),
  };
}
