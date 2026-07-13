import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { captureGitWorkspacePatch } from "../../codex-goal-runtime-result-io";
import {
  captureReviewedWorkerOutput,
  commitReviewedWorkerOutputApproval,
  resolveReviewedWorkerOutput,
} from "../application/reviewed-worker-output-use-cases";
import {
  GitReviewedWorkerOutputSnapshotter,
  LocalReviewedWorkerOutputStore,
  localReviewedWorkerOutputDeps,
} from "../adapters/local-reviewed-worker-output-adapters";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

describe("reviewed worker output", () => {
  it("captures an immutable reviewed patch and resolves it as integration input", async () => {
    const fixture = await reviewedOutputFixture();
    const patch = await captureGitWorkspacePatch({
      workspacePath: fixture.workspacePath,
    });
    const snapshot = await captureReviewedWorkerOutput(
      localReviewedWorkerOutputDeps({ rootDir: fixture.storeRoot }),
      {
        projectId: "project-1",
        controllerJobId: "project-1-controller",
        workerJobId: "project-1-worker",
        taskId: "task-1",
        workspacePath: fixture.workspacePath,
        expectedPatchSha256: sha256(patch),
        reviewedBy: "project-1-controller",
        reason: "Focused review accepted the exact patch.",
        approvedFiles: ["src/value.ts", "src/new.ts"],
        requiredChecks: [{
          checkId: "unit",
          command: ["npm", "test"],
        }],
      },
    );

    expect(snapshot).toMatchObject({
      projectId: "project-1",
      workerJobId: "project-1-worker",
      patchSha256: sha256(patch),
      changedFiles: ["src/new.ts", "src/value.ts"],
      reviewDecision: {
        reviewedBy: "project-1-controller",
        decision: "approved",
        approvedFiles: ["src/new.ts", "src/value.ts"],
      },
    });
    expect(await readFile(snapshot.patchPath, "utf8")).toBe(patch);

    const store = new LocalReviewedWorkerOutputStore({ rootDir: fixture.storeRoot });
    await expect(resolveReviewedWorkerOutput({
      store,
      projectId: "project-1",
      reviewedOutputId: snapshot.reviewedOutputId,
    })).rejects.toThrow("reviewed_worker_output_not_found");
    await commitReviewedWorkerOutputApproval({
      store,
      markerVerifier: {
        async verify() {
          return {
            markerSha256: sha256("review marker"),
            markerContent: "review marker",
          };
        },
      },
      snapshot,
      reviewMarkerPath: "/evidence/review.json",
      clock: { now: () => new Date("2026-07-13T00:00:00.000Z") },
    });
    const resolved = await resolveReviewedWorkerOutput({
      store,
      projectId: "project-1",
      reviewedOutputId: snapshot.reviewedOutputId,
      expectedWorkerJobId: "project-1-worker",
    });
    expect(resolved.workerOutput).toMatchObject({
      workerJobId: "project-1-worker",
      patchPath: snapshot.patchPath,
      patchSha256: snapshot.patchSha256,
      baseCommit: fixture.baseCommit,
      changedFiles: ["src/new.ts", "src/value.ts"],
    });

    const repeated = await captureReviewedWorkerOutput(
      {
        ...localReviewedWorkerOutputDeps({ rootDir: fixture.storeRoot }),
        clock: { now: () => new Date("2030-01-01T00:00:00.000Z") },
      },
      {
        projectId: "project-1",
        controllerJobId: "project-1-controller",
        workerJobId: "project-1-worker",
        taskId: "task-1",
        workspacePath: fixture.workspacePath,
        expectedPatchSha256: sha256(patch),
        reviewedBy: "project-1-controller",
        reason: "Focused review accepted the exact patch.",
        approvedFiles: ["src/value.ts", "src/new.ts"],
        requiredChecks: [{
          checkId: "unit",
          command: ["npm", "test"],
        }],
      },
    );
    expect(repeated).toEqual(snapshot);

    const manifestPath = join(
      fixture.storeRoot,
      snapshot.reviewedOutputId,
      "manifest.json",
    );
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as
      Record<string, unknown>;
    manifest.controllerJobId = "different-controller";
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await expect(resolveReviewedWorkerOutput({
      store,
      projectId: "project-1",
      reviewedOutputId: snapshot.reviewedOutputId,
    })).rejects.toThrow("reviewed_worker_output_manifest_identity_mismatch");
  });

  it("fails closed when the reviewed patch hash or approved paths do not match", async () => {
    const fixture = await reviewedOutputFixture();
    const deps = localReviewedWorkerOutputDeps({ rootDir: fixture.storeRoot });
    const base = {
      projectId: "project-1",
      controllerJobId: "project-1-controller",
      workerJobId: "project-1-worker",
      taskId: "task-1",
      workspacePath: fixture.workspacePath,
      reviewedBy: "project-1-controller",
      reason: "reviewed",
      requiredChecks: [],
    };

    await expect(captureReviewedWorkerOutput(deps, {
      ...base,
      expectedPatchSha256: "0".repeat(64),
      approvedFiles: ["src/value.ts", "src/new.ts"],
    })).rejects.toThrow("reviewed_worker_output_patch_hash_mismatch");

    const patch = await captureGitWorkspacePatch({
      workspacePath: fixture.workspacePath,
    });
    await expect(captureReviewedWorkerOutput(deps, {
      ...base,
      expectedPatchSha256: sha256(patch),
      approvedFiles: ["src/value.ts"],
    })).rejects.toThrow("path_outside_expected_files");
  });

  it("round-trips staged and binary output through the immutable patch", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-reviewed-binary-"));
    roots.push(root);
    const workspacePath = join(root, "workspace");
    await execFileAsync("git", ["init", workspacePath]);
    await execFileAsync("git", ["-C", workspacePath, "config", "user.email", "test@example.com"]);
    await execFileAsync("git", ["-C", workspacePath, "config", "user.name", "Test"]);
    await writeFile(join(workspacePath, "staged.ts"), "export const value = 1;\n");
    await writeFile(join(workspacePath, "blob.bin"), Buffer.alloc(1_024, 0));
    await execFileAsync("git", ["-C", workspacePath, "add", "."]);
    await execFileAsync("git", ["-C", workspacePath, "commit", "-m", "test: base"]);

    await writeFile(join(workspacePath, "staged.ts"), "export const value = 2;\n");
    await execFileAsync("git", ["-C", workspacePath, "add", "staged.ts"]);
    await writeFile(join(workspacePath, "blob.bin"), Buffer.alloc(1_024, 1));
    await writeFile(join(workspacePath, "new.bin"), Buffer.alloc(512, 2));
    const captured = await new GitReviewedWorkerOutputSnapshotter({
      tempRootDir: join(root, "captures"),
    }).capture({ workspacePath });
    expect([...captured.changedFiles].sort()).toEqual([
      "blob.bin",
      "new.bin",
      "staged.ts",
    ]);
    expect(captured.patch).toContain("GIT binary patch");

    const patchPath = join(root, "output.patch");
    await writeFile(patchPath, captured.patch);
    await execFileAsync("git", ["-C", workspacePath, "reset", "--hard", "HEAD"]);
    await rm(join(workspacePath, "new.bin"), { force: true });
    await execFileAsync("git", ["-C", workspacePath, "apply", "--check", patchPath]);
    await execFileAsync("git", ["-C", workspacePath, "apply", patchPath]);
    expect(await readFile(join(workspacePath, "staged.ts"), "utf8")).toBe(
      "export const value = 2;\n",
    );
    expect(await readFile(join(workspacePath, "blob.bin"))).toEqual(
      Buffer.alloc(1_024, 1),
    );
    expect(await readFile(join(workspacePath, "new.bin"))).toEqual(
      Buffer.alloc(512, 2),
    );
  });
});

async function reviewedOutputFixture(): Promise<{
  readonly workspacePath: string;
  readonly storeRoot: string;
  readonly baseCommit: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "subscription-runtime-reviewed-output-"));
  roots.push(root);
  const workspacePath = join(root, "workspace");
  const storeRoot = join(root, "evidence");
  await execFileAsync("git", ["init", workspacePath]);
  await execFileAsync("git", ["-C", workspacePath, "config", "user.email", "test@example.com"]);
  await execFileAsync("git", ["-C", workspacePath, "config", "user.name", "Test"]);
  await mkdir(join(workspacePath, "src"), { recursive: true });
  await writeFile(join(workspacePath, "src", "value.ts"), "export const value = 1;\n");
  await execFileAsync("git", ["-C", workspacePath, "add", "."]);
  await execFileAsync("git", ["-C", workspacePath, "commit", "-m", "test: base"]);
  const { stdout } = await execFileAsync("git", ["-C", workspacePath, "rev-parse", "HEAD"]);
  await writeFile(join(workspacePath, "src", "value.ts"), "export const value = 2;\n");
  await writeFile(join(workspacePath, "src", "new.ts"), "export const added = true;\n");
  return { workspacePath, storeRoot, baseCommit: stdout.trim() };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
