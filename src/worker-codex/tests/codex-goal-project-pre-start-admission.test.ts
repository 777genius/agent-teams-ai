import { execFileSync } from "node:child_process";
import {
  access,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectAccessScope } from "@vioxen/subscription-runtime/worker-core";
import { parseCodexGoalProjectAccessScopeJson } from "../codex-goal-access-plan";
import { projectControlCreateCodexGoalJobView } from "../codex-goal-mcp-project-control-jobs";
import {
  assertProjectPreStartAdmissionLaunchBinding,
  planProjectPreStartAdmission,
  prepareProjectPreStartAdmission,
  rebindProjectPreStartAdmissionManifest,
  validateStoredProjectPreStartAdmission,
} from "../application/project-control/codex-goal-project-pre-start-admission";
import {
  authorizeProjectPreStartAdmissionLaunch,
  withProjectPreStartAdmissionLaunchAuthorization,
} from "../application/project-control/codex-goal-project-pre-start-launch-authorization";

import {
  cleanupProjectPreStartAdmissionFixtures,
  createBuiltinFixture,
  createFixture,
  declarativeContract,
  prepareBuiltin,
  sha256,
  withWorkKey,
} from "./codex-goal-project-pre-start-admission-fixture";

afterEach(async () => {
  await cleanupProjectPreStartAdmissionFixtures();
});

describe("project pre-start admission", () => {
  it("requires the gate and denies the direct create path", async () => {
    const fixture = await createFixture();
    expect(() =>
      planProjectPreStartAdmission({
        value: undefined,
        confirmed: true,
        scope: fixture.scope,
        manifest: fixture.manifest,
      }),
    ).toThrow("project_control_pre_start_admission_required");

    await expect(
      projectControlCreateCodexGoalJobView(
        {},
        {
          loadProjectControlController: async () => ({
            registryRootDir: join(fixture.root, "registry"),
            controller: fixture.storedManifest,
            scope: fixture.scope,
          }),
          codexProjectControlBroker: () => {
            throw new Error("broker_must_not_be_called");
          },
        },
      ),
    ).rejects.toThrow("project_control_pre_start_admission_refill_required");
  });

  it("writes fixed artifacts, runs both validators, and reruns before stored start", async () => {
    const fixture = await createFixture();
    const plan = fixture.plan();
    const prepared = await prepareProjectPreStartAdmission({
      plan,
      manifest: {
        ...fixture.manifest,
        projectPreStartAdmission: plan.descriptor,
      },
      scope: fixture.scope,
    });
    expect(prepared.createdPaths).toEqual([
      plan.descriptor.contractPath,
      plan.descriptor.statePath,
      plan.descriptor.receiptPath,
    ]);
    await expect(access(plan.descriptor.receiptPath)).resolves.toBeUndefined();

    const firstReceipt = JSON.parse(
      await readFile(plan.descriptor.receiptPath, "utf8"),
    );
    expect(firstReceipt).toMatchObject({
      schemaVersion: 1,
      jobId: fixture.manifest.jobId,
      workKey: fixture.contract.workKey,
      contractValidatorSha256: fixture.contractValidatorSha,
      admissionValidatorSha256: fixture.admissionValidatorSha,
    });

    await validateStoredProjectPreStartAdmission({
      manifest: {
        ...fixture.storedManifest,
        projectPreStartAdmission: plan.descriptor,
      },
      scope: fixture.scope,
    });
    const secondReceipt = JSON.parse(
      await readFile(plan.descriptor.receiptPath, "utf8"),
    );
    expect(secondReceipt.manifestSha256).not.toBe(firstReceipt.manifestSha256);
    const storedWithAdmission = {
      ...fixture.storedManifest,
      projectPreStartAdmission: plan.descriptor,
    };
    await expect(assertProjectPreStartAdmissionLaunchBinding({
      manifest: storedWithAdmission,
      scope: fixture.scope,
    })).resolves.toBeUndefined();
    const externalAdmission = fixture.scope.preStartAdmission;
    if (!externalAdmission || externalAdmission.mode !== "serial") {
      throw new Error("test_external_admission_required");
    }
    await expect(assertProjectPreStartAdmissionLaunchBinding({
      manifest: storedWithAdmission,
      scope: {
        ...fixture.scope,
        preStartAdmission: {
          ...externalAdmission,
          validatorBundle: externalAdmission.validatorBundle.map((item) =>
            item.path === "scripts/contract-validator.mjs"
              ? { ...item, sha256: "f".repeat(64) }
              : item
          ),
        },
      },
    })).rejects.toThrow("project_control_pre_start_launch_binding_mismatch");

    await writeFile(
      plan.descriptor.statePath,
      JSON.stringify({
        ...fixture.state,
        records: fixture.state.records.map((record) => ({
          ...record,
          status: "running",
        })),
      }),
    );
    await expect(
      validateStoredProjectPreStartAdmission({
        manifest: {
          ...fixture.storedManifest,
          projectPreStartAdmission: plan.descriptor,
        },
        scope: fixture.scope,
      }),
    ).rejects.toThrow(
      "project_control_pre_start_state_single_queued_match_required",
    );
  });

  it("rejects validator digest tampering and symlink escape", async () => {
    const fixture = await createFixture();
    const plan = fixture.plan();
    await prepareProjectPreStartAdmission({
      plan,
      manifest: {
        ...fixture.manifest,
        projectPreStartAdmission: plan.descriptor,
      },
      scope: fixture.scope,
    });
    await writeFile(
      fixture.contractValidatorPath,
      "process.exit(0);\n// tampered\n",
    );
    await expect(
      validateStoredProjectPreStartAdmission({
        manifest: {
          ...fixture.storedManifest,
          projectPreStartAdmission: plan.descriptor,
        },
        scope: fixture.scope,
      }),
    ).rejects.toThrow("project_control_pre_start_workspace_dirty");

    const symlinkFixture = await createFixture();
    const outside = join(symlinkFixture.root, "outside-validator.mjs");
    await writeFile(outside, "process.exit(0);\n");
    const link = join(
      symlinkFixture.workspacePath,
      "scripts",
      "escaped-validator.mjs",
    );
    await symlink(outside, link);
    const escapedSha = sha256(await readFile(outside));
    const legacyAdmission = symlinkFixture.scope.preStartAdmission;
    if (legacyAdmission?.mode !== "serial") throw new Error("legacy fixture expected");
    const escapedScope = {
      ...symlinkFixture.scope,
      preStartAdmission: {
        required: true,
        mode: "serial" as const,
        validatorBundle: [
          ...legacyAdmission.validatorBundle,
          { path: "scripts/escaped-validator.mjs", sha256: escapedSha },
        ],
      },
    };
    const escapedPlan = symlinkFixture.plan(
      {
        contractValidatorPath: "scripts/escaped-validator.mjs",
      },
      escapedScope,
    );
    await expect(
      prepareProjectPreStartAdmission({
        plan: escapedPlan,
        manifest: {
          ...symlinkFixture.manifest,
          projectPreStartAdmission: escapedPlan.descriptor,
        },
        scope: escapedScope,
      }),
    ).rejects.toThrow("project_control_pre_start_workspace_dirty");
  });

  it("bounds serialized artifacts and registry records", async () => {
    const fixture = await createFixture();
    expect(() =>
      fixture.plan({
        contract: { ...fixture.contract, padding: "x".repeat(300 * 1024) },
      }),
    ).toThrow("project_control_pre_start_contract_size_limit_exceeded");
    expect(() =>
      fixture.plan({
        state: {
          ...fixture.state,
          records: Array.from({ length: 65 }, () => fixture.state.records[0]),
        },
      }),
    ).toThrow("project_control_pre_start_serial_single_record_required");
    expect(() =>
      fixture.plan({ state: { ...fixture.state, maxInFlight: 2 } }),
    ).toThrow("project_control_pre_start_serial_maxInFlight_expected_1");
  });

  it("rejects reuse mismatch and removes newly written artifacts after validator failure", async () => {
    const fixture = await createFixture();
    const plan = fixture.plan();
    await prepareProjectPreStartAdmission({
      plan,
      manifest: {
        ...fixture.manifest,
        projectPreStartAdmission: plan.descriptor,
      },
      scope: fixture.scope,
    });
    const mismatched = fixture.plan({
      state: { ...fixture.state, maxRetries: 9 },
    });
    await expect(
      prepareProjectPreStartAdmission({
        plan: mismatched,
        manifest: {
          ...fixture.manifest,
          projectPreStartAdmission: mismatched.descriptor,
        },
        scope: fixture.scope,
      }),
    ).rejects.toThrow("project_control_pre_start_existing_artifact_mismatch");

    const failing = await createFixture({
      admissionValidatorBody: "process.exit(2);\n",
    });
    const failingPlan = failing.plan();
    await expect(
      prepareProjectPreStartAdmission({
        plan: failingPlan,
        manifest: {
          ...failing.manifest,
          projectPreStartAdmission: failingPlan.descriptor,
        },
        scope: failing.scope,
      }),
    ).rejects.toThrow("project_control_pre_start_admission_validation_failed");
    await expect(
      access(failingPlan.descriptor.contractPath),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      access(failingPlan.descriptor.statePath),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      access(failingPlan.descriptor.receiptPath),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("builtin project pre-start admission", () => {
  it("parses builtin scope while preserving legacy serial scope", () => {
    expect(parseCodexGoalProjectAccessScopeJson(JSON.stringify({
      projectId: "project",
      preStartAdmission: {
        required: true,
        mode: "serial-builtin",
      },
    }))).toMatchObject({
      preStartAdmission: {
        required: true,
        mode: "serial-builtin",
      },
    });
    expect(parseCodexGoalProjectAccessScopeJson(JSON.stringify({
      projectId: "project",
      preStartAdmission: {
        required: true,
        mode: "serial",
        validatorBundle: [{ path: "validator.mjs", sha256: "a".repeat(64) }],
      },
    }))).toMatchObject({ preStartAdmission: { mode: "serial" } });
    expect(() => parseCodexGoalProjectAccessScopeJson(JSON.stringify({
      projectId: "project",
      preStartAdmission: {
        required: true,
        mode: "serial-builtin",
        contractSchema: "worker-start-v1",
      },
    }))).toThrow("projectAccessScope.preStartAdmission.unexpected_field:contractSchema");
  });

  it("validates the stable worker launch format without workspace validator snapshots", async () => {
    const fixture = await createBuiltinFixture();
    const plan = fixture.plan();
    await prepareProjectPreStartAdmission({
      plan,
      manifest: { ...fixture.manifest, projectPreStartAdmission: plan.descriptor },
      scope: fixture.scope,
    });

    const receipt = JSON.parse(await readFile(plan.descriptor.receiptPath, "utf8"));
    expect(receipt).toMatchObject({
      validatorKind: "builtin",
      workKey: fixture.contract.workKey,
    });
    expect(fixture.contract.mandatoryScripts).toEqual([]);
    expect(fixture.contract.mandatoryFixtures).toEqual([]);
    await expect(
      access(join(fixture.manifest.jobRootDir, "pre-start-admission", "validator-bundle")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await validateStoredProjectPreStartAdmission({
      manifest: { ...fixture.storedManifest, projectPreStartAdmission: plan.descriptor },
      scope: fixture.scope,
    });
  });

  it("materializes trusted bindings, work key, and canonical serial state", async () => {
    const fixture = await createBuiltinFixture();
    const declarative = declarativeContract(fixture.contract);
    const plan = fixture.plan({ contract: declarative, state: undefined });
    expect(plan.contract).toMatchObject({
      jobId: fixture.manifest.jobId,
      workerId: fixture.manifest.jobId,
      registryStatus: "queued",
      jobRoot: fixture.manifest.jobRootDir,
      workspaceRoot: fixture.manifest.workspacePath,
      promptPath: fixture.manifest.promptPath,
      revision: 0,
      retryCount: 0,
      supersedes: null,
      workKey: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(plan.state).toEqual({
      schemaVersion: 1,
      maxRetries: 0,
      maxInFlight: 1,
      records: [{
        workKey: plan.contract.workKey,
        jobId: fixture.manifest.jobId,
        workerId: fixture.manifest.jobId,
        phaseId: plan.contract.phaseId,
        laneId: plan.contract.laneId,
        baseSha: plan.contract.baseSha,
        phaseStartSha: plan.contract.phaseStartSha,
        packetRevision: plan.contract.packetRevision,
        controllerPacket: plan.contract.controllerPacket,
        lanePacket: plan.contract.lanePacket,
        inputPatchHash: plan.contract.inputPatchHash,
        reviewKind: plan.contract.reviewKind,
        revision: 0,
        retryCount: 0,
        supersedes: null,
        status: "queued",
        supersededBy: null,
        supersededFrom: null,
      }],
    });
    const manifest = {
      ...fixture.storedManifest,
      projectPreStartAdmission: plan.descriptor,
    };
    await prepareProjectPreStartAdmission({ plan, manifest, scope: fixture.scope });
    await validateStoredProjectPreStartAdmission({ manifest, scope: fixture.scope });
    await assertProjectPreStartAdmissionLaunchBinding({ manifest, scope: fixture.scope });

    expect(() => fixture.plan({
      contract: { ...declarative, jobId: "wrong-job" },
      state: undefined,
    })).toThrow("project_control_pre_start_builtin_materialization_jobId_mismatch");
    expect(() => fixture.plan({
      contract: { ...declarative, workKey: "f".repeat(64) },
      state: undefined,
    })).toThrow("project_control_pre_start_builtin_materialization_workKey_mismatch");
    expect(() => fixture.plan({
      contract: declarative,
      state: { schemaVersion: 1, maxRetries: 1, maxInFlight: 1, records: [] },
    })).toThrow("project_control_pre_start_builtin_materialization_state_mismatch");
  });

  it("rejects malformed work identity, paths, checks, and state identity", async () => {
    const badWorkKey = await createBuiltinFixture();
    await expect(prepareBuiltin(badWorkKey, {
      contract: { ...badWorkKey.contract, workKey: "f".repeat(64) },
    })).rejects.toThrow("project_control_pre_start_builtin_contract_workKey_mismatch");

    const badPath = await createBuiltinFixture();
    const badPathContract = withWorkKey({
      ...badPath.contract,
      ownedPaths: ["../escape.ts"],
    });
    await expect(prepareBuiltin(badPath, { contract: badPathContract }))
      .rejects.toThrow(
        "worker_launch_request_invalid:ownedPaths.0:contract_relative_path_invalid",
      );

    const badCheck = await createBuiltinFixture();
    const badCheckContract = withWorkKey({
      ...badCheck.contract,
      requiredChecks: [{ id: "focused", cwd: "scripts", command: " pnpm test" }],
    });
    await expect(prepareBuiltin(badCheck, { contract: badCheckContract }))
      .rejects.toThrow(
        "worker_launch_request_invalid:requiredChecks.0.command:contract_requiredCheck_command_invalid",
      );

    const mismatch = await createBuiltinFixture();
    await expect(prepareBuiltin(mismatch, {
      state: {
        ...mismatch.state,
        records: mismatch.state.records.map((record) => ({ ...record, laneId: "other" })),
      },
    })).rejects.toThrow("project_control_pre_start_state_laneId_mismatch");

    const remediation = await createBuiltinFixture();
    const remediationContract = withWorkKey({
      ...remediation.contract,
      reviewKind: "remediation",
      revision: 1,
      retryCount: 1,
      supersedes: "e".repeat(64),
    });
    await expect(prepareBuiltin(remediation, { contract: remediationContract }))
      .rejects.toThrow("project_control_pre_start_builtin_contract_serial_initial_only");

    const emptyForbidden = await createBuiltinFixture();
    const emptyForbiddenContract = {
      ...emptyForbidden.contract,
      executionPolicy: {
        ...emptyForbidden.contract.executionPolicy,
        forbiddenRealProjects: [],
      },
    };
    await expect(prepareBuiltin(emptyForbidden, { contract: emptyForbiddenContract }))
      .rejects.toThrow(
        "worker_launch_request_invalid:executionPolicy.forbiddenRealProjects:contract_forbiddenRealProjects_empty",
      );
  });

  it("rejects dirty non-validator workspace content", async () => {
    const fixture = await createBuiltinFixture();
    await writeFile(join(fixture.workspacePath, "UNTRACKED.txt"), "dirty\n");
    await expect(prepareBuiltin(fixture, {}))
      .rejects.toThrow("project_control_pre_start_workspace_dirty");
  });

  it("accepts a clean first builtin implementation and validates its launch binding", async () => {
    const fixture = await createBuiltinFixture();
    const contract = withWorkKey({
      ...fixture.contract,
      inputPatchHash: null,
    });
    const plan = fixture.plan({ contract });
    const manifest = {
      ...fixture.storedManifest,
      projectPreStartAdmission: plan.descriptor,
    };

    await prepareBuiltin(fixture, { contract });
    await validateStoredProjectPreStartAdmission({
      manifest,
      scope: fixture.scope,
    });
    await expect(assertProjectPreStartAdmissionLaunchBinding({
      manifest,
      scope: fixture.scope,
    })).resolves.toBeUndefined();
  });

  it("accepts a clean builtin canonical review and validates its launch binding", async () => {
    const fixture = await createBuiltinFixture();
    const contract = withWorkKey({
      ...fixture.contract,
      inputPatchHash: null,
      reviewKind: "review",
    });
    const plan = fixture.plan({ contract });
    const manifest = {
      ...fixture.storedManifest,
      projectPreStartAdmission: plan.descriptor,
    };

    await prepareBuiltin(fixture, { contract });
    await validateStoredProjectPreStartAdmission({
      manifest,
      scope: fixture.scope,
    });
    await expect(assertProjectPreStartAdmissionLaunchBinding({
      manifest,
      scope: fixture.scope,
    })).resolves.toBeUndefined();
  });

  it("keeps null input patches out of external and remediation admission", async () => {
    const external = await createFixture();
    const externalContract = {
      ...external.contract,
      inputPatchHash: null,
      reviewKind: "review",
    };
    const externalPlan = external.plan({
      contract: externalContract,
      state: {
        ...external.state,
        records: [{
          ...external.state.records[0],
          inputPatchHash: null,
          reviewKind: "review",
        }],
      },
    });
    await expect(prepareProjectPreStartAdmission({
      plan: externalPlan,
      manifest: {
        ...external.manifest,
        projectPreStartAdmission: externalPlan.descriptor,
      },
      scope: external.scope,
    })).rejects.toThrow("project_control_pre_start_input_patch_hash_required");

    const remediation = await createBuiltinFixture();
    const remediationContract = withWorkKey({
      ...remediation.contract,
      inputPatchHash: null,
      reviewKind: "remediation",
    });
    await expect(prepareBuiltin(remediation, { contract: remediationContract }))
      .rejects.toThrow("contract_inputPatchHash_null_invalid");
  });

  it("accepts only the staged patch bound by inputPatchHash", async () => {
    const fixture = await createBuiltinFixture();
    await mkdir(join(fixture.workspacePath, "src"), { recursive: true });
    await writeFile(join(fixture.workspacePath, "src", "example.ts"), "export const value = 1;\n");
    execFileSync("git", ["add", "src/example.ts"], { cwd: fixture.workspacePath });
    const stagedPatch = execFileSync(
      "git",
      ["diff", "--cached", "--binary", "HEAD", "--"],
      { cwd: fixture.workspacePath },
    );
    const contract = withWorkKey({
      ...fixture.contract,
      inputPatchHash: sha256(stagedPatch),
    });

    await expect(prepareBuiltin(fixture, { contract })).resolves.toBeDefined();

    await writeFile(join(fixture.workspacePath, "src", "unstaged.ts"), "unstaged\n");
    await expect(prepareBuiltin(fixture, { contract }))
      .rejects.toThrow("project_control_pre_start_workspace_dirty");
  });

  it("rebinds prompt and workspace HEAD immediately before launch", async () => {
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
    await assertProjectPreStartAdmissionLaunchBinding({ manifest, scope: fixture.scope });
    await expect(assertProjectPreStartAdmissionLaunchBinding({
      manifest,
      scope: fixture.scope,
      workspaceMode: "reviewed_dirty_continuation",
    })).rejects.toThrow("project_control_pre_start_launch_binding_mismatch");

    await expect(assertProjectPreStartAdmissionLaunchBinding({
      manifest: { ...manifest, description: "manifest changed after receipt" },
      scope: fixture.scope,
    })).rejects.toThrow(
      "project_control_pre_start_launch_binding_mismatch:manifest_sha256",
    );
    await writeFile(join(fixture.workspacePath, "DIRTY.txt"), "dirty\n");
    await expect(assertProjectPreStartAdmissionLaunchBinding({
      manifest: { ...manifest, description: "manifest changed after receipt" },
      scope: fixture.scope,
      workspaceMode: "reviewed_dirty_continuation",
    })).rejects.toThrow("project_control_pre_start_launch_binding_mismatch");
    await rm(join(fixture.workspacePath, "DIRTY.txt"));

    await writeFile(fixture.manifest.promptPath, "changed prompt\n");
    await expect(assertProjectPreStartAdmissionLaunchBinding({
      manifest,
      scope: fixture.scope,
    })).rejects.toThrow("project_control_pre_start_launch_binding_mismatch");

    const dirtyFixture = await createBuiltinFixture();
    const dirtyPlan = dirtyFixture.plan();
    const dirtyManifest = {
      ...dirtyFixture.storedManifest,
      projectPreStartAdmission: dirtyPlan.descriptor,
    };
    await prepareProjectPreStartAdmission({
      plan: dirtyPlan,
      manifest: dirtyManifest,
      scope: dirtyFixture.scope,
    });
    await authorizeProjectPreStartAdmissionLaunch({
      manifest: dirtyManifest,
      scope: dirtyFixture.scope,
    });
    await expect(readFile(dirtyPlan.descriptor.receiptPath, "utf8")).resolves
      .toContain('"status": "launch_authorized"');
    await expect(validateStoredProjectPreStartAdmission({
      manifest: dirtyManifest,
      scope: dirtyFixture.scope,
    })).rejects.toThrow(
      "project_control_pre_start_admission_already_authorized",
    );
    await writeFile(join(dirtyFixture.workspacePath, "DIRTY.txt"), "dirty\n");
    await expect(assertProjectPreStartAdmissionLaunchBinding({
      manifest: dirtyManifest,
      scope: dirtyFixture.scope,
    })).rejects.toThrow("project_control_pre_start_launch_binding_mismatch");
    await expect(assertProjectPreStartAdmissionLaunchBinding({
      manifest: dirtyManifest,
      scope: dirtyFixture.scope,
      workspaceMode: "reviewed_dirty_continuation",
    })).resolves.toBeUndefined();
    await writeFile(dirtyFixture.manifest.promptPath, "changed prompt\n");
    await expect(assertProjectPreStartAdmissionLaunchBinding({
      manifest: dirtyManifest,
      scope: dirtyFixture.scope,
      workspaceMode: "reviewed_dirty_continuation",
    })).rejects.toThrow("project_control_pre_start_launch_binding_mismatch");

    const headFixture = await createBuiltinFixture();
    const headPlan = headFixture.plan();
    const headManifest = {
      ...headFixture.storedManifest,
      projectPreStartAdmission: headPlan.descriptor,
    };
    await prepareProjectPreStartAdmission({
      plan: headPlan,
      manifest: headManifest,
      scope: headFixture.scope,
    });
    await writeFile(join(headFixture.workspacePath, "HEAD-CHANGE.md"), "change\n");
    execFileSync("git", ["add", "HEAD-CHANGE.md"], { cwd: headFixture.workspacePath });
    execFileSync("git", ["commit", "--quiet", "-m", "test: change head"], {
      cwd: headFixture.workspacePath,
    });
    await expect(assertProjectPreStartAdmissionLaunchBinding({
      manifest: headManifest,
      scope: headFixture.scope,
    })).rejects.toThrow("project_control_pre_start_launch_binding_mismatch");
    await writeFile(join(headFixture.workspacePath, "DIRTY.txt"), "dirty\n");
    await expect(assertProjectPreStartAdmissionLaunchBinding({
      manifest: headManifest,
      scope: headFixture.scope,
      workspaceMode: "reviewed_dirty_continuation",
    })).rejects.toThrow("project_control_pre_start_launch_binding_mismatch");
  });

  it("permits reviewed dirty continuation after an adoption input patch evolves", async () => {
    const fixture = await createBuiltinFixture();
    await writeFile(join(fixture.workspacePath, "adopted.md"), "input patch\n");
    execFileSync("git", ["add", "adopted.md"], { cwd: fixture.workspacePath });
    const inputPatchHash = sha256(execFileSync(
      "git",
      ["diff", "--cached", "--binary", "HEAD", "--"],
      { cwd: fixture.workspacePath },
    ));
    const contract = withWorkKey({
      ...fixture.contract,
      inputPatchHash,
    });
    const state = {
      ...fixture.state,
      records: fixture.state.records.map((record) => ({
        ...record,
        workKey: contract.workKey,
        inputPatchHash,
      })),
    };
    const plan = fixture.plan({ contract, state });
    const manifest = {
      ...fixture.storedManifest,
      tags: ["worker-role-adoption"],
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
    await writeFile(join(fixture.workspacePath, "remediated.md"), "reviewed output\n");

    await expect(assertProjectPreStartAdmissionLaunchBinding({
      manifest,
      scope: fixture.scope,
      workspaceMode: "reviewed_dirty_continuation",
    })).resolves.toBeUndefined();
  });

  it("rebinds only the repaired manifest for an authorized reviewed dirty continuation", async () => {
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
    await writeFile(join(fixture.workspacePath, "reviewed-change.ts"), "dirty\n");

    const repairedManifest = {
      ...manifest,
      serviceTier: "default" as const,
    };
    await expect(
      assertProjectPreStartAdmissionLaunchBinding({
        manifest: repairedManifest,
        scope: fixture.scope,
        workspaceMode: "reviewed_dirty_continuation",
      }),
    ).rejects.toThrow(
      "project_control_pre_start_launch_binding_mismatch:manifest_sha256",
    );

    const rebound = await rebindProjectPreStartAdmissionManifest({
      manifest: repairedManifest,
      scope: fixture.scope,
      workspaceMode: "reviewed_dirty_continuation",
    });
    expect(rebound).toMatchObject({ updated: true });
    expect(rebound.previousManifestSha256).not.toBe(rebound.manifestSha256);
    await expect(
      assertProjectPreStartAdmissionLaunchBinding({
        manifest: repairedManifest,
        scope: fixture.scope,
        workspaceMode: "reviewed_dirty_continuation",
      }),
    ).resolves.toBeUndefined();

    const receipt = JSON.parse(
      await readFile(plan.descriptor.receiptPath, "utf8"),
    ) as Record<string, unknown>;
    expect(receipt).toMatchObject({
      manifestSha256: rebound.manifestSha256,
      manifestRepair: {
        previousManifestSha256: rebound.previousManifestSha256,
        manifestSha256: rebound.manifestSha256,
        repairedAt: expect.any(String),
      },
    });
    await expect(
      rebindProjectPreStartAdmissionManifest({
        manifest: repairedManifest,
        scope: fixture.scope,
        workspaceMode: "reviewed_dirty_continuation",
      }),
    ).resolves.toMatchObject({ updated: false });

    await writeFile(fixture.manifest.promptPath, "tampered prompt\n");
    await expect(
      rebindProjectPreStartAdmissionManifest({
        manifest: { ...repairedManifest, description: "another repair" },
        scope: fixture.scope,
        workspaceMode: "reviewed_dirty_continuation",
      }),
    ).rejects.toThrow(
      "project_control_pre_start_manifest_rebind_mismatch:prompt_sha256",
    );
  });

  it("rolls back failed startup authorization and permits one reviewed-dirty restart", async () => {
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

    await expect(withProjectPreStartAdmissionLaunchAuthorization({
        manifest,
        scope: fixture.scope,
      }, async () => {
        throw new Error("provider_startup_failed");
      })).rejects.toThrow("provider_startup_failed");
    await expect(validateStoredProjectPreStartAdmission({
      manifest,
      scope: fixture.scope,
    })).resolves.toBeUndefined();

    await authorizeProjectPreStartAdmissionLaunch({
      manifest,
      scope: fixture.scope,
    });
    await writeFile(join(fixture.workspacePath, "reviewed-change.ts"), "dirty\n");
    await authorizeProjectPreStartAdmissionLaunch({
      manifest,
      scope: fixture.scope,
      workspaceMode: "reviewed_dirty_continuation",
    });
    await expect(
      withProjectPreStartAdmissionLaunchAuthorization(
        {
          manifest,
          scope: fixture.scope,
          workspaceMode: "terminal_handoff_dependency_recovery",
        },
        async () => {
          throw new Error("dependency_recovery_startup_failed");
        },
      ),
    ).rejects.toThrow("dependency_recovery_startup_failed");
    await authorizeProjectPreStartAdmissionLaunch({
      manifest,
      scope: fixture.scope,
      workspaceMode: "terminal_handoff_dependency_recovery",
    });
    await authorizeProjectPreStartAdmissionLaunch({
      manifest,
      scope: fixture.scope,
      workspaceMode: "terminal_handoff_runtime_interrupt_continuation",
    });

    const receipt = JSON.parse(
      await readFile(plan.descriptor.receiptPath, "utf8"),
    ) as Record<string, unknown>;
    expect(receipt).toMatchObject({
      status: "launch_authorized",
      launchAuthorizationCount: 4,
    });
  });

  it("upgrades a legacy validated receipt only for a reviewed dirty continuation", async () => {
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
    await writeFile(join(fixture.workspacePath, "reviewed-change.ts"), "dirty\n");

    await expect(assertProjectPreStartAdmissionLaunchBinding({
      manifest,
      scope: fixture.scope,
    })).rejects.toThrow("project_control_pre_start_launch_binding_mismatch");
    await expect(assertProjectPreStartAdmissionLaunchBinding({
      manifest,
      scope: fixture.scope,
      workspaceMode: "reviewed_dirty_continuation",
    })).resolves.toBeUndefined();

    await authorizeProjectPreStartAdmissionLaunch({
      manifest,
      scope: fixture.scope,
      workspaceMode: "reviewed_dirty_continuation",
    });
    const receipt = JSON.parse(
      await readFile(plan.descriptor.receiptPath, "utf8"),
    ) as Record<string, unknown>;
    expect(receipt).toMatchObject({
      status: "launch_authorized",
      launchAuthorizationCount: 1,
    });
  });
});
