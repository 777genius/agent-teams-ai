import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  ProjectControlOperationClaimEnvironment,
} from "./project-control-operation-file-store";
import {
  type JsonRecord,
  type ProjectControlOperationRecord,
  type ProjectControlOperationRunResult,
  ProjectControlOperationRunDisposition,
  ProjectControlOperationStatus,
  type ProjectControlOperationToolName,
  readProjectControlOperation,
  runProjectControlOperationFile,
} from "./project-control-operation-lifecycle";

export type ProjectControlOperationRecoverySummary = {
  readonly scanned: number;
  readonly attempted: number;
  readonly recovered: number;
  readonly reconciled: number;
  readonly alreadyRunning: number;
  readonly terminal: number;
  readonly failed: number;
  readonly invalid: number;
  readonly results: readonly ProjectControlOperationRunResult[];
};

export async function recoverProjectControlOperations(input: {
  readonly operationsRootDir: string;
  readonly invokeTool: (
    toolName: ProjectControlOperationToolName,
    args: JsonRecord,
  ) => Promise<unknown>;
  readonly claimEnvironment?: ProjectControlOperationClaimEnvironment;
  readonly heartbeatIntervalMs?: number;
}): Promise<ProjectControlOperationRecoverySummary> {
  let entries;
  try {
    entries = await readdir(input.operationsRootDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return emptyRecoverySummary();
    }
    throw error;
  }

  const operationFiles = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(input.operationsRootDir, entry.name, "operation.json"))
    .sort();
  const results: ProjectControlOperationRunResult[] = [];
  let attempted = 0;
  let recovered = 0;
  let reconciled = 0;
  let alreadyRunning = 0;
  let terminal = 0;
  let failed = 0;
  let invalid = 0;

  for (const operationFilePath of operationFiles) {
    let operation: ProjectControlOperationRecord;
    try {
      operation = await readProjectControlOperation(operationFilePath);
    } catch {
      invalid += 1;
      continue;
    }
    if (operationIsTerminal(operation)) {
      terminal += 1;
      continue;
    }
    attempted += 1;
    const result = await runProjectControlOperationFile({
      operationFilePath,
      invokeTool: input.invokeTool,
      recovery: true,
      ...(input.claimEnvironment === undefined
        ? {}
        : { claimEnvironment: input.claimEnvironment }),
      ...(input.heartbeatIntervalMs === undefined
        ? {}
        : { heartbeatIntervalMs: input.heartbeatIntervalMs }),
    });
    results.push(result);
    if (result.disposition === ProjectControlOperationRunDisposition.Executed) {
      recovered += 1;
    } else if (
      result.disposition === ProjectControlOperationRunDisposition.Reconciled
    ) {
      reconciled += 1;
    } else if (
      result.disposition === ProjectControlOperationRunDisposition.AlreadyRunning
    ) {
      alreadyRunning += 1;
    } else if (
      result.disposition === ProjectControlOperationRunDisposition.TerminalReplay
    ) {
      terminal += 1;
    }
    if (!result.ok) failed += 1;
  }

  return {
    scanned: operationFiles.length,
    attempted,
    recovered,
    reconciled,
    alreadyRunning,
    terminal,
    failed,
    invalid,
    results,
  };
}

function operationIsTerminal(operation: ProjectControlOperationRecord): boolean {
  return operation.status === ProjectControlOperationStatus.Completed ||
    operation.status === ProjectControlOperationStatus.Failed;
}

function emptyRecoverySummary(): ProjectControlOperationRecoverySummary {
  return {
    scanned: 0,
    attempted: 0,
    recovered: 0,
    reconciled: 0,
    alreadyRunning: 0,
    terminal: 0,
    failed: 0,
    invalid: 0,
    results: [],
  };
}
