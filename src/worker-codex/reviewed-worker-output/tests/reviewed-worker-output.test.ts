import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { ReviewDecisionStatus } from "@vioxen/subscription-runtime/worker-core";
import { captureGitWorkspacePatch } from "../../codex-goal-runtime-result-io";
import {
  captureReviewedWorkerOutput,
  commitReviewedWorkerOutputReviewAttestation,
  resolveReviewedWorkerContinuation,
  resolveReviewedWorkerOutput,
  withReviewedWorkerOutputStillMatching,
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
  it("binds an exact merge source into the immutable reviewed output identity", async () => {
    const fixture = await reviewedOutputFixture();
    const patch = await captureGitWorkspacePatch({
      workspacePath: fixture.workspacePath,
    });
    const deps = localReviewedWorkerOutputDeps({ rootDir: fixture.storeRoot });
    const capture = (sourceCommit: string) => captureReviewedWorkerOutput(deps, {
      projectId: "project-1",
      controllerJobId: "project-1-controller",
      workerJobId: "project-1-worker",
      taskId: "task-1",
      workspacePath: fixture.workspacePath,
      expectedPatchSha256: sha256(patch),
      decision: ReviewDecisionStatus.Approved,
      reviewedBy: "project-1-controller",
      reason: "Reviewed conflict resolution.",
      approvedFiles: ["src/value.ts", "src/new.ts"],
      requiredChecks: [],
      merge: {
        sourceRemote: "origin",
        sourceBranch: "base/current",
        sourceCommit,
        expectedTargetCommit: fixture.baseCommit,
      },
    });

    const first = await capture("1".repeat(40));
    const second = await capture("2".repeat(40));

    expect(first.reviewedOutputId).not.toBe(second.reviewedOutputId);
    expect(first.merge).toEqual({
      sourceRemote: "origin",
      sourceBranch: "base/current",
      sourceCommit: "1".repeat(40),
      expectedTargetCommit: fixture.baseCommit,
    });
    expect(JSON.parse(await readFile(
      join(fixture.storeRoot, first.reviewedOutputId, "manifest.json"),
      "utf8",
    ))).toMatchObject({ merge: first.merge });
  });

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
        decision: ReviewDecisionStatus.Approved,
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
    await commitReviewedWorkerOutputReviewAttestation({
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
        decision: ReviewDecisionStatus.Approved,
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
      decision: ReviewDecisionStatus.Approved,
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

  it("reads deployed approval artifacts as approved-only review attestations", async () => {
    const fixture = await reviewedOutputFixture();
    const deps = localReviewedWorkerOutputDeps({ rootDir: fixture.storeRoot });
    const patch = await captureGitWorkspacePatch({ workspacePath: fixture.workspacePath });
    const snapshot = await captureReviewedWorkerOutput(deps, {
      projectId: "project-1",
      controllerJobId: "project-1-controller",
      workerJobId: "project-1-worker",
      taskId: "task-1",
      workspacePath: fixture.workspacePath,
      expectedPatchSha256: sha256(patch),
      decision: ReviewDecisionStatus.Approved,
      reviewedBy: "project-1-controller",
      reason: "Legacy approved review.",
      approvedFiles: ["src/value.ts", "src/new.ts"],
      requiredChecks: [],
    });
    await commitReviewedWorkerOutputReviewAttestation({
      store: deps.store,
      markerVerifier: {
        async verify() {
          return {
            markerSha256: sha256("legacy marker"),
            markerContent: "legacy marker",
          };
        },
      },
      snapshot,
      reviewMarkerPath: "/evidence/legacy-review.json",
    });
    const itemDir = join(fixture.storeRoot, snapshot.reviewedOutputId);
    const currentPath = join(itemDir, "review-attestation.json");
    const legacyPath = join(itemDir, "approval.json");
    const current = JSON.parse(await readFile(currentPath, "utf8")) as
      Record<string, unknown>;
    await writeFile(legacyPath, `${JSON.stringify({
      ...current,
      format: "reviewed-worker-output-approval",
    }, null, 2)}\n`);
    await rm(currentPath);

    await expect(resolveReviewedWorkerOutput({
      store: deps.store,
      projectId: "project-1",
      reviewedOutputId: snapshot.reviewedOutputId,
    })).resolves.toMatchObject({
      snapshot: { reviewedOutputId: snapshot.reviewedOutputId },
    });
  });

  it("uses an attested rejected snapshot only for the same dirty worker continuation", async () => {
    const fixture = await reviewedOutputFixture();
    const deps = localReviewedWorkerOutputDeps({ rootDir: fixture.storeRoot });
    const patch = await captureGitWorkspacePatch({ workspacePath: fixture.workspacePath });
    const snapshot = await captureReviewedWorkerOutput(deps, {
      projectId: "project-1",
      controllerJobId: "project-1-controller",
      workerJobId: "project-1-worker",
      taskId: "task-1",
      workspacePath: fixture.workspacePath,
      expectedPatchSha256: sha256(patch),
      decision: ReviewDecisionStatus.Rejected,
      reviewedBy: "project-1-controller",
      reason: "Evidence needs remediation in the same workspace.",
      approvedFiles: ["src/value.ts", "src/new.ts"],
      requiredChecks: [],
    });
    await commitReviewedWorkerOutputReviewAttestation({
      store: deps.store,
      markerVerifier: {
        async verify() {
          return {
            markerSha256: sha256("rejected review marker"),
            markerContent: "rejected review marker",
          };
        },
      },
      snapshot,
      reviewMarkerPath: "/evidence/rejected-review.json",
    });

    await expect(resolveReviewedWorkerOutput({
      store: deps.store,
      projectId: "project-1",
      reviewedOutputId: snapshot.reviewedOutputId,
    })).rejects.toThrow("reviewed_worker_output_not_approved");
    await expect(resolveReviewedWorkerContinuation({
      store: deps.store,
      projectId: "project-1",
      controllerJobId: "project-1-controller",
      workerJobId: "project-1-worker",
      taskId: "task-1",
      workspacePath: fixture.workspacePath,
      reviewedOutputId: snapshot.reviewedOutputId,
    })).resolves.toEqual(snapshot);
    await expect(resolveReviewedWorkerContinuation({
      store: deps.store,
      projectId: "project-1",
      controllerJobId: "wrong-controller",
      workerJobId: "project-1-worker",
      taskId: "task-1",
      workspacePath: fixture.workspacePath,
      reviewedOutputId: snapshot.reviewedOutputId,
    })).rejects.toThrow("reviewed_worker_output_controller_mismatch");
  });

  it("holds the continuation lock across exact verification and the launch effect", async () => {
    const fixture = await reviewedOutputFixture();
    const localDeps = localReviewedWorkerOutputDeps({ rootDir: fixture.storeRoot });
    const patch = await captureGitWorkspacePatch({ workspacePath: fixture.workspacePath });
    const snapshot = await captureReviewedWorkerOutput(localDeps, {
      projectId: "project-1",
      controllerJobId: "project-1-controller",
      workerJobId: "project-1-worker",
      taskId: "task-1",
      workspacePath: fixture.workspacePath,
      expectedPatchSha256: sha256(patch),
      decision: ReviewDecisionStatus.Rejected,
      reviewedBy: "project-1-controller",
      reason: "Same worker continuation.",
      approvedFiles: ["src/value.ts", "src/new.ts"],
      requiredChecks: [],
    });
    let lockHeld = false;
    const deps = {
      ...localDeps,
      locks: {
        async acquire(input: { readonly workspacePath: string; readonly owner: string }) {
          const lock = await localDeps.locks.acquire(input);
          lockHeld = true;
          return lock;
        },
        async release(lock: Parameters<typeof localDeps.locks.release>[0]) {
          await localDeps.locks.release(lock);
          lockHeld = false;
        },
      },
    };
    let effectCalls = 0;
    await expect(withReviewedWorkerOutputStillMatching(deps, snapshot, async () => {
      expect(lockHeld).toBe(true);
      effectCalls += 1;
      return "started";
    })).resolves.toBe("started");
    expect(effectCalls).toBe(1);
    expect(lockHeld).toBe(false);

    await writeFile(join(fixture.workspacePath, "src", "value.ts"), "mutated\n");
    await expect(withReviewedWorkerOutputStillMatching(deps, snapshot, async () => {
      effectCalls += 1;
      return "must-not-start";
    })).rejects.toThrow("reviewed_worker_output_workspace_changed_after_capture");
    expect(effectCalls).toBe(1);
    expect(lockHeld).toBe(false);
  });

  it("carries fixture paths through reviewed-output blob validation", async () => {
    const fixture = await reviewedOutputFixture();
    const fixturePath = join(fixture.workspacePath, "src", "config.fixture.env");
    await writeFile(
      fixturePath,
      ["API_", "KEY=", "test-", "fixture-literal", "\n"].join(""),
    );

    await expect(new GitReviewedWorkerOutputSnapshotter({
      tempRootDir: join(fixture.storeRoot, ".captures"),
    }).capture({ workspacePath: fixture.workspacePath })).resolves.toMatchObject({
      changedFiles: ["src/config.fixture.env", "src/new.ts", "src/value.ts"],
      patch: expect.stringContaining("config.fixture.env"),
    });
  });

  it("rejects provider-shaped material embedded in a reviewed binary blob", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-reviewed-secret-"));
    roots.push(root);
    const workspacePath = join(root, "workspace");
    await execFileAsync("git", ["init", workspacePath]);
    await execFileAsync("git", ["-C", workspacePath, "config", "user.email", "test@example.com"]);
    await execFileAsync("git", ["-C", workspacePath, "config", "user.name", "Test"]);
    await writeFile(join(workspacePath, "blob.bin"), Buffer.alloc(256, 1));
    await execFileAsync("git", ["-C", workspacePath, "add", "blob.bin"]);
    await execFileAsync("git", ["-C", workspacePath, "commit", "-m", "test: base"]);
    await writeFile(join(workspacePath, "blob.bin"), Buffer.concat([
      Buffer.from([0x00, 0x01]),
      Buffer.from([["s", "k", "-"].join(""), "z".repeat(24)].join("")),
      Buffer.from([0xff]),
    ]));

    await expect(new GitReviewedWorkerOutputSnapshotter({
      tempRootDir: join(root, "captures"),
    }).capture({ workspacePath })).rejects.toThrow(
      "reviewed_worker_output_secret_like_content",
    );
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
