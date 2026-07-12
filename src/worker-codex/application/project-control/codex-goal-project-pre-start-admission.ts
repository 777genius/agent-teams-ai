import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
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
import { validateBuiltinWorkerStartV1 } from "./codex-goal-project-builtin-pre-start-admission";

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
      readonly contractSchema: "worker-start-v1";
      readonly contract: JsonObject;
      readonly state: JsonObject;
    };

export type PlannedProjectPreStartAdmission = {
  readonly descriptor: CodexGoalProjectPreStartAdmission;
  readonly contract: JsonObject;
  readonly state: JsonObject;
};

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
    assertBuiltinScope(input.scope, parsed.contractSchema);
  } else {
    configuredValidator(parsed.contractValidatorPath, input.scope);
    configuredValidator(parsed.admissionValidatorPath, input.scope);
  }
  assertSerializedSize("contract", parsed.contract, MAX_CONTRACT_BYTES);
  assertSerializedSize("state", parsed.state, MAX_STATE_BYTES);
  if (parsed.state.maxInFlight !== 1) {
    throw new Error("project_control_pre_start_serial_maxInFlight_expected_1");
  }
  if (!Array.isArray(parsed.state.records) || parsed.state.records.length !== 1) {
    throw new Error("project_control_pre_start_serial_single_record_required");
  }
  assertContractBindings(parsed.contract, input.manifest);
  const root = join(input.manifest.jobRootDir, ADMISSION_DIRECTORY);
  return {
    descriptor: isBuiltinInput(parsed)
      ? {
          schemaVersion: 1,
          mode: "serial-builtin",
          contractSchema: parsed.contractSchema,
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
    contract: parsed.contract,
    state: parsed.state,
  };
}

export async function prepareProjectPreStartAdmission(input: {
  readonly plan: PlannedProjectPreStartAdmission;
  readonly manifest: CodexGoalJobManifestInput;
  readonly scope: ProjectAccessScope;
}): Promise<{ readonly createdPaths: readonly string[] }> {
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
}): Promise<void> {
  const descriptor = input.manifest.projectPreStartAdmission;
  if (!descriptor) {
    if (input.scope.preStartAdmission?.required) {
      throw new Error("project_control_pre_start_admission_required");
    }
    return;
  }
  await assertArtifactRootSecure(input.manifest.jobRootDir);
  const contract = await readJsonObject(descriptor.contractPath, "contract", MAX_CONTRACT_BYTES);
  const state = await readJsonObject(descriptor.statePath, "state", MAX_STATE_BYTES);
  const receipt = await readJsonObject(descriptor.receiptPath, "receipt", 64 * 1024);
  assertContractBindings(contract, input.manifest);
  assertQueuedStateBinding(contract, state, input.manifest.jobId);
  const binding = await currentBinding(input.manifest, descriptor);
  const builtinReceiptValid = !isBuiltinDescriptor(descriptor) ||
    (receipt.validatorKind === "builtin" &&
      receipt.contractSchema === descriptor.contractSchema);
  if (
    binding.workspaceHead !== contract.phaseStartSha ||
    receipt.status !== "validated_not_launched" ||
    receipt.jobId !== input.manifest.jobId ||
    receipt.workKey !== contract.workKey ||
    receipt.contractSha256 !== binding.contractSha256 ||
    receipt.stateSha256 !== binding.stateSha256 ||
    receipt.promptSha256 !== binding.promptSha256 ||
    !builtinReceiptValid
  ) {
    throw new Error("project_control_pre_start_launch_binding_mismatch");
  }
}

export async function removeProjectPreStartAdmissionPaths(
  paths: readonly string[],
): Promise<void> {
  await Promise.all(paths.map((path) => rm(path, { force: true })));
}

async function validateProjectPreStartAdmission(input: {
  readonly manifest: CodexGoalJobManifest | CodexGoalJobManifestInput;
  readonly scope: ProjectAccessScope;
}): Promise<void> {
  const descriptor = input.manifest.projectPreStartAdmission;
  if (!descriptor)
    throw new Error("project_control_pre_start_admission_required");
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
  assertContractBindings(contract, input.manifest);
  assertQueuedStateBinding(contract, state, input.manifest.jobId);
  const beforeBinding = await currentBinding(input.manifest, descriptor);
  let validatorReceipt: JsonObject;
  if (isBuiltinDescriptor(descriptor)) {
    assertBuiltinScope(input.scope, descriptor.contractSchema);
    if (beforeBinding.workspaceHead !== contract.phaseStartSha) {
      throw new Error("project_control_pre_start_workspace_head_mismatch");
    }
    await validateBuiltinWorkerStartV1({
      contract,
      state,
      manifest: input.manifest,
      scope: input.scope,
    });
    validatorReceipt = {
      validatorKind: "builtin",
      contractSchema: descriptor.contractSchema,
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
    validatedAt: new Date().toISOString(),
  };
  await writeJsonAtomically(descriptor.receiptPath, receipt);
}

function parseProjectPreStartAdmissionInput(
  value: unknown,
): ProjectPreStartAdmissionInput {
  if (!isObject(value))
    throw new Error("project_control_pre_start_admission_invalid");
  const builtin = value.mode === "serial-builtin";
  const allowedFields = new Set(builtin
    ? ["mode", "contractSchema", "contract", "state"]
    : ["contractValidatorPath", "admissionValidatorPath", "contract", "state"]);
  for (const field of Object.keys(value)) {
    if (!allowedFields.has(field)) {
      throw new Error(
        `project_control_pre_start_admission_unexpected_field:${field}`,
      );
    }
  }
  if (!isObject(value.contract) || !isObject(value.state)) {
    throw new Error(
      "project_control_pre_start_admission_json_objects_required",
    );
  }
  if (builtin) {
    if (value.contractSchema !== "worker-start-v1") {
      throw new Error("project_control_pre_start_contractSchema_invalid");
    }
    return {
      mode: "serial-builtin",
      contractSchema: "worker-start-v1",
      contract: value.contract,
      state: value.state,
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
    state: value.state,
  };
}

function assertBuiltinScope(
  scope: ProjectAccessScope,
  contractSchema: "worker-start-v1",
): void {
  if (
    scope.preStartAdmission?.mode !== "serial-builtin" ||
    scope.preStartAdmission.contractSchema !== contractSchema
  ) {
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
  return {
    workspaceHead,
    contractSha256: sha256(Buffer.from(await readBoundedFile(descriptor.contractPath, MAX_CONTRACT_BYTES, "contract"))),
    stateSha256: sha256(Buffer.from(await readBoundedFile(descriptor.statePath, MAX_STATE_BYTES, "state"))),
    promptSha256: sha256(Buffer.from(await readBoundedFile(manifest.promptPath, MAX_PROMPT_BYTES, "prompt"))),
  };
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

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
