import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ProjectAccessScope } from "@vioxen/subscription-runtime/worker-core";
import type { CodexGoalJobManifestInput } from "../codex-goal-jobs";
import {
  assertProjectControlCreateManifestPaths,
  assertProjectControlScopeRepairAllowed,
  projectControlCanonicalWorkspacePath,
  projectControlChildScope,
  projectControlDependencyBootstrapMode,
  projectControlPathArg,
  projectControlWorkerRole,
} from "../codex-goal-mcp-project-scope";

describe("codex goal MCP project scope helpers", () => {
  it("builds a child scope constrained to the worker workspace", () => {
    const child = projectControlChildScope(
      projectScope(),
      "/tmp/project/worktrees/job-a",
    );

    expect(child).toMatchObject({
      projectId: "project-a",
      projectSlug: "project-a-slug",
      isolatedWorkspaceRoot: "/tmp/project/worktrees/job-a",
      workspaceRoots: ["/tmp/project/worktrees/job-a"],
      registryRoot: "/tmp/project/registry/jobs",
      authRoot: "/tmp/project/auth",
      deniedRoots: ["/tmp/project/denied"],
      allowedAccountIds: ["account-a"],
    });
    expect(child.readRoots).toEqual([
      "/tmp/project/read",
      "/tmp/project/worktrees/job-a",
      "/tmp/project/registry/jobs",
    ]);
  });

  it("allows only append-only consumed ledger roots during scope repair", () => {
    const existing = projectScope();
    expect(() =>
      assertProjectControlScopeRepairAllowed({
        existing,
        proposed: {
          ...existing,
          consumedOutputLedgerRoots: ["/tmp/project/worktrees/ledger"],
        },
      }),
    ).not.toThrow();

    expect(() =>
      assertProjectControlScopeRepairAllowed({
        existing,
        proposed: {
          ...existing,
          workspaceRoots: ["/tmp/project/other"],
        },
      }),
    ).toThrow("project_control_scope_workspaceRoots_repair_denied");

    expect(() =>
      assertProjectControlScopeRepairAllowed({
        existing,
        proposed: {
          ...existing,
          consumedOutputLedgerRoots: ["/tmp/outside/ledger"],
        },
      }),
    ).toThrow("project_control_consumed_output_ledger_root_outside_scope");
  });

  it("allows append-only account registration during confirmed scope repair", () => {
    const existing = projectScope();

    expect(() =>
      assertProjectControlScopeRepairAllowed({
        existing,
        proposed: {
          ...existing,
          allowedAccountIds: ["account-a", "account-j"],
        },
      }),
    ).not.toThrow();
    expect(() =>
      assertProjectControlScopeRepairAllowed({
        existing,
        proposed: {
          ...existing,
          allowedAccountIds: ["account-j"],
        },
      }),
    ).toThrow("project_control_scope_allowedAccountIds_repair_denied");
    expect(() =>
      assertProjectControlScopeRepairAllowed({
        existing,
        proposed: {
          ...existing,
          allowedAccountIds: ["account-a", "account-a"],
        },
      }),
    ).toThrow("project_control_scope_allowedAccountIds_repair_denied");
  });

  it("allows only safe exact append-only branches during scope repair", () => {
    const existing = { ...projectScope(), allowedBranches: ["main"] };

    expect(() =>
      assertProjectControlScopeRepairAllowed({
        existing,
        proposed: {
          ...existing,
          allowedBranches: [...(existing.allowedBranches ?? []), "dev"],
        },
      }),
    ).not.toThrow();
    expect(() =>
      assertProjectControlScopeRepairAllowed({
        existing,
        proposed: { ...existing, allowedBranches: ["dev"] },
      }),
    ).toThrow("project_control_scope_allowedBranches_repair_denied");
    expect(() =>
      assertProjectControlScopeRepairAllowed({
        existing,
        proposed: {
          ...existing,
          allowedBranches: ["dev", ...(existing.allowedBranches ?? [])],
        },
      }),
    ).toThrow("project_control_scope_allowedBranches_repair_denied");
    expect(() =>
      assertProjectControlScopeRepairAllowed({
        existing,
        proposed: {
          ...existing,
          allowedBranches: [...(existing.allowedBranches ?? []), "feature/*"],
        },
      }),
    ).toThrow("project_control_scope_allowedBranches_repair_denied");
    expect(() =>
      assertProjectControlScopeRepairAllowed({
        existing,
        proposed: {
          ...existing,
          allowedBranches: [...(existing.allowedBranches ?? []), "bad branch"],
        },
      }),
    ).toThrow("project_control_scope_allowedBranches_repair_denied");
    for (const invalid of [
      "",
      "@",
      "feature/@{upstream}",
      "feature/topic.lock",
      "feature/.hidden",
      "feature\\topic",
      "/feature",
      "feature//topic",
    ]) {
      expect(() =>
        assertProjectControlScopeRepairAllowed({
          existing,
          proposed: {
            ...existing,
            allowedBranches: [...(existing.allowedBranches ?? []), invalid],
          },
        }),
      ).toThrow("project_control_scope_allowedBranches_repair_denied");
    }

    const implicitMain = projectScope();
    expect(() =>
      assertProjectControlScopeRepairAllowed({
        existing: implicitMain,
        proposed: {
          ...implicitMain,
          allowedBranches: ["main", "dev"],
        },
      }),
    ).not.toThrow();
    for (const allowedBranches of [[], ["dev"]]) {
      expect(() =>
        assertProjectControlScopeRepairAllowed({
          existing: implicitMain,
          proposed: { ...implicitMain, allowedBranches },
        }),
      ).toThrow("project_control_scope_allowedBranches_repair_denied");
    }
  });

  it("allows only a fail-closed builtin admission upgrade", () => {
    const existing = projectScope();
    const upgraded = {
      ...existing,
      preStartAdmission: {
        required: true as const,
        mode: "serial-builtin" as const,
      },
    };

    expect(() =>
      assertProjectControlScopeRepairAllowed({ existing, proposed: upgraded }),
    ).not.toThrow();
    expect(() =>
      assertProjectControlScopeRepairAllowed({
        existing: upgraded,
        proposed: existing,
      }),
    ).toThrow("project_control_scope_preStartAdmission_repair_denied");
    expect(() =>
      assertProjectControlScopeRepairAllowed({
        existing,
        proposed: {
          ...existing,
          preStartAdmission: {
            required: false,
            mode: "serial-builtin",
          },
        },
      }),
    ).toThrow("project_control_scope_preStartAdmission_repair_denied");

    expect(() =>
      assertProjectControlScopeRepairAllowed({
        existing: {
          ...upgraded,
          preStartAdmission: {
            ...upgraded.preStartAdmission,
            contractSchema: "worker-start-v1",
          } as NonNullable<ProjectAccessScope["preStartAdmission"]>,
        },
        proposed: upgraded,
      }),
    ).not.toThrow();

    expect(() =>
      assertProjectControlScopeRepairAllowed({
        existing: {
          ...existing,
          preStartAdmission: {
            required: true,
            mode: "serial",
            validatorBundle: [
              { path: "/tmp/validator", sha256: "a".repeat(64) },
            ],
          },
        },
        proposed: {
          ...existing,
          preStartAdmission: {
            required: true,
            mode: "serial",
            validatorBundle: [{ path: "/tmp/other", sha256: "b".repeat(64) }],
          },
        },
      }),
    ).toThrow("project_control_scope_preStartAdmission_repair_denied");
  });

  it("parses project control role and dependency bootstrap mode", () => {
    expect(projectControlWorkerRole(undefined)).toBe("producer");
    expect(projectControlWorkerRole("reviewer")).toBe("reviewer");
    expect(() => projectControlWorkerRole("admin")).toThrow(
      "project_control_worker_role_invalid",
    );

    expect(projectControlDependencyBootstrapMode(undefined)).toBe("preflight");
    expect(projectControlDependencyBootstrapMode("install")).toBe("install");
    expect(() => projectControlDependencyBootstrapMode("force")).toThrow(
      "project_control_dependency_bootstrap_mode_invalid",
    );
  });

  it("fails closed when create-manifest paths leave project scope", () => {
    const scope = projectScope();
    const manifest = projectManifest();

    expect(() =>
      assertProjectControlCreateManifestPaths({
        scope,
        registryRootDir: "/tmp/project/registry/jobs",
        manifest,
      }),
    ).not.toThrow();
    expect(() =>
      assertProjectControlCreateManifestPaths({
        scope,
        registryRootDir: "/tmp/project/registry/jobs",
        manifest: { ...manifest, jobRootDir: "/tmp/other/jobs/job-a" },
      }),
    ).toThrow("project_control_job_root_outside_scope");
    expect(() =>
      assertProjectControlCreateManifestPaths({
        scope,
        registryRootDir: "/tmp/project/registry/jobs",
        manifest: { ...manifest, authRootDir: "/tmp/other/auth" },
      }),
    ).toThrow("project_control_auth_root_outside_scope");
    expect(() =>
      assertProjectControlCreateManifestPaths({
        scope,
        registryRootDir: "/tmp/project/registry/jobs",
        manifest: { ...manifest, workspacePath: "/tmp/other/workspace" },
      }),
    ).toThrow("project_control_workspace_outside_scope");
    expect(() =>
      assertProjectControlCreateManifestPaths({
        scope,
        registryRootDir: "/tmp/project/registry/jobs",
        manifest: { ...manifest, promptPath: "/tmp/project/other/prompt.md" },
      }),
    ).toThrow("project_control_promptPath_outside_scope");
  });

  it("resolves project control path args from the request cwd", () => {
    expect(
      projectControlPathArg(
        { cwd: "/tmp/project" },
        "worktrees/job-a",
        "sourceWorkspacePath",
      ),
    ).toBe("/tmp/project/worktrees/job-a");
    expect(() =>
      projectControlPathArg({}, undefined, "sourceWorkspacePath"),
    ).toThrow("sourceWorkspacePath is required");
  });

  it("rejects a worker workspace symlink substituted outside physical scope", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "subscription-runtime-workspace-scope-"),
    );
    const worktreeRoot = join(root, "worktrees");
    const workspace = join(worktreeRoot, "job-a");
    const outside = join(root, "outside");
    const scope: ProjectAccessScope = {
      projectId: "project-a",
      workspaceRoots: [workspace],
      worktreeRoots: [worktreeRoot],
      isolatedWorkspaceRoot: workspace,
    };
    try {
      await Promise.all([
        mkdir(workspace, { recursive: true }),
        mkdir(outside, { recursive: true }),
      ]);
      await expect(
        projectControlCanonicalWorkspacePath(workspace, scope),
      ).resolves.toBe(await realpath(workspace));

      await rm(workspace, { recursive: true });
      await symlink(outside, workspace, "dir");
      await expect(
        projectControlCanonicalWorkspacePath(workspace, scope),
      ).rejects.toThrow("project_control_workspace_real_path_outside_scope");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function projectScope(): ProjectAccessScope {
  return {
    projectId: "project-a",
    projectSlug: "project-a-slug",
    readRoots: ["/tmp/project/read"],
    workspaceRoots: ["/tmp/project/workspaces"],
    worktreeRoots: ["/tmp/project/worktrees"],
    registryRoot: "/tmp/project/registry/jobs",
    authRoot: "/tmp/project/auth",
    deniedRoots: ["/tmp/project/denied"],
    jobIdPrefixes: ["job-"],
    allowedAccountIds: ["account-a"],
  };
}

function projectManifest(): CodexGoalJobManifestInput {
  return {
    jobId: "job-a",
    jobRootDir: "/tmp/project/registry/job-a",
    workspacePath: "/tmp/project/worktrees/job-a",
    promptPath: "/tmp/project/registry/job-a/prompt.md",
    taskId: "task-a",
    accounts: ["account-a"],
  };
}
