import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import type { IntegrationAttempt } from "@vioxen/subscription-runtime/worker-core";
import { LocalGitIntegrationAdapter } from "../index";

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

describe("local project integration output rollback", () => {
  it("reverses the exact immutable patch and verifies a clean target", async () => {
    const fixture = await createFixture();
    const adapter = new LocalGitIntegrationAdapter({
      allowedPatchRoots: [fixture.rootDir],
    });

    await adapter.applyWorkerOutput({
      attempt: fixture.attempt,
      workerOutput: fixture.attempt.workerOutput,
    });
    await expect(readFile(fixture.filePath, "utf8"))
      .resolves.toBe("export const value = 2;\n");
    await adapter.rollbackWorkerOutput({ attempt: fixture.attempt });
    await adapter.rollbackWorkerOutput({ attempt: fixture.attempt });

    await expect(adapter.getStatus({ workspacePath: fixture.workspacePath }))
      .resolves.toEqual({ branch: "main", dirtyFiles: [] });
    await expect(readFile(fixture.filePath, "utf8"))
      .resolves.toBe("export const value = 1;\n");
    expect((await gitOutput(fixture.workspacePath, ["rev-parse", "HEAD"])).trim())
      .toBe(fixture.targetCommit);
  });

  it("fails closed when the applied patch no longer matches target state", async () => {
    const fixture = await createFixture();
    const adapter = new LocalGitIntegrationAdapter({
      allowedPatchRoots: [fixture.rootDir],
    });
    await adapter.applyWorkerOutput({
      attempt: fixture.attempt,
      workerOutput: fixture.attempt.workerOutput,
    });
    await writeFile(fixture.filePath, "export const value = 99;\n");

    await expect(adapter.rollbackWorkerOutput({ attempt: fixture.attempt }))
      .rejects.toThrow(
        "local_git_integration_output_rollback_patch_not_exactly_applied",
      );
    await expect(readFile(fixture.filePath, "utf8"))
      .resolves.toBe("export const value = 99;\n");
  });

  it("does not partially reverse a patch after distant same-file tampering", async () => {
    const fixture = await createDistantPatchFixture();
    const adapter = new LocalGitIntegrationAdapter({
      allowedPatchRoots: [fixture.rootDir],
    });
    await adapter.applyWorkerOutput({
      attempt: fixture.attempt,
      workerOutput: fixture.attempt.workerOutput,
    });
    const tamperedLines = (await readFile(fixture.filePath, "utf8")).split("\n");
    tamperedLines[19] = "line 20: tampered";
    await writeFile(fixture.filePath, tamperedLines.join("\n"));

    await expect(adapter.rollbackWorkerOutput({ attempt: fixture.attempt }))
      .rejects.toThrow(
        "local_git_integration_output_rollback_patch_not_exactly_applied",
      );
    const preservedLines = (await readFile(fixture.filePath, "utf8")).split("\n");
    expect(preservedLines[0]).toBe("line 1: applied");
    expect(preservedLines[19]).toBe("line 20: tampered");
  });

  it("fails closed when the real index contains staged patch tampering", async () => {
    const fixture = await createFixture();
    const adapter = new LocalGitIntegrationAdapter({
      allowedPatchRoots: [fixture.rootDir],
    });
    await adapter.applyWorkerOutput({
      attempt: fixture.attempt,
      workerOutput: fixture.attempt.workerOutput,
    });
    await writeFile(fixture.filePath, "export const value = 99;\n");
    await git(fixture.workspacePath, ["add", "src/memory.ts"]);
    await writeFile(fixture.filePath, "export const value = 2;\n");

    await expect(adapter.rollbackWorkerOutput({ attempt: fixture.attempt }))
      .rejects.toThrow(
        "local_git_integration_output_rollback_patch_index_mismatch",
      );
    await expect(readFile(fixture.filePath, "utf8"))
      .resolves.toBe("export const value = 2;\n");
    expect(await gitOutput(fixture.workspacePath, ["show", ":src/memory.ts"]))
      .toBe("export const value = 99;\n");
  });

  it("rolls back applied patch bytes hidden by skip-worktree", async () => {
    const fixture = await createFixture();
    const adapter = new LocalGitIntegrationAdapter({
      allowedPatchRoots: [fixture.rootDir],
    });
    await adapter.applyWorkerOutput({
      attempt: fixture.attempt,
      workerOutput: fixture.attempt.workerOutput,
    });
    await git(fixture.workspacePath, [
      "update-index",
      "--skip-worktree",
      "src/memory.ts",
    ]);
    await expect(adapter.getStatus({ workspacePath: fixture.workspacePath }))
      .resolves.toEqual({ branch: "main", dirtyFiles: [] });

    await adapter.rollbackWorkerOutput({ attempt: fixture.attempt });
    await git(fixture.workspacePath, [
      "update-index",
      "--no-skip-worktree",
      "src/memory.ts",
    ]);

    await expect(readFile(fixture.filePath, "utf8"))
      .resolves.toBe("export const value = 1;\n");
    await expect(adapter.getStatus({ workspacePath: fixture.workspacePath }))
      .resolves.toEqual({ branch: "main", dirtyFiles: [] });
  });

  it("accepts idempotent target state hidden by skip-worktree", async () => {
    const fixture = await createFixture();
    const adapter = new LocalGitIntegrationAdapter({
      allowedPatchRoots: [fixture.rootDir],
    });
    await git(fixture.workspacePath, [
      "update-index",
      "--skip-worktree",
      "src/memory.ts",
    ]);

    await adapter.rollbackWorkerOutput({ attempt: fixture.attempt });
    await git(fixture.workspacePath, [
      "update-index",
      "--no-skip-worktree",
      "src/memory.ts",
    ]);

    await expect(readFile(fixture.filePath, "utf8"))
      .resolves.toBe("export const value = 1;\n");
  });

  it("fails closed on unrelated tracked tampering hidden by skip-worktree", async () => {
    const fixture = await createFixture();
    const adapter = new LocalGitIntegrationAdapter({
      allowedPatchRoots: [fixture.rootDir],
    });
    const unrelatedFile = "src/unrelated.ts";
    const unrelatedPath = join(fixture.workspacePath, unrelatedFile);
    await writeFile(unrelatedPath, "export const unrelated = 1;\n");
    await git(fixture.workspacePath, ["add", unrelatedFile]);
    await git(fixture.workspacePath, ["commit", "-m", "test: tracked peer"]);
    const targetCommit = (await gitOutput(
      fixture.workspacePath,
      ["rev-parse", "HEAD"],
    )).trim();
    const attempt = {
      ...fixture.attempt,
      workerOutput: {
        ...fixture.attempt.workerOutput,
        baseCommit: targetCommit,
        targetCommit,
      },
    } as IntegrationAttempt;
    await adapter.applyWorkerOutput({
      attempt,
      workerOutput: attempt.workerOutput,
    });
    await git(fixture.workspacePath, [
      "update-index",
      "--skip-worktree",
      unrelatedFile,
    ]);
    await writeFile(unrelatedPath, "export const unrelated = 99;\n");
    await expect(adapter.getStatus({ workspacePath: fixture.workspacePath }))
      .resolves.toEqual({ branch: "main", dirtyFiles: ["src/memory.ts"] });

    await expect(adapter.rollbackWorkerOutput({ attempt }))
      .rejects.toThrow(
        "local_git_integration_output_rollback_patch_not_exactly_applied",
      );
    await expect(readFile(fixture.filePath, "utf8"))
      .resolves.toBe("export const value = 2;\n");
    await expect(readFile(unrelatedPath, "utf8"))
      .resolves.toBe("export const unrelated = 99;\n");
  });

  it("removes a new file introduced by the exact immutable patch", async () => {
    const fixture = await createFixture({ newFile: true });
    const adapter = new LocalGitIntegrationAdapter({
      allowedPatchRoots: [fixture.rootDir],
    });

    await adapter.applyWorkerOutput({
      attempt: fixture.attempt,
      workerOutput: fixture.attempt.workerOutput,
    });
    await expect(readFile(fixture.filePath, "utf8"))
      .resolves.toBe("export const added = true;\n");
    await adapter.rollbackWorkerOutput({ attempt: fixture.attempt });

    await expect(adapter.getStatus({ workspacePath: fixture.workspacePath }))
      .resolves.toEqual({ branch: "main", dirtyFiles: [] });
    await expect(readFile(fixture.filePath, "utf8")).rejects.toThrow();
  });

  it("fails closed when patch output has an extra dirty file", async () => {
    const fixture = await createFixture();
    const adapter = new LocalGitIntegrationAdapter({
      allowedPatchRoots: [fixture.rootDir],
    });
    await adapter.applyWorkerOutput({
      attempt: fixture.attempt,
      workerOutput: fixture.attempt.workerOutput,
    });
    const unrelatedPath = join(fixture.workspacePath, "src", "unrelated.ts");
    await writeFile(unrelatedPath, "export const unrelated = true;\n");

    await expect(adapter.rollbackWorkerOutput({ attempt: fixture.attempt }))
      .rejects.toThrow(
        "local_git_integration_output_rollback_dirty_mismatch",
      );
    await expect(readFile(fixture.filePath, "utf8"))
      .resolves.toBe("export const value = 2;\n");
    await expect(readFile(unrelatedPath, "utf8"))
      .resolves.toBe("export const unrelated = true;\n");
  });

  it("restores an exact commit-backed modification", async () => {
    const fixture = await createCommitFixture();
    const adapter = new LocalGitIntegrationAdapter();

    await adapter.applyWorkerOutput({
      attempt: fixture.attempt,
      workerOutput: fixture.attempt.workerOutput,
    });
    await expect(readFile(fixture.filePath, "utf8"))
      .resolves.toBe("export const value = 2;\n");

    await adapter.rollbackWorkerOutput({ attempt: fixture.attempt });

    await expect(adapter.getStatus({ workspacePath: fixture.workspacePath }))
      .resolves.toEqual({ branch: "main", dirtyFiles: [] });
    await expect(readFile(fixture.filePath, "utf8"))
      .resolves.toBe("export const value = 1;\n");
  });

  it("removes a new file introduced by the exact commit output", async () => {
    const fixture = await createCommitFixture({ newFile: true });
    const adapter = new LocalGitIntegrationAdapter();

    await adapter.applyWorkerOutput({
      attempt: fixture.attempt,
      workerOutput: fixture.attempt.workerOutput,
    });
    await expect(readFile(fixture.filePath, "utf8"))
      .resolves.toBe("export const added = true;\n");
    await adapter.rollbackWorkerOutput({ attempt: fixture.attempt });

    await expect(adapter.getStatus({ workspacePath: fixture.workspacePath }))
      .resolves.toEqual({ branch: "main", dirtyFiles: [] });
    await expect(readFile(fixture.filePath, "utf8")).rejects.toThrow();
  });

  it("fails closed when commit output content is tampered on the same path", async () => {
    const fixture = await createCommitFixture();
    const adapter = new LocalGitIntegrationAdapter();
    await adapter.applyWorkerOutput({
      attempt: fixture.attempt,
      workerOutput: fixture.attempt.workerOutput,
    });
    await writeFile(fixture.filePath, "export const value = 99;\n");

    await expect(adapter.rollbackWorkerOutput({ attempt: fixture.attempt }))
      .rejects.toThrow(
        "local_git_integration_output_rollback_commit_not_exactly_applied",
      );
    await expect(readFile(fixture.filePath, "utf8"))
      .resolves.toBe("export const value = 99;\n");
  });

  it("fails closed when the real index contains staged commit tampering", async () => {
    const fixture = await createCommitFixture();
    const adapter = new LocalGitIntegrationAdapter();
    await adapter.applyWorkerOutput({
      attempt: fixture.attempt,
      workerOutput: fixture.attempt.workerOutput,
    });
    await writeFile(fixture.filePath, "export const value = 99;\n");
    await git(fixture.workspacePath, ["add", "src/memory.ts"]);
    await writeFile(fixture.filePath, "export const value = 2;\n");

    await expect(adapter.rollbackWorkerOutput({ attempt: fixture.attempt }))
      .rejects.toThrow(
        "local_git_integration_output_rollback_commit_index_mismatch",
      );
    await expect(readFile(fixture.filePath, "utf8"))
      .resolves.toBe("export const value = 2;\n");
    expect(await gitOutput(fixture.workspacePath, ["show", ":src/memory.ts"]))
      .toBe("export const value = 99;\n");
  });

  it("fails closed when commit output has an extra dirty file", async () => {
    const fixture = await createCommitFixture();
    const adapter = new LocalGitIntegrationAdapter();
    await adapter.applyWorkerOutput({
      attempt: fixture.attempt,
      workerOutput: fixture.attempt.workerOutput,
    });
    const unrelatedPath = join(fixture.workspacePath, "src", "unrelated.ts");
    await writeFile(unrelatedPath, "export const unrelated = true;\n");

    await expect(adapter.rollbackWorkerOutput({ attempt: fixture.attempt }))
      .rejects.toThrow(
        "local_git_integration_output_rollback_dirty_mismatch",
      );
    await expect(readFile(fixture.filePath, "utf8"))
      .resolves.toBe("export const value = 2;\n");
    await expect(readFile(unrelatedPath, "utf8"))
      .resolves.toBe("export const unrelated = true;\n");
  });

  it("fails closed when the immutable commit parent is not the target", async () => {
    const fixture = await createParentMismatchCommitFixture();
    const adapter = new LocalGitIntegrationAdapter();
    await adapter.applyWorkerOutput({
      attempt: fixture.attempt,
      workerOutput: fixture.attempt.workerOutput,
    });

    await expect(adapter.rollbackWorkerOutput({ attempt: fixture.attempt }))
      .rejects.toThrow(
        "local_git_integration_output_rollback_commit_parent_mismatch",
      );
    await expect(readFile(fixture.filePath, "utf8"))
      .resolves.toBe("export const value = 2;\n");
  });

  it("fails closed when claimed applied files differ from the immutable commit", async () => {
    const fixture = await createCommitFixture();
    const adapter = new LocalGitIntegrationAdapter();
    await adapter.applyWorkerOutput({
      attempt: fixture.attempt,
      workerOutput: fixture.attempt.workerOutput,
    });
    const unrelatedFile = "src/unrelated.ts";
    const unrelatedPath = join(fixture.workspacePath, unrelatedFile);
    await writeFile(unrelatedPath, "export const unrelated = true;\n");
    const mismatchedAttempt = {
      ...fixture.attempt,
      appliedFiles: ["src/memory.ts", unrelatedFile],
    } as IntegrationAttempt;

    await expect(adapter.rollbackWorkerOutput({ attempt: mismatchedAttempt }))
      .rejects.toThrow(
        "local_git_integration_output_rollback_commit_files_mismatch",
      );
    await expect(readFile(fixture.filePath, "utf8"))
      .resolves.toBe("export const value = 2;\n");
    await expect(readFile(unrelatedPath, "utf8"))
      .resolves.toBe("export const unrelated = true;\n");
  });

  it.each(["patch", "commit"] as const)(
    "restores exact binary modification and deletion for %s output",
    async (source) => {
      const fixture = await createBinaryDeletionFixture(source);
      const adapter = new LocalGitIntegrationAdapter(
        source === "patch" ? { allowedPatchRoots: [fixture.rootDir] } : {},
      );
      await adapter.applyWorkerOutput({
        attempt: fixture.attempt,
        workerOutput: fixture.attempt.workerOutput,
      });
      expect(Array.from(await readFile(fixture.binaryPath)))
        .toEqual([0, 1, 9, 3, 255]);
      await expect(readFile(fixture.deletedPath)).rejects.toThrow();

      await adapter.rollbackWorkerOutput({ attempt: fixture.attempt });

      expect(Array.from(await readFile(fixture.binaryPath)))
        .toEqual([0, 1, 2, 3, 255]);
      await expect(readFile(fixture.deletedPath, "utf8"))
        .resolves.toBe("export const removed = true;\n");
      await expect(adapter.getStatus({ workspacePath: fixture.workspacePath }))
        .resolves.toEqual({ branch: "main", dirtyFiles: [] });
    },
  );

  it.each(["patch", "commit"] as const)(
    "restores mode-only %s output when core.fileMode is false",
    async (source) => {
      const fixture = await createModeOnlyFixture(source);
      const adapter = new LocalGitIntegrationAdapter(
        source === "patch" ? { allowedPatchRoots: [fixture.rootDir] } : {},
      );

      const applied = await adapter.applyWorkerOutput({
        attempt: fixture.attempt,
        workerOutput: fixture.attempt.workerOutput,
      });
      expect(applied.changedFiles).toEqual([fixture.relativeFile]);
      expect((await stat(fixture.filePath)).mode & 0o111).not.toBe(0);

      await adapter.rollbackWorkerOutput({
        attempt: {
          ...fixture.attempt,
          appliedFiles: applied.changedFiles,
        } as IntegrationAttempt,
      });

      expect((await stat(fixture.filePath)).mode & 0o111).toBe(0);
      await expect(adapter.getStatus({ workspacePath: fixture.workspacePath }))
        .resolves.toEqual({ branch: "main", dirtyFiles: [] });
    },
  );

  it("rejects a patch rename when only the destination is owned", async () => {
    const fixture = await createRenamePatchFixture(false);
    const adapter = new LocalGitIntegrationAdapter({
      allowedPatchRoots: [fixture.rootDir],
    });

    await expect(adapter.applyWorkerOutput({
      attempt: fixture.attempt,
      workerOutput: fixture.attempt.workerOutput,
    })).rejects.toThrow();

    await expect(readFile(fixture.sourcePath, "utf8"))
      .resolves.toBe("export const renamed = true;\n");
    await expect(readFile(fixture.destinationPath, "utf8")).rejects.toThrow();
  });

  it("rolls back a patch rename when both paths are owned", async () => {
    const fixture = await createRenamePatchFixture(true);
    const adapter = new LocalGitIntegrationAdapter({
      allowedPatchRoots: [fixture.rootDir],
    });

    const applied = await adapter.applyWorkerOutput({
      attempt: fixture.attempt,
      workerOutput: fixture.attempt.workerOutput,
    });
    expect(applied.changedFiles).toEqual(["outside.ts", "src/inside.ts"]);
    await expect(readFile(fixture.sourcePath, "utf8")).rejects.toThrow();
    await expect(readFile(fixture.destinationPath, "utf8"))
      .resolves.toBe("export const renamed = true;\n");

    await adapter.rollbackWorkerOutput({
      attempt: {
        ...fixture.attempt,
        appliedFiles: applied.changedFiles,
      } as IntegrationAttempt,
    });

    await expect(readFile(fixture.sourcePath, "utf8"))
      .resolves.toBe("export const renamed = true;\n");
    await expect(readFile(fixture.destinationPath, "utf8")).rejects.toThrow();
    await expect(adapter.getStatus({ workspacePath: fixture.workspacePath }))
      .resolves.toEqual({ branch: "main", dirtyFiles: [] });
  });
});

async function createFixture(options: {
  readonly newFile?: boolean;
} = {}): Promise<{
  readonly rootDir: string;
  readonly workspacePath: string;
  readonly filePath: string;
  readonly targetCommit: string;
  readonly attempt: IntegrationAttempt;
}> {
  const rootDir = await mkdtemp(join(tmpdir(), "output-rollback-"));
  tempRoots.push(rootDir);
  const workspacePath = join(rootDir, "workspace");
  const relativeFile = options.newFile ? "src/added.ts" : "src/memory.ts";
  const filePath = join(workspacePath, relativeFile);
  await mkdir(join(workspacePath, "src"), { recursive: true });
  await git(workspacePath, ["init", "-b", "main"]);
  await git(workspacePath, ["config", "user.email", "test@example.com"]);
  await git(workspacePath, ["config", "user.name", "Test User"]);
  await writeFile(
    join(workspacePath, "src", "memory.ts"),
    "export const value = 1;\n",
  );
  await git(workspacePath, ["add", "."]);
  await git(workspacePath, ["commit", "-m", "chore: initial"]);
  const targetCommit = (await gitOutput(
    workspacePath,
    ["rev-parse", "HEAD"],
  )).trim();
  await writeFile(
    filePath,
    options.newFile
      ? "export const added = true;\n"
      : "export const value = 2;\n",
  );
  if (options.newFile) await git(workspacePath, ["add", relativeFile]);
  const patch = await gitOutput(
    workspacePath,
    options.newFile ? ["diff", "--cached", "--binary"] : ["diff", "--binary"],
  );
  const patchPath = join(rootDir, "reviewed-output.patch");
  await writeFile(patchPath, patch);
  if (options.newFile) {
    await git(workspacePath, ["reset", "--", relativeFile]);
    await rm(filePath);
  } else {
    await git(workspacePath, ["restore", "--", relativeFile]);
  }
  const attempt = {
    targetWorkspacePath: workspacePath,
    targetBranch: "main",
    expectedFiles: [relativeFile],
    workerOutput: {
      workerJobId: "reviewed-worker",
      workspacePath,
      patchPath,
      patchSha256: createHash("sha256").update(patch).digest("hex"),
      baseCommit: targetCommit,
      targetCommit,
      changedFiles: [relativeFile],
    },
  } as unknown as IntegrationAttempt;
  return { rootDir, workspacePath, filePath, targetCommit, attempt };
}

async function createDistantPatchFixture(): Promise<{
  readonly rootDir: string;
  readonly workspacePath: string;
  readonly filePath: string;
  readonly targetCommit: string;
  readonly attempt: IntegrationAttempt;
}> {
  const rootDir = await mkdtemp(join(tmpdir(), "output-rollback-distant-"));
  tempRoots.push(rootDir);
  const workspacePath = join(rootDir, "workspace");
  const relativeFile = "src/memory.ts";
  const filePath = join(workspacePath, relativeFile);
  await mkdir(join(workspacePath, "src"), { recursive: true });
  await git(workspacePath, ["init", "-b", "main"]);
  await git(workspacePath, ["config", "user.email", "test@example.com"]);
  await git(workspacePath, ["config", "user.name", "Test User"]);
  const originalLines = Array.from(
    { length: 20 },
    (_, index) => `line ${index + 1}: original`,
  );
  await writeFile(filePath, `${originalLines.join("\n")}\n`);
  await git(workspacePath, ["add", relativeFile]);
  await git(workspacePath, ["commit", "-m", "chore: initial"]);
  const targetCommit = (await gitOutput(
    workspacePath,
    ["rev-parse", "HEAD"],
  )).trim();
  const appliedLines = [...originalLines];
  appliedLines[0] = "line 1: applied";
  await writeFile(filePath, `${appliedLines.join("\n")}\n`);
  const patch = await gitOutput(workspacePath, ["diff", "--binary"]);
  const patchPath = join(rootDir, "reviewed-output.patch");
  await writeFile(patchPath, patch);
  await git(workspacePath, ["restore", "--", relativeFile]);
  const attempt = {
    targetWorkspacePath: workspacePath,
    targetBranch: "main",
    expectedFiles: [relativeFile],
    workerOutput: {
      workerJobId: "reviewed-worker",
      workspacePath,
      patchPath,
      patchSha256: createHash("sha256").update(patch).digest("hex"),
      baseCommit: targetCommit,
      targetCommit,
      changedFiles: [relativeFile],
    },
  } as unknown as IntegrationAttempt;
  return { rootDir, workspacePath, filePath, targetCommit, attempt };
}

async function createCommitFixture(options: {
  readonly newFile?: boolean;
} = {}): Promise<{
  readonly rootDir: string;
  readonly workspacePath: string;
  readonly filePath: string;
  readonly targetCommit: string;
  readonly attempt: IntegrationAttempt;
}> {
  const fixture = await createFixture();
  const relativeFile = options.newFile ? "src/added.ts" : "src/memory.ts";
  const filePath = join(fixture.workspacePath, relativeFile);
  await writeFile(
    filePath,
    options.newFile
      ? "export const added = true;\n"
      : "export const value = 2;\n",
  );
  await git(fixture.workspacePath, ["add", relativeFile]);
  await git(fixture.workspacePath, ["commit", "-m", "feat: worker output"]);
  const commitSha = (await gitOutput(
    fixture.workspacePath,
    ["rev-parse", "HEAD"],
  )).trim();
  await git(fixture.workspacePath, ["reset", "--hard", fixture.targetCommit]);
  const attempt = {
    ...fixture.attempt,
    expectedFiles: [relativeFile],
    workerOutput: {
      workerJobId: "reviewed-worker",
      workspacePath: fixture.workspacePath,
      commitSha,
      baseCommit: fixture.targetCommit,
      targetCommit: fixture.targetCommit,
      changedFiles: [relativeFile],
    },
  } as IntegrationAttempt;
  return { ...fixture, filePath, attempt };
}

async function createParentMismatchCommitFixture(): Promise<{
  readonly rootDir: string;
  readonly workspacePath: string;
  readonly filePath: string;
  readonly targetCommit: string;
  readonly attempt: IntegrationAttempt;
}> {
  const fixture = await createFixture();
  const alternateBasePath = join(fixture.workspacePath, "src", "alternate.ts");
  await writeFile(alternateBasePath, "export const alternate = true;\n");
  await git(fixture.workspacePath, ["add", "src/alternate.ts"]);
  await git(fixture.workspacePath, ["commit", "-m", "test: alternate base"]);
  await writeFile(fixture.filePath, "export const value = 2;\n");
  await git(fixture.workspacePath, ["add", "src/memory.ts"]);
  await git(fixture.workspacePath, ["commit", "-m", "feat: worker output"]);
  const commitSha = (await gitOutput(
    fixture.workspacePath,
    ["rev-parse", "HEAD"],
  )).trim();
  await git(fixture.workspacePath, ["reset", "--hard", fixture.targetCommit]);
  const attempt = {
    ...fixture.attempt,
    workerOutput: {
      workerJobId: "reviewed-worker",
      workspacePath: fixture.workspacePath,
      commitSha,
      baseCommit: fixture.targetCommit,
      targetCommit: fixture.targetCommit,
      changedFiles: ["src/memory.ts"],
    },
  } as IntegrationAttempt;
  return { ...fixture, attempt };
}

async function createBinaryDeletionFixture(source: "patch" | "commit"): Promise<{
  readonly rootDir: string;
  readonly workspacePath: string;
  readonly binaryPath: string;
  readonly deletedPath: string;
  readonly attempt: IntegrationAttempt;
}> {
  const rootDir = await mkdtemp(join(tmpdir(), "output-rollback-binary-"));
  tempRoots.push(rootDir);
  const workspacePath = join(rootDir, "workspace");
  const binaryFile = "src/data.bin";
  const deletedFile = "src/removed.ts";
  const binaryPath = join(workspacePath, binaryFile);
  const deletedPath = join(workspacePath, deletedFile);
  await mkdir(join(workspacePath, "src"), { recursive: true });
  await git(workspacePath, ["init", "-b", "main"]);
  await git(workspacePath, ["config", "user.email", "test@example.com"]);
  await git(workspacePath, ["config", "user.name", "Test User"]);
  await writeFile(binaryPath, Uint8Array.from([0, 1, 2, 3, 255]));
  await writeFile(deletedPath, "export const removed = true;\n");
  await git(workspacePath, ["add", "."]);
  await git(workspacePath, ["commit", "-m", "chore: initial"]);
  const targetCommit = (await gitOutput(
    workspacePath,
    ["rev-parse", "HEAD"],
  )).trim();
  await writeFile(binaryPath, Uint8Array.from([0, 1, 9, 3, 255]));
  await rm(deletedPath);
  const baseWorkerOutput = {
    workerJobId: "reviewed-worker",
    workspacePath,
    baseCommit: targetCommit,
    targetCommit,
    changedFiles: [binaryFile, deletedFile],
  };
  let workerOutput: IntegrationAttempt["workerOutput"];
  if (source === "patch") {
    const patch = await gitOutput(workspacePath, ["diff", "--binary"]);
    const patchPath = join(rootDir, "reviewed-output.patch");
    await writeFile(patchPath, patch);
    await git(workspacePath, ["restore", "--", binaryFile, deletedFile]);
    workerOutput = {
      ...baseWorkerOutput,
      patchPath,
      patchSha256: createHash("sha256").update(patch).digest("hex"),
    };
  } else {
    await git(workspacePath, ["add", "-A", "--", binaryFile, deletedFile]);
    await git(workspacePath, ["commit", "-m", "feat: worker output"]);
    const commitSha = (await gitOutput(
      workspacePath,
      ["rev-parse", "HEAD"],
    )).trim();
    await git(workspacePath, ["reset", "--hard", targetCommit]);
    workerOutput = { ...baseWorkerOutput, commitSha };
  }
  const attempt = {
    targetWorkspacePath: workspacePath,
    targetBranch: "main",
    expectedFiles: [binaryFile, deletedFile],
    workerOutput,
  } as unknown as IntegrationAttempt;
  return { rootDir, workspacePath, binaryPath, deletedPath, attempt };
}

async function createRenamePatchFixture(ownBothPaths: boolean): Promise<{
  readonly rootDir: string;
  readonly workspacePath: string;
  readonly sourcePath: string;
  readonly destinationPath: string;
  readonly attempt: IntegrationAttempt;
}> {
  const rootDir = await mkdtemp(join(tmpdir(), "output-rollback-rename-"));
  tempRoots.push(rootDir);
  const workspacePath = join(rootDir, "workspace");
  const sourceFile = "outside.ts";
  const destinationFile = "src/inside.ts";
  const sourcePath = join(workspacePath, sourceFile);
  const destinationPath = join(workspacePath, destinationFile);
  await mkdir(join(workspacePath, "src"), { recursive: true });
  await git(workspacePath, ["init", "-b", "main"]);
  await git(workspacePath, ["config", "user.email", "test@example.com"]);
  await git(workspacePath, ["config", "user.name", "Test User"]);
  await writeFile(sourcePath, "export const renamed = true;\n");
  await git(workspacePath, ["add", sourceFile]);
  await git(workspacePath, ["commit", "-m", "chore: initial"]);
  const targetCommit = (await gitOutput(
    workspacePath,
    ["rev-parse", "HEAD"],
  )).trim();
  await git(workspacePath, ["mv", sourceFile, destinationFile]);
  const patch = await gitOutput(
    workspacePath,
    ["diff", "--cached", "--binary", "--find-renames"],
  );
  const patchPath = join(rootDir, "reviewed-output.patch");
  await writeFile(patchPath, patch);
  await git(workspacePath, ["reset", "--hard", targetCommit]);
  const expectedFiles = ownBothPaths
    ? [sourceFile, destinationFile]
    : [destinationFile];
  const attempt = {
    targetWorkspacePath: workspacePath,
    targetBranch: "main",
    expectedFiles,
    workerOutput: {
      workerJobId: "reviewed-worker",
      workspacePath,
      patchPath,
      patchSha256: createHash("sha256").update(patch).digest("hex"),
      baseCommit: targetCommit,
      targetCommit,
      changedFiles: expectedFiles,
    },
  } as unknown as IntegrationAttempt;
  return {
    rootDir,
    workspacePath,
    sourcePath,
    destinationPath,
    attempt,
  };
}

async function createModeOnlyFixture(source: "patch" | "commit"): Promise<{
  readonly rootDir: string;
  readonly workspacePath: string;
  readonly relativeFile: string;
  readonly filePath: string;
  readonly attempt: IntegrationAttempt;
}> {
  const rootDir = await mkdtemp(join(tmpdir(), "output-rollback-mode-"));
  tempRoots.push(rootDir);
  const workspacePath = join(rootDir, "workspace");
  const relativeFile = "scripts/run.sh";
  const filePath = join(workspacePath, relativeFile);
  await mkdir(join(workspacePath, "scripts"), { recursive: true });
  await git(workspacePath, ["init", "-b", "main"]);
  await git(workspacePath, ["config", "user.email", "test@example.com"]);
  await git(workspacePath, ["config", "user.name", "Test User"]);
  await writeFile(filePath, "#!/bin/sh\nexit 0\n");
  await chmod(filePath, 0o644);
  await git(workspacePath, ["add", relativeFile]);
  await git(workspacePath, ["commit", "-m", "chore: initial"]);
  const targetCommit = (await gitOutput(
    workspacePath,
    ["rev-parse", "HEAD"],
  )).trim();
  await chmod(filePath, 0o755);
  const baseWorkerOutput = {
    workerJobId: "reviewed-worker",
    workspacePath,
    baseCommit: targetCommit,
    targetCommit,
    changedFiles: [relativeFile],
  };
  let workerOutput: IntegrationAttempt["workerOutput"];
  if (source === "patch") {
    const patch = await gitOutput(
      workspacePath,
      ["-c", "core.fileMode=true", "diff", "--binary"],
    );
    const patchPath = join(rootDir, "reviewed-output.patch");
    await writeFile(patchPath, patch);
    await chmod(filePath, 0o644);
    workerOutput = {
      ...baseWorkerOutput,
      patchPath,
      patchSha256: createHash("sha256").update(patch).digest("hex"),
    };
  } else {
    await git(workspacePath, [
      "-c",
      "core.fileMode=true",
      "add",
      relativeFile,
    ]);
    await git(workspacePath, ["commit", "-m", "feat: executable output"]);
    const commitSha = (await gitOutput(
      workspacePath,
      ["rev-parse", "HEAD"],
    )).trim();
    await git(workspacePath, ["reset", "--hard", targetCommit]);
    workerOutput = { ...baseWorkerOutput, commitSha };
  }
  await git(workspacePath, ["config", "core.fileMode", "false"]);
  const attempt = {
    targetWorkspacePath: workspacePath,
    targetBranch: "main",
    expectedFiles: [relativeFile],
    workerOutput,
  } as unknown as IntegrationAttempt;
  return { rootDir, workspacePath, relativeFile, filePath, attempt };
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync("git", [...args], { cwd });
}

async function gitOutput(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], { cwd });
  return stdout;
}
