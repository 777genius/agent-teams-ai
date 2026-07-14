import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AccessBoundary,
  NetworkAccessMode,
  type ProjectAccessScope,
} from "@vioxen/subscription-runtime/worker-core";
import type {
  CodexGoalJobManifest,
  CodexGoalJobManifestInput,
} from "../codex-goal-jobs";
import { parseCodexGoalProjectAccessScopeJson } from "../codex-goal-access-plan";
import { projectControlCreateCodexGoalJobView } from "../codex-goal-mcp-project-control-jobs";
import {
  authorizeProjectPreStartAdmissionLaunch,
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
    })).rejects.toThrow("project_control_pre_start_launch_binding_mismatch");
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
});

async function prepareBuiltin(
  fixture: Awaited<ReturnType<typeof createBuiltinFixture>>,
  overrides: Record<string, unknown>,
) {
  const contract = (overrides.contract ?? fixture.contract) as Record<string, unknown>;
  const state = overrides.state ?? {
    ...fixture.state,
    records: fixture.state.records.map((record) => ({
      ...record,
      ...Object.fromEntries(Object.keys(record).map((field) => [
        field,
        field in contract ? contract[field] : record[field as keyof typeof record],
      ])),
      status: "queued",
      supersededBy: null,
      supersededFrom: null,
    })),
  };
  const plan = fixture.plan({ ...overrides, contract, state });
  return prepareProjectPreStartAdmission({
    plan,
    manifest: { ...fixture.manifest, projectPreStartAdmission: plan.descriptor },
    scope: fixture.scope,
  });
}

async function createBuiltinFixture() {
  const base = await createFixture();
  await mkdir(join(base.workspacePath, "sandbox"));
  await writeFile(join(base.workspacePath, "controller.md"), "controller\n");
  await writeFile(join(base.workspacePath, "lane.md"), "lane\n");
  execFileSync("git", ["add", "controller.md", "lane.md"], { cwd: base.workspacePath });
  execFileSync("git", ["commit", "--quiet", "-m", "test: packets"], {
    cwd: base.workspacePath,
  });
  const phaseStartSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: base.workspacePath,
    encoding: "utf8",
  }).trim();
  const contract = withWorkKey({
    kind: "worker-launch",
    format: 1,
    ...base.contract,
    canonicalSha: phaseStartSha,
    baseSha: phaseStartSha,
    phaseStartSha,
    packetRevision: "phase-01-s0-r1",
    controllerPacket: "controller.md",
    lanePacket: "lane.md",
    ownedPaths: ["src/example.ts"],
    mandatoryDocs: ["README.md", "controller.md", "lane.md"],
    mandatoryScripts: [],
    mandatoryFixtures: [],
    requiredChecks: [{
      id: "focused",
      cwd: "scripts",
      command: "node --check contract-validator.mjs",
    }],
    executionPolicy: {
      mode: "sandbox-only",
      sandboxRoot: join(base.workspacePath, "sandbox"),
      forbiddenRealProjects: [join(base.root, "forbidden-project")],
    },
  });
  const stateIdentityFields = [
    "workKey",
    "jobId",
    "workerId",
    "phaseId",
    "laneId",
    "baseSha",
    "phaseStartSha",
    "packetRevision",
    "controllerPacket",
    "lanePacket",
    "inputPatchHash",
    "reviewKind",
    "revision",
    "retryCount",
    "supersedes",
  ] as const;
  const stateRecord = Object.fromEntries(
    stateIdentityFields.map((field) => [field, contract[field]]),
  );
  const state = {
    schemaVersion: 1,
    maxRetries: 2,
    maxInFlight: 1,
    records: [{ ...stateRecord, status: "queued", supersededBy: null, supersededFrom: null }],
  };
  const scope: ProjectAccessScope = {
    projectId: "project",
    deniedRoots: [join(base.root, "denied")],
    preStartAdmission: {
      required: true,
      mode: "serial-builtin",
    },
  };
  return {
    ...base,
    contract,
    state,
    scope,
    plan(overrides: Record<string, unknown> = {}) {
      return planProjectPreStartAdmission({
        value: {
          mode: "serial-builtin",
          contract,
          state,
          ...overrides,
        },
        confirmed: true,
        scope,
        manifest: base.manifest,
      })!;
    },
  };
}

function withWorkKey<T extends Record<string, unknown>>(contract: T): T & { workKey: string } {
  const workKey = sha256(Buffer.from(JSON.stringify({
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
  })));
  return { ...contract, workKey };
}

function declarativeContract(contract: Record<string, unknown>): Record<string, unknown> {
  const computed = new Set([
    "jobId",
    "workerId",
    "registryStatus",
    "jobRoot",
    "workspaceRoot",
    "promptPath",
    "workKey",
    "revision",
    "retryCount",
    "supersedes",
  ]);
  return Object.fromEntries(
    Object.entries(contract).filter(([field]) => !computed.has(field)),
  );
}

async function createFixture(
  options: { readonly admissionValidatorBody?: string } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "project-pre-start-admission-"));
  roots.push(root);
  const workspacePath = join(root, "workspace");
  const jobRootDir = join(root, "jobs", "project-worker");
  await mkdir(join(workspacePath, "scripts"), { recursive: true });
  await mkdir(jobRootDir, { recursive: true });
  execFileSync("git", ["init", "--quiet"], { cwd: workspacePath });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: workspacePath,
  });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: workspacePath });
  await writeFile(join(workspacePath, "README.md"), "fixture\n");
  execFileSync("git", ["add", "."], { cwd: workspacePath });
  execFileSync("git", ["commit", "--quiet", "-m", "test: fixture"], {
    cwd: workspacePath,
  });

  const contractValidatorPath = join(
    workspacePath,
    "scripts",
    "contract-validator.mjs",
  );
  const admissionValidatorPath = join(
    workspacePath,
    "scripts",
    "admission-validator.mjs",
  );
  await writeFile(
    contractValidatorPath,
    `
import { readFileSync } from "node:fs";
const path = process.argv[process.argv.indexOf("--contract") + 1];
JSON.parse(readFileSync(path, "utf8"));
`,
  );
  await writeFile(
    admissionValidatorPath,
    options.admissionValidatorBody ??
      `
import { readFileSync } from "node:fs";
const contract = JSON.parse(readFileSync(process.argv[process.argv.indexOf("--contract") + 1], "utf8"));
const state = JSON.parse(readFileSync(process.argv[process.argv.indexOf("--state") + 1], "utf8"));
if (state.records.filter((record) => record.workKey === contract.workKey).length !== 1) process.exit(2);
`,
  );
  execFileSync("git", ["add", "scripts"], { cwd: workspacePath });
  execFileSync("git", ["commit", "--quiet", "-m", "test: validators"], {
    cwd: workspacePath,
  });
  const workspaceHead = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: workspacePath,
    encoding: "utf8",
  }).trim();
  const contractValidatorSha = sha256(await readFile(contractValidatorPath));
  const admissionValidatorSha = sha256(await readFile(admissionValidatorPath));
  const promptPath = join(jobRootDir, "prompt.md");
  await writeFile(promptPath, "bounded prompt\n");
  const manifest: CodexGoalJobManifestInput = {
    jobId: "project-worker",
    jobRootDir,
    workspacePath,
    promptPath,
    taskId: "project-worker",
    accounts: ["account-a"],
    accessBoundary: AccessBoundary.IsolatedWorkspaceWrite,
    networkAccess: NetworkAccessMode.Restricted,
  };
  const storedManifest: CodexGoalJobManifest = {
    ...manifest,
    schemaVersion: 1,
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:00.000Z",
  };
  const contract = {
    jobId: manifest.jobId,
    workerId: "worker-1",
    jobRoot: jobRootDir,
    workspaceRoot: workspacePath,
    promptPath,
    registryStatus: "queued",
    workKey: "a".repeat(64),
    phaseId: "phase-01",
    laneId: "p1-s0",
    baseSha: "b".repeat(40),
    phaseStartSha: workspaceHead,
    packetRevision: "r1",
    controllerPacket: "controller.md",
    lanePacket: "lane.md",
    inputPatchHash: sha256(Buffer.alloc(0)),
    reviewKind: "implementation",
    revision: 0,
    retryCount: 0,
    supersedes: null,
  };
  const state = {
    schemaVersion: 1,
    maxRetries: 0,
    maxInFlight: 1,
    records: [{ ...contract, status: "queued", registryStatus: undefined }],
  };
  const scope: ProjectAccessScope = {
    projectId: "project",
    preStartAdmission: {
      required: true,
      mode: "serial",
      validatorBundle: [
        {
          path: "scripts/contract-validator.mjs",
          sha256: contractValidatorSha,
        },
        {
          path: "scripts/admission-validator.mjs",
          sha256: admissionValidatorSha,
        },
      ],
    },
  };
  return {
    root,
    workspacePath,
    contractValidatorPath,
    contractValidatorSha,
    admissionValidatorSha,
    manifest,
    storedManifest,
    contract,
    state,
    scope,
    plan(overrides: Record<string, unknown> = {}, selectedScope = scope) {
      return planProjectPreStartAdmission({
        value: {
          contractValidatorPath: "scripts/contract-validator.mjs",
          admissionValidatorPath: "scripts/admission-validator.mjs",
          contract,
          state,
          ...overrides,
        },
        confirmed: true,
        scope: selectedScope,
        manifest,
      })!;
    },
  };
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
