import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import {
  CheckRunStatus,
  IntegrationAttemptStatus,
  OperatorArtifactRecoveryState,
  ReviewDecisionStatus,
  validateOperatorArtifactRecoveryAttempt,
  type IntegrationAttempt,
  type OperatorArtifactRecoveryPermit,
} from "@vioxen/subscription-runtime/worker-core";
import { LocalOperatorArtifactRecoveryAdapter } from "../project-integration-local-operator-artifact-recovery";
import { quarantineAndValidateOperatorArtifact } from "../project-integration-local-operator-artifact-recovery";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("LocalOperatorArtifactRecoveryAdapter", () => {
  it("previews, archives and idempotently replays one exact untracked artifact", async () => {
    const fixture = await createFixture();
    const input = fixture.input();

    const preview = await fixture.adapter.inspect(input);
    expect(preview.state).toBe(OperatorArtifactRecoveryState.Ready);
    expect(
      await exists(
        join(fixture.archive, "integration-check-artifact-recovery"),
      ),
    ).toBe(false);

    const prepared = await fixture.adapter.prepare({
      ...input,
      preparedAt: "2026-07-22T00:00:03.000Z",
    });
    expect(prepared.state).toBe(OperatorArtifactRecoveryState.Prepared);

    const completed = await fixture.adapter.complete({
      ...input,
      completedAt: "2026-07-22T00:00:04.000Z",
    });
    expect(completed.state).toBe(OperatorArtifactRecoveryState.Completed);
    expect(
      await exists(join(fixture.workspace, fixture.permit.artifact.path)),
    ).toBe(false);
    expect(await readFile(completed.artifactArchivePath!, "utf8")).toBe(
      "cache-bytes\n",
    );
    expect(await fixture.adapter.inspect(input)).toMatchObject({
      state: OperatorArtifactRecoveryState.Completed,
      artifactArchivePath: completed.artifactArchivePath,
    });
  });

  it("fails closed when any unrelated dirty file is present", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.workspace, "unrelated.txt"), "foreign\n");

    await expect(fixture.adapter.inspect(fixture.input())).rejects.toThrow(
      "operator_artifact_recovery_dirty_set_mismatch",
    );
    expect(
      await exists(join(fixture.workspace, fixture.permit.artifact.path)),
    ).toBe(true);
  });

  it("rejects symlink artifacts without moving them", async () => {
    const fixture = await createFixture();
    const artifactPath = join(fixture.workspace, fixture.permit.artifact.path);
    await rm(artifactPath);
    await execFileAsync("ln", ["-s", "src/a.ts", artifactPath]);

    await expect(fixture.adapter.inspect(fixture.input())).rejects.toThrow(
      "operator_artifact_recovery_artifact_not_regular_file",
    );
    expect((await lstat(artifactPath)).isSymbolicLink()).toBe(true);
  });

  it("rejects candidate bytes that differ from the immutable reviewed patch", async () => {
    const fixture = await createFixture();
    await writeFile(
      join(fixture.workspace, "src/a.ts"),
      "export const value = 3;\n",
    );
    await expect(fixture.adapter.inspect(fixture.input())).rejects.toThrow(
      "local_git_integration_patch_not_exactly_applied",
    );
  });

  it("rejects a staged candidate even when its worktree bytes match", async () => {
    const fixture = await createFixture();
    await git(fixture.workspace, ["add", "src/a.ts"]);
    await expect(fixture.adapter.inspect(fixture.input())).rejects.toThrow(
      "operator_artifact_recovery_index_head_mismatch",
    );
  });

  it("rejects an artifact whose mtime is outside the passed check interval", async () => {
    const fixture = await createFixture();
    const artifactPath = join(fixture.workspace, fixture.permit.artifact.path);
    await utimes(
      artifactPath,
      new Date("2026-07-21T23:00:00.000Z"),
      new Date("2026-07-21T23:00:00.000Z"),
    );
    await expect(fixture.adapter.inspect(fixture.input())).rejects.toThrow(
      "operator_artifact_recovery_artifact_mtime_mismatch",
    );
  });

  it("restores a quarantined artifact atomically when post-rename identity fails", async () => {
    const fixture = await createFixture();
    const sourcePath = join(fixture.workspace, fixture.permit.artifact.path);
    const archivePath = join(fixture.archive, "quarantine.bin");
    await expect(
      quarantineAndValidateOperatorArtifact({
        sourcePath,
        archivePath,
        permit: {
          ...fixture.permit,
          artifact: { ...fixture.permit.artifact, sha256: "0".repeat(64) },
        },
      }),
    ).rejects.toThrow("operator_artifact_recovery_artifact_hash_mismatch");
    expect(await exists(sourcePath)).toBe(true);
    expect(await exists(archivePath)).toBe(false);
  });

  it("rejects unsafe archive permissions and symlinks without writing", async () => {
    const fixture = await createFixture();
    await chmod(fixture.archive, 0o755);
    await expect(fixture.adapter.inspect(fixture.input())).rejects.toThrow(
      "operator_artifact_recovery_archive_directory_unsafe",
    );
    await rm(fixture.archive, { recursive: true });
    await execFileAsync("ln", ["-s", fixture.workspace, fixture.archive]);
    await expect(fixture.adapter.inspect(fixture.input())).rejects.toThrow(
      "operator_artifact_recovery_archive_directory_unsafe",
    );
  });
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "operator-artifact-recovery-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  const workerWorkspace = join(root, "worker");
  const evidence = join(root, "evidence");
  const archive = join(root, "archive");
  await Promise.all([
    mkdir(join(workspace, "src"), { recursive: true }),
    mkdir(workerWorkspace, { recursive: true }),
    mkdir(evidence, { recursive: true }),
    mkdir(archive, { recursive: true }),
  ]);
  await chmod(archive, 0o700);
  await git(workspace, ["init", "-b", "main"]);
  await writeFile(join(workspace, "src/a.ts"), "export const value = 1;\n");
  await git(workspace, ["add", "src/a.ts"]);
  await git(workspace, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-m",
    "test: seed",
  ]);
  const head = (await git(workspace, ["rev-parse", "HEAD"])).trim();
  await writeFile(join(workspace, "src/a.ts"), "export const value = 2;\n");
  const patchBytes = Buffer.from(await git(workspace, ["diff", "--binary"]));
  const patchPath = join(evidence, "output.patch");
  await writeFile(patchPath, patchBytes);
  await git(workspace, ["restore", "src/a.ts"]);
  await git(workspace, ["apply", patchPath]);
  const artifactPath = join(workspace, ".eslintcache-features");
  const artifactBytes = Buffer.from("cache-bytes\n");
  await writeFile(artifactPath, artifactBytes, { mode: 0o600 });
  await chmod(artifactPath, 0o600);
  await utimes(
    artifactPath,
    new Date("2026-07-22T00:00:01.500Z"),
    new Date("2026-07-22T00:00:01.500Z"),
  );
  const artifactMtimeMs = (await lstat(artifactPath)).mtimeMs;

  const attempt: IntegrationAttempt = {
    attemptId: "attempt-1",
    projectId: "project-1",
    controllerJobId: "controller-1",
    workerJobId: "worker-1",
    sourceWorkspacePath: workerWorkspace,
    targetWorkspacePath: workspace,
    targetBranch: "main",
    targetRemote: "origin",
    expectedFiles: ["src/a.ts"],
    status: IntegrationAttemptStatus.ChecksPassed,
    workerOutput: {
      workerJobId: "worker-1",
      workspacePath: workerWorkspace,
      patchPath,
      patchSha256: sha256(patchBytes),
      targetCommit: head,
      changedFiles: ["src/a.ts"],
    },
    reviewDecision: {
      reviewedBy: "reviewer",
      decision: ReviewDecisionStatus.Approved,
      reason: "approved",
      approvedFiles: ["src/a.ts"],
      requiredChecks: [{ checkId: "lint", command: ["npm", "run", "lint"] }],
    },
    checkRuns: [
      {
        checkId: "lint",
        command: ["npm", "run", "lint"],
        status: CheckRunStatus.Passed,
        startedAt: "2026-07-22T00:00:01.000Z",
        completedAt: "2026-07-22T00:00:02.000Z",
        exitCode: 0,
      },
    ],
    createdAt: "2026-07-22T00:00:00.000Z",
    updatedAt: "2026-07-22T00:00:02.000Z",
  };
  const permit: OperatorArtifactRecoveryPermit = {
    schemaVersion: 1,
    registryRootDir: join(root, "registry"),
    controllerJobId: attempt.controllerJobId,
    projectId: attempt.projectId,
    attemptId: attempt.attemptId,
    expectedAttemptStatus: IntegrationAttemptStatus.ChecksPassed,
    targetWorkspacePath: workspace,
    targetBranch: "main",
    targetHeadSha: head,
    candidatePatchSha256: sha256(patchBytes),
    candidatePatchSize: patchBytes.length,
    artifact: {
      path: ".eslintcache-features",
      sha256: sha256(artifactBytes),
      size: artifactBytes.length,
      mode: 0o600,
      mtimeMs: artifactMtimeMs,
    },
    check: {
      checkId: "lint",
      command: ["npm", "run", "lint"],
      startedAt: "2026-07-22T00:00:01.000Z",
      completedAt: "2026-07-22T00:00:02.000Z",
    },
  };
  const adapter = new LocalOperatorArtifactRecoveryAdapter({
    archiveRoot: archive,
    allowedPatchRoots: [evidence],
  });
  return {
    workspace,
    archive,
    permit,
    adapter,
    input: () => ({
      attempt,
      permit,
      permitSha256: "f".repeat(64),
      validation: validateOperatorArtifactRecoveryAttempt({ attempt, permit }),
    }),
  };
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync("git", [...args], { cwd });
  return result.stdout;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
