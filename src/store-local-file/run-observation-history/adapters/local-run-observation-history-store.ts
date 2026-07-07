import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  RunObservationHistoryEntry,
  RunObservationHistoryStorePort,
} from "../ports/run-observation-history-store-contracts";
import { runEventProviderKindFromString } from "@vioxen/subscription-runtime/worker-core";
import {
  localRunObservationHistoryStorageVersion as storageVersion,
} from "../domain/run-observation-history-record-policy";

export type LocalFileRunObservationHistoryStoreOptions = {
  readonly rootDir: string;
};

type PersistedRunObservationHistoryEntry = RunObservationHistoryEntry & {
  readonly storageVersion: typeof storageVersion;
};

export class LocalFileRunObservationHistoryStore
  implements RunObservationHistoryStorePort
{
  constructor(
    private readonly options: LocalFileRunObservationHistoryStoreOptions,
  ) {}

  async readObservation(
    runId: string,
  ): Promise<RunObservationHistoryEntry | null> {
    const path = this.recordPath(runId);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      if (error instanceof SyntaxError) {
        await rm(path, { force: true });
        return null;
      }
      throw error;
    }
    const entry = parsePersistedEntry(parsed);
    if (!entry) {
      await rm(path, { force: true });
      return null;
    }
    if (entry.runId !== runId) {
      await rm(path, { force: true });
      return null;
    }
    return entry;
  }

  async writeObservation(entry: RunObservationHistoryEntry): Promise<void> {
    const path = this.recordPath(entry.runId);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const tempPath = join(dirname(path), `${randomUUID()}.tmp`);
    try {
      await writeFile(
        tempPath,
        `${JSON.stringify({ storageVersion, ...entry }, null, 2)}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      await rename(tempPath, path);
    } catch (error) {
      await rm(tempPath, { force: true });
      throw error;
    }
  }

  private recordPath(runId: string): string {
    return join(
      this.options.rootDir,
      "run-observation-history",
      hashText(runId),
    );
  }
}

function parsePersistedEntry(
  value: unknown,
): RunObservationHistoryEntry | null {
  if (!isRecord(value) || value.storageVersion !== storageVersion) return null;
  if (
    value.schemaVersion !== 1 ||
    typeof value.runId !== "string" ||
    typeof value.providerKind !== "string" ||
    typeof value.observedAt !== "string"
  ) {
    return null;
  }
  if (!optionalBoolean(value.workspaceDirty)) return null;
  if (!optionalNumber(value.changedFilesCount)) return null;
  if (!optionalString(value.workspaceSignature)) return null;
  if (!optionalBoolean(value.resultExists)) return null;
  if (!optionalString(value.resultStatus)) return null;
  if (!optionalString(value.resultReason)) return null;
  if (!optionalString(value.resultUpdatedAt)) return null;
  if (!optionalString(value.logUpdatedAt)) return null;
  if (!optionalNumber(value.logByteLength)) return null;
  return {
    schemaVersion: 1,
    runId: value.runId,
    providerKind: runEventProviderKindFromString(value.providerKind),
    observedAt: value.observedAt,
    ...(value.workspaceDirty === undefined
      ? {}
      : { workspaceDirty: value.workspaceDirty }),
    ...(value.changedFilesCount === undefined
      ? {}
      : { changedFilesCount: value.changedFilesCount }),
    ...(value.workspaceSignature === undefined
      ? {}
      : { workspaceSignature: value.workspaceSignature }),
    ...(value.resultExists === undefined ? {} : { resultExists: value.resultExists }),
    ...(value.resultStatus === undefined ? {} : { resultStatus: value.resultStatus }),
    ...(value.resultReason === undefined ? {} : { resultReason: value.resultReason }),
    ...(value.resultUpdatedAt === undefined
      ? {}
      : { resultUpdatedAt: value.resultUpdatedAt }),
    ...(value.logUpdatedAt === undefined ? {} : { logUpdatedAt: value.logUpdatedAt }),
    ...(value.logByteLength === undefined ? {} : { logByteLength: value.logByteLength }),
  };
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function optionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === "boolean";
}

function optionalNumber(value: unknown): value is number | undefined {
  return value === undefined ||
    (typeof value === "number" && Number.isFinite(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
