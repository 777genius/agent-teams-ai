#!/usr/bin/env node
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { LocalIntegrationAttemptStore } from "@vioxen/subscription-runtime/store-local-file";
import {
  IntegrationAttemptStatus,
  recoverOperatorCheckArtifact,
  type OperatorArtifactRecoveryPermit,
  type OperatorArtifactRecoveryResult,
} from "@vioxen/subscription-runtime/worker-core";
import { LocalOperatorArtifactRecoveryAdapter } from "@vioxen/subscription-runtime/worker-local";
import { loadProjectControlController } from "./codex-goal-mcp-project-control-deps";
import { projectControlWorkspaceLocks } from "./codex-goal-project-workspace-lock";
import { projectControlCanonicalWorkspacePath } from "./application/project-control/codex-goal-project-workspace-scope";
import { localProjectIntegrationSnapshotRoot } from "./project-integration-mcp/adapters/local-worker-handoff-artifact-validator";
import { reviewedWorkerOutputRoot } from "./reviewed-worker-output";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/i);
const nonEmptyString = z.string().min(1);
const isoTimestamp = z
  .string()
  .refine(
    (value) =>
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString() === value,
  );

const permitSchema = z
  .object({
    schemaVersion: z.literal(1),
    registryRootDir: nonEmptyString,
    controllerJobId: nonEmptyString,
    projectId: nonEmptyString,
    attemptId: nonEmptyString,
    expectedAttemptStatus: z.literal(IntegrationAttemptStatus.ChecksPassed),
    targetWorkspacePath: nonEmptyString,
    targetBranch: nonEmptyString,
    targetHeadSha: z.string().regex(/^[a-f0-9]{40}$/i),
    candidatePatchSha256: sha256Schema,
    candidatePatchSize: z.number().int().nonnegative().safe(),
    artifact: z
      .object({
        path: nonEmptyString,
        sha256: sha256Schema,
        size: z.number().int().nonnegative().safe(),
        mode: z.number().int().min(0).max(0o777),
        mtimeMs: z.number().finite().nonnegative(),
        mtimeToleranceMs: z.number().int().min(0).max(2_000).optional(),
      })
      .strict(),
    check: z
      .object({
        checkId: nonEmptyString,
        command: z.array(nonEmptyString).min(1),
        startedAt: isoTimestamp,
        completedAt: isoTimestamp,
      })
      .strict(),
  })
  .strict();

export type ProjectIntegrationOperatorRecoveryCliIo = {
  readonly cwd: () => string;
  readonly writeStdout: (chunk: string) => void;
  readonly writeStderr: (chunk: string) => void;
};

export type ProjectIntegrationOperatorRecoveryCliDependencies = {
  readonly execute?: (input: {
    readonly permit: OperatorArtifactRecoveryPermit;
    readonly permitSha256: string;
    readonly confirm: boolean;
  }) => Promise<OperatorArtifactRecoveryResult>;
};

export async function runProjectIntegrationOperatorRecoveryCli(
  argv = process.argv.slice(2),
  io: ProjectIntegrationOperatorRecoveryCliIo = defaultIo,
  dependencies: ProjectIntegrationOperatorRecoveryCliDependencies = {},
): Promise<number> {
  try {
    const args = parseArgs(argv);
    const permitPath = isAbsolute(args.permitFile)
      ? args.permitFile
      : resolve(io.cwd(), args.permitFile);
    const permitHandle = await open(
      permitPath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    ).catch(() => {
      throw new Error("operator_artifact_recovery_permit_open_failed");
    });
    let permitBytes: Buffer;
    try {
      const permitStatus = await permitHandle.stat();
      if (!permitStatus.isFile()) {
        throw new Error(
          "operator_artifact_recovery_permit_regular_file_required",
        );
      }
      if (permitStatus.size > 64 * 1024) {
        throw new Error("operator_artifact_recovery_permit_too_large");
      }
      if (dependencies.execute === undefined) {
        assertOperatorRecoveryPermitFileSecurity(permitStatus);
      }
      permitBytes = await permitHandle.readFile();
      if (permitBytes.length !== permitStatus.size) {
        throw new Error("operator_artifact_recovery_permit_size_changed");
      }
    } finally {
      await permitHandle.close();
    }
    const permit = permitSchema.parse(
      JSON.parse(permitBytes.toString("utf8")),
    ) as OperatorArtifactRecoveryPermit;
    const permitSha256 = createHash("sha256").update(permitBytes).digest("hex");
    const execute = dependencies.execute ?? executeRecovery;
    const result = await execute({
      permit,
      permitSha256,
      confirm: args.confirm,
    });
    io.writeStdout(
      `${JSON.stringify(
        {
          schemaVersion: 1,
          mode: args.confirm ? "confirm" : "preview",
          ...result,
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  } catch (error) {
    io.writeStderr(`${safeError(error)}\n`);
    return 1;
  }
}

export function assertOperatorRecoveryPermitFileSecurity(
  status: {
    readonly uid: number | bigint;
    readonly mode: number | bigint;
  },
  effectiveUid = process.geteuid?.(),
): void {
  if (effectiveUid !== 0) {
    throw new Error("operator_artifact_recovery_root_required");
  }
  const ownerUid = Number(status.uid);
  if (ownerUid !== 0) {
    throw new Error("operator_artifact_recovery_permit_owner_invalid");
  }
  if ((Number(status.mode) & 0o777) !== 0o600) {
    throw new Error("operator_artifact_recovery_permit_mode_invalid");
  }
}

async function executeRecovery(input: {
  readonly permit: OperatorArtifactRecoveryPermit;
  readonly permitSha256: string;
  readonly confirm: boolean;
}): Promise<OperatorArtifactRecoveryResult> {
  if (!isAbsolute(input.permit.registryRootDir)) {
    throw new Error(
      "operator_artifact_recovery_registry_root_absolute_required",
    );
  }
  const registryRootDir = await realpath(input.permit.registryRootDir);
  if (registryRootDir !== input.permit.registryRootDir) {
    throw new Error("operator_artifact_recovery_registry_root_not_canonical");
  }
  const controller = await loadProjectControlController({
    registryRootDir,
    controllerJobId: input.permit.controllerJobId,
  });
  if (
    controller.controller.jobId !== input.permit.controllerJobId ||
    controller.scope.projectId !== input.permit.projectId ||
    controller.registryRootDir !== registryRootDir
  ) {
    throw new Error("operator_artifact_recovery_controller_scope_mismatch");
  }
  const canonicalWorkspacePath = await projectControlCanonicalWorkspacePath(
    input.permit.targetWorkspacePath,
    controller.scope,
  );
  if (canonicalWorkspacePath !== input.permit.targetWorkspacePath) {
    throw new Error("operator_artifact_recovery_workspace_not_canonical");
  }
  if (
    controller.scope.allowedBranches &&
    !controller.scope.allowedBranches.includes(input.permit.targetBranch)
  ) {
    throw new Error("operator_artifact_recovery_branch_outside_scope");
  }

  const archiveRoot = join(controller.controller.jobRootDir, "archives");
  return await recoverOperatorCheckArtifact(
    {
      store: new LocalIntegrationAttemptStore({
        rootDir: join(controller.controller.jobRootDir, "project-integration"),
      }),
      locks: projectControlWorkspaceLocks(controller.registryRootDir),
      recovery: new LocalOperatorArtifactRecoveryAdapter({
        archiveRoot,
        controllerArchiveRoot: archiveRoot,
        allowedPatchRoots: [
          ...(controller.scope.workspaceRoots ?? []),
          ...(controller.scope.worktreeRoots ?? []),
          localProjectIntegrationSnapshotRoot(controller),
          reviewedWorkerOutputRoot(controller.registryRootDir),
        ],
        workerJobRootParent: dirname(controller.controller.jobRootDir),
      }),
    },
    input,
  );
}

function parseArgs(argv: readonly string[]): {
  readonly permitFile: string;
  readonly confirm: boolean;
} {
  let permitFile: string | undefined;
  let confirm = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--permit-file") {
      if (permitFile !== undefined || !argv[index + 1]) {
        throw new Error("operator_artifact_recovery_permit_file_required");
      }
      permitFile = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--confirm" && !confirm) {
      confirm = true;
      continue;
    }
    throw new Error("operator_artifact_recovery_argument_invalid");
  }
  if (!permitFile) {
    throw new Error("operator_artifact_recovery_permit_file_required");
  }
  return { permitFile, confirm };
}

function safeError(error: unknown): string {
  if (error instanceof z.ZodError)
    return "operator_artifact_recovery_permit_invalid";
  if (error instanceof SyntaxError)
    return "operator_artifact_recovery_permit_invalid";
  if (
    error instanceof Error &&
    /^operator_artifact_recovery_[a-z0-9_]+$/.test(error.message)
  ) {
    return error.message;
  }
  return "operator_artifact_recovery_failed";
}

const defaultIo: ProjectIntegrationOperatorRecoveryCliIo = {
  cwd: () => process.cwd(),
  writeStdout: (chunk) => process.stdout.write(chunk),
  writeStderr: (chunk) => process.stderr.write(chunk),
};

if (await isMainModule()) {
  process.exitCode = await runProjectIntegrationOperatorRecoveryCli();
}

async function isMainModule(): Promise<boolean> {
  if (!process.argv[1]) return false;
  const modulePath = fileURLToPath(import.meta.url);
  try {
    return (await realpath(modulePath)) === (await realpath(process.argv[1]));
  } catch {
    return modulePath === process.argv[1];
  }
}
