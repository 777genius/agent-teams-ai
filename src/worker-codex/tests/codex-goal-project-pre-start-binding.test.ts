import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { CodexGoalJobManifest } from "../codex-goal-jobs";
import { captureProjectPreStartBinding } from "../application/project-control/codex-goal-project-pre-start-binding";

const execFileAsync = promisify(execFile);

describe("project pre-start binding", () => {
  it("captures both endpoints of a staged rename", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-pre-start-binding-"));
    const workspacePath = join(root, "workspace");
    const jobRootDir = join(root, "job");
    const promptPath = join(jobRootDir, "prompt.md");
    const contractPath = join(jobRootDir, "contract.json");
    const statePath = join(jobRootDir, "state.json");
    const receiptPath = join(jobRootDir, "receipt.json");
    try {
      await Promise.all([
        mkdir(join(workspacePath, "src", "outside"), { recursive: true }),
        mkdir(join(workspacePath, "src", "pending"), { recursive: true }),
        mkdir(jobRootDir, { recursive: true }),
      ]);
      await writeFile(
        join(workspacePath, "src", "outside", "value.ts"),
        "export const value = true;\n",
      );
      await writeFile(promptPath, "Review exact staged rename.\n");
      await Promise.all([
        writeFile(contractPath, "{}\n"),
        writeFile(statePath, "{}\n"),
        writeFile(receiptPath, "{}\n"),
      ]);
      await execFileAsync("git", ["init", "-b", "main"], {
        cwd: workspacePath,
      });
      await execFileAsync("git", ["config", "user.email", "test@example.com"], {
        cwd: workspacePath,
      });
      await execFileAsync("git", ["config", "user.name", "Runtime Test"], {
        cwd: workspacePath,
      });
      await execFileAsync("git", ["add", "."], { cwd: workspacePath });
      await execFileAsync("git", ["commit", "-m", "test: base"], {
        cwd: workspacePath,
      });
      await execFileAsync(
        "git",
        ["mv", "src/outside/value.ts", "src/pending/value.ts"],
        { cwd: workspacePath },
      );
      const head = (await execFileAsync("git", ["rev-parse", "HEAD"], {
        cwd: workspacePath,
      })).stdout.trim();
      const manifest = {
        schemaVersion: 1,
        createdAt: "2026-08-04T00:00:00.000Z",
        updatedAt: "2026-08-04T00:00:00.000Z",
        jobId: "project-rename",
        jobRootDir,
        workspacePath,
        promptPath,
        taskId: "project-rename",
        accounts: ["account-i"],
      } as CodexGoalJobManifest;

      const binding = await captureProjectPreStartBinding(manifest, {
        schemaVersion: 1,
        mode: "serial-builtin",
        contractPath,
        statePath,
        receiptPath,
      });

      expect(binding.workspaceHead).toBe(head);
      expect(binding.workspaceStagedPaths).toEqual([
        "src/outside/value.ts",
        "src/pending/value.ts",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
