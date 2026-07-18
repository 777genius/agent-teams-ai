import { isAbsolute, normalize, sep } from "node:path";
import { z } from "zod";

const sha1Schema = z.string().regex(/^[0-9a-f]{40}$/, {
  error: "contract_git_revision_invalid",
});
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, {
  error: "contract_digest_invalid",
});
const simpleIdSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/, {
  error: "contract_identifier_invalid",
});
const phaseIdSchema = z.string().regex(/^phase-[0-9]{2}$/, {
  error: "contract_phaseId_invalid",
});
const laneIdSchema = z.string().regex(/^[a-z][a-z0-9-]*$/, {
  error: "contract_laneId_invalid",
});
const nonNegativeIntegerSchema = z.number().int().nonnegative();
const mergeIntegrationPlanSchema = z
  .object({
    sourceRemote: z.string().min(1),
    sourceBranch: z.string().min(1),
    sourceCommit: sha1Schema,
    expectedTargetCommit: sha1Schema,
  })
  .strict();

const relativePathSchema = z.string().check((context) => {
  const value = context.value;
  if (
    !value ||
    isAbsolute(value) ||
    value.includes("\\") ||
    normalize(value) !== value ||
    value === "." ||
    value === ".." ||
    value.startsWith(`..${sep}`)
  ) {
    context.issues.push({
      code: "custom",
      input: value,
      message: "contract_relative_path_invalid",
    });
  }
});

const uniqueRelativePathsSchema = (minimum: number) =>
  z
    .array(relativePathSchema)
    .min(minimum, { error: "contract_path_list_empty" })
    .check((context) => {
      if (new Set(context.value).size !== context.value.length) {
        context.issues.push({
          code: "custom",
          input: context.value,
          message: "contract_path_list_duplicate",
        });
      }
    });

export const workerLaunchRequiredCheckSchema = z
  .object({
    id: simpleIdSchema,
    cwd: relativePathSchema,
    command: z
      .string()
      .min(1, { error: "contract_requiredCheck_command_empty" })
      .check((context) => {
        if (context.value.trim() !== context.value) {
          context.issues.push({
            code: "custom",
            input: context.value,
            message: "contract_requiredCheck_command_invalid",
          });
        }
      }),
  })
  .strict();

export const workerLaunchExecutionPolicySchema = z
  .object({
    mode: z.literal("sandbox-only", {
      error: "contract_executionPolicy_mode_invalid",
    }),
    sandboxRoot: z.string().check((context) => {
      if (!isAbsolute(context.value)) {
        context.issues.push({
          code: "custom",
          input: context.value,
          message: "contract_sandboxRoot_absolute_required",
        });
      }
    }),
    forbiddenRealProjects: z
      .array(
        z.string().min(1, { error: "contract_forbiddenRealProject_empty" }),
      )
      .min(1, { error: "contract_forbiddenRealProjects_empty" })
      .check((context) => {
        if (new Set(context.value).size !== context.value.length) {
          context.issues.push({
            code: "custom",
            input: context.value,
            message: "contract_forbiddenRealProjects_duplicate",
          });
        }
      }),
  })
  .strict();

const workerLaunchDeclarativeShape = {
  kind: z.literal("worker-launch", { error: "contract_kind_invalid" }),
  format: z.literal(1, { error: "contract_format_unsupported" }),
  canonicalSha: sha1Schema,
  baseSha: sha1Schema,
  phaseStartSha: sha1Schema,
  packetRevision: simpleIdSchema,
  controllerPacket: relativePathSchema,
  lanePacket: relativePathSchema,
  phaseId: phaseIdSchema,
  laneId: laneIdSchema,
  inputPatchHash: sha256Schema.nullable(),
  reviewKind: z.enum(["implementation", "review", "remediation"]),
  ownedPaths: uniqueRelativePathsSchema(1),
  mandatoryDocs: uniqueRelativePathsSchema(1),
  mandatoryScripts: uniqueRelativePathsSchema(0),
  mandatoryFixtures: uniqueRelativePathsSchema(0),
  requiredChecks: z
    .array(workerLaunchRequiredCheckSchema)
    .min(1, { error: "contract_requiredChecks_empty" })
    .check((context) => {
      const ids = context.value.map(({ id }) => id);
      if (new Set(ids).size !== ids.length) {
        context.issues.push({
          code: "custom",
          input: context.value,
          message: "contract_requiredCheck_duplicate_id",
        });
      }
    }),
  executionPolicy: workerLaunchExecutionPolicySchema,
  merge: mergeIntegrationPlanSchema.optional(),
} as const;

const workerLaunchRequestShape = {
  ...workerLaunchDeclarativeShape,
  canonicalSha: workerLaunchDeclarativeShape.canonicalSha.optional(),
  phaseStartSha: workerLaunchDeclarativeShape.phaseStartSha.optional(),
} as const;

const workerLaunchMaterializedShape = {
  jobId: simpleIdSchema,
  workerId: simpleIdSchema,
  revision: nonNegativeIntegerSchema,
  retryCount: nonNegativeIntegerSchema,
  workKey: sha256Schema,
  supersedes: sha256Schema.nullable(),
  registryStatus: z.literal("queued", {
    error: "contract_registryStatus_not_queued",
  }),
  jobRoot: z.string().min(1, { error: "contract_jobRoot_empty" }),
  workspaceRoot: z.string().min(1, { error: "contract_workspaceRoot_empty" }),
  promptPath: z.string().min(1, { error: "contract_promptPath_empty" }),
} as const;

function workerLaunchMissingPackets(
  value: Readonly<Record<string, unknown>>,
): readonly string[] {
  const mandatoryDocs = value.mandatoryDocs;
  if (!Array.isArray(mandatoryDocs)) return [];
  return ["controllerPacket", "lanePacket"].flatMap((field) => {
    const packet = value[field];
    return typeof packet === "string" && !mandatoryDocs.includes(packet)
      ? [packet]
      : [];
  });
}

function addWorkerLaunchCrossFieldIssues(context: {
  readonly value: Readonly<Record<string, unknown>>;
  readonly issues: Array<Record<string, unknown>>;
}): void {
  if (
    context.value.inputPatchHash === null &&
    (context.value.reviewKind !== "implementation" &&
      context.value.reviewKind !== "review" ||
      ("revision" in context.value && context.value.revision !== 0) ||
      ("retryCount" in context.value && context.value.retryCount !== 0) ||
      ("supersedes" in context.value && context.value.supersedes !== null))
  ) {
    context.issues.push({
      code: "custom",
      input: context.value.inputPatchHash,
      path: ["inputPatchHash"],
      message: "contract_inputPatchHash_null_invalid",
    });
  }
  for (const packet of workerLaunchMissingPackets(context.value)) {
    context.issues.push({
      code: "custom",
      input: packet,
      path: ["mandatoryDocs"],
      message: "contract_mandatoryDocs_missing_packet",
    });
  }
}

/**
 * Stable model-facing input. Runtime-owned identity, filesystem and ledger
 * fields are deliberately absent: callers describe the work and the runtime
 * materializes the execution binding from the admitted job manifest.
 * `format: 1` identifies the durable representation, not a planned
 * WorkerLaunchV1/V2 type family. Compatible changes update this format in
 * place; a new format is introduced only for a genuine breaking change.
 */
export const workerLaunchRequestSchema = z
  .object({
    ...workerLaunchRequestShape,
  })
  .strict()
  .check(addWorkerLaunchCrossFieldIssues);

const workerLaunchMaterializationInputSchema = z
  .object({
    ...workerLaunchRequestShape,
    jobId: workerLaunchMaterializedShape.jobId.optional(),
    workerId: workerLaunchMaterializedShape.workerId.optional(),
    revision: workerLaunchMaterializedShape.revision.optional(),
    retryCount: workerLaunchMaterializedShape.retryCount.optional(),
    workKey: workerLaunchMaterializedShape.workKey.optional(),
    supersedes: workerLaunchMaterializedShape.supersedes.optional(),
    registryStatus: workerLaunchMaterializedShape.registryStatus.optional(),
    jobRoot: workerLaunchMaterializedShape.jobRoot.optional(),
    workspaceRoot: workerLaunchMaterializedShape.workspaceRoot.optional(),
    promptPath: workerLaunchMaterializedShape.promptPath.optional(),
  })
  .strict()
  .check(addWorkerLaunchCrossFieldIssues);

/**
 * The one stable ProjectScopedControl admission shape exposed to models.
 * External validators and caller-supplied materialized state remain internal
 * compatibility mechanisms and are not part of this public control surface.
 */
export const workerLaunchAdmissionSchema = z
  .object({
    mode: z.literal("serial-builtin"),
    contract: workerLaunchRequestSchema,
  })
  .strict();

export const workerLaunchSpecSchema = z
  .object({
    ...workerLaunchDeclarativeShape,
    ...workerLaunchMaterializedShape,
  })
  .strict()
  .check(addWorkerLaunchCrossFieldIssues);

const workerLaunchStateRecordSchema = z
  .object({
    workKey: sha256Schema,
    jobId: simpleIdSchema,
    workerId: simpleIdSchema,
    phaseId: phaseIdSchema,
    laneId: laneIdSchema,
    baseSha: sha1Schema,
    phaseStartSha: sha1Schema,
    packetRevision: simpleIdSchema,
    controllerPacket: relativePathSchema,
    lanePacket: relativePathSchema,
    inputPatchHash: sha256Schema.nullable(),
    reviewKind: z.enum(["implementation", "review", "remediation"]),
    revision: nonNegativeIntegerSchema,
    retryCount: nonNegativeIntegerSchema,
    supersedes: sha256Schema.nullable(),
    status: z.literal("queued"),
    supersededBy: sha256Schema.nullable().optional(),
    supersededFrom: sha256Schema.nullable().optional(),
  })
  .strict()
  .check(addWorkerLaunchCrossFieldIssues);

export const workerLaunchStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    maxRetries: nonNegativeIntegerSchema,
    maxInFlight: z.literal(1),
    records: z.array(workerLaunchStateRecordSchema).length(1),
  })
  .strict();

export type WorkerLaunchRequest = z.infer<typeof workerLaunchRequestSchema>;
export type WorkerLaunchAdmission = z.infer<typeof workerLaunchAdmissionSchema>;
export type WorkerLaunchSpec = z.infer<typeof workerLaunchSpecSchema>;
export type WorkerLaunchState = z.infer<typeof workerLaunchStateSchema>;

export function parseWorkerLaunchRequest(value: unknown): WorkerLaunchRequest {
  return parseWorkerLaunchValue(workerLaunchRequestSchema, value, "request");
}

export function parseWorkerLaunchMaterializationInput(
  value: unknown,
): Readonly<Record<string, unknown>> {
  return parseWorkerLaunchValue(
    workerLaunchMaterializationInputSchema,
    value,
    "request",
  );
}

export function parseWorkerLaunchSpec(value: unknown): WorkerLaunchSpec {
  return parseWorkerLaunchValue(workerLaunchSpecSchema, value, "spec");
}

export function parseWorkerLaunchState(value: unknown): WorkerLaunchState {
  return parseWorkerLaunchValue(workerLaunchStateSchema, value, "state");
}

export function workerLaunchValidationIssues(
  error: z.ZodError,
): readonly string[] {
  return error.issues.flatMap((issue) => {
    if (issue.code === "unrecognized_keys") {
      return issue.keys.map((key) => `unexpected_field_${key}`);
    }
    const field = issue.path.map(String).join(".") || "root";
    if (issue.code === "invalid_type" && issue.input === undefined) {
      return [`missing_field_${field}`];
    }
    return [`${field}:${issue.message}`];
  });
}

function parseWorkerLaunchValue<T>(
  schema: z.ZodType<T>,
  value: unknown,
  label: "request" | "spec" | "state",
): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new Error(
    `worker_launch_${label}_invalid:${workerLaunchValidationIssues(parsed.error).join("|")}`,
  );
}
