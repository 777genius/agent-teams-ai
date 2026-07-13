import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  normalizeWorkerAccountId,
  normalizeWorkerRuntimeDemand,
  workerAccountLeaseResourceKey,
  workerRuntimeDemandKey,
  type WorkerAccountLease,
  type WorkerAccountLeaseAcquireResult,
  type WorkerAccountLeaseRenewResult,
  type WorkerAccountLeaseStore,
  type WorkerRuntimeDemand,
} from "@vioxen/subscription-runtime/worker-core";
import {
  localFileWorkerAccountLeaseDefaultLockAcquireTimeoutMs,
  localFileWorkerAccountLeaseDefaultLockPollMs,
  localFileWorkerAccountLeaseDefaultMalformedLockStaleMs,
  localFileWorkerAccountLeaseLockStorageVersion,
  localFileWorkerAccountLeaseStorageVersion,
} from "../domain/local-file-worker-account-lease-policy";

export type LocalFileWorkerAccountLeaseStoreOptions = {
  readonly rootDir: string;
  readonly lockAcquireTimeoutMs?: number;
  readonly lockPollMs?: number;
  readonly malformedLockStaleMs?: number;
};

type PersistedWorkerAccountLease = {
  readonly storageVersion: typeof localFileWorkerAccountLeaseStorageVersion;
  readonly resourceHash: string;
  readonly accountId: string;
  readonly demand?: WorkerRuntimeDemand;
  readonly leaseId: string;
  readonly ownerIdHash: string;
  readonly fencingToken: number;
  readonly state: "active" | "released";
  readonly acquiredAt: string;
  readonly expiresAt: string;
  readonly releasedAt?: string;
};

type PersistedLeaseLock = {
  readonly storageVersion: typeof localFileWorkerAccountLeaseLockStorageVersion;
  readonly lockId: string;
  readonly pid: number;
  readonly acquiredAt: string;
};

type LeaseResource = {
  readonly accountId: string;
  readonly demand: WorkerRuntimeDemand | null;
  readonly resourceHash: string;
};

export class LocalFileWorkerAccountLeaseStore
  implements WorkerAccountLeaseStore
{
  constructor(private readonly options: LocalFileWorkerAccountLeaseStoreOptions) {
    if (!options.rootDir.trim()) {
      throw new Error("local_file_worker_account_lease_root_required");
    }
  }

  async acquire(input: {
    readonly accountId: string;
    readonly demand?: WorkerRuntimeDemand;
    readonly ownerId: string;
    readonly ttlMs: number;
    readonly now: Date;
  }): Promise<WorkerAccountLeaseAcquireResult> {
    const resource = normalizeResource(input.accountId, input.demand);
    const ownerId = normalizeOwnerId(input.ownerId);
    const expiresAt = leaseExpiry(input.now, input.ttlMs);

    return await this.withResourceLock(resource.resourceHash, async () => {
      const current = await this.readRecord(resource.resourceHash);
      if (isActiveAt(current, input.now)) {
        if (current.ownerIdHash === hashText(ownerId)) {
          return {
            status: "granted",
            lease: leaseFromRecord(current, ownerId),
          };
        }
        return {
          status: "denied",
          reason: "leased",
          currentLeaseExpiresAt: new Date(current.expiresAt),
        };
      }

      const fencingToken = nextFencingToken(current);
      const leaseId = localLeaseId(resource.resourceHash);
      const record: PersistedWorkerAccountLease = {
        storageVersion: localFileWorkerAccountLeaseStorageVersion,
        resourceHash: resource.resourceHash,
        accountId: resource.accountId,
        ...(resource.demand ? { demand: resource.demand } : {}),
        leaseId,
        ownerIdHash: hashText(ownerId),
        fencingToken,
        state: "active",
        acquiredAt: input.now.toISOString(),
        expiresAt: expiresAt.toISOString(),
      };
      await this.writeRecord(record);
      return { status: "granted", lease: leaseFromRecord(record, ownerId) };
    });
  }

  async renew(input: {
    readonly leaseId: string;
    readonly ownerId: string;
    readonly ttlMs: number;
    readonly now: Date;
  }): Promise<WorkerAccountLeaseRenewResult> {
    const ownerId = normalizeOwnerId(input.ownerId);
    const parsedLeaseId = parseLocalLeaseId(input.leaseId);
    const requestedExpiry = leaseExpiry(input.now, input.ttlMs);
    if (!parsedLeaseId) {
      return { status: "lost", reason: "lease_not_current" };
    }

    return await this.withResourceLock(parsedLeaseId.resourceHash, async () => {
      const current = await this.readRecord(parsedLeaseId.resourceHash);
      if (!isCurrentLease(current, input.leaseId, ownerId)) {
        return { status: "lost", reason: "lease_not_current" };
      }
      if (!isActiveAt(current, input.now)) {
        return { status: "lost", reason: "lease_expired" };
      }

      const renewed: PersistedWorkerAccountLease = {
        ...current,
        expiresAt: new Date(
          Math.max(new Date(current.expiresAt).getTime(), requestedExpiry.getTime()),
        ).toISOString(),
      };
      await this.writeRecord(renewed);
      return { status: "renewed", lease: leaseFromRecord(renewed, ownerId) };
    });
  }

  async release(input: {
    readonly leaseId: string;
    readonly ownerId: string;
    readonly reason: string;
    readonly now: Date;
  }): Promise<void> {
    const ownerId = normalizeOwnerId(input.ownerId);
    assertValidDate(input.now);
    const parsedLeaseId = parseLocalLeaseId(input.leaseId);
    if (!parsedLeaseId) return;

    await this.withResourceLock(parsedLeaseId.resourceHash, async () => {
      const current = await this.readRecord(parsedLeaseId.resourceHash);
      if (!isCurrentLease(current, input.leaseId, ownerId)) return;
      await this.writeRecord({
        ...current,
        state: "released",
        releasedAt: input.now.toISOString(),
      });
    });
  }

  private async withResourceLock<T>(
    resourceHash: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const lock = await this.acquireLock(resourceHash);
    try {
      return await operation();
    } finally {
      await this.releaseLock(lock.path, lock.lockId);
    }
  }

  private async acquireLock(
    resourceHash: string,
  ): Promise<{ readonly path: string; readonly lockId: string }> {
    await mkdir(this.lockRoot(), { recursive: true, mode: 0o700 });
    const path = this.lockPath(resourceHash);
    const deadline =
      Date.now() +
      (this.options.lockAcquireTimeoutMs ??
        localFileWorkerAccountLeaseDefaultLockAcquireTimeoutMs);

    while (true) {
      const lockId = randomUUID();
      if (await this.tryPublishLock(path, lockId)) return { path, lockId };
      await this.recoverAbandonedLock(path);
      if (Date.now() >= deadline) {
        throw new Error("local_file_worker_account_lease_lock_timeout");
      }
      await delay(
        this.options.lockPollMs ??
          localFileWorkerAccountLeaseDefaultLockPollMs,
      );
    }
  }

  private async tryPublishLock(path: string, lockId: string): Promise<boolean> {
    const stagingPath = `${path}.${process.pid}.${lockId}.staging`;
    const record: PersistedLeaseLock = {
      storageVersion: localFileWorkerAccountLeaseLockStorageVersion,
      lockId,
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
    };
    await mkdir(stagingPath, { mode: 0o700 });
    try {
      await writeDurableFile(
        join(stagingPath, "owner.json"),
        `${JSON.stringify(record, null, 2)}\n`,
        true,
      );
      await syncDirectory(stagingPath);
      try {
        await rename(stagingPath, path);
        await syncDirectory(dirname(path));
        return true;
      } catch (error) {
        if (isAlreadyExistsError(error)) return false;
        throw error;
      }
    } finally {
      await rm(stagingPath, { recursive: true, force: true });
    }
  }

  private async recoverAbandonedLock(path: string): Promise<void> {
    const owner = await readLockOwner(path);
    if (owner) {
      if (isProcessAlive(owner.pid)) return;
      await this.quarantineLockIfMatches(path, `owner:${owner.lockId}`, async () =>
        (await readLockOwner(path))?.lockId === owner.lockId,
      );
      return;
    }

    const identity = await staleMalformedLockIdentity(
      path,
      this.options.malformedLockStaleMs ??
        localFileWorkerAccountLeaseDefaultMalformedLockStaleMs,
    );
    if (!identity) return;
    await this.quarantineLockIfMatches(
      path,
      `malformed:${identity}`,
      async () =>
        (await staleMalformedLockIdentity(path, 0)) === identity,
    );
  }

  private async quarantineLockIfMatches(
    path: string,
    identity: string,
    isCurrent: () => Promise<boolean>,
  ): Promise<void> {
    const recoveryPath = `${path}.recover-${hashText(identity).slice(0, 20)}`;
    const recoveryId = randomUUID();
    if (!(await this.tryPublishLock(recoveryPath, recoveryId))) return;
    try {
      if (!(await isCurrent())) return;
      const quarantinePath = `${path}.${process.pid}.${randomUUID()}.abandoned`;
      try {
        await rename(path, quarantinePath);
      } catch (error) {
        if (isMissingFileError(error)) return;
        throw error;
      }
      await rm(quarantinePath, { recursive: true, force: true });
      await syncDirectory(dirname(path));
    } finally {
      await this.releaseLock(recoveryPath, recoveryId);
    }
  }

  private async releaseLock(path: string, lockId: string): Promise<void> {
    const owner = await readLockOwner(path);
    if (owner?.lockId !== lockId) return;
    const tombstonePath = `${path}.${process.pid}.${randomUUID()}.released`;
    try {
      await rename(path, tombstonePath);
    } catch (error) {
      if (isMissingFileError(error)) return;
      throw error;
    }
    const movedOwner = await readLockOwner(tombstonePath);
    if (movedOwner?.lockId === lockId) {
      await rm(tombstonePath, { recursive: true, force: true });
      await syncDirectory(dirname(path));
      return;
    }
    try {
      await rename(tombstonePath, path);
    } catch {
      await rm(tombstonePath, { recursive: true, force: true });
    }
  }

  private async readRecord(
    resourceHash: string,
  ): Promise<PersistedWorkerAccountLease | null> {
    try {
      return parseRecord(
        await readFile(this.recordPath(resourceHash), "utf8"),
        resourceHash,
      );
    } catch (error) {
      if (isMissingFileError(error)) return null;
      throw error;
    }
  }

  private async writeRecord(record: PersistedWorkerAccountLease): Promise<void> {
    const path = this.recordPath(record.resourceHash);
    await writeDurableFile(path, `${JSON.stringify(record, null, 2)}\n`, false);
  }

  private recordPath(resourceHash: string): string {
    return join(this.options.rootDir, "worker-account-leases", "records", `${resourceHash}.json`);
  }

  private lockRoot(): string {
    return join(this.options.rootDir, "worker-account-leases", "locks");
  }

  private lockPath(resourceHash: string): string {
    return join(this.lockRoot(), `${resourceHash}.lock`);
  }
}

function normalizeResource(
  accountIdInput: string,
  demandInput: WorkerRuntimeDemand | undefined,
): LeaseResource {
  const accountId = normalizeWorkerAccountId(accountIdInput);
  if (!accountId) throw new Error("worker_account_lease_account_id_required");
  const demand = normalizeWorkerRuntimeDemand(demandInput);
  return {
    accountId,
    demand,
    resourceHash: hashText(workerAccountLeaseResourceKey(accountId, demand)),
  };
}

function normalizeOwnerId(value: string): string {
  const ownerId = value.trim();
  if (!ownerId) throw new Error("worker_account_lease_owner_id_required");
  return ownerId;
}

function leaseExpiry(now: Date, ttlMs: number): Date {
  assertValidDate(now);
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error("worker_account_lease_ttl_invalid");
  }
  const expiresAt = new Date(now.getTime() + ttlMs);
  assertValidDate(expiresAt);
  return expiresAt;
}

function assertValidDate(value: Date): void {
  if (!Number.isFinite(value.getTime())) {
    throw new Error("worker_account_lease_now_invalid");
  }
}

function nextFencingToken(record: PersistedWorkerAccountLease | null): number {
  const token = (record?.fencingToken ?? 0) + 1;
  if (!Number.isSafeInteger(token)) {
    throw new Error("local_file_worker_account_lease_fencing_token_exhausted");
  }
  return token;
}

function leaseFromRecord(
  record: PersistedWorkerAccountLease,
  ownerId: string,
): WorkerAccountLease {
  return {
    leaseId: record.leaseId,
    fencingToken: record.fencingToken,
    accountId: record.accountId,
    ...(record.demand ? { demand: record.demand } : {}),
    ownerId,
    acquiredAt: new Date(record.acquiredAt),
    expiresAt: new Date(record.expiresAt),
  };
}

function isActiveAt(
  record: PersistedWorkerAccountLease | null,
  now: Date,
): record is PersistedWorkerAccountLease {
  return (
    record?.state === "active" &&
    new Date(record.expiresAt).getTime() > now.getTime()
  );
}

function isCurrentLease(
  record: PersistedWorkerAccountLease | null,
  leaseId: string,
  ownerId: string,
): record is PersistedWorkerAccountLease {
  return (
    record?.state === "active" &&
    record.leaseId === leaseId &&
    record.ownerIdHash === hashText(ownerId)
  );
}

function localLeaseId(resourceHash: string): string {
  return `local-worker-account-lease:${resourceHash}:${randomUUID()}`;
}

function parseLocalLeaseId(
  value: string,
): { readonly resourceHash: string } | null {
  const match = /^local-worker-account-lease:([a-f0-9]{64}):[0-9a-f-]{36}$/.exec(
    value.trim(),
  );
  return match?.[1] ? { resourceHash: match[1] } : null;
}

function parseRecord(
  value: string,
  expectedResourceHash: string,
): PersistedWorkerAccountLease {
  const parsed = JSON.parse(value) as Partial<PersistedWorkerAccountLease>;
  const accountId = normalizeWorkerAccountId(parsed.accountId);
  const demand = normalizeWorkerRuntimeDemand(parsed.demand);
  if (
    parsed.storageVersion !== localFileWorkerAccountLeaseStorageVersion ||
    parsed.resourceHash !== expectedResourceHash ||
    !accountId ||
    (parsed.demand !== undefined && !demand) ||
    typeof parsed.leaseId !== "string" ||
    parseLocalLeaseId(parsed.leaseId)?.resourceHash !== expectedResourceHash ||
    typeof parsed.ownerIdHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(parsed.ownerIdHash) ||
    typeof parsed.fencingToken !== "number" ||
    !Number.isSafeInteger(parsed.fencingToken) ||
    parsed.fencingToken <= 0 ||
    (parsed.state !== "active" && parsed.state !== "released") ||
    !isIsoDate(parsed.acquiredAt) ||
    !isIsoDate(parsed.expiresAt) ||
    hashText(workerAccountLeaseResourceKey(accountId, demand)) !==
      expectedResourceHash
  ) {
    throw new Error("local_file_worker_account_lease_invalid_record");
  }
  if (
    demand &&
    workerRuntimeDemandKey(demand) !== workerRuntimeDemandKey(parsed.demand)
  ) {
    throw new Error("local_file_worker_account_lease_invalid_record");
  }
  return {
    storageVersion: localFileWorkerAccountLeaseStorageVersion,
    resourceHash: expectedResourceHash,
    accountId,
    ...(demand ? { demand } : {}),
    leaseId: parsed.leaseId,
    ownerIdHash: parsed.ownerIdHash,
    fencingToken: parsed.fencingToken,
    state: parsed.state,
    acquiredAt: parsed.acquiredAt,
    expiresAt: parsed.expiresAt,
    ...(isIsoDate(parsed.releasedAt) ? { releasedAt: parsed.releasedAt } : {}),
  };
}

async function readLockOwner(path: string): Promise<PersistedLeaseLock | null> {
  try {
    const parsed = JSON.parse(
      await readFile(join(path, "owner.json"), "utf8"),
    ) as Partial<PersistedLeaseLock>;
    if (
      parsed.storageVersion !== localFileWorkerAccountLeaseLockStorageVersion ||
      typeof parsed.lockId !== "string" ||
      typeof parsed.pid !== "number" ||
      !Number.isSafeInteger(parsed.pid) ||
      !isIsoDate(parsed.acquiredAt)
    ) {
      return null;
    }
    return {
      storageVersion: localFileWorkerAccountLeaseLockStorageVersion,
      lockId: parsed.lockId,
      pid: parsed.pid,
      acquiredAt: parsed.acquiredAt,
    };
  } catch {
    return null;
  }
}

async function staleMalformedLockIdentity(
  path: string,
  staleMs: number,
): Promise<string | null> {
  try {
    const item = await stat(path);
    if (Date.now() - item.mtimeMs < staleMs) return null;
    return `${item.dev}:${item.ino}:${item.mtimeMs}:${item.size}`;
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
}

async function writeDurableFile(
  path: string,
  value: string,
  exclusive: boolean,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  if (exclusive) {
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(value, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(dirname(path));
    return;
  }

  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await open(tempPath, "wx", 0o600);
    try {
      await handle.writeFile(value, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tempPath, path);
    await syncDirectory(dirname(path));
  } finally {
    await rm(tempPath, { force: true });
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } catch (error) {
    if (!isUnsupportedDirectorySyncError(error)) throw error;
  } finally {
    await handle.close();
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error) && error.code === "EPERM";
  }
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}

function isAlreadyExistsError(error: unknown): boolean {
  return (
    isNodeError(error) &&
    (error.code === "EEXIST" || error.code === "ENOTEMPTY")
  );
}

function isMissingFileError(error: unknown): boolean {
  return isNodeError(error) && error.code === "ENOENT";
}

function isUnsupportedDirectorySyncError(error: unknown): boolean {
  return (
    isNodeError(error) &&
    (error.code === "EINVAL" ||
      error.code === "ENOTSUP" ||
      error.code === "EBADF")
  );
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}
