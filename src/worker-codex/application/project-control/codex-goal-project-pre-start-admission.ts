import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  lstat,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
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
import {
  assertProjectInputPatchContract,
  projectInputPatchBindingMatches,
} from "./codex-goal-project-input-patch-policy";
import { stagedPatchSha256 } from "./codex-goal-project-git";

const execFileAsync = promisify(execFile);
const ADMISSION_DIRECTORY = "pre-start-admission";
const VALIDATOR_TIMEOUT_MS = 60_000;
const MAX_CONTRACT_BYTES = 256 * 1024;
const MAX_STATE_BYTES = 1024 * 1024;
const MAX_STATE_RECORDS = 1;
const MAX_VALIDATOR_BYTES = 2 * 1024 * 1024;
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
  if (!Array.isArray(materialized.state.records) || materialized.state.records.length !== 1) {
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

export type ProjectPreStartAdmissionDirtyContinuationMode =
  "reviewed_dirty_continuation" | "terminal_handoff_dependency_recovery";

export async function assertProjectPreStartAdmissionLaunchBinding(input: {
  readonly manifest: CodexGoalJobManifest;
  readonly scope: ProjectAccessScope;
  readonly expectedInputPatchArtifactSha256?: string;
  readonly workspaceMode?:
    | "clean_first_launch"
    | "admitted_input_patch"
    | ProjectPreStartAdmissionDirtyContinuationMode;
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
  const contract = await readJsonObject(descriptor.contractPath, "contract", MAX_CONTRACT_BYTES);
  const state = await readJsonObject(descriptor.statePath, "state", MAX_STATE_BYTES);
  const receipt = await readJsonObject(descriptor.receiptPath, "receipt", 64 * 1024);
  assertProjectInputPatchContract({
    builtin: isBuiltinDescriptor(descriptor),
    contract,
  });
  assertContractBindings(contract, input.manifest);
  assertQueuedStateBinding(contract, state, input.manifest.jobId);
  const binding = await currentBinding(input.manifest, descriptor);
  const validatorReceiptValid = projectPreStartValidatorReceiptValid({
    descriptor,
    receipt,
    scope: input.scope,
  });
  const verifiedInputPatch = verifiedInputPatchFromReceipt(receipt, contract);
  const dirtyContinuation =
    input.workspaceMode === "reviewed_dirty_continuation" ||
    input.workspaceMode === "terminal_handoff_dependency_recovery";
  const expectedReceiptStatus = dirtyContinuation
    ? "launch_authorized"
    : "validated_not_launched";
  const workspaceBindingValid =
    input.workspaceMode === "admitted_input_patch" || dirtyContinuation
      ? binding.workspaceStatus !== ""
      : verifiedInputPatch
      ? verifiedInputPatchBindingValid(binding, verifiedInputPatch)
      : binding.workspaceStatus === "";
  const inputPatchBindingValid =
    dirtyContinuation ||
    (verifiedInputPatch
      ? verifiedInputPatchBindingValid(binding, verifiedInputPatch)
      : projectInputPatchBindingMatches(binding, contract));
  if (
    binding.workspaceHead !== contract.phaseStartSha ||
    (input.expectedInputPatchArtifactSha256 !== undefined &&
      verifiedInputPatch?.artifactSha256 !==
        input.expectedInputPatchArtifactSha256) ||
    !inputPatchBindingValid ||
    !workspaceBindingValid ||
    receipt.status !== expectedReceiptStatus ||
    receipt.jobId !== input.manifest.jobId ||
    receipt.workKey !== contract.workKey ||
    receipt.contractSha256 !== binding.contractSha256 ||
    receipt.stateSha256 !== binding.stateSha256 ||
    receipt.promptSha256 !== binding.promptSha256 ||
    receipt.manifestSha256 !== sha256(Buffer.from(JSON.stringify(input.manifest))) ||
    !validatorReceiptValid
  ) {
    throw new Error("project_control_pre_start_launch_binding_mismatch");
  }
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
  return input.receipt.validatorKind === "external" &&
    input.receipt.contractValidatorPath === input.descriptor.contractValidatorPath &&
    input.receipt.admissionValidatorPath === input.descriptor.admissionValidatorPath &&
    input.receipt.contractValidatorSha256 === contractValidator.sha256 &&
    input.receipt.admissionValidatorSha256 === admissionValidator.sha256;
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
  const verifiedInputPatch = input.verifiedInputPatch ??
    await readVerifiedInputPatchFromExistingReceipt(descriptor, contract);
  if (
    verifiedInputPatch &&
    verifiedInputPatch.artifactSha256 !== contract.inputPatchHash
  ) {
    throw new Error("project_control_pre_start_verified_input_patch_mismatch");
  }
  const beforeBinding = await currentBinding(input.manifest, descriptor);
  if (
    verifiedInputPatch
      ? !verifiedInputPatchBindingValid(beforeBinding, verifiedInputPatch)
      : !projectInputPatchBindingMatches(beforeBinding, contract)
  ) {
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
    const contractValidator = join(snapshotRoot, descriptor.contractValidatorPath);
    const admissionValidator = join(snapshotRoot, descriptor.admissionValidatorPath);
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
  const afterBinding = await currentBinding(input.manifest, descriptor);
  if (
    verifiedInputPatch
      ? !verifiedInputPatchBindingValid(afterBinding, verifiedInputPatch)
      : !projectInputPatchBindingMatches(afterBinding, contract)
  ) {
    throw new Error("project_control_pre_start_workspace_dirty");
  }
  if (JSON.stringify(beforeBinding) !== JSON.stringify(afterBinding)) {
    throw new Error("project_control_pre_start_binding_changed_during_validation");
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
    workspaceHead,
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
  const allowedFields = new Set(builtin
    ? ["mode", "contract", "state"]
    : ["contractValidatorPath", "admissionValidatorPath", "contract", "state"]);
  for (const field of Object.keys(value)) {
    if (!allowedFields.has(field)) {
      throw new Error(
        `project_control_pre_start_admission_unexpected_field:${field}`,
      );
    }
  }
  if (!isObject(value.contract) || (!builtin && !isObject(value.state)) ||
    (value.state !== undefined && !isObject(value.state))) {
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
): input is Extract<ProjectPreStartAdmissionInput, { readonly mode: "serial-builtin" }> {
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

function configuredValidator(
  path: string,
  scope: ProjectAccessScope,
): { readonly path: string; readonly sha256: string } {
  assertNormalizedRelativePath(path);
  if (scope.preStartAdmission?.mode !== "serial") {
    throw new Error("project_control_pre_start_serial_mode_required");
  }
  const configured = scope.preStartAdmission.validatorBundle.find(
    (candidate) => candidate.path === path,
  );
  if (!configured) {
    throw new Error(`project_control_pre_start_validator_not_allowed:${path}`);
  }
  return configured;
}

function assertNormalizedRelativePath(path: string): void {
  if (
    !path ||
    isAbsolute(path) ||
    path.includes("\\") ||
    normalize(path) !== path ||
    path === "." ||
    path === ".." ||
    path.startsWith(`..${sep}`)
  ) {
    throw new Error("project_control_pre_start_validator_path_invalid");
  }
}

async function snapshotValidatorBundle(input: {
  readonly workspacePath: string;
  readonly jobRootDir: string;
  readonly scope: ProjectAccessScope;
  readonly expectedHead: string;
}): Promise<string> {
  const workspace = await realpath(input.workspacePath);
  const bundle = input.scope.preStartAdmission?.mode === "serial"
    ? input.scope.preStartAdmission.validatorBundle
    : [];
  if (bundle.length < 2) {
    throw new Error("project_control_pre_start_validator_bundle_required");
  }
  const paths = bundle.map(({ path }) => path);
  await assertWorkspaceBinding(workspace, input.expectedHead, paths);
  const snapshotRoot = join(input.jobRootDir, ADMISSION_DIRECTORY, "validator-bundle");
  await mkdir(snapshotRoot, { recursive: true, mode: 0o700 });
  if ((await lstat(snapshotRoot)).isSymbolicLink()) {
    throw new Error("project_control_pre_start_validator_snapshot_symlink_denied");
  }
  const canonicalSnapshotRoot = await realpath(snapshotRoot);
  for (const configured of bundle) {
    assertNormalizedRelativePath(configured.path);
    const source = await realpath(resolve(workspace, configured.path));
    const relationToWorkspace = relative(workspace, source);
    if (relationToWorkspace.startsWith(`..${sep}`) || isAbsolute(relationToWorkspace)) {
      throw new Error("project_control_pre_start_validator_outside_workspace");
    }
    const bytes = await readFile(source);
    if (bytes.byteLength > MAX_VALIDATOR_BYTES || sha256(bytes) !== configured.sha256) {
      throw new Error("project_control_pre_start_validator_digest_mismatch");
    }
    const destination = join(snapshotRoot, configured.path);
    await mkdir(resolve(destination, ".."), { recursive: true, mode: 0o700 });
    const canonicalParent = await realpath(resolve(destination, ".."));
    const parentRelation = relative(canonicalSnapshotRoot, canonicalParent);
    if (parentRelation.startsWith(`..${sep}`) || isAbsolute(parentRelation)) {
      throw new Error("project_control_pre_start_validator_snapshot_escape");
    }
    try {
      await writeFile(destination, bytes, { mode: 0o500, flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if ((await lstat(destination)).isSymbolicLink()) {
        throw new Error("project_control_pre_start_validator_snapshot_symlink_denied");
      }
      if (sha256(await readFile(destination)) !== configured.sha256) {
        throw new Error("project_control_pre_start_validator_snapshot_mismatch");
      }
    }
  }
  await assertWorkspaceBinding(workspace, input.expectedHead, paths);
  return snapshotRoot;
}

async function assertWorkspaceBinding(
  workspace: string,
  expectedHead: string,
  paths: readonly string[],
): Promise<void> {
  const head = (await execFileAsync("git", ["-C", workspace, "rev-parse", "HEAD"], {
    encoding: "utf8",
    timeout: VALIDATOR_TIMEOUT_MS,
  })).stdout.trim();
  if (head !== expectedHead) throw new Error("project_control_pre_start_workspace_head_mismatch");
  const status = (await execFileAsync("git", ["-C", workspace, "status", "--porcelain", "--", ...paths], {
    encoding: "utf8",
    timeout: VALIDATOR_TIMEOUT_MS,
  })).stdout.trim();
  if (status) throw new Error("project_control_pre_start_validator_bundle_dirty");
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

async function currentBinding(
  manifest: CodexGoalJobManifest | CodexGoalJobManifestInput,
  descriptor: CodexGoalProjectPreStartAdmission,
) {
  const workspaceHead = (await execFileAsync("git", ["-C", manifest.workspacePath, "rev-parse", "HEAD"], {
    encoding: "utf8",
    timeout: VALIDATOR_TIMEOUT_MS,
  })).stdout.trim();
  const workspaceStatus = (await execFileAsync(
    "git",
    ["-C", manifest.workspacePath, "status", "--porcelain", "--untracked-files=all"],
    { encoding: "utf8", timeout: VALIDATOR_TIMEOUT_MS },
  )).stdout.trim();
  const workspaceStagedPatchSha256 = await stagedPatchSha256(
    manifest.workspacePath,
  );
  const workspaceUnstagedPaths = (await execFileAsync(
    "git",
    ["-C", manifest.workspacePath, "diff", "--name-only", "-z", "--"],
    { encoding: "utf8", timeout: VALIDATOR_TIMEOUT_MS },
  )).stdout;
  const workspaceUntrackedPaths = (await execFileAsync(
    "git",
    ["-C", manifest.workspacePath, "ls-files", "--others", "--exclude-standard", "-z"],
    { encoding: "utf8", timeout: VALIDATOR_TIMEOUT_MS },
  )).stdout;
  return {
    workspaceHead,
    workspaceStatus,
    workspaceStagedPatchSha256,
    workspaceUnstagedDirty:
      workspaceUnstagedPaths.length > 0 || workspaceUntrackedPaths.length > 0,
    contractSha256: sha256(Buffer.from(await readBoundedFile(descriptor.contractPath, MAX_CONTRACT_BYTES, "contract"))),
    stateSha256: sha256(Buffer.from(await readBoundedFile(descriptor.statePath, MAX_STATE_BYTES, "state"))),
    promptSha256: sha256(Buffer.from(await readBoundedFile(manifest.promptPath, MAX_PROMPT_BYTES, "prompt"))),
  };
}

type VerifiedInputPatchBinding = {
  readonly artifactSha256: string;
  readonly stagedPatchSha256: string;
};

function verifiedInputPatchBindingValid(
  binding: Awaited<ReturnType<typeof currentBinding>>,
  verifiedInputPatch: VerifiedInputPatchBinding,
): boolean {
  return /^[0-9a-f]{64}$/.test(verifiedInputPatch.artifactSha256) &&
    /^[0-9a-f]{64}$/.test(verifiedInputPatch.stagedPatchSha256) &&
    binding.workspaceStatus !== "" &&
    !binding.workspaceUnstagedDirty &&
    binding.workspaceStagedPatchSha256 === verifiedInputPatch.stagedPatchSha256;
}

async function readVerifiedInputPatchFromExistingReceipt(
  descriptor: CodexGoalProjectPreStartAdmission,
  contract: JsonObject,
): Promise<VerifiedInputPatchBinding | undefined> {
  let receipt: JsonObject;
  try {
    receipt = await readJsonObject(descriptor.receiptPath, "receipt", 64 * 1024);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (
      error instanceof Error &&
      error.message === "project_control_pre_start_receipt_invalid"
    ) {
      try {
        await access(descriptor.receiptPath);
      } catch (accessError) {
        if ((accessError as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      }
    }
    throw error;
  }
  return verifiedInputPatchFromReceipt(receipt, contract);
}

function verifiedInputPatchFromReceipt(
  receipt: JsonObject,
  contract: JsonObject,
): VerifiedInputPatchBinding | undefined {
  if (receipt.workspaceMode !== "verified_input_patch") return undefined;
  const artifactSha256 = requiredSha256(
    receipt.inputPatchArtifactSha256,
    "inputPatchArtifactSha256",
  );
  const stagedPatchSha256 = requiredSha256(
    receipt.workspaceStagedPatchSha256,
    "workspaceStagedPatchSha256",
  );
  if (receipt.expectedWorkspaceStagedPatchSha256 === undefined) {
    throw new Error(
      "project_control_pre_start_verified_input_patch_receipt_migration_required",
    );
  }
  const expectedStagedPatchSha256 = requiredSha256(
    receipt.expectedWorkspaceStagedPatchSha256,
    "expectedWorkspaceStagedPatchSha256",
  );
  if (artifactSha256 !== requiredSha256(contract.inputPatchHash, "inputPatchHash")) {
    throw new Error("project_control_pre_start_verified_input_patch_mismatch");
  }
  if (stagedPatchSha256 !== expectedStagedPatchSha256) {
    throw new Error("project_control_pre_start_verified_input_patch_mismatch");
  }
  return { artifactSha256, stagedPatchSha256: expectedStagedPatchSha256 };
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

async function runValidator(
  kind: "contract" | "admission",
  validatorPath: string,
  args: readonly string[],
  cwd: string,
): Promise<void> {
  try {
    await execFileAsync(process.execPath, [validatorPath, ...args], {
      cwd,
      encoding: "utf8",
      timeout: VALIDATOR_TIMEOUT_MS,
      maxBuffer: 256 * 1024,
    });
  } catch {
    throw new Error(`project_control_pre_start_${kind}_validation_failed`);
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
