import { describe, expect, it } from "vitest";
import type { ProjectAccessScope } from "@vioxen/subscription-runtime/worker-core";
import { projectControlChildManifestInput } from "../application/project-control/codex-goal-project-child-manifest";

describe("project control child manifest", () => {
  const registryRootDir = "/project/worker-jobs/registry";
  const scope: ProjectAccessScope = {
    projectId: "project",
    registryRoot: registryRootDir,
    authRoot: "/runtime/live-codex-auth",
  };

  it("inherits broker-owned roots when the caller omits them", () => {
    const manifest = projectControlChildManifestInput({
      args: {
        jobId: "project-worker-r1",
        workspacePath: "/project/worktrees/project-worker-r1",
      },
      scope,
      registryRootDir,
    });

    expect(manifest.jobRootDir).toBe(
      "/project/worker-jobs/project-worker-r1",
    );
    expect(manifest.authRootDir).toBe("/runtime/live-codex-auth");
  });

  it("preserves explicit roots for fail-closed scope validation", () => {
    const manifest = projectControlChildManifestInput({
      args: {
        jobId: "project-worker-r1",
        jobRootDir: "/explicit/job-root",
        authRootDir: "/explicit/auth-root",
        workspacePath: "/project/worktrees/project-worker-r1",
      },
      scope,
      registryRootDir,
    });

    expect(manifest.jobRootDir).toBe("/explicit/job-root");
    expect(manifest.authRootDir).toBe("/explicit/auth-root");
  });
});
