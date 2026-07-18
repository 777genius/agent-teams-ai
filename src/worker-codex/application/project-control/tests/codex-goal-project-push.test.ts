import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import {
  ProjectControlPushOutcome,
  pushProjectBranch,
} from "../codex-goal-project-push";

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("project-control push truth", () => {
  it("uses authoritative remote refs when local tracking is stale", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-control-push-"));
    tempRoots.push(root);
    const workspacePath = join(root, "workspace");
    const externalPath = join(root, "external");
    const remotePath = join(root, "remote.git");
    await mkdir(workspacePath);
    await git(workspacePath, ["init", "-b", "integration-target"]);
    await configureIdentity(workspacePath);
    await writeFile(join(workspacePath, "value.txt"), "base\n");
    await git(workspacePath, ["add", "value.txt"]);
    await git(workspacePath, ["commit", "-m", "test: base"]);
    const baseCommit = await head(workspacePath);
    await execFileAsync("git", ["init", "--bare", remotePath]);
    await git(workspacePath, ["remote", "add", "origin", remotePath]);
    await git(workspacePath, ["push", "-u", "origin", "integration-target"]);

    await writeFile(join(workspacePath, "value.txt"), "local\n");
    await git(workspacePath, ["add", "value.txt"]);
    await git(workspacePath, ["commit", "-m", "test: local advance"]);
    const localCommit = await head(workspacePath);
    await git(workspacePath, [
      "update-ref",
      "refs/remotes/origin/integration-target",
      localCommit,
    ]);

    await expect(
      pushProjectBranch({
        workspacePath,
        branch: "integration-target",
        remote: "origin",
        force: false,
      }),
    ).resolves.toMatchObject({
      status: "applied",
      outcome: ProjectControlPushOutcome.FastForwarded,
      localCommit,
      remoteCommitBefore: baseCommit,
      remoteCommitAfter: localCommit,
    });

    await expect(
      pushProjectBranch({
        workspacePath,
        branch: "integration-target",
        remote: "origin",
        force: false,
      }),
    ).resolves.toMatchObject({
      status: "noop",
      outcome: ProjectControlPushOutcome.UpToDate,
      remoteCommitBefore: localCommit,
      remoteCommitAfter: localCommit,
    });

    await git(root, ["clone", remotePath, externalPath]);
    await git(externalPath, [
      "checkout",
      "-b",
      "integration-target",
      "origin/integration-target",
    ]);
    await configureIdentity(externalPath);
    await writeFile(join(externalPath, "remote.txt"), "remote\n");
    await git(externalPath, ["add", "remote.txt"]);
    await git(externalPath, ["commit", "-m", "test: remote advance"]);
    const remoteCommit = await head(externalPath);
    await git(externalPath, ["push", "origin", "integration-target"]);
    await git(workspacePath, [
      "update-ref",
      "refs/remotes/origin/integration-target",
      localCommit,
    ]);

    await expect(
      pushProjectBranch({
        workspacePath,
        branch: "integration-target",
        remote: "origin",
        force: false,
      }),
    ).resolves.toMatchObject({
      status: "noop",
      outcome: ProjectControlPushOutcome.RemoteChanged,
      localCommit,
      remoteCommitBefore: remoteCommit,
      remoteCommitAfter: remoteCommit,
    });
  });
});

async function configureIdentity(workspacePath: string): Promise<void> {
  await git(workspacePath, ["config", "user.name", "Runtime Test"]);
  await git(workspacePath, ["config", "user.email", "runtime@example.com"]);
}

async function head(workspacePath: string): Promise<string> {
  return (await git(workspacePath, ["rev-parse", "HEAD"])).trim();
}

async function git(
  workspacePath: string,
  args: readonly string[],
): Promise<string> {
  const result = await execFileAsync("git", ["-C", workspacePath, ...args]);
  return result.stdout;
}
