import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import {
  CheckRunStatus,
  SecretScanStatus,
} from "@vioxen/subscription-runtime/worker-core";
import {
  LocalGitIntegrationAdapter,
  LocalProjectCheckRunner,
  LocalWorkspaceIntegrationLock,
  SimpleSecretScanner,
} from "../index";

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((path) =>
      rm(path, { recursive: true, force: true })
    ),
  );
});

describe("local project integration adapters", () => {
  it("applies, commits, and pushes a worker commit through git cli", async () => {
    const fixture = await createGitFixture();
    const adapter = new LocalGitIntegrationAdapter();

    await expect(adapter.getStatus({ workspacePath: fixture.workspacePath }))
      .resolves.toEqual({ branch: "main", dirtyFiles: [] });

    await expect(adapter.applyWorkerOutput({
      attempt: { targetWorkspacePath: fixture.workspacePath },
      workerOutput: {
        workspacePath: fixture.workspacePath,
        commitSha: fixture.workerCommitSha,
      },
    })).resolves.toEqual({ changedFiles: ["src/memory.ts"] });
    await expect(adapter.diffCheck({ workspacePath: fixture.workspacePath }))
      .resolves.toEqual({ ok: true });

    const commit = await adapter.commit({
      workspacePath: fixture.workspacePath,
      message: "fix(memory): integrate worker output",
      files: ["src/memory.ts"],
    });
    expect(commit.commitSha).toMatch(/^[a-f0-9]{40}$/);

    await adapter.push({
      workspacePath: fixture.workspacePath,
      remote: "origin",
      branch: "main",
      commitSha: commit.commitSha,
      force: false,
    });
    const pushed = await gitOutput(
      fixture.workspacePath,
      ["ls-remote", "origin", "refs/heads/main"],
    );
    expect(pushed).toContain(commit.commitSha);
  });

  it("applies an approved patch artifact from an allowed project root", async () => {
    const fixture = await createGitFixture();
    const patchRoot = join(fixture.rootDir, "worker-jobs");
    await mkdir(patchRoot);
    const patchPath = join(patchRoot, "worker-output.patch");
    const patch = await gitOutput(fixture.workspacePath, [
      "show",
      "--format=",
      fixture.workerCommitSha,
    ]);
    await writeFile(patchPath, patch);

    const adapter = new LocalGitIntegrationAdapter({
      allowedPatchRoots: [patchRoot],
    });

    await expect(adapter.applyWorkerOutput({
      attempt: { targetWorkspacePath: fixture.workspacePath },
      workerOutput: {
        workspacePath: fixture.workspacePath,
        patchPath,
      },
    })).resolves.toEqual({ changedFiles: ["src/memory.ts"] });
  });

  it("runs declared checks and redacts unsafe output tails", async () => {
    const fixture = await createGitFixture();
    const runner = new LocalProjectCheckRunner();

    await expect(runner.runCheck({
      workspacePath: fixture.workspacePath,
      startedAt: "2026-01-01T00:00:00.000Z",
      check: {
        checkId: "pass",
        command: [process.execPath, "-e", "process.stdout.write('ok')"],
      },
    })).resolves.toMatchObject({
      checkId: "pass",
      status: CheckRunStatus.Passed,
      exitCode: 0,
      safeOutputTail: "ok\n",
    });

    await expect(runner.runCheck({
      workspacePath: fixture.workspacePath,
      startedAt: "2026-01-01T00:00:00.000Z",
      check: {
        checkId: "redact",
        command: [
          process.execPath,
          "-e",
          "console.error('OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz'); process.exit(1)",
        ],
      },
    })).resolves.toMatchObject({
      checkId: "redact",
      status: CheckRunStatus.Failed,
      exitCode: 1,
      safeOutputTail: "\nOPENAI_API_KEY=<redacted>\n",
    });
  });

  it("runs pnpm checks through corepack when pnpm is not directly installed", async () => {
    const fixture = await createGitFixture();
    const binDir = join(fixture.rootDir, "bin");
    await mkdir(binDir);
    const corepackPath = join(binDir, "corepack");
    await writeFile(
      corepackPath,
      "#!/bin/sh\nprintf '%s' \"$*\"\n",
      "utf8",
    );
    await chmod(corepackPath, 0o755);
    const runner = new LocalProjectCheckRunner({
      env: { PATH: binDir },
    });

    await expect(runner.runCheck({
      workspacePath: fixture.workspacePath,
      startedAt: "2026-01-01T00:00:00.000Z",
      check: {
        checkId: "pnpm-check",
        command: ["pnpm", "exec", "vitest", "run", "unit.test.ts"],
      },
    })).resolves.toMatchObject({
      checkId: "pnpm-check",
      status: CheckRunStatus.Passed,
      exitCode: 0,
      safeOutputTail: "pnpm exec vitest run unit.test.ts\n",
    });
  });

  it("fails checks whose cwd escapes the workspace", async () => {
    const fixture = await createGitFixture();
    const runner = new LocalProjectCheckRunner();

    await expect(runner.runCheck({
      workspacePath: fixture.workspacePath,
      startedAt: "2026-01-01T00:00:00.000Z",
      check: {
        checkId: "outside",
        command: [process.execPath, "-e", "process.exit(0)"],
        cwd: "..",
      },
    })).resolves.toMatchObject({
      checkId: "outside",
      status: CheckRunStatus.Failed,
      safeOutputTail: "check_cwd_outside_workspace",
    });
  });

  it("detects secret-like file contents without printing the secret", async () => {
    const fixture = await createGitFixture();
    await writeFile(
      join(fixture.workspacePath, "src", "secret.ts"),
      "export const token = 'sk-abcdefghijklmnopqrstuvwxyz';\n",
      "utf8",
    );
    const scanner = new SimpleSecretScanner();

    await expect(scanner.scanFiles({
      workspacePath: fixture.workspacePath,
      files: ["src/secret.ts"],
    })).resolves.toEqual({
      status: SecretScanStatus.Failed,
      safeMessage: "secret_like_content:src/secret.ts",
    });
  });

  it("uses a real workspace lock store for integration locks", async () => {
    const fixture = await createGitFixture();
    const lock = new LocalWorkspaceIntegrationLock({
      rootDir: join(fixture.rootDir, "locks"),
    });
    const first = await lock.acquire({
      workspacePath: fixture.workspacePath,
      owner: "attempt-1",
    });

    await expect(lock.acquire({
      workspacePath: fixture.workspacePath,
      owner: "attempt-2",
    })).rejects.toThrow("Workspace is already locked");

    await lock.release(first);
    await expect(lock.acquire({
      workspacePath: fixture.workspacePath,
      owner: "attempt-2",
    })).resolves.toMatchObject({
      owner: "attempt-2",
    });
  });
});

async function createGitFixture(): Promise<{
  readonly rootDir: string;
  readonly workspacePath: string;
  readonly workerCommitSha: string;
}> {
  const rootDir = await mkdtemp(join(tmpdir(), "project-integration-adapters-"));
  tempRoots.push(rootDir);
  const workspacePath = join(rootDir, "workspace");
  const remotePath = join(rootDir, "remote.git");
  await mkdir(workspacePath);
  try {
    await git(workspacePath, ["init"]);
    await git(workspacePath, ["checkout", "-b", "main"]);
    await git(workspacePath, ["config", "user.email", "test@example.com"]);
    await git(workspacePath, ["config", "user.name", "Test User"]);
    await mkdir(join(workspacePath, "src"));
    await writeFile(join(workspacePath, "src", "memory.ts"), "export const value = 1;\n");
    await git(workspacePath, ["add", "."]);
    await git(workspacePath, ["commit", "-m", "chore: initial"]);
    await execFileAsync("git", ["init", "--bare", remotePath]);
    await git(workspacePath, ["remote", "add", "origin", remotePath]);
    await git(workspacePath, ["checkout", "-b", "worker"]);
    await writeFile(join(workspacePath, "src", "memory.ts"), "export const value = 2;\n");
    await git(workspacePath, ["add", "."]);
    await git(workspacePath, ["commit", "-m", "fix: worker output"]);
    const workerCommitSha = (await gitOutput(workspacePath, ["rev-parse", "HEAD"])).trim();
    await git(workspacePath, ["checkout", "main"]);
    return { rootDir, workspacePath, workerCommitSha };
  } catch (error) {
    await rm(rootDir, { recursive: true, force: true });
    throw error;
  }
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync("git", [...args], { cwd });
}

async function gitOutput(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], { cwd });
  return stdout;
}
