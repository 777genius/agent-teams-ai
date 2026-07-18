import { createHash } from "node:crypto";

type JsonObject = Readonly<Record<string, unknown>>;

export function assertProjectRefillInputPatchSource(input: {
  readonly contract: JsonObject | undefined;
  readonly producerJobId: string | undefined;
  readonly reviewedOutputId?: string | undefined;
  readonly workerRole: string;
}): void {
  const producerJobId = input.producerJobId?.trim();
  const reviewedOutputId = input.reviewedOutputId?.trim();
  const inputPatchHash = input.contract?.inputPatchHash;
  if (inputPatchHash === null || inputPatchHash === undefined) {
    if (producerJobId || reviewedOutputId) {
      throw new Error("project_control_refill_input_patch_hash_required");
    }
    return;
  }
  if (!producerJobId) {
    throw new Error("project_control_refill_input_patch_source_required");
  }
  if (input.workerRole !== "producer" && input.workerRole !== "adoption") {
    throw new Error("project_control_refill_input_patch_producer_role_required");
  }
  if (reviewedOutputId) {
    if (input.workerRole !== "producer") {
      throw new Error(
        "project_control_refill_reviewed_output_producer_role_required",
      );
    }
    if (input.contract?.reviewKind !== "remediation") {
      throw new Error(
        "project_control_refill_reviewed_output_remediation_required",
      );
    }
  }
}

export function assertProjectInputPatchContract(input: {
  readonly builtin: boolean;
  readonly contract: JsonObject;
}): void {
  if (input.contract.inputPatchHash !== null) return;
  if (
    !input.builtin ||
    (input.contract.reviewKind !== "implementation" &&
      input.contract.reviewKind !== "review") ||
    input.contract.revision !== 0 ||
    input.contract.retryCount !== 0 ||
    input.contract.supersedes !== null
  ) {
    throw new Error("project_control_pre_start_input_patch_hash_required");
  }
}

export function projectInputPatchBindingMatches(
  binding: {
    readonly workspaceStatus: string;
    readonly workspaceStagedPatchSha256: string;
    readonly workspaceUnstagedDirty: boolean;
  },
  contract: JsonObject,
): boolean {
  const inputPatchHash = contract.inputPatchHash;
  const emptyPatchHash = createHash("sha256").update(Buffer.alloc(0)).digest("hex");
  if (inputPatchHash === null) {
    return binding.workspaceStatus === "" &&
      binding.workspaceStagedPatchSha256 === emptyPatchHash;
  }
  if (typeof inputPatchHash !== "string" || !/^[0-9a-f]{64}$/.test(inputPatchHash)) {
    return false;
  }
  if (inputPatchHash === emptyPatchHash) {
    return binding.workspaceStatus === "" &&
      binding.workspaceStagedPatchSha256 === emptyPatchHash;
  }
  return binding.workspaceStatus !== "" &&
    !binding.workspaceUnstagedDirty &&
    binding.workspaceStagedPatchSha256 === inputPatchHash;
}
