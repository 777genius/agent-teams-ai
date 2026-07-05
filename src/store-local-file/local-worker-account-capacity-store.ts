import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type {
  WorkerAccountCapacityStore,
  WorkerAccountLimitSignal,
  WorkerCapacitySnapshot,
} from "@vioxen/subscription-runtime/worker-core";
import {
  defaultRuntimeDemandFromCapacityDetails,
  isPersistableWorkerAccountAvailability,
  normalizeWorkerAccountCapacitySignal,
  normalizeWorkerAccountId,
  normalizeWorkerRuntimeDemand,
  shouldKeepExistingWorkerAccountCapacity,
  workerRuntimeDemandKey,
  type WorkerRuntimeDemand,
} from "@vioxen/subscription-runtime/worker-core";

const storageVersion = "local-file-worker-account-capacity-v1";
const demandAwareStorageVersion = "local-file-worker-account-capacity-v2";

export type LocalFileWorkerAccountCapacityStoreOptions = {
  readonly rootDir: string;
};

type PersistedWorkerAccountCapacityRecord = {
  readonly storageVersion:
    | typeof storageVersion
    | typeof demandAwareStorageVersion;
  readonly accountId: string;
  readonly demand?: WorkerRuntimeDemand;
  readonly capacity: PersistedWorkerCapacitySnapshot;
  readonly updatedAt: string;
};

type PersistedWorkerCapacitySnapshot = {
  readonly availability: WorkerCapacitySnapshot["availability"];
  readonly reason?: string;
  readonly cooldownUntil?: string;
  readonly lastLimitSignalAt?: string;
  readonly details?: Readonly<Record<string, string>>;
};

export class LocalFileWorkerAccountCapacityStore
  implements WorkerAccountCapacityStore
{
  constructor(
    private readonly options: LocalFileWorkerAccountCapacityStoreOptions,
  ) {}

  read(input: {
    readonly accountId: string;
    readonly demand?: WorkerRuntimeDemand;
    readonly now?: Date;
  }): WorkerCapacitySnapshot | null {
    const accountId = normalizeWorkerAccountId(input.accountId);
    if (!accountId) return null;
    const demand = normalizeWorkerRuntimeDemand(input.demand);

    const record =
      (demand ? this.readRecord(accountId, demand) : null) ??
      this.readRecord(accountId, null) ??
      this.readLegacyRecord(accountId);
    if (!record) return null;
    if (record.accountId !== accountId) {
      this.clear({ accountId });
      return null;
    }
    if (demand && record.demand) {
      const persistedDemandKey = workerRuntimeDemandKey(record.demand);
      if (persistedDemandKey !== workerRuntimeDemandKey(demand)) {
        this.clear({ accountId });
        return null;
      }
    }

    const capacity = parsePersistedCapacity(record.capacity);
    if (!capacity) {
      this.clear({ accountId });
      return null;
    }

    const now = input.now ?? new Date();
    if (
      capacity.cooldownUntil &&
      capacity.cooldownUntil.getTime() <= now.getTime()
    ) {
      this.clear({ accountId });
      return null;
    }
    return capacity;
  }

  observe(input: WorkerAccountLimitSignal): void {
    const accountId = normalizeWorkerAccountId(input.accountId);
    if (!accountId) return;

    const capacity = normalizeWorkerAccountCapacitySignal(input);
    if (!capacity) return;
    const demand =
      normalizeWorkerRuntimeDemand(input.demand) ??
      defaultRuntimeDemandFromCapacityDetails(input.capacity.details);

    const existing = this.read({
      accountId,
      ...(demand ? { demand } : {}),
      now: input.observedAt,
    });
    if (
      existing &&
      shouldKeepExistingWorkerAccountCapacity(existing, capacity)
    ) {
      return;
    }

    this.writeRecord({
      storageVersion: demandAwareStorageVersion,
      accountId,
      ...(demand ? { demand } : {}),
      capacity: persistCapacity(capacity),
      updatedAt: input.observedAt.toISOString(),
    });
  }

  clear(input: { readonly accountId: string }): void {
    const accountId = normalizeWorkerAccountId(input.accountId);
    if (!accountId) return;
    rmSync(this.legacyRecordPath(accountId), { force: true });
    rmSync(this.accountRecordDir(accountId), { recursive: true, force: true });
  }

  private readRecord(
    accountId: string,
    demand: WorkerRuntimeDemand | null,
  ): PersistedWorkerAccountCapacityRecord | null {
    const path = this.recordPath(accountId, demand);
    return this.readRecordPath(path);
  }

  private readLegacyRecord(
    accountId: string,
  ): PersistedWorkerAccountCapacityRecord | null {
    return this.readRecordPath(this.legacyRecordPath(accountId));
  }

  private readRecordPath(
    path: string,
  ): PersistedWorkerAccountCapacityRecord | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      if (error instanceof SyntaxError) {
        rmSync(path, { force: true });
        return null;
      }
      throw error;
    }
    if (
      !isRecord(parsed) ||
      (parsed.storageVersion !== storageVersion &&
        parsed.storageVersion !== demandAwareStorageVersion) ||
      typeof parsed.accountId !== "string" ||
      !isRecord(parsed.capacity) ||
      typeof parsed.updatedAt !== "string"
    ) {
      rmSync(path, { force: true });
      return null;
    }
    return parsed as PersistedWorkerAccountCapacityRecord;
  }

  private writeRecord(record: PersistedWorkerAccountCapacityRecord): void {
    const path = this.recordPath(
      record.accountId,
      normalizeWorkerRuntimeDemand(record.demand),
    );
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tempPath = join(dirname(path), `${randomUUID()}.tmp`);
    try {
      writeFileSync(tempPath, `${JSON.stringify(record, null, 2)}\n`, {
        mode: 0o600,
      });
      renameSync(tempPath, path);
    } catch (error) {
      rmSync(tempPath, { force: true });
      throw error;
    }
  }

  private recordPath(
    accountId: string,
    demand: WorkerRuntimeDemand | null,
  ): string {
    const demandKey = workerRuntimeDemandKey(demand);
    const fileName = demandKey ? `${hashText(demandKey)}.json` : "account.json";
    return join(this.accountRecordDir(accountId), fileName);
  }

  private accountRecordDir(accountId: string): string {
    return join(
      this.options.rootDir,
      "account-capacity-v2",
      hashText(accountId),
    );
  }

  private legacyRecordPath(accountId: string): string {
    return join(this.options.rootDir, "account-capacity", hashText(accountId));
  }
}

function persistCapacity(
  capacity: WorkerCapacitySnapshot,
): PersistedWorkerCapacitySnapshot {
  return {
    availability: capacity.availability,
    ...(capacity.reason ? { reason: capacity.reason } : {}),
    ...(capacity.cooldownUntil
      ? { cooldownUntil: capacity.cooldownUntil.toISOString() }
      : {}),
    ...(capacity.lastLimitSignalAt
      ? { lastLimitSignalAt: capacity.lastLimitSignalAt.toISOString() }
      : {}),
    ...(capacity.details ? { details: capacity.details } : {}),
  };
}

function parsePersistedCapacity(
  value: PersistedWorkerCapacitySnapshot,
): WorkerCapacitySnapshot | null {
  if (!isPersistableWorkerAccountAvailability(value.availability)) return null;
  if (value.reason !== undefined && typeof value.reason !== "string") {
    return null;
  }
  const cooldownUntil = optionalDate(value.cooldownUntil);
  const lastLimitSignalAt = optionalDate(value.lastLimitSignalAt);
  const details = optionalStringRecord(value.details);
  if (
    cooldownUntil === false ||
    lastLimitSignalAt === false ||
    details === false
  ) {
    return null;
  }
  return {
    availability: value.availability,
    ...(value.reason ? { reason: value.reason } : {}),
    ...(cooldownUntil ? { cooldownUntil } : {}),
    ...(lastLimitSignalAt ? { lastLimitSignalAt } : {}),
    ...(details ? { details } : {}),
  };
}

function optionalDate(value: string | undefined): Date | false | null {
  if (value === undefined) return null;
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : false;
}

function optionalStringRecord(
  value: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> | false | null {
  if (value === undefined) return null;
  if (!isRecord(value)) return false;
  for (const entry of Object.values(value)) {
    if (typeof entry !== "string") return false;
  }
  return value;
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
