import { execFileSync } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  validateProjectRefillPreStartAdmission,
  validateProjectRefillPreStartAdmissionLocked,
} from "../application/project-control/codex-goal-project-refill-admission";
import { prepareProjectPreStartAdmission } from "../application/project-control/codex-goal-project-pre-start-admission";
import { authorizeProjectPreStartAdmissionLaunch } from "../application/project-control/codex-goal-project-pre-start-launch-authorization";
import {
  cleanupProjectPreStartAdmissionFixtures,
  createBuiltinFixture,
  declarativeContract,
  sha256,
} from "./codex-goal-project-pre-start-admission-fixture";

afterEach(async () => {
  await cleanupProjectPreStartAdmissionFixtures();
});

describe("project refill pre-start admission", () => {
  it("refills and starts the same launch-authorized verifier with continuation mode", async () => {
    const fixture = await authorizedVerifierFixture();
    const receiptBefore = await readFile(fixture.receiptPath, "utf8");

    await expect(fixture.prepareAgain()).resolves.toEqual({ createdPaths: [] });
    expect(await readFile(fixture.receiptPath, "utf8")).toBe(receiptBefore);
    await expect(fixture.startAgain()).resolves.toBe(
      "admitted_input_patch_continuation",
    );
    expect(
      JSON.parse(await readFile(fixture.receiptPath, "utf8")),
    ).toMatchObject({
      status: "launch_authorized",
      launchAuthorizationCount: 2,
    });
  });

  it("starts an already-authorized admitted patch through stored-job mode detection", async () => {
    const fixture = await authorizedVerifierFixture();

    await expect(fixture.startFromStoredTool()).resolves.toBe(
      "admitted_input_patch_continuation",
    );
    expect(
      JSON.parse(await readFile(fixture.receiptPath, "utf8")),
    ).toMatchObject({ launchAuthorizationCount: 2 });
  });

  it("does not infer clean capacity continuation without caller evidence", async () => {
    const fixture = await createBuiltinFixture();
    const plan = fixture.plan();
    const manifest = {
      ...fixture.storedManifest,
      projectPreStartAdmission: plan.descriptor,
    };
    await prepareProjectPreStartAdmission({
      plan,
      manifest,
      scope: fixture.scope,
    });
    await authorizeProjectPreStartAdmissionLaunch({
      manifest,
      scope: fixture.scope,
    });

    await expect(
      validateProjectRefillPreStartAdmissionLocked({
        manifest,
        scope: fixture.scope,
      }),
    ).rejects.toThrow(
      "project_control_pre_start_launch_binding_mismatch:input_patch_artifact",
    );
    await expect(
      validateProjectRefillPreStartAdmissionLocked({
        manifest,
        scope: fixture.scope,
        admittedInputPatch: false,
      }),
    ).resolves.toBe("clean_capacity_continuation");
  });

  it("rejects an authorized verifier continuation with untracked workspace drift", async () => {
    const fixture = await authorizedVerifierFixture();
    await writeFile(join(fixture.workspacePath, "unexpected.txt"), "drift\n");

    await expect(fixture.validateStoredTool()).rejects.toThrow(
      "project_control_pre_start_launch_binding_mismatch:input_patch_binding",
    );
  });

  it("rejects an authorized verifier continuation with prompt drift", async () => {
    const fixture = await authorizedVerifierFixture();
    await writeFile(fixture.promptPath, "changed prompt\n");

    await expect(fixture.validate()).rejects.toThrow(
      "project_control_pre_start_launch_binding_mismatch:prompt_sha256",
    );
  });

  it("rejects an authorized verifier continuation with manifest drift", async () => {
    const fixture = await authorizedVerifierFixture();

    await expect(
      fixture.validate({
        ...fixture.manifest,
        updatedAt: "2026-07-22T00:00:00.000Z",
      }),
    ).rejects.toThrow(
      "project_control_pre_start_launch_binding_mismatch:manifest_sha256",
    );
  });

  it("rejects an authorized verifier continuation when its admitted patch changes", async () => {
    const fixture = await authorizedVerifierFixture();
    await writeFile(
      join(fixture.workspacePath, "src", "example.ts"),
      "export const value = 2;\n",
    );
    execFileSync("git", ["add", "src/example.ts"], {
      cwd: fixture.workspacePath,
    });

    await expect(fixture.validate()).rejects.toThrow(
      "project_control_pre_start_launch_binding_mismatch:input_patch_binding",
    );
  });
});

async function authorizedVerifierFixture() {
  const fixture = await createBuiltinFixture();
  await mkdir(join(fixture.workspacePath, "src"), { recursive: true });
  await writeFile(
    join(fixture.workspacePath, "src", "example.ts"),
    "export const value = 1;\n",
  );
  execFileSync("git", ["add", "src/example.ts"], {
    cwd: fixture.workspacePath,
  });
  const stagedPatchSha256 = sha256(
    execFileSync("git", ["diff", "--cached", "--binary", "HEAD", "--"], {
      cwd: fixture.workspacePath,
    }),
  );
  const inputPatchArtifactSha256 = sha256(
    Buffer.from("immutable producer handoff artifact"),
  );
  const contract = {
    ...declarativeContract(fixture.contract),
    inputPatchHash: inputPatchArtifactSha256,
    reviewKind: "review",
  };
  const plan = fixture.plan({ contract, state: undefined });
  const manifest = {
    ...fixture.storedManifest,
    projectPreStartAdmission: plan.descriptor,
  };
  await prepareProjectPreStartAdmission({
    plan,
    manifest,
    scope: fixture.scope,
    verifiedInputPatchArtifactSha256: inputPatchArtifactSha256,
    verifiedInputPatchStagedSha256: stagedPatchSha256,
  });
  await authorizeProjectPreStartAdmissionLaunch({
    manifest,
    scope: fixture.scope,
    workspaceMode: "admitted_input_patch",
  });
  const registryRootDir = join(fixture.root, "registry");
  await mkdir(registryRootDir, { recursive: true });
  const scope = {
    ...fixture.scope,
    workspaceRoots: [fixture.workspacePath],
  };
  const expectedCanonicalWorkspacePath = await realpath(fixture.workspacePath);

  return {
    manifest,
    promptPath: fixture.manifest.promptPath,
    receiptPath: plan.descriptor.receiptPath,
    workspacePath: fixture.workspacePath,
    prepareAgain: async () =>
      await prepareProjectPreStartAdmission({
        plan,
        manifest: fixture.manifest,
        existingManifest: manifest,
        scope: fixture.scope,
        verifiedInputPatchArtifactSha256: inputPatchArtifactSha256,
        verifiedInputPatchStagedSha256: stagedPatchSha256,
      }),
    startAgain: async () => {
      const workspaceMode = await validateProjectRefillPreStartAdmission({
        registryRootDir,
        controllerJobId: "project-controller",
        manifest,
        scope,
        expectedCanonicalWorkspacePath,
        admittedInputPatch: true,
      });
      if (!workspaceMode) throw new Error("expected_refill_workspace_mode");
      await authorizeProjectPreStartAdmissionLaunch({
        manifest,
        scope,
        workspaceMode,
      });
      return workspaceMode;
    },
    startFromStoredTool: async () => {
      const workspaceMode =
        await validateProjectRefillPreStartAdmissionLocked({
          manifest,
          scope,
        });
      if (!workspaceMode) throw new Error("expected_project_start_workspace_mode");
      await authorizeProjectPreStartAdmissionLaunch({
        manifest,
        scope,
        workspaceMode,
      });
      return workspaceMode;
    },
    validateStoredTool: async () =>
      await validateProjectRefillPreStartAdmissionLocked({
        manifest,
        scope,
      }),
    validate: async (selectedManifest = manifest) =>
      await validateProjectRefillPreStartAdmission({
        registryRootDir,
        controllerJobId: "project-controller",
        manifest: selectedManifest,
        scope,
        expectedCanonicalWorkspacePath,
        admittedInputPatch: true,
      }),
  };
}
