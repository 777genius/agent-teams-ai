import { readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  CheckRunStatus,
  CheckWorkspaceIntegrityDisposition,
} from "@vioxen/subscription-runtime/worker-core";
import { LocalProjectCheckRunner } from "../index";
import {
  createGitFixture,
  gitOutput,
  tempRoots,
} from "./project-integration-local-adapters.fixture";

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("local project check runner workspace hygiene", () => {
  it("terminates delayed descendants before checking and cleaning the workspace", async () => {
    const fixture = await createGitFixture();
    const runner = new LocalProjectCheckRunner({ terminationGraceMs: 50 });
    const delayedPath = join(fixture.workspacePath, "delayed-descendant.tmp");
    const descendant = [
      "setTimeout(() =>",
      "require('node:fs').writeFileSync('delayed-descendant.tmp', 'late\\n'),",
      "350)",
    ].join(" ");

    await expect(runner.runCheck({
      workspacePath: fixture.workspacePath,
      allowedWorkspaceFiles: [],
      startedAt: "2026-01-01T00:00:00.000Z",
      check: {
        checkId: "descendant-cleanup",
        command: [
          process.execPath,
          "-e",
          [
            "const {spawn}=require('node:child_process')",
            `spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {stdio:'ignore'})`,
          ].join("; "),
        ],
      },
    })).resolves.toMatchObject({
      status: CheckRunStatus.Passed,
      workspaceIntegrity: CheckWorkspaceIntegrityDisposition.Unchanged,
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    await expect(readFile(delayedPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("terminates delayed descendants before cleanup after timeout", async () => {
    const fixture = await createGitFixture();
    const runner = new LocalProjectCheckRunner({
      terminationGraceMs: 50,
      timeoutMs: 100,
    });
    const delayedPath = join(fixture.workspacePath, "timeout-descendant.tmp");
    const descendant = [
      "setTimeout(() =>",
      "require('node:fs').writeFileSync('timeout-descendant.tmp', 'late\\n'),",
      "350)",
    ].join(" ");

    await expect(runner.runCheck({
      workspacePath: fixture.workspacePath,
      allowedWorkspaceFiles: [],
      startedAt: "2026-01-01T00:00:00.000Z",
      check: {
        checkId: "timeout-descendant-cleanup",
        command: [
          process.execPath,
          "-e",
          [
            "const {spawn}=require('node:child_process')",
            `spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {stdio:'ignore'})`,
            "setInterval(() => {}, 1_000)",
          ].join("; "),
        ],
      },
    })).resolves.toMatchObject({
      status: CheckRunStatus.TimedOut,
      workspaceIntegrity: CheckWorkspaceIntegrityDisposition.Unchanged,
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    await expect(readFile(delayedPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each([
    { name: "passing", exitCode: 0, status: CheckRunStatus.Passed },
    { name: "failing", exitCode: 7, status: CheckRunStatus.Failed },
  ])("removes only untracked files created by a $name check", async ({
    exitCode,
    status,
  }) => {
    const fixture = await createGitFixture();
    const runner = new LocalProjectCheckRunner();
    const preexistingPath = join(fixture.workspacePath, "preexisting.tmp");
    const generatedPath = join(fixture.workspacePath, "generated.tmp");
    await writeFile(preexistingPath, "keep\n");

    await expect(runner.runCheck({
      workspacePath: fixture.workspacePath,
      allowedWorkspaceFiles: ["preexisting.tmp", "src/memory.ts"],
      startedAt: "2026-01-01T00:00:00.000Z",
      check: {
        checkId: "workspace-cleanup",
        command: [
          process.execPath,
          "-e",
          [
            `require("node:fs").writeFileSync("generated.tmp", "remove\\n")`,
            `process.exit(${exitCode})`,
          ].join("; "),
        ],
      },
    })).resolves.toMatchObject({ status, exitCode });
    await expect(readFile(preexistingPath, "utf8")).resolves.toBe("keep\n");
    await expect(readFile(generatedPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("removes newly-created untracked files after a timed out check", async () => {
    const fixture = await createGitFixture();
    const runner = new LocalProjectCheckRunner({ timeoutMs: 100 });
    const generatedPath = join(fixture.workspacePath, "timed-out.tmp");

    await expect(runner.runCheck({
      workspacePath: fixture.workspacePath,
      allowedWorkspaceFiles: ["src/memory.ts"],
      startedAt: "2026-01-01T00:00:00.000Z",
      check: {
        checkId: "timeout-cleanup",
        command: [
          process.execPath,
          "-e",
          [
            "require('node:fs').writeFileSync('timed-out.tmp', 'remove\\n')",
            "setInterval(() => {}, 1_000)",
          ].join("; "),
        ],
      },
    })).resolves.toMatchObject({ status: CheckRunStatus.TimedOut });
    await expect(readFile(generatedPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("restores candidate bytes before reporting sanitized hygiene failure", async () => {
    const fixture = await createGitFixture();
    const runner = new LocalProjectCheckRunner();

    await expect(runner.runCheck({
      workspacePath: fixture.workspacePath,
      allowedWorkspaceFiles: ["src/memory.ts"],
      startedAt: "2026-01-01T00:00:00.000Z",
      check: {
        checkId: "candidate-mutation",
        command: [
          process.execPath,
          "-e",
          "require('node:fs').writeFileSync('src/memory.ts', 'mutated by check\\n')",
        ],
      },
    })).resolves.toMatchObject({
      status: CheckRunStatus.Failed,
      exitCode: 0,
      safeOutputTail: "\n\ncheck_workspace_hygiene_tracked_or_index_changed",
    });
    await expect(readFile(
      join(fixture.workspacePath, "src", "memory.ts"),
      "utf8",
    )).resolves.toBe("export const value = 1;\n");
    await expect(gitOutput(fixture.workspacePath, ["status", "--short"]))
      .resolves.toBe("");
  });

  it("restores baseline after post-command Git cleanup inspection fails", async () => {
    const fixture = await createGitFixture();
    const runner = new LocalProjectCheckRunner();

    await expect(runner.runCheck({
      workspacePath: fixture.workspacePath,
      allowedWorkspaceFiles: ["src/memory.ts"],
      startedAt: "2026-01-01T00:00:00.000Z",
      check: {
        checkId: "index-corruption",
        command: [
          process.execPath,
          "-e",
          [
            "const fs=require('node:fs')",
            "const {execFileSync}=require('node:child_process')",
            "const args=['rev-parse','--git-path','index']",
            "const index=execFileSync('git',args,{encoding:'utf8'}).trim()",
            "fs.writeFileSync(index,'corrupt-index')",
          ].join("; "),
        ],
      },
    })).resolves.toMatchObject({
      status: CheckRunStatus.Failed,
      safeOutputTail: "\n\ncheck_workspace_hygiene_cleanup_failed",
      workspaceIntegrity: CheckWorkspaceIntegrityDisposition.Restored,
    });
    await expect(gitOutput(fixture.workspacePath, ["status", "--short"]))
      .resolves.toBe("");
    await expect(readFile(
      join(fixture.workspacePath, "src", "memory.ts"),
      "utf8",
    )).resolves.toBe("export const value = 1;\n");
  });

  it("restores candidate bytes and exact index state after staging", async () => {
    const fixture = await createGitFixture();
    const runner = new LocalProjectCheckRunner();
    await writeFile(
      join(fixture.workspacePath, "src", "memory.ts"),
      "export const value = 3;\n",
    );

    await expect(runner.runCheck({
      workspacePath: fixture.workspacePath,
      allowedWorkspaceFiles: ["src/memory.ts"],
      startedAt: "2026-01-01T00:00:00.000Z",
      check: {
        checkId: "index-mutation",
        command: ["git", "add", "src/memory.ts"],
      },
    })).resolves.toMatchObject({
      status: CheckRunStatus.Failed,
      exitCode: 0,
      safeOutputTail: "\n\ncheck_workspace_hygiene_tracked_or_index_changed",
    });
    await expect(readFile(
      join(fixture.workspacePath, "src", "memory.ts"),
      "utf8",
    )).resolves.toBe("export const value = 3;\n");
    await expect(gitOutput(fixture.workspacePath, [
      "diff",
      "--cached",
      "--name-only",
    ])).resolves.toBe("");
    await expect(gitOutput(fixture.workspacePath, ["diff", "--name-only"]))
      .resolves.toBe("src/memory.ts\n");
  });

  it("restores a modified untracked candidate without touching its identity", async () => {
    const fixture = await createGitFixture();
    const runner = new LocalProjectCheckRunner();
    const candidatePath = join(fixture.workspacePath, "candidate.txt");
    await writeFile(candidatePath, "approved bytes\n");

    await expect(runner.runCheck({
      workspacePath: fixture.workspacePath,
      allowedWorkspaceFiles: ["candidate.txt"],
      startedAt: "2026-01-01T00:00:00.000Z",
      check: {
        checkId: "untracked-candidate-mutation",
        command: [
          process.execPath,
          "-e",
          "require('node:fs').writeFileSync('candidate.txt', 'changed\\n')",
        ],
      },
    })).resolves.toMatchObject({
      status: CheckRunStatus.Failed,
      safeOutputTail: "\n\ncheck_workspace_hygiene_candidate_bytes_changed",
    });
    await expect(readFile(candidatePath, "utf8")).resolves.toBe(
      "approved bytes\n",
    );
  });

  it("restores an untracked candidate symlink without following its target", async () => {
    const fixture = await createGitFixture();
    const runner = new LocalProjectCheckRunner();
    const linkPath = join(fixture.workspacePath, "candidate-link");
    await symlink("src/memory.ts", linkPath);

    await expect(runner.runCheck({
      workspacePath: fixture.workspacePath,
      allowedWorkspaceFiles: ["candidate-link"],
      startedAt: "2026-01-01T00:00:00.000Z",
      check: {
        checkId: "symlink-candidate-mutation",
        command: [
          process.execPath,
          "-e",
          [
            "require('node:fs').unlinkSync('candidate-link')",
            "require('node:fs').writeFileSync('candidate-link', 'changed\\n')",
          ].join("; "),
        ],
      },
    })).resolves.toMatchObject({
      status: CheckRunStatus.Failed,
      safeOutputTail: "\n\ncheck_workspace_hygiene_candidate_bytes_changed",
    });
    await expect(readlink(linkPath)).resolves.toBe("src/memory.ts");
    await expect(readFile(
      join(fixture.workspacePath, "src", "memory.ts"),
      "utf8",
    )).resolves.toBe("export const value = 1;\n");
  });

  it("removes a check-created staged file while restoring the exact index", async () => {
    const fixture = await createGitFixture();
    const runner = new LocalProjectCheckRunner();
    const generatedPath = join(fixture.workspacePath, "src", "staged.ts");

    await expect(runner.runCheck({
      workspacePath: fixture.workspacePath,
      allowedWorkspaceFiles: [],
      startedAt: "2026-01-01T00:00:00.000Z",
      check: {
        checkId: "staged-file-mutation",
        command: [
          process.execPath,
          "-e",
          [
            "const {execFileSync}=require('node:child_process')",
            "require('node:fs').writeFileSync('src/staged.ts', 'new\\n')",
            "execFileSync('git', ['add', 'src/staged.ts'])",
          ].join("; "),
        ],
      },
    })).resolves.toMatchObject({
      status: CheckRunStatus.Failed,
      safeOutputTail: "\n\ncheck_workspace_hygiene_tracked_or_index_changed",
    });
    await expect(readFile(generatedPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(gitOutput(fixture.workspacePath, ["status", "--short"]))
      .resolves.toBe("");
  });
});
