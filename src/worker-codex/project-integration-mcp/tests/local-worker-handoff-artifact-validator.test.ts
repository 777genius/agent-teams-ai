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
      attemptId: "attempt-1",
      workerJobId: "worker-1",
      workspacePath,
      patchPath: materialized.patchPath,
      summaryPath: materialized.summaryPath,
      manifestPath: materialized.manifestPath,
      manifestSha256,
      baseCommit: materialized.baseCommit,
      changedPaths: ["feature.ts"],
    };

    await expect(validateLocalWorkerHandoffArtifact(input)).resolves.toMatchObject({
      baseCommit: materialized.baseCommit,
      manifestPath: materialized.manifestPath,
      patchPath: expect.stringContaining("artifact-snapshots/attempt-1/"),
      patchSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
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
      attemptId: "attempt-legacy",
      workerJobId: "worker-1",
      workspacePath,
      patchPath: legacyPatchPath,
      changedPaths: ["feature.ts"],
    })).resolves.toMatchObject({
      patchPath: expect.stringContaining("artifact-snapshots/attempt-legacy/"),
      patchSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it("carries fixture paths into downstream exact-blob validation", async () => {
    const root = await mkdtemp(join(tmpdir(), "integration-handoff-fixture-"));
    cleanup.push(root);
    const jobsRoot = join(root, "worker-jobs");
    const controllerRoot = join(jobsRoot, "controller-1");
    const workerRoot = join(jobsRoot, "worker-1");
    const workspacePath = join(root, "workspace");
    await mkdir(controllerRoot, { recursive: true });
    await mkdir(workerRoot, { recursive: true });
    await mkdir(join(workspacePath, "tests", "fixtures"), { recursive: true });
    await git(workspacePath, ["init"]);
    await git(workspacePath, ["config", "user.email", "test@example.com"]);
    await git(workspacePath, ["config", "user.name", "Test User"]);
    await writeFile(join(workspacePath, "README.md"), "fixture\n");
    await git(workspacePath, ["add", "README.md"]);
    await git(workspacePath, ["commit", "-m", "fixture"]);
    const relativePath = "tests/fixtures/config.env";
    await writeFile(
      join(workspacePath, relativePath),
      ["API_", "KEY=", "test-", "fixture-literal", "\n"].join(""),
    );
    const artifacts = await materializeCodexGoalHandoffArtifacts({
      workerJobId: "worker-1",
      taskId: "task-fixture",
      workspacePath,
      jobRootDir: workerRoot,
    });
    expect(artifacts).not.toBeNull();
    const materialized = artifacts!;
    const manifestSha256 = createHash("sha256")
      .update(await readFile(materialized.manifestPath))
      .digest("hex");

    await expect(validateLocalWorkerHandoffArtifact({
      controller: {
        registryRootDir: join(root, "registry"),
        controller: { jobId: "controller-1", jobRootDir: controllerRoot },
        scope: { projectId: "project-1" },
      },
      attemptId: "attempt-fixture",
      workerJobId: "worker-1",
      workspacePath,
      patchPath: materialized.patchPath,
      summaryPath: materialized.summaryPath,
      manifestPath: materialized.manifestPath,
      manifestSha256,
      baseCommit: materialized.baseCommit,
      changedPaths: [relativePath],
    })).resolves.toMatchObject({
      baseCommit: materialized.baseCommit,
      patchSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it("rejects oversized changed-path inputs before artifact I/O", async () => {
    await expect(validateLocalWorkerHandoffArtifact({
      controller: {
        registryRootDir: "/not-read",
        controller: { jobId: "controller-1", jobRootDir: "/not-read/controller" },
        scope: { projectId: "project-1" },
      },
      attemptId: "attempt-oversized",
      workerJobId: "worker-1",
      workspacePath: "/not-read/workspace",
      patchPath: "/not-read/output.patch",
      changedPaths: Array.from(
        { length: 257 },
        (_, index) => `src/file-${index}.ts`,
      ),
    })).rejects.toThrow(
      "project_integration_handoff_changed_path_limit_exceeded",
    );
  });
});
