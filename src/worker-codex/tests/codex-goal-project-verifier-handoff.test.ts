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
import {
  readVerifiedProducerHandoff,
} from "../application/project-control/codex-goal-project-verifier-handoff";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
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

    await expect(readVerifiedProducerHandoff({ producer })).resolves.toMatchObject({
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
    await expect(() => assertCanonicalRemoteRevision({
      canonical,
      resolvedRevision: localHead,
    })).toThrow("project_control_source_revision_stale");
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
  await git(path, ["config", "user.email", "test@example.com"]);
  await git(path, ["config", "user.name", "Runtime Test"]);
  await writeFile(join(path, "feature.txt"), "base\n");
  await git(path, ["add", "feature.txt"]);
  await git(path, ["commit", "-m", "base"]);
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
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return stdout.trim();
}
