import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  lstat,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { ProjectAccessScope } from "@vioxen/subscription-runtime/worker-core";
import type {
  CodexGoalJobManifest,
  CodexGoalJobManifestInput,
  CodexGoalProjectPreStartAdmission,
} from "../../codex-goal-jobs";
import {
  materializeBuiltinWorkerLaunchSpec,
  validateBuiltinWorkerLaunchSpec,
} from "./codex-goal-project-builtin-pre-start-admission";
import { readControlledRuntimeInterruptionHandoff } from "./codex-goal-project-verifier-handoff";
import { parseWorkerLaunchSpec } from "./worker-launch-spec";
import type { ProjectPreStartAdmissionLaunchWorkspaceMode } from "./codex-goal-project-pre-start-admission-types";
export type {
  ProjectPreStartAdmissionDirtyContinuationMode,
  ProjectPreStartAdmissionLaunchWorkspaceMode,
} from "./codex-goal-project-pre-start-admission-types";
import {
  assertProjectInputPatchContract,
  projectInputPatchBindingMatches,
} from "./codex-goal-project-input-patch-policy";
import {
  captureProjectPreStartBinding,
  readVerifiedInputPatchFromExistingReceipt,
  verifiedInputPatchBindingValid,
  verifiedInputPatchFromReceipt,
} from "./codex-goal-project-pre-start-binding";
import {
  configuredValidator,
  runValidator,
  snapshotValidatorBundle,
} from "./codex-goal-project-pre-start-validator-bundle";

const ADMISSION_DIRECTORY = "pre-start-admission";
const MAX_CONTRACT_BYTES = 256 * 1024;
const MAX_STATE_BYTES = 1024 * 1024;
const MAX_STATE_RECORDS = 1;
const MAX_PROMPT_BYTES = 1024 * 1024;

type JsonObject = Readonly<Record<string, unknown>>;

// This bridge proves a bounded serial launch gate. Its state artifact is caller-supplied evidence,
// not a durable multi-host uniqueness registry. Parallel admission still requires a transactional
// shared-runtime work-key authority.

export type ProjectPreStartAdmissionInput =
  | {
      readonly contractValidatorPath: string;
      readonly admissionValidatorPath: string;
      readonly contract: JsonObject;
      readonly state: JsonObject;
    }
  | {
      readonly mode: "serial-builtin";
      readonly contract: JsonObject;
      readonly state?: JsonObject;
    };

export type PlannedProjectPreStartAdmission = {
  readonly descriptor: CodexGoalProjectPreStartAdmission;
  readonly contract: JsonObject;
  readonly state: JsonObject;
};

export function assertProjectPreStartAdmissionSourceRevision(input: {
  readonly plan: PlannedProjectPreStartAdmission | undefined;
  readonly sourceRevision: string;
}): void {
  if (
    input.plan &&
    isBuiltinDescriptor(input.plan.descriptor) &&
    input.plan.contract.phaseStartSha !== input.sourceRevision
  ) {
    throw new Error("project_control_pre_start_source_revision_mismatch");
  }
}

export function planProjectPreStartAdmission(input: {
  readonly value: unknown;
  readonly confirmed: boolean;
  readonly scope: ProjectAccessScope;
  readonly manifest: CodexGoalJobManifestInput;
}): PlannedProjectPreStartAdmission | undefined {
  if (input.value === undefined) {
    if (input.scope.preStartAdmission?.required) {
      throw new Error("project_control_pre_start_admission_required");
    }
    return undefined;
  }
  if (!input.confirmed) {
    throw new Error("project_control_confirm_pre_start_admission_required");
  }
  const parsed = parseProjectPreStartAdmissionInput(input.value);
  if (isBuiltinInput(parsed)) {
    assertBuiltinScope(input.scope);
  } else {
    configuredValidator(parsed.contractValidatorPath, input.scope);
    configuredValidator(parsed.admissionValidatorPath, input.scope);
  }
  const materialized = isBuiltinInput(parsed)
    ? materializeBuiltinWorkerLaunchSpec({
        contract: parsed.contract,
        ...(parsed.state ? { state: parsed.state } : {}),
        manifest: input.manifest,
      })
    : { contract: parsed.contract, state: parsed.state };
  assertSerializedSize("contract", materialized.contract, MAX_CONTRACT_BYTES);
  assertSerializedSize("state", materialized.state, MAX_STATE_BYTES);
  if (materialized.state.maxInFlight !== 1) {
    throw new Error("project_control_pre_start_serial_maxInFlight_expected_1");
  }
  if (
    !Array.isArray(materialized.state.records) ||
    materialized.state.records.length !== 1
  ) {
    throw new Error("project_control_pre_start_serial_single_record_required");
  }
  assertContractBindings(materialized.contract, input.manifest);
  const root = join(input.manifest.jobRootDir, ADMISSION_DIRECTORY);
  return {
    descriptor: isBuiltinInput(parsed)
      ? {
          schemaVersion: 1,
          mode: "serial-builtin",
          contractPath: join(root, "contract.json"),
          statePath: join(root, "state.json"),
          receiptPath: join(root, "receipt.json"),
        }
      : {
          schemaVersion: 1,
          contractValidatorPath: parsed.contractValidatorPath,
          admissionValidatorPath: parsed.admissionValidatorPath,
          contractPath: join(root, "contract.json"),
          statePath: join(root, "state.json"),
          receiptPath: join(root, "receipt.json"),
        },
    contract: materialized.contract,
    state: materialized.state,
  };
}

export async function prepareProjectPreStartAdmission(input: {
  readonly plan: PlannedProjectPreStartAdmission;
  readonly manifest: CodexGoalJobManifestInput;
  readonly scope: ProjectAccessScope;
  readonly verifiedInputPatchArtifactSha256?: string;
  readonly verifiedInputPatchStagedSha256?: string;
}): Promise<{ readonly createdPaths: readonly string[] }> {
  if (
    input.verifiedInputPatchArtifactSha256 === undefined &&
    input.verifiedInputPatchStagedSha256 !== undefined
  ) {
    throw new Error("project_control_pre_start_verified_input_patch_mismatch");
  }
  assertDescriptorPaths(input.plan.descriptor, input.manifest.jobRootDir);
  const createdPaths: string[] = [];
  try {
    await assertArtifactRootSecure(input.manifest.jobRootDir);
    await mkdir(join(input.manifest.jobRootDir, ADMISSION_DIRECTORY), {
      recursive: true,
      mode: 0o700,
    });
    if (
      await writeJsonArtifact(
        input.plan.descriptor.contractPath,
        input.plan.contract,
        MAX_CONTRACT_BYTES,
      )
    ) {
      createdPaths.push(input.plan.descriptor.contractPath);
    }
    if (
      await writeJsonArtifact(
        input.plan.descriptor.statePath,
        input.plan.state,
        MAX_STATE_BYTES,
      )
    ) {
      createdPaths.push(input.plan.descriptor.statePath);
    }
    await validateProjectPreStartAdmission({
      manifest: {
        ...input.manifest,
        projectPreStartAdmission: input.plan.descriptor,
      },
      scope: input.scope,
      ...(input.verifiedInputPatchArtifactSha256
        ? {
            verifiedInputPatch: {
              artifactSha256: input.verifiedInputPatchArtifactSha256,
              stagedPatchSha256: requiredSha256(
                input.verifiedInputPatchStagedSha256,
                "verifiedInputPatchStagedSha256",
              ),
            },
          }
        : {}),
    });
    if (createdPaths.length > 0) {
      createdPaths.push(input.plan.descriptor.receiptPath);
    }
    return { createdPaths };
  } catch (error) {
    await removeProjectPreStartAdmissionPaths(createdPaths);
    throw error;
  }
}

export async function validateStoredProjectPreStartAdmission(input: {
  readonly manifest: CodexGoalJobManifest;
  readonly scope: ProjectAccessScope;
}): Promise<void> {
  if (!input.manifest.projectPreStartAdmission) {
    if (input.scope.preStartAdmission?.required) {
      throw new Error("project_control_pre_start_admission_required");
    }
    return;
  }
  await validateProjectPreStartAdmission(input);
}

export async function assertProjectPreStartAdmissionLaunchBinding(input: {
  readonly manifest: CodexGoalJobManifest;
  readonly scope: ProjectAccessScope;
  readonly expectedInputPatchArtifactSha256?: string;
  readonly workspaceMode?: ProjectPreStartAdmissionLaunchWorkspaceMode;
}): Promise<void> {
  const descriptor = input.manifest.projectPreStartAdmission;
  if (!descriptor) {
    if (
      input.scope.preStartAdmission?.required ||
      input.workspaceMode === "admitted_input_patch" ||
      input.expectedInputPatchArtifactSha256 !== undefined
    ) {
      throw new Error("project_control_pre_start_admission_required");
    }
    return;
  }
  assertDescriptorPaths(descriptor, input.manifest.jobRootDir);
  await assertArtifactRootSecure(input.manifest.jobRootDir);
  const contract = await readJsonObject(
    descriptor.contractPath,
    "contract",
    MAX_CONTRACT_BYTES,
  );
  const state = await readJsonObject(
    descriptor.statePath,
    "state",
    MAX_STATE_BYTES,
  );
  const receipt = await readJsonObject(
    descriptor.receiptPath,
    "receipt",
    64 * 1024,
  );
  assertProjectInputPatchContract({
    builtin: isBuiltinDescriptor(descriptor),
    contract,
  });
  assertContractBindings(contract, input.manifest);
  assertQueuedStateBinding(contract, state, input.manifest.jobId);
  const binding = await captureProjectPreStartBinding(
    input.manifest,
    descriptor,
  );
  const validatorReceiptValid = projectPreStartValidatorReceiptValid({
    descriptor,
    receipt,
    scope: input.scope,
  });
  const verifiedInputPatch = verifiedInputPatchFromReceipt(receipt, contract);
  const adoptionInput = isAdoptionManifest(input.manifest);
  const dirtyContinuation =
    input.workspaceMode === "reviewed_dirty_continuation" ||
    input.workspaceMode === "terminal_handoff_dependency_recovery";
  const admittedInputPatchContinuation =
    input.workspaceMode === "admitted_input_patch_continuation";
  const admittedInputPatchRuntimeContinuation =
    input.workspaceMode === "admitted_input_patch_runtime_continuation";
  const cleanCapacityContinuation =
    input.workspaceMode === "clean_capacity_continuation";
  const cleanExplicitContinuation =
    input.workspaceMode === "clean_explicit_continuation";
  const receiptStatusValid =
    adoptionInput ||
    dirtyContinuation ||
    admittedInputPatchContinuation ||
    admittedInputPatchRuntimeContinuation ||
    cleanCapacityContinuation ||
    cleanExplicitContinuation
      ? receipt.status === "launch_authorized" ||
        receipt.status === "validated_not_launched"
      : receipt.status === "validated_not_launched";
  const workspaceBindingValid =
    adoptionInput ||
    input.workspaceMode === "admitted_input_patch" ||
    admittedInputPatchContinuation ||
    admittedInputPatchRuntimeContinuation ||
    dirtyContinuation
      ? binding.workspaceStatus !== ""
      : verifiedInputPatch
        ? verifiedInputPatchBindingValid(binding, verifiedInputPatch)
        : binding.workspaceStatus === "";
  const inputPatchBindingValid = admittedInputPatchRuntimeContinuation
    ? await controlledRuntimeInputPatchBindingValid({
        manifest: input.manifest,
        descriptor,
        contract,
        binding,
        verifiedInputPatch,
      })
    : dirtyContinuation
      ? true
      : verifiedInputPatch
        ? verifiedInputPatchBindingValid(binding, verifiedInputPatch)
        : adoptionInput
          ? contract.inputPatchHash === binding.workspacePatchSha256 &&
            receipt.workspacePatchSha256 === binding.workspacePatchSha256
          : projectInputPatchBindingMatches(binding, contract);
  const mismatches = [
    binding.workspaceHead !== contract.phaseStartSha
      ? "workspace_head"
      : undefined,
    admittedInputPatchContinuation && verifiedInputPatch === undefined
      ? "input_patch_artifact"
      : undefined,
    input.expectedInputPatchArtifactSha256 !== undefined &&
    verifiedInputPatch?.artifactSha256 !==
      input.expectedInputPatchArtifactSha256
      ? "input_patch_artifact"
      : undefined,
    !inputPatchBindingValid ? "input_patch_binding" : undefined,
    !workspaceBindingValid ? "workspace_binding" : undefined,
    !receiptStatusValid ? "receipt_status" : undefined,
    receipt.jobId !== input.manifest.jobId ? "job_id" : undefined,
    receipt.workKey !== contract.workKey ? "work_key" : undefined,
    receipt.contractSha256 !== binding.contractSha256
      ? "contract_sha256"
      : undefined,
    receipt.stateSha256 !== binding.stateSha256 ? "state_sha256" : undefined,
    receipt.promptSha256 !== binding.promptSha256 ? "prompt_sha256" : undefined,
    receipt.manifestSha256 !==
    sha256(Buffer.from(JSON.stringify(input.manifest)))
      ? "manifest_sha256"
      : undefined,
    !validatorReceiptValid ? "validator_receipt" : undefined,
  ].filter((value): value is string => value !== undefined);
  if (mismatches.length > 0) {
    throw new Error(
      `project_control_pre_start_launch_binding_mismatch:${mismatches.join(",")}`,
    );
  }
}

async function controlledRuntimeInputPatchBindingValid(input: {
  readonly manifest: CodexGoalJobManifest;
  readonly descriptor: CodexGoalProjectPreStartAdmission;
  readonly contract: JsonObject;
  readonly binding: Awaited<ReturnType<typeof captureProjectPreStartBinding>>;
  readonly verifiedInputPatch:
    | ReturnType<typeof verifiedInputPatchFromReceipt>
    | undefined;
}): Promise<boolean> {
  if (!isBuiltinDescriptor(input.descriptor)) {
    return false;
  }
  const launch = parseWorkerLaunchSpec(input.contract);
  if (launch.reviewKind === "review") {
    return (
      input.verifiedInputPatch !== undefined &&
      verifiedInputPatchBindingValid(input.binding, input.verifiedInputPatch)
    );
  }
  const handoff = await readControlledRuntimeInterruptionHandoff({
    producer: input.manifest,
  });
  const ownedPaths = new Set(launch.ownedPaths);
  return (
    handoff.baseCommit === launch.phaseStartSha &&
    handoff.patchSha256 === input.binding.workspacePatchSha256 &&
    handoff.changedPaths.length > 0 &&
    handoff.changedPaths.every((path) => ownedPaths.has(path))
  );
}

export async function rebindProjectPreStartAdmissionManifest(input: {
  readonly manifest: CodexGoalJobManifest;
  readonly scope: ProjectAccessScope;
  readonly workspaceMode:
    | "clean_capacity_continuation"
    | "reviewed_dirty_continuation"
    | "admitted_input_patch_continuation";
}): Promise<{
  readonly updated: boolean;
  readonly workspaceMode: typeof input.workspaceMode;
  readonly previousManifestSha256: string;
  readonly manifestSha256: string;
}> {
  const descriptor = input.manifest.projectPreStartAdmission;
  if (!descriptor) {
    throw new Error("project_control_pre_start_admission_required");
  }
  assertDescriptorPaths(descriptor, input.manifest.jobRootDir);
  await assertArtifactRootSecure(input.manifest.jobRootDir);
  const contract = await readJsonObject(
    descriptor.contractPath,
    "contract",
    MAX_CONTRACT_BYTES,
  );
  const state = await readJsonObject(
    descriptor.statePath,
    "state",
    MAX_STATE_BYTES,
  );
  const receipt = await readJsonObject(
    descriptor.receiptPath,
    "receipt",
    64 * 1024,
  );
  assertProjectInputPatchContract({
    builtin: isBuiltinDescriptor(descriptor),
    contract,
  });
  assertContractBindings(contract, input.manifest);
  assertQueuedStateBinding(contract, state, input.manifest.jobId);
  const binding = await captureProjectPreStartBinding(
    input.manifest,
    descriptor,
  );
  const verifiedInputPatch = verifiedInputPatchFromReceipt(receipt, contract);
  const reviewedDirtyContinuation =
    input.workspaceMode === "reviewed_dirty_continuation";
  const admittedInputPatchContinuation =
    input.workspaceMode === "admitted_input_patch_continuation";
  const dirtyContinuation =
    reviewedDirtyContinuation || admittedInputPatchContinuation;
  const receiptStatusValid =
    receipt.status === "launch_authorized" ||
    receipt.status === "validated_not_launched";
  const workspaceBindingValid = dirtyContinuation
    ? binding.workspaceStatus !== ""
    : binding.workspaceStatus === "";
  const inputPatchBindingValid = reviewedDirtyContinuation
    ? true
    : admittedInputPatchContinuation
      ? verifiedInputPatch !== undefined &&
        verifiedInputPatchBindingValid(binding, verifiedInputPatch)
      : projectInputPatchBindingMatches(binding, contract);
  const mismatches = [
    binding.workspaceHead !== contract.phaseStartSha
      ? "workspace_head"
      : undefined,
    !inputPatchBindingValid ? "input_patch_binding" : undefined,
    !workspaceBindingValid ? "workspace_binding" : undefined,
    !receiptStatusValid ? "receipt_status" : undefined,
    receipt.jobId !== input.manifest.jobId ? "job_id" : undefined,
    receipt.workKey !== contract.workKey ? "work_key" : undefined,
    receipt.contractSha256 !== binding.contractSha256
      ? "contract_sha256"
      : undefined,
    receipt.stateSha256 !== binding.stateSha256 ? "state_sha256" : undefined,
    receipt.promptSha256 !== binding.promptSha256 ? "prompt_sha256" : undefined,
    !projectPreStartValidatorReceiptValid({
      descriptor,
      receipt,
      scope: input.scope,
    })
      ? "validator_receipt"
      : undefined,
  ].filter((value): value is string => value !== undefined);
  if (mismatches.length > 0) {
    throw new Error(
      `project_control_pre_start_manifest_rebind_mismatch:${mismatches.join(",")}`,
    );
  }
  const previousManifestSha256 = requiredSha256(
    receipt.manifestSha256,
    "manifestSha256",
  );
  const manifestSha256 = sha256(Buffer.from(JSON.stringify(input.manifest)));
  if (previousManifestSha256 === manifestSha256) {
    return {
      updated: false,
      workspaceMode: input.workspaceMode,
      previousManifestSha256,
      manifestSha256,
    };
  }
  await writeJsonAtomically(descriptor.receiptPath, {
    ...receipt,
    manifestSha256,
    manifestRepair: {
      previousManifestSha256,
      manifestSha256,
      repairedAt: new Date().toISOString(),
    },
  });
  return {
    updated: true,
    workspaceMode: input.workspaceMode,
    previousManifestSha256,
    manifestSha256,
  };
}

function projectPreStartValidatorReceiptValid(input: {
  readonly descriptor: CodexGoalProjectPreStartAdmission;
  readonly receipt: JsonObject;
  readonly scope: ProjectAccessScope;
}): boolean {
  if (isBuiltinDescriptor(input.descriptor)) {
    assertBuiltinScope(input.scope);
    return input.receipt.validatorKind === "builtin";
  }
  const contractValidator = configuredValidator(
    input.descriptor.contractValidatorPath,
    input.scope,
  );
  const admissionValidator = configuredValidator(
    input.descriptor.admissionValidatorPath,
    input.scope,
  );
  return (
    input.receipt.validatorKind === "external" &&
    input.receipt.contractValidatorPath ===
      input.descriptor.contractValidatorPath &&
    input.receipt.admissionValidatorPath ===
      input.descriptor.admissionValidatorPath &&
    input.receipt.contractValidatorSha256 === contractValidator.sha256 &&
    input.receipt.admissionValidatorSha256 === admissionValidator.sha256
  );
}

export async function removeProjectPreStartAdmissionPaths(
  paths: readonly string[],
): Promise<void> {
  await Promise.all(paths.map((path) => rm(path, { force: true })));
}

async function validateProjectPreStartAdmission(input: {
  readonly manifest: CodexGoalJobManifest | CodexGoalJobManifestInput;
  readonly scope: ProjectAccessScope;
  readonly verifiedInputPatch?: {
    readonly artifactSha256: string;
    readonly stagedPatchSha256: string;
  };
}): Promise<void> {
  const descriptor = input.manifest.projectPreStartAdmission;
  if (!descriptor)
    throw new Error("project_control_pre_start_admission_required");
  await assertProjectPreStartAdmissionNotAuthorized(descriptor);
  assertDescriptorPaths(descriptor, input.manifest.jobRootDir);
  await assertArtifactRootSecure(input.manifest.jobRootDir);
  const contract = await readJsonObject(
    descriptor.contractPath,
    "contract",
    MAX_CONTRACT_BYTES,
  );
  const state = await readJsonObject(
    descriptor.statePath,
    "state",
    MAX_STATE_BYTES,
  );
  assertProjectInputPatchContract({
    builtin: isBuiltinDescriptor(descriptor),
    contract,
  });
  assertContractBindings(contract, input.manifest);
  assertQueuedStateBinding(contract, state, input.manifest.jobId);
  const verifiedInputPatch =
    input.verifiedInputPatch ??
    (await readVerifiedInputPatchFromExistingReceipt(descriptor, contract));
  if (
    verifiedInputPatch &&
    verifiedInputPatch.artifactSha256 !== contract.inputPatchHash
  ) {
    throw new Error("project_control_pre_start_verified_input_patch_mismatch");
  }
  const beforeBinding = await captureProjectPreStartBinding(
    input.manifest,
    descriptor,
  );
  const adoptionInput = isAdoptionManifest(input.manifest);
  const beforeBindingValid = verifiedInputPatch
    ? verifiedInputPatchBindingValid(beforeBinding, verifiedInputPatch)
    : adoptionInput
      ? contract.inputPatchHash === beforeBinding.workspacePatchSha256
      : projectInputPatchBindingMatches(beforeBinding, contract);
  if (!beforeBindingValid) {
    if (adoptionInput) {
      throw new Error("project_control_pre_start_input_patch_hash_mismatch");
    }
    throw new Error("project_control_pre_start_workspace_dirty");
  }
  let validatorReceipt: JsonObject;
  if (isBuiltinDescriptor(descriptor)) {
    assertBuiltinScope(input.scope);
    if (beforeBinding.workspaceHead !== contract.phaseStartSha) {
      throw new Error("project_control_pre_start_workspace_head_mismatch");
    }
    await validateBuiltinWorkerLaunchSpec({
      contract,
      state,
      manifest: input.manifest,
      scope: input.scope,
    });
    validatorReceipt = {
      validatorKind: "builtin",
    };
  } else {
    const contractValidatorConfig = configuredValidator(
      descriptor.contractValidatorPath,
      input.scope,
    );
    const admissionValidatorConfig = configuredValidator(
      descriptor.admissionValidatorPath,
      input.scope,
    );
    const snapshotRoot = await snapshotValidatorBundle({
      workspacePath: input.manifest.workspacePath,
      jobRootDir: input.manifest.jobRootDir,
      scope: input.scope,
      expectedHead: requiredString(contract.phaseStartSha, "phaseStartSha"),
    });
    const contractValidator = join(
      snapshotRoot,
      descriptor.contractValidatorPath,
    );
    const admissionValidator = join(
      snapshotRoot,
      descriptor.admissionValidatorPath,
    );
    await runValidator(
      "contract",
      contractValidator,
      ["--contract", descriptor.contractPath],
      input.manifest.workspacePath,
    );
    await runValidator(
      "admission",
      admissionValidator,
      ["--contract", descriptor.contractPath, "--state", descriptor.statePath],
      input.manifest.workspacePath,
    );
    validatorReceipt = {
      validatorKind: "external",
      contractValidatorPath: descriptor.contractValidatorPath,
      admissionValidatorPath: descriptor.admissionValidatorPath,
      contractValidatorSha256: contractValidatorConfig.sha256,
      admissionValidatorSha256: admissionValidatorConfig.sha256,
    };
  }
  const afterBinding = await captureProjectPreStartBinding(
    input.manifest,
    descriptor,
  );
  const afterBindingValid = verifiedInputPatch
    ? verifiedInputPatchBindingValid(afterBinding, verifiedInputPatch)
    : adoptionInput
      ? contract.inputPatchHash === afterBinding.workspacePatchSha256
      : projectInputPatchBindingMatches(afterBinding, contract);
  if (!afterBindingValid) {
    throw new Error("project_control_pre_start_workspace_dirty");
  }
  if (JSON.stringify(beforeBinding) !== JSON.stringify(afterBinding)) {
    throw new Error(
      "project_control_pre_start_binding_changed_during_validation",
    );
  }

  const workspaceHead = afterBinding.workspaceHead;
  const receipt = {
    schemaVersion: 1,
    status: "validated_not_launched",
    jobId: input.manifest.jobId,
    workKey: contract.workKey,
    manifestSha256: sha256(Buffer.from(JSON.stringify(input.manifest))),
    ...validatorReceipt,
    contractSha256: afterBinding.contractSha256,
    stateSha256: afterBinding.stateSha256,
    promptSha256: afterBinding.promptSha256,
    ...(adoptionInput
      ? { workspacePatchSha256: afterBinding.workspacePatchSha256 }
      : {}),
    workspaceHead,
    ...(contract.merge ? { merge: contract.merge } : {}),
    ...(verifiedInputPatch
      ? {
          workspaceMode: "verified_input_patch",
          inputPatchArtifactSha256: verifiedInputPatch.artifactSha256,
          expectedWorkspaceStagedPatchSha256:
            verifiedInputPatch.stagedPatchSha256,
          workspaceStagedPatchSha256: afterBinding.workspaceStagedPatchSha256,
        }
      : {}),
    validatedAt: new Date().toISOString(),
  };
  await assertProjectPreStartAdmissionNotAuthorized(descriptor);
  await writeJsonAtomically(descriptor.receiptPath, receipt);
}

async function assertProjectPreStartAdmissionNotAuthorized(
  descriptor: CodexGoalProjectPreStartAdmission,
): Promise<void> {
  try {
    await access(descriptor.receiptPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const receipt = await readJsonObject(
    descriptor.receiptPath,
    "receipt",
    64 * 1024,
  );
  if (receipt.status === "launch_authorized") {
    throw new Error("project_control_pre_start_admission_already_authorized");
  }
}

function parseProjectPreStartAdmissionInput(
  value: unknown,
): ProjectPreStartAdmissionInput {
  if (!isObject(value))
    throw new Error("project_control_pre_start_admission_invalid");
  const builtin = value.mode === "serial-builtin";
  const allowedFields = new Set(
    builtin
      ? ["mode", "contract", "state"]
      : [
          "contractValidatorPath",
          "admissionValidatorPath",
          "contract",
          "state",
        ],
  );
  for (const field of Object.keys(value)) {
    if (!allowedFields.has(field)) {
      throw new Error(
        `project_control_pre_start_admission_unexpected_field:${field}`,
      );
    }
  }
  if (
    !isObject(value.contract) ||
    (!builtin && !isObject(value.state)) ||
    (value.state !== undefined && !isObject(value.state))
  ) {
    throw new Error(
      "project_control_pre_start_admission_json_objects_required",
    );
  }
  if (builtin) {
    return {
      mode: "serial-builtin",
      contract: value.contract,
      ...(isObject(value.state) ? { state: value.state } : {}),
    };
  }
  return {
    contractValidatorPath: requiredString(
      value.contractValidatorPath,
      "contractValidatorPath",
    ),
    admissionValidatorPath: requiredString(
      value.admissionValidatorPath,
      "admissionValidatorPath",
    ),
    contract: value.contract,
    state: value.state as JsonObject,
  };
}

function assertBuiltinScope(scope: ProjectAccessScope): void {
  if (scope.preStartAdmission?.mode !== "serial-builtin") {
    throw new Error("project_control_pre_start_serial_builtin_scope_required");
  }
}

function isBuiltinInput(
  input: ProjectPreStartAdmissionInput,
): input is Extract<
  ProjectPreStartAdmissionInput,
  { readonly mode: "serial-builtin" }
> {
  return "mode" in input && input.mode === "serial-builtin";
}

function isBuiltinDescriptor(
  descriptor: CodexGoalProjectPreStartAdmission,
): descriptor is Extract<
  CodexGoalProjectPreStartAdmission,
  { readonly mode: "serial-builtin" }
> {
  return "mode" in descriptor && descriptor.mode === "serial-builtin";
}

async function assertArtifactRootSecure(jobRootDir: string): Promise<void> {
  if ((await lstat(jobRootDir)).isSymbolicLink()) {
    throw new Error("project_control_pre_start_job_root_symlink_denied");
  }
  const admissionRoot = join(jobRootDir, ADMISSION_DIRECTORY);
  await mkdir(admissionRoot, { recursive: true, mode: 0o700 });
  if ((await lstat(admissionRoot)).isSymbolicLink()) {
    throw new Error("project_control_pre_start_artifact_root_symlink_denied");
  }
}

function isAdoptionManifest(
  manifest: CodexGoalJobManifest | CodexGoalJobManifestInput,
): boolean {
  return manifest.tags?.includes("worker-role-adoption") === true;
}

function assertDescriptorPaths(
  descriptor: CodexGoalProjectPreStartAdmission,
  jobRootDir: string,
): void {
  const root = join(jobRootDir, ADMISSION_DIRECTORY);
  const expected = {
    contractPath: join(root, "contract.json"),
    statePath: join(root, "state.json"),
    receiptPath: join(root, "receipt.json"),
  };
  for (const [field, path] of Object.entries(expected)) {
    if (descriptor[field as keyof typeof expected] !== path) {
      throw new Error(`project_control_pre_start_${field}_invalid`);
    }
  }
}

function assertContractBindings(
  contract: JsonObject,
  manifest: CodexGoalJobManifest | CodexGoalJobManifestInput,
): void {
  const bindings: ReadonlyArray<readonly [string, unknown]> = [
    ["jobId", manifest.jobId],
    ["jobRoot", manifest.jobRootDir],
    ["workspaceRoot", manifest.workspacePath],
    ["promptPath", manifest.promptPath],
    ["registryStatus", "queued"],
  ];
  for (const [field, expected] of bindings) {
    if (contract[field] !== expected) {
      throw new Error(`project_control_pre_start_contract_${field}_mismatch`);
    }
  }
}

function assertQueuedStateBinding(
  contract: JsonObject,
  state: JsonObject,
  jobId: string,
): void {
  if (!Array.isArray(state.records)) {
    throw new Error("project_control_pre_start_state_records_required");
  }
  if (state.maxInFlight !== 1 || state.records.length !== MAX_STATE_RECORDS) {
    throw new Error("project_control_pre_start_serial_state_required");
  }
  const matching = state.records.filter(
    (record) => isObject(record) && record.workKey === contract.workKey,
  );
  const record = matching[0];
  if (matching.length !== 1 || !record || record.status !== "queued") {
    throw new Error(
      "project_control_pre_start_state_single_queued_match_required",
    );
  }
  if (record.jobId !== jobId) {
    throw new Error("project_control_pre_start_state_jobId_mismatch");
  }
  for (const field of [
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
  ]) {
    if (record[field] !== contract[field]) {
      throw new Error(`project_control_pre_start_state_${field}_mismatch`);
    }
  }
}

async function readJsonObject(
  path: string,
  label: string,
  maxBytes: number,
): Promise<JsonObject> {
  try {
    const value: unknown = JSON.parse(
      await readBoundedFile(path, maxBytes, label),
    );
    if (!isObject(value)) throw new Error("not_object");
    return value;
  } catch {
    throw new Error(`project_control_pre_start_${label}_invalid`);
  }
}

async function writeJsonArtifact(
  path: string,
  value: JsonObject,
  maxBytes: number,
): Promise<boolean> {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  try {
    const existing = await readBoundedFile(path, maxBytes, "artifact");
    if (existing !== body) {
      throw new Error("project_control_pre_start_existing_artifact_mismatch");
    }
    return false;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "project_control_pre_start_existing_artifact_mismatch"
    ) {
      throw error;
    }
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    await writeFile(path, body, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return true;
  }
}

async function writeJsonAtomically(
  path: string,
  value: JsonObject,
): Promise<void> {
  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporaryPath, path);
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertSerializedSize(
  label: string,
  value: JsonObject,
  maxBytes: number,
): void {
  let bytes: number;
  try {
    bytes = Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`);
  } catch {
    throw new Error(`project_control_pre_start_${label}_not_serializable`);
  }
  if (bytes > maxBytes) {
    throw new Error(`project_control_pre_start_${label}_size_limit_exceeded`);
  }
}

async function readBoundedFile(
  path: string,
  maxBytes: number,
  label: string,
): Promise<string> {
  const bytes = await readFile(path);
  if (bytes.byteLength > maxBytes) {
    throw new Error(`project_control_pre_start_${label}_size_limit_exceeded`);
  }
  return bytes.toString("utf8");
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`project_control_pre_start_${field}_required`);
  }
  return value;
}

function requiredSha256(value: unknown, field: string): string {
  const parsed = requiredString(value, field).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(parsed)) {
    throw new Error(`project_control_pre_start_${field}_invalid`);
  }
  return parsed;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
