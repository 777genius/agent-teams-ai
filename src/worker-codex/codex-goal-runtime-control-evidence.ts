import { readFile } from "node:fs/promises";

export type ControlledRuntimeInterruptionEvidence = {
  readonly signalId: string;
  readonly resultUpdatedAt: string;
};

/**
 * Reads only the narrow runtime-authored proof required for a controlled
 * interruption continuation. Non-strict, stale-shaped or mismatched results
 * deliberately project no evidence.
 */
export async function readControlledRuntimeInterruptionEvidence(input: {
  readonly resultPath: string | undefined;
  readonly taskId: string;
}): Promise<ControlledRuntimeInterruptionEvidence | undefined> {
  if (!input.resultPath) return undefined;
  try {
    const value: unknown = JSON.parse(await readFile(input.resultPath, "utf8"));
    if (!isRecord(value) || !isStrictRuntimeResult(value)) return undefined;
    if (
      value.schemaVersion !== 1 ||
      value.taskId !== input.taskId ||
      value.status !== "partial" ||
      value.reason !== "runtime_interrupted" ||
      value.nextAction !== "preserve_patch" ||
      typeof value.updatedAt !== "string" ||
      !Number.isFinite(Date.parse(value.updatedAt)) ||
      !isRecord(value.details) ||
      value.details.runtimeControl !== "interrupt_then_continue" ||
      typeof value.details.signalId !== "string" ||
      value.details.signalId.trim().length === 0
    ) {
      return undefined;
    }
    return {
      signalId: value.details.signalId,
      resultUpdatedAt: value.updatedAt,
    };
  } catch {
    return undefined;
  }
}

function isStrictRuntimeResult(value: Record<string, unknown>): boolean {
  return (
    typeof value.status === "string" &&
    Array.isArray(value.changedFiles) &&
    value.changedFiles.every((item) => typeof item === "string") &&
    Array.isArray(value.evidence) &&
    value.evidence.every((item) => typeof item === "string") &&
    Array.isArray(value.blockers) &&
    value.blockers.every((item) => typeof item === "string") &&
    typeof value.nextAction === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
