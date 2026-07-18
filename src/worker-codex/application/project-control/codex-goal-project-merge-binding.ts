import type {
  MergeIntegrationPlan,
  ProjectAccessScope,
} from "@vioxen/subscription-runtime/worker-core";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  materializePinnedRemoteCommit,
  resolveCanonicalRemoteHead,
  resolveCanonicalRemoteWorktreeSource,
} from "./codex-goal-project-git";
import {
  resolveProjectSourceRevision,
  type ResolvedProjectSourceRevision,
} from "./codex-goal-project-source-revision";

export type ProjectMergeBindingRequest = {
  readonly sourceRemote: string;
  readonly sourceBranch: string;
};

export function parseProjectMergeBindingRequest(input: {
  readonly value: unknown;
  readonly admission: unknown;
  readonly requireCanonicalRemoteHead: boolean;
  readonly expectedSourceCommit: unknown;
}): ProjectMergeBindingRequest | undefined {
  if (input.value === undefined) {
    if (projectAdmissionHasCallerMerge(input.admission)) {
      throw new Error("project_control_merge_binding_runtime_owned");
    }
    return undefined;
  }
  if (!isObject(input.value)) {
    throw new Error("project_control_merge_binding_invalid");
  }
  const fields = Object.keys(input.value);
  if (fields.some((field) => field !== "sourceRemote" && field !== "sourceBranch")) {
    throw new Error("project_control_merge_binding_invalid");
  }
  if (!input.requireCanonicalRemoteHead) {
    throw new Error("project_control_merge_binding_canonical_head_required");
  }
  if (input.expectedSourceCommit !== undefined) {
    throw new Error("project_control_merge_binding_expected_source_conflict");
  }
  if (typeof input.value.sourceRemote !== "string" || !input.value.sourceRemote) {
    throw new Error("mergeBinding.sourceRemote is required");
  }
  if (typeof input.value.sourceBranch !== "string" || !input.value.sourceBranch) {
    throw new Error("mergeBinding.sourceBranch is required");
  }
  return {
    sourceRemote: input.value.sourceRemote,
    sourceBranch: input.value.sourceBranch,
  };
}

export async function finalizeProjectMergeBoundSource(input: {
  readonly binding: ProjectMergeBindingRequest | undefined;
  readonly jobRootDir: string;
  readonly admission: unknown;
  readonly resolvedSource: { readonly revision: string; readonly sourceRealPath: string };
  readonly scope: ProjectAccessScope;
  readonly targetRemoteTrackingRef: string;
  readonly expectedSourceCommit?: string;
  readonly requireRemoteHead: boolean;
}): Promise<{
  readonly merge?: MergeIntegrationPlan;
  readonly sourceRevision: ResolvedProjectSourceRevision;
  readonly admission: unknown;
  readonly promptSuffix: string;
}> {
  if (!input.binding) {
    return {
      sourceRevision: await resolveProjectSourceRevision({
        resolvedSource: input.resolvedSource,
        remoteTrackingRef: input.targetRemoteTrackingRef,
        scope: input.scope,
        ...(input.expectedSourceCommit
          ? { expectedSourceCommit: input.expectedSourceCommit }
          : {}),
        requireRemoteHead: input.requireRemoteHead,
      }),
      admission: input.admission,
      promptSuffix: "",
    };
  }
  const existing = await readExistingProjectMergeBinding(input.jobRootDir);
  if (
    existing &&
    (existing.sourceRemote !== input.binding.sourceRemote ||
      existing.sourceBranch !== input.binding.sourceBranch)
  ) {
    throw new Error("project_control_merge_binding_retry_mismatch");
  }
  const merge =
    existing ??
    (await resolveProjectMergeBinding({
      workspacePath: input.resolvedSource.sourceRealPath,
      scope: input.scope,
      targetRemoteTrackingRef: input.targetRemoteTrackingRef,
      binding: input.binding,
    }));
  const separator = input.targetRemoteTrackingRef.indexOf("/");
  const remote = input.targetRemoteTrackingRef.slice(0, separator);
  const branch = input.targetRemoteTrackingRef.slice(separator + 1);
  return {
    merge,
    sourceRevision: {
      revision: merge.expectedTargetCommit,
      sourceRealPath: input.resolvedSource.sourceRealPath,
      pinned: true,
      remoteHead: {
        remote,
        branch,
        fullRef: `refs/heads/${branch}`,
        oid: merge.expectedTargetCommit,
      },
    },
    admission: bindProjectMergeAdmission({ admission: input.admission, merge }),
    promptSuffix: projectMergePromptBinding(merge),
  };
}

export async function resolveProjectMergeBinding(input: {
  readonly workspacePath: string;
  readonly scope: ProjectAccessScope;
  readonly targetRemoteTrackingRef: string;
  readonly binding: ProjectMergeBindingRequest;
}): Promise<MergeIntegrationPlan> {
  const source = resolveCanonicalRemoteWorktreeSource({
    requestedRef: `${input.binding.sourceRemote}/${input.binding.sourceBranch}`,
    scope: input.scope,
  });
  const targetObserved = await resolveCanonicalRemoteHead({
    workspacePath: input.workspacePath,
    remoteTrackingRef: input.targetRemoteTrackingRef,
  });
  await materializePinnedRemoteCommit({
    workspacePath: input.workspacePath,
    remoteTrackingRef: input.targetRemoteTrackingRef,
    expectedCommit: targetObserved.oid,
  });
  const sourceObserved = await resolveCanonicalRemoteHead({
    workspacePath: input.workspacePath,
    remoteTrackingRef: source.remoteTrackingRef,
  });
  await materializePinnedRemoteCommit({
    workspacePath: input.workspacePath,
    remoteTrackingRef: source.remoteTrackingRef,
    expectedCommit: sourceObserved.oid,
  });
  const [targetConfirmed, sourceConfirmed] = await Promise.all([
    resolveCanonicalRemoteHead({
      workspacePath: input.workspacePath,
      remoteTrackingRef: input.targetRemoteTrackingRef,
    }),
    resolveCanonicalRemoteHead({
      workspacePath: input.workspacePath,
      remoteTrackingRef: source.remoteTrackingRef,
    }),
  ]);
  if (targetConfirmed.oid !== targetObserved.oid) {
    throw new Error("project_control_merge_binding_target_changed");
  }
  if (sourceConfirmed.oid !== sourceObserved.oid) {
    throw new Error("project_control_merge_binding_source_changed");
  }
  if (sourceConfirmed.oid === targetConfirmed.oid) {
    throw new Error("project_control_merge_binding_distinct_parents_required");
  }
  return {
    sourceRemote: sourceConfirmed.remote,
    sourceBranch: sourceConfirmed.branch,
    sourceCommit: sourceConfirmed.oid,
    expectedTargetCommit: targetConfirmed.oid,
  };
}

export async function readExistingProjectMergeBinding(
  jobRootDir: string,
): Promise<MergeIntegrationPlan | undefined> {
  let value: unknown;
  try {
    value = JSON.parse(
      await readFile(
        join(jobRootDir, "pre-start-admission", "contract.json"),
        "utf8",
      ),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("project_control_merge_binding_existing_contract_invalid");
  }
  if (!isObject(value) || value.merge === undefined) return undefined;
  if (!isObject(value.merge)) {
    throw new Error("project_control_merge_binding_existing_contract_invalid");
  }
  const merge = value.merge;
  if (
    typeof merge.sourceRemote !== "string" ||
    typeof merge.sourceBranch !== "string" ||
    typeof merge.sourceCommit !== "string" ||
    typeof merge.expectedTargetCommit !== "string"
  ) {
    throw new Error("project_control_merge_binding_existing_contract_invalid");
  }
  return {
    sourceRemote: merge.sourceRemote,
    sourceBranch: merge.sourceBranch,
    sourceCommit: merge.sourceCommit,
    expectedTargetCommit: merge.expectedTargetCommit,
  };
}

export function bindProjectMergeAdmission(input: {
  readonly admission: unknown;
  readonly merge: MergeIntegrationPlan;
}): unknown {
  if (input.merge.sourceCommit === input.merge.expectedTargetCommit) {
    throw new Error("project_control_merge_binding_distinct_parents_required");
  }
  if (!isObject(input.admission) || input.admission.mode !== "serial-builtin") {
    throw new Error("project_control_merge_binding_builtin_admission_required");
  }
  if (!isObject(input.admission.contract)) {
    throw new Error("project_control_merge_binding_contract_required");
  }
  if (input.admission.contract.phaseStartSha !== undefined) {
    throw new Error(
      "project_control_merge_binding_phaseStartSha_must_be_omitted",
    );
  }
  if (input.admission.contract.canonicalSha !== undefined) {
    throw new Error(
      "project_control_merge_binding_canonicalSha_must_be_omitted",
    );
  }
  if (input.admission.contract.merge !== undefined) {
    throw new Error("project_control_merge_binding_merge_override_denied");
  }
  return {
    ...input.admission,
    contract: {
      ...input.admission.contract,
      canonicalSha: input.merge.expectedTargetCommit,
      phaseStartSha: input.merge.expectedTargetCommit,
      merge: input.merge,
    },
  };
}

export function projectMergePromptBinding(merge: MergeIntegrationPlan): string {
  return [
    "",
    "<!-- subscription-runtime:merge-binding -->",
    "Immutable merge binding admitted by ProjectScopedControl:",
    `- target commit: ${merge.expectedTargetCommit}`,
    `- source remote: ${merge.sourceRemote}`,
    `- source branch: ${merge.sourceBranch}`,
    `- source commit: ${merge.sourceCommit}`,
    "Do not re-resolve or substitute either commit.",
    "<!-- /subscription-runtime:merge-binding -->",
    "",
  ].join("\n");
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function projectAdmissionHasCallerMerge(value: unknown): boolean {
  if (!isObject(value) || !isObject(value.contract)) return false;
  return "merge" in value.contract;
}
