import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AccessBoundary,
  NetworkAccessMode,
  type ProjectAccessScope,
} from "@vioxen/subscription-runtime/worker-core";
import type { CodexGoalJobManifest } from "../codex-goal-jobs";
import {
  assertProjectPreStartAdmissionLaunchBinding,
  planProjectPreStartAdmission,
  prepareProjectPreStartAdmission,
  validateStoredProjectPreStartAdmission,
} from "../application/project-control/codex-goal-project-pre-start-admission";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("project verifier admission binding", () => {
  it("binds verified artifact bytes separately from the normalized staged patch", async () => {
    const fixture = await createFixture();
    const sourcePath = join(fixture.workspacePath, "src", "example.ts");
    await writeFile(sourcePath, "export const value = 1;\n");
    execFileSync("git", ["add", "src/example.ts"], { cwd: fixture.workspacePath });
    const stagedPatch = execFileSync(
      "git",
      ["diff", "--cached", "--binary", "HEAD", "--"],
      { cwd: fixture.workspacePath },
    );
    expect(sha256(stagedPatch)).not.toBe(fixture.artifactSha256);

    await prepareProjectPreStartAdmission({
      plan: fixture.plan,
      manifest: fixture.manifest,
      scope: fixture.scope,
      verifiedInputPatchArtifactSha256: fixture.artifactSha256,
    });
    expect(JSON.parse(await readFile(fixture.plan.descriptor.receiptPath, "utf8")))
      .toMatchObject({
        workspaceMode: "verified_input_patch",
        inputPatchArtifactSha256: fixture.artifactSha256,
        workspaceStagedPatchSha256: sha256(stagedPatch),
      });
    await expect(validateStoredProjectPreStartAdmission({
      manifest: fixture.manifest,
      scope: fixture.scope,
    })).resolves.toBeUndefined();
    await expect(assertProjectPreStartAdmissionLaunchBinding({
      manifest: fixture.manifest,
      scope: fixture.scope,
    })).resolves.toBeUndefined();

    await writeFile(sourcePath, "export const value = 2;\n");
    execFileSync("git", ["add", "src/example.ts"], { cwd: fixture.workspacePath });
    await expect(validateStoredProjectPreStartAdmission({
      manifest: fixture.manifest,
      scope: fixture.scope,
    })).rejects.toThrow("project_control_pre_start_workspace_dirty");
  });

  it("rejects a mismatched artifact digest and unstaged workspace input", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.workspacePath, "src", "example.ts"), "staged\n");
    execFileSync("git", ["add", "src/example.ts"], { cwd: fixture.workspacePath });
    await expect(prepareProjectPreStartAdmission({
      plan: fixture.plan,
      manifest: fixture.manifest,
      scope: fixture.scope,
      verifiedInputPatchArtifactSha256: "f".repeat(64),
    })).rejects.toThrow("project_control_pre_start_verified_input_patch_mismatch");

    await writeFile(join(fixture.workspacePath, "UNTRACKED.txt"), "untracked\n");
    await expect(prepareProjectPreStartAdmission({
      plan: fixture.plan,
      manifest: fixture.manifest,
      scope: fixture.scope,
      verifiedInputPatchArtifactSha256: fixture.artifactSha256,
    })).rejects.toThrow("project_control_pre_start_workspace_dirty");
  });
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "verifier-admission-binding-"));
  roots.push(root);
  const workspacePath = join(root, "workspace");
  const jobRootDir = join(root, "jobs", "reviewer");
  const promptPath = join(jobRootDir, "prompt.md");
  await mkdir(join(workspacePath, "src"), { recursive: true });
  await mkdir(join(workspacePath, "sandbox"));
  await mkdir(jobRootDir, { recursive: true });
  execFileSync("git", ["init", "--quiet"], { cwd: workspacePath });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: workspacePath,
  });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: workspacePath });
  await writeFile(join(workspacePath, "README.md"), "fixture\n");
  await writeFile(join(workspacePath, "controller.md"), "controller\n");
  await writeFile(join(workspacePath, "lane.md"), "lane\n");
  await writeFile(promptPath, "review the verified handoff\n");
  execFileSync("git", ["add", "."], { cwd: workspacePath });
  execFileSync("git", ["commit", "--quiet", "-m", "test: fixture"], {
    cwd: workspacePath,
  });
  const phaseStartSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: workspacePath,
    encoding: "utf8",
  }).trim();
  const artifactSha256 = sha256(Buffer.from("verified handoff artifact bytes\n"));
  const manifestBase = {
    jobId: "reviewer",
    jobRootDir,
    workspacePath,
    promptPath,
    taskId: "reviewer",
    accounts: ["account-a"],
    accessBoundary: AccessBoundary.IsolatedWorkspaceWrite,
    networkAccess: NetworkAccessMode.Restricted,
  } as const;
  const contract = withWorkKey({
    kind: "worker-launch",
    format: 1,
    jobId: manifestBase.jobId,
    workerId: "worker-1",
    jobRoot: jobRootDir,
    workspaceRoot: workspacePath,
    promptPath,
    registryStatus: "queued",
    canonicalSha: phaseStartSha,
    baseSha: phaseStartSha,
    phaseStartSha,
    packetRevision: "phase-08-s0-r1",
    controllerPacket: "controller.md",
    lanePacket: "lane.md",
    phaseId: "phase-08",
    laneId: "p8-s0",
    inputPatchHash: artifactSha256,
    reviewKind: "review",
    revision: 0,
    retryCount: 0,
    supersedes: null,
    ownedPaths: ["src/example.ts"],
    mandatoryDocs: ["README.md", "controller.md", "lane.md"],
    mandatoryScripts: [],
    mandatoryFixtures: [],
    requiredChecks: [{ id: "focused", cwd: "sandbox", command: "true" }],
    executionPolicy: {
      mode: "sandbox-only",
      sandboxRoot: join(workspacePath, "sandbox"),
      forbiddenRealProjects: [join(root, "real-user-project")],
    },
  });
  const stateFields = [
    "workKey", "jobId", "workerId", "phaseId", "laneId", "baseSha",
    "phaseStartSha", "packetRevision", "controllerPacket", "lanePacket",
    "inputPatchHash", "reviewKind", "revision", "retryCount", "supersedes",
  ] as const;
  const state = {
    schemaVersion: 1,
    maxRetries: 0,
    maxInFlight: 1,
    records: [{
      ...Object.fromEntries(stateFields.map((field) => [field, contract[field]])),
      status: "queued",
      supersededBy: null,
      supersededFrom: null,
    }],
  };
  const scope: ProjectAccessScope = {
    projectId: "project",
    deniedRoots: [join(root, "real-user-project")],
    preStartAdmission: { required: true, mode: "serial-builtin" },
  };
  const plan = planProjectPreStartAdmission({
    value: { mode: "serial-builtin", contract, state },
    confirmed: true,
    scope,
    manifest: manifestBase,
  })!;
  const manifest: CodexGoalJobManifest = {
    ...manifestBase,
    schemaVersion: 1,
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
    projectPreStartAdmission: plan.descriptor,
  };
  return { workspacePath, artifactSha256, scope, plan, manifest };
}

function withWorkKey<T extends Record<string, unknown>>(contract: T): T & { workKey: string } {
  return {
    ...contract,
    workKey: sha256(Buffer.from(JSON.stringify({
      kind: contract.kind,
      format: contract.format,
      phaseId: contract.phaseId,
      laneId: contract.laneId,
      baseSha: contract.baseSha,
      phaseStartSha: contract.phaseStartSha,
      packetRevision: contract.packetRevision,
      inputPatchHash: contract.inputPatchHash,
      reviewKind: contract.reviewKind,
      revision: contract.revision,
    }))),
  };
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
