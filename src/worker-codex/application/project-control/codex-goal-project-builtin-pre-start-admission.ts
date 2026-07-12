import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, normalize, relative, resolve, sep } from "node:path";
import type { ProjectAccessScope } from "@vioxen/subscription-runtime/worker-core";
import type {
  CodexGoalJobManifest,
  CodexGoalJobManifestInput,
} from "../../codex-goal-jobs";

type JsonObject = Readonly<Record<string, unknown>>;

const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const PHASE_ID = /^phase-[0-9]{2}$/;
const LANE_ID = /^[a-z][a-z0-9-]*$/;
const SIMPLE_ID = /^[a-z0-9][a-z0-9._-]*$/;
const WORK_KEY_FIELDS = [
  "phaseId",
  "laneId",
  "baseSha",
  "phaseStartSha",
  "packetRevision",
  "inputPatchHash",
  "reviewKind",
  "revision",
] as const;
const STATE_IDENTITY_FIELDS = [
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
const AUTO_CONTRACT_FIELDS = [
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
] as const;

export function materializeBuiltinWorkerStartV1(input: {
  readonly contract: JsonObject;
  readonly state?: JsonObject;
  readonly manifest: CodexGoalJobManifest | CodexGoalJobManifestInput;
}): { readonly contract: JsonObject; readonly state: JsonObject } {
  const fullyMaterialized = AUTO_CONTRACT_FIELDS.every((field) => field in input.contract) &&
    input.state !== undefined;
  if (fullyMaterialized) {
    return { contract: input.contract, state: input.state as JsonObject };
  }
  const expectedBindings: JsonObject = {
    jobId: input.manifest.jobId,
    workerId: input.manifest.jobId,
    registryStatus: "queued",
    jobRoot: input.manifest.jobRootDir,
    workspaceRoot: input.manifest.workspacePath,
    promptPath: input.manifest.promptPath,
    revision: 0,
    retryCount: 0,
    supersedes: null,
  };
  for (const [field, expected] of Object.entries(expectedBindings)) {
    if (field in input.contract && input.contract[field] !== expected) {
      fail(`materialization_${field}_mismatch`);
    }
  }
  const withoutWorkKey: JsonObject = { ...input.contract, ...expectedBindings };
  const workKey = computeWorkerStartWorkKey(withoutWorkKey);
  if ("workKey" in input.contract && input.contract.workKey !== workKey) {
    fail("materialization_workKey_mismatch");
  }
  const contract: JsonObject = { ...withoutWorkKey, workKey };
  const record = Object.fromEntries([
    ...STATE_IDENTITY_FIELDS.map((field) => [field, contract[field]]),
    ["status", "queued"],
    ["supersededBy", null],
    ["supersededFrom", null],
  ]);
  const state: JsonObject = {
    schemaVersion: 1,
    maxRetries: 0,
    maxInFlight: 1,
    records: [record],
  };
  if (input.state !== undefined && JSON.stringify(input.state) !== JSON.stringify(state)) {
    fail("materialization_state_mismatch");
  }
  return { contract, state };
}

export async function validateBuiltinWorkerStartV1(input: {
  readonly contract: JsonObject;
  readonly state: JsonObject;
  readonly manifest: CodexGoalJobManifest | CodexGoalJobManifestInput;
  readonly scope: ProjectAccessScope;
}): Promise<void> {
  assertWorkerStartContract(input.contract);
  assertSerialState(input.contract, input.state);
  await assertWorkerStartFilesystem(input.contract, input.manifest, input.scope);
}

function assertWorkerStartContract(contract: JsonObject): void {
  assertExactKeys(contract, [
    "schemaVersion",
    "jobId",
    "workerId",
    "canonicalSha",
    "baseSha",
    "phaseStartSha",
    "packetRevision",
    "controllerPacket",
    "lanePacket",
    "phaseId",
    "laneId",
    "inputPatchHash",
    "reviewKind",
    "revision",
    "retryCount",
    "workKey",
    "supersedes",
    "registryStatus",
    "jobRoot",
    "workspaceRoot",
    "promptPath",
    "ownedPaths",
    "mandatoryDocs",
    "mandatoryScripts",
    "mandatoryFixtures",
    "requiredChecks",
    "executionPolicy",
  ], "contract");
  if (contract.schemaVersion !== 1) fail("contract_schemaVersion_expected_1");
  assertPattern(contract.jobId, SIMPLE_ID, "contract_jobId_invalid");
  assertPattern(contract.workerId, SIMPLE_ID, "contract_workerId_invalid");
  assertPattern(contract.canonicalSha, SHA1, "contract_canonicalSha_invalid");
  assertPattern(contract.baseSha, SHA1, "contract_baseSha_invalid");
  assertPattern(contract.phaseStartSha, SHA1, "contract_phaseStartSha_invalid");
  assertPattern(contract.packetRevision, SIMPLE_ID, "contract_packetRevision_invalid");
  assertRelativePath(contract.controllerPacket, "contract_controllerPacket_invalid");
  assertRelativePath(contract.lanePacket, "contract_lanePacket_invalid");
  assertPattern(contract.phaseId, PHASE_ID, "contract_phaseId_invalid");
  assertPattern(contract.laneId, LANE_ID, "contract_laneId_invalid");
  assertPattern(contract.inputPatchHash, SHA256, "contract_inputPatchHash_invalid");
  if (!["implementation", "review", "remediation"].includes(String(contract.reviewKind))) {
    fail("contract_reviewKind_invalid");
  }
  assertNonNegativeInteger(contract.revision, "contract_revision_invalid");
  assertNonNegativeInteger(contract.retryCount, "contract_retryCount_invalid");
  assertPattern(contract.workKey, SHA256, "contract_workKey_invalid");
  if (contract.supersedes !== null) {
    assertPattern(contract.supersedes, SHA256, "contract_supersedes_invalid");
  }
  if (contract.registryStatus !== "queued") fail("contract_registryStatus_not_queued");
  // Builtin admission is intentionally serial-initial-only. Safe remediation/refill
  // requires the future transactional shared work-key ledger.
  if (
    contract.reviewKind === "remediation" ||
    contract.revision !== 0 ||
    contract.retryCount !== 0 ||
    contract.supersedes !== null
  ) {
    fail("contract_serial_initial_only");
  }
  const expectedWorkKey = computeWorkerStartWorkKey(contract);
  if (contract.workKey !== expectedWorkKey) fail("contract_workKey_mismatch");

  const ownedPaths = assertPathList(contract.ownedPaths, "contract_ownedPaths");
  const mandatoryDocs = assertPathList(contract.mandatoryDocs, "contract_mandatoryDocs");
  assertPathList(contract.mandatoryScripts, "contract_mandatoryScripts", true);
  assertPathList(contract.mandatoryFixtures, "contract_mandatoryFixtures", true);
  if (ownedPaths.length === 0 || mandatoryDocs.length === 0) {
    fail("contract_path_list_empty");
  }
  for (const packet of [contract.controllerPacket, contract.lanePacket]) {
    if (typeof packet === "string" && !mandatoryDocs.includes(packet)) {
      fail("contract_mandatoryDocs_missing_packet");
    }
  }
  assertRequiredChecks(contract.requiredChecks);
  assertExecutionPolicy(contract.executionPolicy);
}

function computeWorkerStartWorkKey(contract: JsonObject): string {
  return sha256(JSON.stringify(Object.fromEntries(
    WORK_KEY_FIELDS.map((field) => [field, contract[field]]),
  )));
}

function assertSerialState(contract: JsonObject, state: JsonObject): void {
  assertExactKeys(state, ["schemaVersion", "maxRetries", "maxInFlight", "records"], "state");
  if (state.schemaVersion !== 1) fail("state_schemaVersion_expected_1");
  assertNonNegativeInteger(state.maxRetries, "state_maxRetries_invalid");
  if (state.maxInFlight !== 1) fail("serial_maxInFlight_expected_1");
  if (!Array.isArray(state.records) || state.records.length !== 1) {
    fail("serial_single_record_required");
  }
  const record = state.records[0];
  if (!isObject(record)) fail("state_record_object_required");
  assertExactKeys(record, [
    ...STATE_IDENTITY_FIELDS,
    "status",
    "supersededBy",
    "supersededFrom",
  ], "state_record", new Set(["supersededBy", "supersededFrom"]));
  if (record.status !== "queued") fail("state_record_not_queued");
  if (record.supersededBy !== undefined && record.supersededBy !== null) {
    fail("state_record_has_successor");
  }
  if (record.supersededFrom !== undefined && record.supersededFrom !== null) {
    fail("state_record_has_terminal_metadata");
  }
  for (const field of STATE_IDENTITY_FIELDS) {
    if (record[field] !== contract[field]) fail(`state_${field}_mismatch`);
  }
  if (
    typeof state.maxRetries === "number" &&
    typeof record.retryCount === "number" &&
    record.retryCount > state.maxRetries
  ) {
    fail("state_maxRetries_exceeded");
  }
}

async function assertWorkerStartFilesystem(
  contract: JsonObject,
  manifest: CodexGoalJobManifest | CodexGoalJobManifestInput,
  scope: ProjectAccessScope,
): Promise<void> {
  const workspace = await realpath(manifest.workspacePath);
  const jobRoot = await realpath(manifest.jobRootDir);
  const prompt = await realpath(manifest.promptPath);
  if (!inside(jobRoot, prompt)) fail("prompt_outside_jobRoot");
  if (inside(workspace, prompt)) fail("prompt_inside_workspace");
  if (inside(jobRoot, workspace) || inside(workspace, jobRoot)) fail("job_workspace_overlap");

  const executionPolicy = contract.executionPolicy as JsonObject;
  const sandboxRoot = await realpath(requiredString(executionPolicy.sandboxRoot, "sandboxRoot"));
  if (!inside(workspace, sandboxRoot)) fail("sandbox_outside_workspace");
  if (inside(jobRoot, sandboxRoot) || inside(sandboxRoot, jobRoot)) fail("sandbox_jobRoot_overlap");

  for (const field of ["mandatoryDocs", "mandatoryScripts", "mandatoryFixtures"] as const) {
    for (const path of contract[field] as readonly string[]) {
      const resolved = await realpath(resolve(workspace, path));
      if (!inside(workspace, resolved) || !(await stat(resolved)).isFile()) {
        fail(`${field}_unsafe_or_missing`);
      }
    }
  }
  for (const check of contract.requiredChecks as readonly JsonObject[]) {
    const cwd = await realpath(resolve(workspace, requiredString(check.cwd, "requiredChecks.cwd")));
    if (!inside(workspace, cwd) || !(await stat(cwd)).isDirectory()) {
      fail("requiredChecks_cwd_unsafe_or_missing");
    }
  }

  const forbiddenRoots = [
    ...(executionPolicy.forbiddenRealProjects as readonly string[]),
    ...(scope.deniedRoots ?? []),
  ].map((path) => resolve(expandHome(path)));
  for (const forbidden of forbiddenRoots) {
    for (const candidate of [jobRoot, workspace, prompt, sandboxRoot]) {
      if (inside(forbidden, candidate) || inside(candidate, forbidden)) {
        fail("forbidden_root_overlap");
      }
    }
  }
}

function assertRequiredChecks(value: unknown): void {
  if (!Array.isArray(value) || value.length === 0) fail("contract_requiredChecks_empty");
  const ids = new Set<string>();
  for (const check of value) {
    if (!isObject(check)) fail("contract_requiredCheck_object_required");
    assertExactKeys(check, ["id", "cwd", "command"], "requiredCheck");
    assertPattern(check.id, SIMPLE_ID, "contract_requiredCheck_id_invalid");
    assertRelativePath(check.cwd, "contract_requiredCheck_cwd_invalid");
    const command = requiredString(check.command, "requiredCheck.command");
    if (command.trim() !== command) fail("contract_requiredCheck_command_invalid");
    if (ids.has(check.id as string)) fail("contract_requiredCheck_duplicate_id");
    ids.add(check.id as string);
  }
}

function assertExecutionPolicy(value: unknown): void {
  if (!isObject(value)) fail("contract_executionPolicy_object_required");
  assertExactKeys(value, ["mode", "sandboxRoot", "forbiddenRealProjects"], "executionPolicy");
  if (value.mode !== "sandbox-only") fail("contract_executionPolicy_mode_invalid");
  if (typeof value.sandboxRoot !== "string" || !isAbsolute(value.sandboxRoot)) {
    fail("contract_sandboxRoot_absolute_required");
  }
  if (
    !Array.isArray(value.forbiddenRealProjects) ||
    value.forbiddenRealProjects.length === 0 ||
    !value.forbiddenRealProjects.every((entry) => typeof entry === "string" && entry.length > 0) ||
    new Set(value.forbiddenRealProjects).size !== value.forbiddenRealProjects.length
  ) {
    fail("contract_forbiddenRealProjects_invalid");
  }
}

function assertPathList(
  value: unknown,
  label: string,
  allowEmpty = false,
): readonly string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) fail(`${label}_empty`);
  const paths = value as unknown[];
  for (const path of paths) assertRelativePath(path, `${label}_invalid`);
  if (new Set(paths).size !== paths.length) fail(`${label}_duplicate`);
  return paths as readonly string[];
}

function assertExactKeys(
  value: JsonObject,
  allowed: readonly string[],
  label: string,
  optional = new Set<string>(),
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${label}_unexpected_field_${key}`);
  }
  for (const key of allowed) {
    if (!optional.has(key) && !(key in value)) fail(`${label}_missing_field_${key}`);
  }
}

function assertPattern(value: unknown, pattern: RegExp, error: string): void {
  if (typeof value !== "string" || !pattern.test(value)) fail(error);
}

function assertRelativePath(value: unknown, error: string): void {
  if (
    typeof value !== "string" || !value || isAbsolute(value) || value.includes("\\") ||
    normalize(value) !== value || value === "." || value === ".." || value.startsWith(`..${sep}`)
  ) {
    fail(error);
  }
}

function assertNonNegativeInteger(value: unknown, error: string): void {
  if (!Number.isInteger(value) || (value as number) < 0) fail(error);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) fail(`${field}_required`);
  return value as string;
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith(`~${sep}`) || path.startsWith("~/")) {
    return resolve(homedir(), path.slice(2));
  }
  return path;
}

function inside(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation === "" ||
    (!relation.startsWith(`..${sep}`) && relation !== ".." &&
      !isAbsolute(relation));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(code: string): never {
  throw new Error(`project_control_pre_start_builtin_${code}`);
}
