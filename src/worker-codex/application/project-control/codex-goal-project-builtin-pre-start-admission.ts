import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ProjectAccessScope } from "@vioxen/subscription-runtime/worker-core";
import type {
  CodexGoalJobManifest,
  CodexGoalJobManifestInput,
} from "../../codex-goal-jobs";
import {
  parseWorkerLaunchRequest,
  parseWorkerLaunchSpec,
  parseWorkerLaunchState,
  type WorkerLaunchSpec,
  type WorkerLaunchState,
} from "./worker-launch-spec";

type JsonObject = Readonly<Record<string, unknown>>;

const WORK_KEY_FIELDS = [
  "kind",
  "format",
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

export function materializeBuiltinWorkerLaunchSpec(input: {
  readonly contract: JsonObject;
  readonly state?: JsonObject;
  readonly manifest: CodexGoalJobManifest | CodexGoalJobManifestInput;
}): { readonly contract: JsonObject; readonly state: JsonObject } {
  const requestedContract = parseWorkerLaunchRequest(input.contract) as JsonObject;
  const fullyMaterialized = AUTO_CONTRACT_FIELDS.every(
    (field) => field in requestedContract,
  ) &&
    input.state !== undefined;
  if (fullyMaterialized) {
    return {
      contract: parseWorkerLaunchSpec(requestedContract),
      state: parseWorkerLaunchState(input.state),
    };
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
    if (field in requestedContract && requestedContract[field] !== expected) {
      fail(`materialization_${field}_mismatch`);
    }
  }
  const withoutWorkKey: JsonObject = { ...requestedContract, ...expectedBindings };
  const workKey = computeWorkerLaunchWorkKey(withoutWorkKey);
  if ("workKey" in requestedContract && requestedContract.workKey !== workKey) {
    fail("materialization_workKey_mismatch");
  }
  const contract = parseWorkerLaunchSpec({ ...withoutWorkKey, workKey });
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
  return { contract, state: parseWorkerLaunchState(state) };
}

export async function validateBuiltinWorkerLaunchSpec(input: {
  readonly contract: JsonObject;
  readonly state: JsonObject;
  readonly manifest: CodexGoalJobManifest | CodexGoalJobManifestInput;
  readonly scope: ProjectAccessScope;
}): Promise<void> {
  const contract = parseWorkerLaunchSpec(input.contract);
  const state = parseWorkerLaunchState(input.state);
  assertSerialState(contract, state, {
    allowRemediation: isAdoptionManifest(input.manifest),
  });
  await assertWorkerLaunchFilesystem(contract, input.manifest, input.scope);
}

function assertSerialState(
  contract: WorkerLaunchSpec,
  state: WorkerLaunchState,
  options: { readonly allowRemediation: boolean },
): void {
  // Builtin admission remains serial-initial-only. Adoption is the only remediation
  // entry because its exact dirty patch is bound by the pre-start receipt.
  if (
    (contract.reviewKind === "remediation" && !options.allowRemediation) ||
    contract.revision !== 0 ||
    contract.retryCount !== 0 ||
    contract.supersedes !== null
  ) {
    fail("contract_serial_initial_only");
  }
  const expectedWorkKey = computeWorkerLaunchWorkKey(contract);
  if (contract.workKey !== expectedWorkKey) fail("contract_workKey_mismatch");

  const record = state.records[0];
  if (!record) fail("state_record_missing");
  if (record.supersededBy !== undefined && record.supersededBy !== null) {
    fail("state_record_has_successor");
  }
  if (record.supersededFrom !== undefined && record.supersededFrom !== null) {
    fail("state_record_has_terminal_metadata");
  }
  for (const field of STATE_IDENTITY_FIELDS) {
    if (record[field] !== contract[field]) fail(`state_${field}_mismatch`);
  }
  if (record.retryCount > state.maxRetries) {
    fail("state_maxRetries_exceeded");
  }
}

function isAdoptionManifest(
  manifest: CodexGoalJobManifest | CodexGoalJobManifestInput,
): boolean {
  return manifest.tags?.includes("worker-role-adoption") === true;
}

function computeWorkerLaunchWorkKey(
  contract: Readonly<Record<string, unknown>>,
): string {
  return sha256(JSON.stringify(Object.fromEntries(
    WORK_KEY_FIELDS.map((field) => [field, contract[field]]),
  )));
}

async function assertWorkerLaunchFilesystem(
  contract: WorkerLaunchSpec,
  manifest: CodexGoalJobManifest | CodexGoalJobManifestInput,
  scope: ProjectAccessScope,
): Promise<void> {
  const workspace = await realpath(manifest.workspacePath);
  const jobRoot = await realpath(manifest.jobRootDir);
  const prompt = await realpath(manifest.promptPath);
  if (!inside(jobRoot, prompt)) fail("prompt_outside_jobRoot");
  if (inside(workspace, prompt)) fail("prompt_inside_workspace");
  if (inside(jobRoot, workspace) || inside(workspace, jobRoot)) fail("job_workspace_overlap");

  const executionPolicy = contract.executionPolicy;
  const sandboxRoot = await realpath(executionPolicy.sandboxRoot);
  if (!inside(workspace, sandboxRoot)) fail("sandbox_outside_workspace");
  if (inside(jobRoot, sandboxRoot) || inside(sandboxRoot, jobRoot)) fail("sandbox_jobRoot_overlap");

  for (const field of ["mandatoryDocs", "mandatoryScripts", "mandatoryFixtures"] as const) {
    for (const path of contract[field]) {
      const resolved = await realpath(resolve(workspace, path));
      if (!inside(workspace, resolved) || !(await stat(resolved)).isFile()) {
        fail(`${field}_unsafe_or_missing`);
      }
    }
  }
  for (const check of contract.requiredChecks) {
    const cwd = await realpath(resolve(workspace, check.cwd));
    if (!inside(workspace, cwd) || !(await stat(cwd)).isDirectory()) {
      fail("requiredChecks_cwd_unsafe_or_missing");
    }
  }

  const forbiddenRoots = [
    ...executionPolicy.forbiddenRealProjects,
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

function fail(code: string): never {
  throw new Error(`project_control_pre_start_builtin_${code}`);
}
