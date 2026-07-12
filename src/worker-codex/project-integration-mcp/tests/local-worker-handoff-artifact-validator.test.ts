import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { materializeCodexGoalHandoffArtifacts } from "../../codex-goal-handoff-artifacts";
import { git } from "../../tests/codex-goal-mcp-test-support";
import { validateLocalWorkerHandoffArtifact } from "../adapters/local-worker-handoff-artifact-validator";

const cleanup: string[] = [];

describe("local worker handoff artifact validator", () => {
  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) =>
      rm(path, { recursive: true, force: true })
    ));
  });

  it("validates exact owner, manifest hash, base and changed paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "integration-handoff-validator-"));
    cleanup.push(root);
    const jobsRoot = join(root, "worker-jobs");
    const controllerRoot = join(jobsRoot, "controller-1");
    const workerRoot = join(jobsRoot, "worker-1");
    const workspacePath = join(root, "workspace");
    await mkdir(controllerRoot, { recursive: true });
    await mkdir(workerRoot, { recursive: true });
    await mkdir(workspacePath, { recursive: true });
    await git(workspacePath, ["init"]);
    await git(workspacePath, ["config", "user.email", "test@example.com"]);
    await git(workspacePath, ["config", "user.name", "Test User"]);
    await writeFile(join(workspacePath, "README.md"), "fixture\n");
    await git(workspacePath, ["add", "README.md"]);
    await git(workspacePath, ["commit", "-m", "fixture"]);
    await writeFile(join(workspacePath, "feature.ts"), "export const value = 1;\n");
    const artifacts = await materializeCodexGoalHandoffArtifacts({
      workerJobId: "worker-1",
      taskId: "task-1",
      workspacePath,
      jobRootDir: workerRoot,
    });
    expect(artifacts).not.toBeNull();
    const materialized = artifacts!;
    const manifestSha256 = createHash("sha256")
      .update(await readFile(materialized.manifestPath))
      .digest("hex");
    const controller = {
      registryRootDir: join(root, "registry"),
      controller: { jobId: "controller-1", jobRootDir: controllerRoot },
      scope: { projectId: "project-1" },
    };
    const input = {
      controller,
      workerJobId: "worker-1",
      workspacePath,
      patchPath: materialized.patchPath,
      summaryPath: materialized.summaryPath,
      manifestPath: materialized.manifestPath,
      manifestSha256,
      baseCommit: materialized.baseCommit,
      changedPaths: ["feature.ts"],
    };

    await expect(validateLocalWorkerHandoffArtifact(input)).resolves.toEqual({
      baseCommit: materialized.baseCommit,
      manifestPath: materialized.manifestPath,
      summaryPath: materialized.summaryPath,
    });
    await expect(validateLocalWorkerHandoffArtifact({
      ...input,
      changedPaths: ["other.ts"],
    })).rejects.toThrow("project_integration_handoff_changed_paths_mismatch");
    await expect(validateLocalWorkerHandoffArtifact({
      ...input,
      manifestSha256: "0".repeat(64),
    })).rejects.toThrow("project_integration_handoff_manifest_hash_mismatch");
    await expect(validateLocalWorkerHandoffArtifact({
      ...input,
      baseCommit: "a".repeat(40),
    })).rejects.toThrow("project_integration_handoff_base_commit_mismatch");
    await expect(validateLocalWorkerHandoffArtifact({
      ...input,
      workerJobId: "worker-2",
    })).rejects.toThrow("project_integration_handoff_manifest_unowned_patch");

    const legacyPatchPath = join(workerRoot, "task-1.preserved.patch");
    await writeFile(legacyPatchPath, await readFile(materialized.patchPath));
    await expect(validateLocalWorkerHandoffArtifact({
      controller,
      workerJobId: "worker-1",
      workspacePath,
      patchPath: legacyPatchPath,
      changedPaths: ["feature.ts"],
    })).resolves.toEqual({});
  });
});
