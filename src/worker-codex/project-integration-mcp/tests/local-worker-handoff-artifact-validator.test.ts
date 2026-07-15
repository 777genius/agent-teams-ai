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
    await Promise.all(
      cleanup
        .splice(0)
        .map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  it("validates exact owner, manifest hash, base and changed paths", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "integration-handoff-validator-"),
    );
    cleanup.push(root);
    const jobsRoot = join(root, "worker-jobs");
    const controllerRoot = join(jobsRoot, "controller-1");
    const workerRoot = join(jobsRoot, "worker-1");
    const workspacePath = join(root, "workspace");
    const registryRootDir = join(jobsRoot, "registry");
    await mkdir(controllerRoot, { recursive: true });
    await mkdir(workerRoot, { recursive: true });
    await mkdir(workspacePath, { recursive: true });
    await mkdir(registryRootDir, { recursive: true });
    await git(workspacePath, ["init"]);
    await git(workspacePath, ["config", "user.email", "test@example.com"]);
    await git(workspacePath, ["config", "user.name", "Test User"]);
    await writeFile(join(workspacePath, "README.md"), "fixture\n");
    await git(workspacePath, ["add", "README.md"]);
    await git(workspacePath, ["commit", "-m", "fixture"]);
    await writeFile(
      join(workspacePath, "feature.ts"),
      "export const value = 1;\n",
    );
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
      registryRootDir,
      controller: { jobId: "controller-1", jobRootDir: controllerRoot },
      scope: {
        projectId: "project-1",
        registryRoot: registryRootDir,
        workspaceRoots: [workspacePath],
      },
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

    await expect(
      validateLocalWorkerHandoffArtifact(input),
    ).resolves.toMatchObject({
      baseCommit: materialized.baseCommit,
      manifestPath: materialized.manifestPath,
      patchPath: expect.stringContaining("artifact-snapshots/attempt-1/"),
      patchSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      summaryPath: materialized.summaryPath,
    });
    await expect(
      validateLocalWorkerHandoffArtifact({
        ...input,
        changedPaths: ["other.ts"],
      }),
    ).rejects.toThrow("project_integration_handoff_changed_paths_mismatch");
    await expect(
      validateLocalWorkerHandoffArtifact({
        ...input,
        manifestSha256: "0".repeat(64),
      }),
    ).rejects.toThrow("project_integration_handoff_manifest_hash_mismatch");
    await expect(
      validateLocalWorkerHandoffArtifact({
        ...input,
        baseCommit: "a".repeat(40),
      }),
    ).rejects.toThrow("project_integration_handoff_base_commit_mismatch");
    await expect(
      validateLocalWorkerHandoffArtifact({
        ...input,
        workerJobId: "worker-2",
      }),
    ).rejects.toThrow("project_integration_handoff_manifest_unowned_patch");

    const legacyPatchPath = join(workerRoot, "task-1.preserved.patch");
    await writeFile(legacyPatchPath, await readFile(materialized.patchPath));
    await expect(
      validateLocalWorkerHandoffArtifact({
        controller,
        attemptId: "attempt-legacy",
        workerJobId: "worker-1",
        workspacePath,
        patchPath: legacyPatchPath,
        changedPaths: ["feature.ts"],
      }),
    ).resolves.toMatchObject({
      patchPath: expect.stringContaining("artifact-snapshots/attempt-legacy/"),
      patchSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it("resolves a top-level worker job root from the project registry", async () => {
    const root = await mkdtemp(join(tmpdir(), "integration-handoff-registry-"));
    cleanup.push(root);
    const jobsRoot = join(root, "worker-jobs");
    const controllerRoot = join(jobsRoot, "jobs", "controller-1");
    const workerRoot = join(jobsRoot, "worker-1");
    const workspacePath = join(root, "workspace");
    const registryRootDir = join(jobsRoot, "registry");
    await mkdir(controllerRoot, { recursive: true });
    await mkdir(workerRoot, { recursive: true });
    await mkdir(workspacePath, { recursive: true });
    await mkdir(registryRootDir, { recursive: true });
    await git(workspacePath, ["init"]);
    await git(workspacePath, ["config", "user.email", "test@example.com"]);
    await git(workspacePath, ["config", "user.name", "Test User"]);
    await writeFile(join(workspacePath, "README.md"), "fixture\n");
    await git(workspacePath, ["add", "README.md"]);
    await git(workspacePath, ["commit", "-m", "fixture"]);
    await writeFile(
      join(workspacePath, "feature.ts"),
      "export const value = 2;\n",
    );
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
    const registeredJob = {
      schemaVersion: 1,
      jobId: "worker-1",
      createdAt: "2026-07-14T00:00:00.000Z",
      updatedAt: "2026-07-14T00:00:00.000Z",
      jobRootDir: workerRoot,
      workspacePath,
      promptPath: join(workerRoot, "prompt.md"),
      taskId: "task-1",
      accounts: ["account-a"],
      projectAccessScope: {
        projectId: "project-1",
        registryRoot: registryRootDir,
        isolatedWorkspaceRoot: workspacePath,
        workspaceRoots: [workspacePath],
      },
    };
    const controller = {
      registryRootDir,
      controller: { jobId: "controller-1", jobRootDir: controllerRoot },
      scope: {
        projectId: "project-1",
        registryRoot: registryRootDir,
        workspaceRoots: [workspacePath],
      },
    };
    const validationInput = {
      controller,
      attemptId: "attempt-registered-root",
      workerJobId: "worker-1",
      workspacePath,
      patchPath: materialized.patchPath,
      summaryPath: materialized.summaryPath,
      manifestPath: materialized.manifestPath,
      manifestSha256,
      baseCommit: materialized.baseCommit,
      changedPaths: ["feature.ts"],
      registeredWorker: registeredJob,
    };

    await expect(
      validateLocalWorkerHandoffArtifact(validationInput),
    ).resolves.toMatchObject({
      baseCommit: materialized.baseCommit,
      manifestPath: materialized.manifestPath,
      patchPath: expect.stringContaining(
        "artifact-snapshots/attempt-registered-root/",
      ),
      patchSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      summaryPath: materialized.summaryPath,
    });

    await expect(
      validateLocalWorkerHandoffArtifact({
        ...validationInput,
        registeredWorker: {
          ...registeredJob,
          projectAccessScope: {
            ...registeredJob.projectAccessScope,
            projectId: "other-project",
          },
        },
      }),
    ).rejects.toThrow("project_integration_worker_registry_scope_mismatch");

    await expect(
      validateLocalWorkerHandoffArtifact({
        ...validationInput,
        registeredWorker: { ...registeredJob, jobId: "worker-2" },
      }),
    ).rejects.toThrow("project_integration_worker_registry_identity_mismatch");

    const otherWorkspace = join(root, "other-workspace");
    await mkdir(otherWorkspace);
    await expect(
      validateLocalWorkerHandoffArtifact({
        ...validationInput,
        registeredWorker: {
          ...registeredJob,
          workspacePath: otherWorkspace,
          projectAccessScope: {
            ...registeredJob.projectAccessScope,
            isolatedWorkspaceRoot: otherWorkspace,
            workspaceRoots: [otherWorkspace],
          },
        },
      }),
    ).rejects.toThrow("project_integration_worker_registry_ownership_mismatch");

    await expect(
      validateLocalWorkerHandoffArtifact({
        ...validationInput,
        registeredWorker: {
          jobId: registeredJob.jobId,
          jobRootDir: registeredJob.jobRootDir,
          workspacePath: registeredJob.workspacePath,
        },
      }),
    ).rejects.toThrow("project_integration_worker_registry_scope_mismatch");

    const outsideJobRoot = join(root, "outside", "worker-1");
    await mkdir(outsideJobRoot, { recursive: true });
    await expect(
      validateLocalWorkerHandoffArtifact({
        ...validationInput,
        registeredWorker: { ...registeredJob, jobRootDir: outsideJobRoot },
      }),
    ).rejects.toThrow("project_integration_worker_registry_job_root_unowned");

    const archiveRoot = join(
      controllerRoot,
      "archives",
      "worker-1-rejected-attempt-1",
    );
    await mkdir(archiveRoot, { recursive: true });
    const archivedPatchPath = join(archiveRoot, "tracked.diff");
    await writeFile(archivedPatchPath, await readFile(materialized.patchPath));
    await expect(
      validateLocalWorkerHandoffArtifact({
        controller,
        attemptId: "attempt-archived-worker-root-missing",
        workerJobId: "worker-1",
        workspacePath,
        patchPath: archivedPatchPath,
        changedPaths: ["feature.ts"],
        registeredWorker: {
          ...registeredJob,
          jobRootDir: join(jobsRoot, "missing", "worker-1"),
        },
      }),
    ).resolves.toMatchObject({
      patchPath: expect.stringContaining(
        "artifact-snapshots/attempt-archived-worker-root-missing/",
      ),
    });
  });

  it("carries fixture paths into downstream exact-blob validation", async () => {
    const root = await mkdtemp(join(tmpdir(), "integration-handoff-fixture-"));
    cleanup.push(root);
    const jobsRoot = join(root, "worker-jobs");
    const controllerRoot = join(jobsRoot, "controller-1");
    const workerRoot = join(jobsRoot, "worker-1");
    const workspacePath = join(root, "workspace");
    const registryRootDir = join(root, "registry");
    await mkdir(controllerRoot, { recursive: true });
    await mkdir(workerRoot, { recursive: true });
    await mkdir(join(workspacePath, "tests", "fixtures"), { recursive: true });
    await mkdir(registryRootDir, { recursive: true });
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

    await expect(
      validateLocalWorkerHandoffArtifact({
        controller: {
          registryRootDir,
          controller: { jobId: "controller-1", jobRootDir: controllerRoot },
          scope: {
            projectId: "project-1",
            registryRoot: registryRootDir,
            workspaceRoots: [workspacePath],
          },
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
      }),
    ).resolves.toMatchObject({
      baseCommit: materialized.baseCommit,
      patchSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it("rejects oversized changed-path inputs before artifact I/O", async () => {
    await expect(
      validateLocalWorkerHandoffArtifact({
        controller: {
          registryRootDir: "/not-read",
          controller: {
            jobId: "controller-1",
            jobRootDir: "/not-read/controller",
          },
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
      }),
    ).rejects.toThrow(
      "project_integration_handoff_changed_path_limit_exceeded",
    );
  });
});
