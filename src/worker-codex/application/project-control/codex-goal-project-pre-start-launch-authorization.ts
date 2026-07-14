import { isDeepStrictEqual } from "node:util";
import { readFile, rename, writeFile } from "node:fs/promises";
import type { ProjectAccessScope } from "@vioxen/subscription-runtime/worker-core";
import type { CodexGoalJobManifest } from "../../codex-goal-jobs";
import {
  assertProjectPreStartAdmissionLaunchBinding,
  type ProjectPreStartAdmissionDirtyContinuationMode,
} from "./codex-goal-project-pre-start-admission";

const MAX_RECEIPT_BYTES = 64 * 1024;

type JsonObject = Readonly<Record<string, unknown>>;

export type ProjectPreStartAdmissionLaunchAuthorization = {
  readonly receiptPath: string;
  readonly previousReceipt: JsonObject;
  readonly authorizedReceipt: JsonObject;
};

export async function authorizeProjectPreStartAdmissionLaunch(input: {
  readonly manifest: CodexGoalJobManifest;
  readonly scope: ProjectAccessScope;
  readonly workspaceMode?: ProjectPreStartAdmissionDirtyContinuationMode;
}): Promise<ProjectPreStartAdmissionLaunchAuthorization | undefined> {
  const descriptor = input.manifest.projectPreStartAdmission;
  if (!descriptor) {
    if (input.scope.preStartAdmission?.required) {
      throw new Error("project_control_pre_start_admission_required");
    }
    return undefined;
  }
  await assertProjectPreStartAdmissionLaunchBinding({
    manifest: input.manifest,
    scope: input.scope,
    ...(input.workspaceMode ? { workspaceMode: input.workspaceMode } : {}),
  });
  const receipt = await readReceipt(descriptor.receiptPath);
  const authorizationCount =
    typeof receipt.launchAuthorizationCount === "number" &&
      Number.isSafeInteger(receipt.launchAuthorizationCount) &&
      receipt.launchAuthorizationCount >= 0
      ? receipt.launchAuthorizationCount
      : 0;
  const authorizedReceipt = {
    ...receipt,
    status: "launch_authorized",
    launchAuthorizationCount: authorizationCount + 1,
    launchAuthorizedAt: new Date().toISOString(),
  };
  await writeReceipt(descriptor.receiptPath, authorizedReceipt);
  return {
    receiptPath: descriptor.receiptPath,
    previousReceipt: receipt,
    authorizedReceipt,
  };
}

export async function rollbackProjectPreStartAdmissionLaunch(
  authorization: ProjectPreStartAdmissionLaunchAuthorization,
): Promise<void> {
  const currentReceipt = await readReceipt(authorization.receiptPath);
  if (!isDeepStrictEqual(currentReceipt, authorization.authorizedReceipt)) {
    throw new Error(
      "project_control_pre_start_launch_authorization_rollback_conflict",
    );
  }
  await writeReceipt(
    authorization.receiptPath,
    authorization.previousReceipt,
  );
}

export async function withProjectPreStartAdmissionLaunchAuthorization<T>(
  input: {
    readonly manifest: CodexGoalJobManifest;
    readonly scope: ProjectAccessScope;
    readonly workspaceMode?: ProjectPreStartAdmissionDirtyContinuationMode;
  },
  start: () => Promise<T>,
): Promise<T> {
  const authorization = await authorizeProjectPreStartAdmissionLaunch(input);
  try {
    return await start();
  } catch (error) {
    if (authorization) {
      try {
        await rollbackProjectPreStartAdmissionLaunch(authorization);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "project_control_pre_start_launch_rollback_failed",
        );
      }
    }
    throw error;
  }
}

async function readReceipt(path: string): Promise<JsonObject> {
  try {
    const body = await readFile(path);
    if (body.byteLength > MAX_RECEIPT_BYTES) {
      throw new Error("size_limit_exceeded");
    }
    const value: unknown = JSON.parse(body.toString("utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("not_object");
    }
    return value as JsonObject;
  } catch {
    throw new Error("project_control_pre_start_receipt_invalid");
  }
}

async function writeReceipt(path: string, value: JsonObject): Promise<void> {
  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporaryPath, path);
}
