import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { LocalGitIntegrationAdapter, SimpleSecretScanner } from "../index";
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

describe("local merge secret-scan scope", () => {
  it("reports only candidate files that differ from the pinned source commit", async () => {
    const fixture = await createGitFixture();
    const adapter = new LocalGitIntegrationAdapter();
    const targetCommit = (
      await gitOutput(fixture.workspacePath, ["rev-parse", "HEAD"])
    ).trim();

    await adapter.applyWorkerOutput({
      attempt: {
        targetWorkspacePath: fixture.workspacePath,
        expectedFiles: ["src/memory.ts"],
      },
      workerOutput: {
        workspacePath: fixture.workspacePath,
        commitSha: fixture.workerCommitSha,
      },
    });

    await expect(
      adapter.changedFilesSinceCommit({
        workspacePath: fixture.workspacePath,
        commit: targetCommit,
      }),
    ).resolves.toEqual(["src/memory.ts"]);
  });

  it("includes untracked candidate files in the fail-closed scan set", async () => {
    const fixture = await createGitFixture();
    const adapter = new LocalGitIntegrationAdapter();
    const sourceCommit = (
      await gitOutput(fixture.workspacePath, ["rev-parse", "HEAD"])
    ).trim();
    const relativePath = "src/untracked-candidate.ts";
    await writeFile(
      join(fixture.workspacePath, relativePath),
      `export const token = "sk-proj-${"a".repeat(48)}";\n`,
    );

    const scanFiles = await adapter.changedFilesSinceCommit({
      workspacePath: fixture.workspacePath,
      commit: sourceCommit,
    });
    expect(scanFiles).toEqual([relativePath]);
    await expect(
      new SimpleSecretScanner().scanFiles({
        workspacePath: fixture.workspacePath,
        files: scanFiles,
      }),
    ).resolves.toMatchObject({
      status: "failed",
      safeMessage: `secret_like_content:${relativePath}`,
    });
  });
});
