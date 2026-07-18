import { createHash } from "node:crypto";

import type {
  ReviewedWorkerOutputSnapshot,
  ReviewedWorkerOutputStorePort,
} from "../../reviewed-worker-output";
import { resolveReviewedWorkerOutput } from "../../reviewed-worker-output";
import { MAX_STAGED_PATCH_BYTES } from "./codex-goal-project-git";

const MAX_REVIEWED_OUTPUTS = 10;

export type ReviewedOutputAggregateComponent = {
  readonly reviewedOutputId: string;
  readonly workerJobId: string;
  readonly patchSha256: string;
  readonly patchByteLength: number;
  readonly changedFiles: readonly string[];
};

export type ReviewedOutputAggregate = {
  readonly format: "reviewed-output-aggregate";
  readonly formatRevision: 1;
  readonly reviewedOutputIds: readonly string[];
  readonly baseCommit: string;
  readonly changedFiles: readonly string[];
  readonly components: readonly ReviewedOutputAggregateComponent[];
  readonly patch: string;
  readonly patchSha256: string;
  readonly patchByteLength: number;
  readonly provenanceSha256: string;
};

export type ReviewedOutputAggregateDeps = {
  readonly store: ReviewedWorkerOutputStorePort;
  readonly readPatch: (
    snapshot: ReviewedWorkerOutputSnapshot,
  ) => Promise<string>;
};

export async function resolveReviewedOutputAggregate(
  deps: ReviewedOutputAggregateDeps,
  input: {
    readonly projectId: string;
    readonly reviewedOutputIds: readonly string[];
    readonly expectedBaseCommit?: string;
  },
): Promise<ReviewedOutputAggregate> {
  const reviewedOutputIds = normalizeReviewedOutputIds(input.reviewedOutputIds);
  const snapshots: ReviewedWorkerOutputSnapshot[] = [];
  const patches: string[] = [];
  const owners = new Map<string, string>();
  let baseCommit: string | undefined;

  for (const reviewedOutputId of reviewedOutputIds) {
    const { snapshot } = await resolveReviewedWorkerOutput({
      store: deps.store,
      projectId: input.projectId,
      reviewedOutputId,
    });
    if (baseCommit === undefined) baseCommit = snapshot.baseCommit;
    if (snapshot.baseCommit !== baseCommit) {
      throw new Error("reviewed_output_aggregate_base_commit_mismatch");
    }
    for (const changedFile of snapshot.changedFiles) {
      const owner = owners.get(changedFile);
      if (owner) {
        throw new Error(
          `reviewed_output_aggregate_changed_file_overlap:${changedFile}`,
        );
      }
      owners.set(changedFile, reviewedOutputId);
    }
    const patch = await deps.readPatch(snapshot);
    if (sha256(patch) !== snapshot.patchSha256) {
      throw new Error("reviewed_output_aggregate_patch_hash_mismatch");
    }
    if (Buffer.byteLength(patch) !== snapshot.patchByteLength) {
      throw new Error("reviewed_output_aggregate_patch_size_mismatch");
    }
    snapshots.push(snapshot);
    patches.push(patch.endsWith("\n") ? patch : `${patch}\n`);
  }

  if (!baseCommit) throw new Error("reviewed_output_aggregate_empty");
  if (
    input.expectedBaseCommit !== undefined &&
    baseCommit !== input.expectedBaseCommit.toLowerCase()
  ) {
    throw new Error("reviewed_output_aggregate_target_commit_mismatch");
  }

  const patch = patches.join("");
  const patchByteLength = Buffer.byteLength(patch);
  if (patchByteLength > MAX_STAGED_PATCH_BYTES) {
    throw new Error("reviewed_output_aggregate_patch_size_limit_exceeded");
  }
  const patchSha256 = sha256(patch);
  const components = snapshots.map((snapshot) => ({
    reviewedOutputId: snapshot.reviewedOutputId,
    workerJobId: snapshot.workerJobId,
    patchSha256: snapshot.patchSha256,
    patchByteLength: snapshot.patchByteLength,
    changedFiles: snapshot.changedFiles,
  }));
  const provenance = {
    format: "reviewed-output-aggregate" as const,
    formatRevision: 1 as const,
    reviewedOutputIds,
    baseCommit,
    changedFiles: [...owners.keys()].sort(),
    components,
    patchSha256,
    patchByteLength,
  };
  return {
    ...provenance,
    patch,
    provenanceSha256: sha256(`${JSON.stringify(provenance)}\n`),
  };
}

export function reviewedOutputAggregateView(
  aggregate: ReviewedOutputAggregate,
): Omit<ReviewedOutputAggregate, "patch"> {
  const { patch: _patch, ...view } = aggregate;
  return view;
}

function normalizeReviewedOutputIds(
  values: readonly string[],
): readonly string[] {
  if (values.length === 0) throw new Error("reviewed_output_aggregate_empty");
  if (values.length > MAX_REVIEWED_OUTPUTS) {
    throw new Error("reviewed_output_aggregate_limit_exceeded");
  }
  const normalized = values.map((value) => {
    const result = value.trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(result)) {
      throw new Error("reviewed_output_aggregate_id_invalid");
    }
    return result;
  });
  if (new Set(normalized).size !== normalized.length) {
    throw new Error("reviewed_output_aggregate_duplicate_id");
  }
  return normalized;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
