import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import {
  ProjectDebtReason,
  ProjectOperation,
  type ProjectAccessScope,
  type ProjectAdmissionRequest,
  type ProjectAdmissionSnapshot,
} from "@vioxen/subscription-runtime/worker-core";
import type {
  CodexGoalJobManifest,
  CodexGoalJobSummary,
} from "../../codex-goal-jobs";
import {
  parseWorkerLaunchSpec,
  type WorkerLaunchSpec,
} from "./worker-launch-spec";
import { assertProjectPreStartAdmissionLaunchBinding } from "./codex-goal-project-pre-start-admission";
import {
  validateBuiltinWorkerLaunchSpec,
  workerLaunchSpecHasOwnershipBoundWorkKey,
} from "./codex-goal-project-builtin-pre-start-admission";
import { captureProjectPreStartBinding } from "./codex-goal-project-pre-start-binding";
import { workerLaunchOwnsChangedPath } from "./worker-launch-spec";

type JsonObject = Readonly<Record<string, unknown>>;
type PendingInputPatchBinding = {
  readonly jobId: string;
  readonly workspacePath: string;
};

const MAX_CONTRACT_BYTES = 256 * 1024;
const MAX_STATE_BYTES = 1024 * 1024;
const MAX_RECEIPT_BYTES = 64 * 1024;

export async function withAdmittedInputPatchOwnership(input: {
  readonly snapshot: ProjectAdmissionSnapshot;
  readonly request: ProjectAdmissionRequest;
  readonly binding: PendingInputPatchBinding | undefined;
}): Promise<ProjectAdmissionRequest> {
  const { binding, request } = input;
  if (
    request.ownedPaths !== undefined ||
    !binding ||
    request.operation !== ProjectOperation.StartWorker ||
    request.jobId !== binding.jobId ||
    !request.workspacePath ||
    !await workspacePathsMatch(request.workspacePath, binding.workspacePath)
  ) {
    return request;
  }
  const selfDebt = input.snapshot.debt.find((item) =>
    item.reason === ProjectDebtReason.ActiveWriterConflict &&
    item.subject === binding.jobId &&
    item.pathDisjointProducerEligible === true &&
    item.affectedPaths !== undefined &&
    item.evidence.includes(
      "broker-admitted input patch is validated and pending start",
    )
  );
  return selfDebt?.affectedPaths
    ? { ...request, ownedPaths: selfDebt.affectedPaths }
    : request;
}

export function withoutDisjointHeldOutputBypass(
  snapshot: ProjectAdmissionSnapshot,
): ProjectAdmissionSnapshot {
  return {
    ...snapshot,
    debt: snapshot.debt.map((item) => {
      if (item.reason !== ProjectDebtReason.UnconsumedCompletedJob) return item;
      const { affectedPaths: _affectedPaths, ...blockingDebt } = item;
      return blockingDebt;
    }),
  };
}

export async function pendingAdmittedInputPatchPathEvidence(input: {
  readonly item: JsonObject;
  readonly summary: CodexGoalJobSummary | undefined;
  readonly workerAlive: boolean;
  readonly duplicateWorkspaceIdentity: boolean;
  readonly registryRootDir: string;
  readonly scope: ProjectAccessScope;
  readonly readJob?: (input: {
    readonly registryRootDir: string;
    readonly jobId: string;
  }) => Promise<CodexGoalJobManifest>;
}): Promise<
  | {
      readonly affectedPaths: readonly string[];
      readonly pathDisjointProducerEligible: true;
    }
  | undefined
> {
  const { item, summary } = input;
  if (
    input.workerAlive ||
    item.activeWriterRisk !== "dirty_workspace_without_worker" ||
    item.workspaceConflict === true ||
    input.duplicateWorkspaceIdentity ||
    !summary ||
    !strictProducerRole(summary.tags) ||
    !input.readJob
  ) {
    return undefined;
  }
  try {
    const manifest = await input.readJob({
      registryRootDir: input.registryRootDir,
      jobId: summary.jobId,
    });
    if (
      manifest.jobId !== summary.jobId ||
      !strictProducerRole(manifest.tags ?? []) ||
      !(await workspacePathsMatch(
        manifest.workspacePath,
        summary.workspacePath,
      ))
    ) {
      return undefined;
    }
    const affectedPaths = await readOwnershipBoundAdmittedInputPatchPaths({
      manifest,
      scope: input.scope,
    });
    if (!affectedPaths) {
      throw new Error(
        "project_control_pre_start_validated_input_patch_binding_required",
      );
    }
    return {
      affectedPaths,
      pathDisjointProducerEligible: true,
    };
  } catch {
    return undefined;
  }
}

/**
 * Reads ownership from a broker-validated immutable input patch that has not
 * started yet. Only an exact validated_not_launched receipt and verified
 * staged patch are accepted, so ordinary inactive dirty workspaces never gain
 * pending-writer status.
 */
async function readOwnershipBoundAdmittedInputPatchPaths(input: {
  readonly manifest: CodexGoalJobManifest;
  readonly scope: ProjectAccessScope;
}): Promise<readonly string[] | undefined> {
  const launch = await readValidatedInputPatchWorkerLaunchSpec(input);
  if (!workerLaunchSpecHasOwnershipBoundWorkKey(launch)) return undefined;
  const descriptor = input.manifest.projectPreStartAdmission;
  if (!descriptor) return undefined;
  const binding = await captureProjectPreStartBinding(
    input.manifest,
    descriptor,
  );
  if (
    binding.workspaceStagedPaths.length === 0 ||
    !binding.workspaceStagedPaths.every((path) =>
      workerLaunchOwnsChangedPath(launch, path)
    )
  ) {
    return undefined;
  }
  await assertProjectPreStartAdmissionLaunchBinding({
    manifest: input.manifest,
    scope: input.scope,
    workspaceMode: "admitted_input_patch",
  });
  return [...new Set([
    ...launch.ownedPaths,
    ...binding.workspaceStagedPaths,
  ])].sort();
}

async function readValidatedInputPatchWorkerLaunchSpec(input: {
  readonly manifest: CodexGoalJobManifest;
  readonly scope: ProjectAccessScope;
}): Promise<WorkerLaunchSpec> {
  const descriptor = input.manifest.projectPreStartAdmission;
  if (
    !descriptor ||
    !("mode" in descriptor) ||
    descriptor.mode !== "serial-builtin"
  ) {
    throw new Error(
      "project_control_pre_start_builtin_validated_input_patch_required",
    );
  }
  await assertProjectPreStartAdmissionLaunchBinding({
    manifest: input.manifest,
    scope: input.scope,
    workspaceMode: "admitted_input_patch",
  });
  const [contractBefore, receiptBefore] = await Promise.all([
    readJsonArtifact(descriptor.contractPath, MAX_CONTRACT_BYTES),
    readJsonArtifact(descriptor.receiptPath, MAX_RECEIPT_BYTES),
  ]);
  if (
    receiptBefore.value.status !== "validated_not_launched" ||
    receiptBefore.value.workspaceMode !== "verified_input_patch"
  ) {
    throw new Error(
      "project_control_pre_start_validated_input_patch_receipt_required",
    );
  }
  await assertProjectPreStartAdmissionLaunchBinding({
    manifest: input.manifest,
    scope: input.scope,
    workspaceMode: "admitted_input_patch",
  });
  const [contractAfter, receiptAfter, state] = await Promise.all([
    readJsonArtifact(descriptor.contractPath, MAX_CONTRACT_BYTES),
    readJsonArtifact(descriptor.receiptPath, MAX_RECEIPT_BYTES),
    readJsonArtifact(descriptor.statePath, MAX_STATE_BYTES),
  ]);
  if (
    !contractBefore.raw.equals(contractAfter.raw) ||
    !receiptBefore.raw.equals(receiptAfter.raw)
  ) {
    throw new Error(
      "project_control_pre_start_attestation_changed_during_read",
    );
  }
  await validateBuiltinWorkerLaunchSpec({
    contract: contractAfter.value,
    state: state.value,
    manifest: input.manifest,
    scope: input.scope,
  });
  const launch = parseWorkerLaunchSpec(contractAfter.value);
  if (launch.inputPatchHash === null) {
    throw new Error(
      "project_control_pre_start_validated_input_patch_binding_required",
    );
  }
  return launch;
}

async function readJsonArtifact(
  path: string,
  maxBytes: number,
): Promise<{ readonly raw: Buffer; readonly value: JsonObject }> {
  const body = await readFile(path);
  if (body.byteLength > maxBytes) throw new Error("size_limit_exceeded");
  const value: unknown = JSON.parse(body.toString("utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("json_object_required");
  }
  return { raw: body, value: value as JsonObject };
}

function strictProducerRole(tags: readonly string[]): boolean {
  const roleTags = tags.filter((tag) => tag.startsWith("worker-role-"));
  return roleTags.length === 1 && roleTags[0] === "worker-role-producer";
}

async function workspacePathsMatch(
  left: string,
  right: string,
): Promise<boolean> {
  return (
    ((await optionalRealPath(left)) ?? resolve(left)) ===
    ((await optionalRealPath(right)) ?? resolve(right))
  );
}

async function optionalRealPath(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch {
    return undefined;
  }
}
