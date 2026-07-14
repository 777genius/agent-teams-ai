import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { CodexGoalJobManifest } from "../codex-goal-jobs";
import { materializeCodexGoalHandoffArtifacts } from "../codex-goal-handoff-artifacts";
import {
  applyVerifiedInputPatch,
  assertCanonicalRemoteRevision,
  resolveCanonicalRemoteHead,
} from "../application/project-control/codex-goal-project-git";
import { readVerifiedProducerHandoff } from "../application/project-control/codex-goal-project-verifier-handoff";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("project verifier handoff", () => {
  it("accepts an immutable terminal patch and rejects tampering", async () => {
    const root = await temporaryRoot("verifier-handoff-");
    const workspacePath = join(root, "producer");
    const jobRootDir = join(root, "jobs", "producer-1");
    await initRepository(workspacePath);
    await mkdir(jobRootDir, { recursive: true });
    await writeFile(join(workspacePath, "feature.txt"), "changed\n");
    const materialized = await materializeCodexGoalHandoffArtifacts({
      workerJobId: "producer-1",
      taskId: "task-1",
      workspacePath,
      jobRootDir,
    });
    expect(materialized).not.toBeNull();
    const producer = manifest({ workspacePath, jobRootDir });

    await expect(
      readVerifiedProducerHandoff({ producer }),
    ).resolves.toMatchObject({
      producerJobId: "producer-1",
      baseCommit: materialized?.baseCommit,
      changedPaths: ["feature.txt"],
      patchSha256: materialized?.manifest.artifacts.patch.sha256,
    });

    const verifierPath = join(root, "verifier");
    await git(root, ["clone", workspacePath, verifierPath]);
    await applyVerifiedInputPatch({
      workspacePath: verifierPath,
      patchPath: materialized?.patchPath as string,
      expectedSha256: materialized?.manifest.artifacts.patch.sha256 as string,
      expectedBaseCommit: materialized?.baseCommit as string,
      expectedTargetCommit: materialized?.baseCommit as string,
      changedPaths: ["feature.txt"],
    });
    const stagedPatch = await gitText(verifierPath, [
      "diff",
      "--cached",
      "--binary",
      "HEAD",
      "--",
    ]);
    expect(createHash("sha256").update(`${stagedPatch}\n`).digest("hex")).toBe(
      materialized?.manifest.artifacts.patch.sha256,
    );
    expect(await gitText(verifierPath, ["status", "--porcelain"])).toBe(
      "M  feature.txt",
    );

    const patchPath = materialized?.patchPath as string;
    await writeFile(
      patchPath,
      `${await readFile(patchPath, "utf8")}\n# tampered\n`,
    );
    await expect(readVerifiedProducerHandoff({ producer })).rejects.toThrow(
      "project_control_verifier_handoff_descriptor_mismatch",
    );
  });

  it("resolves the authoritative remote branch and rejects a stale local ref", async () => {
    const root = await temporaryRoot("canonical-remote-");
    const remotePath = join(root, "remote.git");
    const workspacePath = join(root, "source");
    await git(root, ["init", "--bare", remotePath]);
    await initRepository(workspacePath);
    await git(workspacePath, ["remote", "add", "origin", remotePath]);
    await git(workspacePath, ["push", "-u", "origin", "HEAD:main"]);
    const canonical = await resolveCanonicalRemoteHead({
      workspacePath,
      remoteTrackingRef: "origin/main",
    });
    expect(canonical.remote).toBe("origin");
    expect(canonical.oid).toMatch(/^[0-9a-f]{40}$/);

    await writeFile(join(workspacePath, "local.txt"), "local only\n");
    await git(workspacePath, ["add", "local.txt"]);
    await git(workspacePath, ["commit", "-m", "local only"]);
    const localHead = await gitText(workspacePath, ["rev-parse", "HEAD"]);
    await expect(() =>
      assertCanonicalRemoteRevision({
        canonical,
        resolvedRevision: localHead,
      }),
    ).toThrow("project_control_source_revision_stale");
  });

  it("applies an immutable handoff to a descendant with no owned-path drift", async () => {
    const root = await temporaryRoot("verifier-descendant-");
    const producerPath = join(root, "producer");
    const jobRootDir = join(root, "jobs", "producer-1");
    await initRepository(producerPath);
    await mkdir(jobRootDir, { recursive: true });
    await writeFile(join(producerPath, "feature.txt"), "producer change\n");
    const materialized = await materializeCodexGoalHandoffArtifacts({
      workerJobId: "producer-1",
      taskId: "task-1",
      workspacePath: producerPath,
      jobRootDir,
    });
    const handoff = await readVerifiedProducerHandoff({
      producer: manifest({ workspacePath: producerPath, jobRootDir }),
    });
    const targetPath = join(root, "target");
    await git(root, ["clone", producerPath, targetPath]);
    await configureRepository(targetPath);
    await writeFile(join(targetPath, "router.md"), "docs-only authority\n");
    await git(targetPath, ["add", "router.md"]);
    await git(targetPath, ["commit", "-m", "docs: advance authority"]);
    const targetCommit = await gitText(targetPath, ["rev-parse", "HEAD"]);

    await applyVerifiedInputPatch({
      workspacePath: targetPath,
      patchPath: handoff.patchPath,
      expectedSha256: handoff.patchSha256,
      expectedBaseCommit: handoff.baseCommit,
      expectedTargetCommit: targetCommit,
      changedPaths: handoff.changedPaths,
    });
    expect(await gitText(targetPath, ["status", "--porcelain"])).toBe(
      "M  feature.txt",
    );
  });

  it("rejects descendant drift on producer-owned paths", async () => {
    const root = await temporaryRoot("verifier-drift-");
    const producerPath = join(root, "producer");
    const jobRootDir = join(root, "jobs", "producer-1");
    await initRepository(producerPath);
    await mkdir(jobRootDir, { recursive: true });
    await writeFile(join(producerPath, "feature.txt"), "producer change\n");
    await materializeCodexGoalHandoffArtifacts({
      workerJobId: "producer-1",
      taskId: "task-1",
      workspacePath: producerPath,
      jobRootDir,
    });
    const handoff = await readVerifiedProducerHandoff({
      producer: manifest({ workspacePath: producerPath, jobRootDir }),
    });
    const targetPath = join(root, "target");
    await git(root, ["clone", producerPath, targetPath]);
    await configureRepository(targetPath);
    await writeFile(join(targetPath, "feature.txt"), "canonical change\n");
    await git(targetPath, ["add", "feature.txt"]);
    await git(targetPath, ["commit", "-m", "fix: change owned path"]);

    await expect(
      applyVerifiedInputPatch({
        workspacePath: targetPath,
        patchPath: handoff.patchPath,
        expectedSha256: handoff.patchSha256,
        expectedBaseCommit: handoff.baseCommit,
        expectedTargetCommit: await gitText(targetPath, ["rev-parse", "HEAD"]),
        changedPaths: handoff.changedPaths,
      }),
    ).rejects.toThrow("project_control_input_patch_changed_paths_advanced");
  });

  it("treats producer-owned paths as literals when checking descendant drift", async () => {
    const root = await temporaryRoot("verifier-literal-pathspec-");
    const producerPath = join(root, "producer");
    const jobRootDir = join(root, "jobs", "producer-1");
    const magicPath = ":(exclude)feature.txt";
    await initRepository(producerPath);
    await mkdir(jobRootDir, { recursive: true });
    await writeFile(join(producerPath, magicPath), "base literal path\n");
    await git(producerPath, ["--literal-pathspecs", "add", "--", magicPath]);
    await git(producerPath, [
      "commit",
      "-m",
      "test: add literal pathspec file",
    ]);
    await writeFile(join(producerPath, magicPath), "producer change\n");
    await materializeCodexGoalHandoffArtifacts({
      workerJobId: "producer-1",
      taskId: "task-1",
      workspacePath: producerPath,
      jobRootDir,
    });
    const handoff = await readVerifiedProducerHandoff({
      producer: manifest({ workspacePath: producerPath, jobRootDir }),
    });
    expect(handoff.changedPaths).toEqual([magicPath]);

    const targetPath = join(root, "target");
    await git(root, ["clone", producerPath, targetPath]);
    await configureRepository(targetPath);
    await writeFile(join(targetPath, magicPath), "canonical change\n");
    await git(targetPath, ["--literal-pathspecs", "add", "--", magicPath]);
    await git(targetPath, [
      "commit",
      "-m",
      "test: change literal pathspec file",
    ]);

    await expect(
      applyVerifiedInputPatch({
        workspacePath: targetPath,
        patchPath: handoff.patchPath,
        expectedSha256: handoff.patchSha256,
        expectedBaseCommit: handoff.baseCommit,
        expectedTargetCommit: await gitText(targetPath, ["rev-parse", "HEAD"]),
        changedPaths: handoff.changedPaths,
      }),
    ).rejects.toThrow("project_control_input_patch_changed_paths_advanced");
  });

  it("rejects non-ancestor targets and patches that do not apply", async () => {
    const root = await temporaryRoot("verifier-incompatible-");
    const producerPath = join(root, "producer");
    const jobRootDir = join(root, "jobs", "producer-1");
    await initRepository(producerPath);
    await mkdir(jobRootDir, { recursive: true });
    await writeFile(join(producerPath, "feature.txt"), "producer change\n");
    await materializeCodexGoalHandoffArtifacts({
      workerJobId: "producer-1",
      taskId: "task-1",
      workspacePath: producerPath,
      jobRootDir,
    });
    const handoff = await readVerifiedProducerHandoff({
      producer: manifest({ workspacePath: producerPath, jobRootDir }),
    });
    const targetPath = join(root, "unrelated-target");
    await initRepository(targetPath);
    await git(targetPath, ["commit", "--amend", "-m", "unrelated base"]);
    await writeFile(join(targetPath, "unrelated.txt"), "unrelated history\n");
    await git(targetPath, ["add", "unrelated.txt"]);
    await git(targetPath, ["commit", "-m", "test: unrelated history"]);
    const targetCommit = await gitText(targetPath, ["rev-parse", "HEAD"]);

    await expect(
      applyVerifiedInputPatch({
        workspacePath: targetPath,
        patchPath: handoff.patchPath,
        expectedSha256: handoff.patchSha256,
        expectedBaseCommit: handoff.baseCommit,
        expectedTargetCommit: targetCommit,
        changedPaths: handoff.changedPaths,
      }),
    ).rejects.toThrow("project_control_input_patch_base_not_ancestor");

    const invalidPatchPath = join(root, "invalid.patch");
    const invalidPatch = Buffer.from("not a git patch\n");
    await writeFile(invalidPatchPath, invalidPatch);
    await expect(
      applyVerifiedInputPatch({
        workspacePath: targetPath,
        patchPath: invalidPatchPath,
        expectedSha256: createHash("sha256").update(invalidPatch).digest("hex"),
        expectedBaseCommit: targetCommit,
        expectedTargetCommit: targetCommit,
        changedPaths: ["feature.txt"],
      }),
    ).rejects.toThrow("project_control_input_patch_not_applicable");
  });
});

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function initRepository(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await git(path, ["init", "-b", "main"]);
  await configureRepository(path);
  await writeFile(join(path, "feature.txt"), "base\n");
  await git(path, ["add", "feature.txt"]);
  await git(path, ["commit", "-m", "base"]);
}

async function configureRepository(path: string): Promise<void> {
  await git(path, ["config", "user.email", "test@example.com"]);
  await git(path, ["config", "user.name", "Runtime Test"]);
}

function manifest(input: {
  readonly workspacePath: string;
  readonly jobRootDir: string;
}): CodexGoalJobManifest {
  return {
    schemaVersion: 1,
    jobId: "producer-1",
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    jobRootDir: input.jobRootDir,
    workspacePath: input.workspacePath,
    promptPath: join(input.jobRootDir, "prompt.md"),
    taskId: "task-1",
    accounts: ["account-a"],
  };
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function gitText(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
  });
  return stdout.trim();
}
