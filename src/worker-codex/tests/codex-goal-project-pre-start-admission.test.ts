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
import { projectControlCreateCodexGoalJobView } from "../codex-goal-mcp-project-control-jobs";
import {
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
    ).rejects.toThrow("project_control_pre_start_validator_bundle_dirty");

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
    const escapedScope = {
      ...symlinkFixture.scope,
      preStartAdmission: {
        required: true,
        mode: "serial" as const,
        validatorBundle: [
          ...symlinkFixture.scope.preStartAdmission!.validatorBundle,
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
    ).rejects.toThrow("project_control_pre_start_validator_bundle_dirty");
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
    inputPatchHash: "d".repeat(64),
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
