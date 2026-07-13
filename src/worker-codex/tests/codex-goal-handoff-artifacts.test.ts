import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { materializeCodexGoalHandoffArtifacts } from "../codex-goal-handoff-artifacts";
import { git } from "./codex-goal-mcp-test-support";

const cleanup: string[] = [];

describe("Codex goal handoff artifact materialization", () => {
  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) =>
      rm(path, { recursive: true, force: true })
    ));
  });

  it("materializes deterministic patch, summary and manifest for untracked-only output", async () => {
    const fixture = await createFixture();
    await mkdir(join(fixture.workspacePath, "docs"));
    await writeFile(join(fixture.workspacePath, "docs", "plan.md"), "plan\n");

    const first = await materializeCodexGoalHandoffArtifacts({
      workerJobId: "worker-1",
      taskId: "task-1",
      workspacePath: fixture.workspacePath,
      jobRootDir: fixture.jobRootDir,
      expectedBaseCommit: fixture.baseCommit,
    });
    expect(first).not.toBeNull();
    expect(first).toMatchObject({
      baseCommit: fixture.baseCommit,
      changedPaths: ["docs/plan.md"],
      artifacts: [
        { kind: "patch", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
        { kind: "summary", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
        { kind: "manifest", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
      ],
    });
    const materialized = first!;
    expect(await readFile(materialized.patchPath, "utf8")).toContain("+plan");
    expect(JSON.parse(await readFile(materialized.summaryPath, "utf8"))).toMatchObject({
      workerJobId: "worker-1",
      changedPaths: ["docs/plan.md"],
      baseCommit: fixture.baseCommit,
    });
    const manifestBytes = await readFile(materialized.manifestPath);
    expect(JSON.parse(manifestBytes.toString("utf8"))).toMatchObject({
      kind: "subscription-runtime-worker-handoff",
      workerJobId: "worker-1",
      jobRootDir: fixture.jobRootDir,
      changedPaths: ["docs/plan.md"],
    });
    expect(materialized.artifacts[2]?.sha256).toBe(
      createHash("sha256").update(manifestBytes).digest("hex"),
    );

    await expect(materializeCodexGoalHandoffArtifacts({
      workerJobId: "worker-1",
      taskId: "task-1",
      workspacePath: fixture.workspacePath,
      jobRootDir: fixture.jobRootDir,
      expectedBaseCommit: fixture.baseCommit,
    })).resolves.toEqual(first);

    await writeFile(join(fixture.workspacePath, "docs", "plan.md"), "changed\n");
    await expect(materializeCodexGoalHandoffArtifacts({
      workerJobId: "worker-1",
      taskId: "task-1",
      workspacePath: fixture.workspacePath,
      jobRootDir: fixture.jobRootDir,
      expectedBaseCommit: fixture.baseCommit,
    })).rejects.toThrow("handoff_artifact_content_mismatch");
  });

  it("rejects symlinks, sensitive auth files and bounded-size violations", async () => {
    const symlinkFixture = await createFixture();
    await symlink("/etc/hosts", join(symlinkFixture.workspacePath, "link.txt"));
    await expect(materialize(symlinkFixture)).rejects.toThrow(
      "handoff_symlink_rejected",
    );

    const secretFixture = await createFixture();
    await writeFile(join(secretFixture.workspacePath, "auth.json"), "{}\n");
    await expect(materialize(secretFixture)).rejects.toThrow(
      "handoff_sensitive_path_rejected",
    );

    const boundedFixture = await createFixture();
    await writeFile(join(boundedFixture.workspacePath, "large.txt"), "12345");
    await expect(materializeCodexGoalHandoffArtifacts({
      workerJobId: "worker-1",
      taskId: "task-1",
      workspacePath: boundedFixture.workspacePath,
      jobRootDir: boundedFixture.jobRootDir,
      expectedBaseCommit: boundedFixture.baseCommit,
      limits: { maxFileBytes: 4 },
    })).rejects.toThrow("handoff_file_byte_limit_exceeded");

    const envSecretFixture = await createFixture();
    await writeFile(
      join(envSecretFixture.workspacePath, "config.txt"),
      "OPENAI_API_KEY=abcdefghijklmnopqrstuvwxyz\n",
    );
    await expect(materialize(envSecretFixture)).rejects.toThrow(
      "handoff_raw_secret_rejected",
    );

    const deletedSecretFixture = await createFixture();
    const deletedSecretPath = join(
      deletedSecretFixture.workspacePath,
      "deleted-config.txt",
    );
    await writeFile(
      deletedSecretPath,
      "OPENAI_API_KEY=abcdefghijklmnopqrstuvwxyz\n",
    );
    await git(deletedSecretFixture.workspacePath, ["add", "deleted-config.txt"]);
    await git(deletedSecretFixture.workspacePath, ["commit", "-m", "secret fixture"]);
    await rm(deletedSecretPath);
    await expect(materializeCodexGoalHandoffArtifacts({
      workerJobId: "worker-1",
      taskId: "task-1",
      workspacePath: deletedSecretFixture.workspacePath,
      jobRootDir: deletedSecretFixture.jobRootDir,
    })).rejects.toThrow("handoff_raw_secret_rejected");

    const slackFixture = await createFixture();
    await writeFile(
      join(slackFixture.workspacePath, "slack.txt"),
      `SLACK_TOKEN=xoxb-${"a".repeat(24)}\n`,
    );
    await expect(materialize(slackFixture)).rejects.toThrow(
      "handoff_raw_secret_rejected",
    );

    const safeSourceFixture = await createFixture();
    await writeFile(
      join(safeSourceFixture.workspacePath, "config.ts"),
      "export const apiKey = process.env.OPENAI_API_KEY;\n",
    );
    await expect(materialize(safeSourceFixture)).resolves.toMatchObject({
      changedPaths: ["config.ts"],
    });
  });

  it("captures tracked plus untracked paths and enforces file-count bounds", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.workspacePath, "README.md"), "changed\n");
    await writeFile(join(fixture.workspacePath, "new.txt"), "new\n");
    const result = await materialize(fixture);

    expect(result?.changedPaths).toEqual(["README.md", "new.txt"]);
    expect(await readFile(result!.patchPath, "utf8")).toContain("+changed");
    expect(await readFile(result!.patchPath, "utf8")).toContain("+new");

    const boundedFixture = await createFixture();
    await writeFile(join(boundedFixture.workspacePath, "one.txt"), "one\n");
    await writeFile(join(boundedFixture.workspacePath, "two.txt"), "two\n");
    await expect(materializeCodexGoalHandoffArtifacts({
      workerJobId: "worker-1",
      taskId: "task-1",
      workspacePath: boundedFixture.workspacePath,
      jobRootDir: boundedFixture.jobRootDir,
      limits: { maxChangedFiles: 1 },
    })).rejects.toThrow("handoff_changed_file_limit_exceeded");
  });

  it("rejects special files and a symlinked job-root escape", async () => {
    const specialFixture = await createFixture();
    const specialPath = join(specialFixture.workspacePath, "special.txt");
    await writeFile(specialPath, "regular\n");
    await git(specialFixture.workspacePath, ["add", "special.txt"]);
    await git(specialFixture.workspacePath, ["commit", "-m", "tracked special fixture"]);
    await rm(specialPath);
    await promisifyExecFile("mkfifo", [specialPath]);
    await expect(materializeCodexGoalHandoffArtifacts({
      workerJobId: "worker-1",
      taskId: "task-1",
      workspacePath: specialFixture.workspacePath,
      jobRootDir: specialFixture.jobRootDir,
    })).rejects.toThrow(
      "handoff_special_file_rejected",
    );

    const escapedFixture = await createFixture();
    const outside = join(escapedFixture.root, "outside");
    await mkdir(outside);
    await rm(escapedFixture.jobRootDir, { recursive: true });
    await symlink(outside, escapedFixture.jobRootDir);
    await writeFile(join(escapedFixture.workspacePath, "new.txt"), "new\n");
    await expect(materialize(escapedFixture)).rejects.toThrow(
      "handoff_job_root_unsafe",
    );
  });

  it.each([1, 2] as const)(
    "fails when HEAD changes after patch snapshot %s",
    async (changedAfterSnapshot) => {
      const fixture = await createFixture();
      await writeFile(join(fixture.workspacePath, "README.md"), "changed\n");

      await expect(materializeCodexGoalHandoffArtifacts({
        workerJobId: "worker-1",
        taskId: "task-1",
        workspacePath: fixture.workspacePath,
        jobRootDir: fixture.jobRootDir,
        expectedBaseCommit: fixture.baseCommit,
        testHooks: {
          afterPatchSnapshot: async (snapshot) => {
            if (snapshot !== changedAfterSnapshot) return;
            await git(fixture.workspacePath, ["add", "README.md"]);
            await git(fixture.workspacePath, ["commit", "-m", "move head"]);
          },
        },
      })).rejects.toThrow("handoff_head_changed_during_materialization");
    },
  );
});

async function createFixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "codex-handoff-artifacts-")),
  );
  cleanup.push(root);
  const workspacePath = join(root, "workspace");
  const jobRootDir = join(root, "worker-jobs", "worker-1");
  await mkdir(workspacePath, { recursive: true });
  await mkdir(jobRootDir, { recursive: true });
  await git(workspacePath, ["init"]);
  await git(workspacePath, ["config", "user.email", "test@example.com"]);
  await git(workspacePath, ["config", "user.name", "Test User"]);
  await writeFile(join(workspacePath, "README.md"), "fixture\n");
  await git(workspacePath, ["add", "README.md"]);
  await git(workspacePath, ["commit", "-m", "test fixture"]);
  const baseCommit = await gitOutput(workspacePath, ["rev-parse", "HEAD"]);
  return { root, workspacePath, jobRootDir, baseCommit };
}

async function materialize(fixture: Awaited<ReturnType<typeof createFixture>>) {
  return await materializeCodexGoalHandoffArtifacts({
    workerJobId: "worker-1",
    taskId: "task-1",
    workspacePath: fixture.workspacePath,
    jobRootDir: fixture.jobRootDir,
    expectedBaseCommit: fixture.baseCommit,
  });
}

async function gitOutput(cwd: string, args: readonly string[]): Promise<string> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const result = await promisify(execFile)("git", args, { cwd, encoding: "utf8" });
  return result.stdout.trim();
}

async function promisifyExecFile(command: string, args: readonly string[]): Promise<void> {
  const { promisify } = await import("node:util");
  await promisify(execFile)(command, args);
}
