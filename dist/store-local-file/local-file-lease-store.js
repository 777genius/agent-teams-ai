import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
const storageVersion = "local-file-lease-store-v1";
export const localFileLeaseStoreCapabilities = {
    leaseStoreId: "local-file-lease-store",
    supportsTtl: true,
    supportsFinalize: true,
    supportsWritebackCommit: true,
};
const defaultLockTtlMs = 30_000;
const defaultLockAcquireTimeoutMs = 5_000;
const defaultLockPollMs = 25;
export class LocalFileLeaseStore {
    options;
    leaseStoreId = localFileLeaseStoreCapabilities.leaseStoreId;
    capabilities = localFileLeaseStoreCapabilities;
    constructor(options) {
        this.options = options;
    }
    async acquire(input) {
        if (input.ttlMs <= 0) {
            throw new Error("local_file_lease_invalid_ttl");
        }
        return this.withProviderLock(input.providerInstanceId, async () => {
            const now = this.now();
            const active = await this.readActive(input.providerInstanceId);
            if (active && !isExpired(active, now)) {
                if (active.restoredGenerationHash !== input.restoredGenerationHash) {
                    return {
                        status: "stale",
                        safeMessage: "A newer provider session generation is already leased.",
                    };
                }
                return {
                    status: "denied",
                    safeMessage: "Provider session refresh is already leased.",
                };
            }
            if (active) {
                await this.removeActiveIfMatchesLocked(active);
            }
            const record = makeLeaseRecord({
                providerInstanceId: input.providerInstanceId,
                runId: input.runId,
                attempt: input.attempt,
                restoredGenerationHash: input.restoredGenerationHash,
                now,
                expiresAt: new Date(now.getTime() + input.ttlMs),
            });
            await this.writeLeaseRecord(record, { exclusive: true });
            try {
                await this.writeActiveRecord(record, { exclusive: true });
            }
            catch (error) {
                await rm(this.leaseRecordPath(record.leaseId), { force: true });
                if (isAlreadyExistsError(error)) {
                    return {
                        status: "denied",
                        safeMessage: "Provider session refresh is already leased.",
                    };
                }
                throw error;
            }
            return {
                status: "granted",
                leaseId: record.leaseId,
                expiresAt: new Date(record.expiresAt),
            };
        });
    }
    async finalize(input) {
        const initial = await this.requireLeaseRecord(input.leaseId);
        return this.withProviderLock(initial.providerInstanceId, async () => {
            const record = await this.requireLeaseRecord(input.leaseId);
            if (record.restoredGenerationHash !== input.restoredGenerationHash) {
                throw new Error("local_file_lease_generation_hash_mismatch");
            }
            if (record.state === "committed") {
                return {
                    leaseId: record.leaseId,
                    restoredGenerationHash: record.restoredGenerationHash,
                };
            }
            await this.persistLeaseTransitionLocked({
                ...record,
                state: "finalized",
                finalizedAt: this.now().toISOString(),
            });
            return {
                leaseId: record.leaseId,
                restoredGenerationHash: record.restoredGenerationHash,
            };
        });
    }
    async markWritebackStarted(input) {
        const initial = await this.requireLeaseRecord(input.leaseId);
        await this.withProviderLock(initial.providerInstanceId, async () => {
            const record = await this.requireLeaseRecord(input.leaseId);
            if (record.state === "committed") {
                return;
            }
            await this.persistLeaseTransitionLocked({
                ...record,
                state: "writeback_started",
                writebackStartedAt: this.now().toISOString(),
                ...(input.keyId ? { keyId: input.keyId } : {}),
            });
        });
    }
    async markWritebackCommitted(input) {
        const initial = await this.requireLeaseRecord(input.leaseId);
        return this.withProviderLock(initial.providerInstanceId, async () => {
            const record = await this.requireLeaseRecord(input.leaseId);
            if (record.state === "committed") {
                if (record.nextGenerationHash === input.nextGenerationHash &&
                    record.idempotencyKey === input.idempotencyKey) {
                    return { status: "idempotent_replay" };
                }
                return {
                    status: "stale_generation",
                    safeMessage: "Lease was already committed with different writeback metadata.",
                };
            }
            const committed = {
                ...record,
                state: "committed",
                committedAt: this.now().toISOString(),
                nextGenerationHash: input.nextGenerationHash,
                idempotencyKey: input.idempotencyKey,
            };
            await this.persistLeaseTransitionLocked(committed);
            await this.removeActiveIfMatchesLocked(committed);
            return { status: "committed" };
        });
    }
    async release(input) {
        const initial = await this.readLeaseRecord(input.leaseId);
        if (!initial)
            return;
        await this.withProviderLock(initial.providerInstanceId, async () => {
            const record = await this.readLeaseRecord(input.leaseId);
            if (!record || record.state === "committed") {
                return;
            }
            const released = {
                ...record,
                state: "released",
                releasedAt: this.now().toISOString(),
                releaseReason: input.reason,
            };
            await this.persistLeaseTransitionLocked(released);
            await this.removeActiveIfMatchesLocked(released);
        });
    }
    async persistLeaseTransitionLocked(record) {
        await this.writeLeaseRecord(record, { exclusive: false });
        const active = await this.readActive(record.providerInstanceId);
        if (active?.leaseId === record.leaseId) {
            await this.writeActiveRecord(record, { exclusive: false });
        }
    }
    async requireLeaseRecord(leaseId) {
        const record = await this.readLeaseRecord(leaseId);
        if (!record) {
            throw new Error("local_file_lease_not_found");
        }
        return record;
    }
    async readActive(providerInstanceId) {
        return this.readRecord(this.activePath(providerInstanceId));
    }
    async readLeaseRecord(leaseId) {
        return this.readRecord(this.leaseRecordPath(leaseId));
    }
    async readRecord(path) {
        try {
            return parseLeaseRecord(await readFile(path, "utf8"));
        }
        catch (error) {
            if (isMissingFileError(error))
                return null;
            throw error;
        }
    }
    async writeActiveRecord(record, options) {
        await this.writeRecord(this.activePath(record.providerInstanceId), record, options);
    }
    async writeLeaseRecord(record, options) {
        await this.writeRecord(this.leaseRecordPath(record.leaseId), record, options);
    }
    async writeRecord(path, record, options) {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        const serialized = `${JSON.stringify(record, null, 2)}\n`;
        if (options.exclusive) {
            await writeFile(path, serialized, { flag: "wx", mode: 0o600 });
            return;
        }
        const tempPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
        await writeFile(tempPath, serialized, { mode: 0o600 });
        await rename(tempPath, path);
    }
    async removeActiveIfMatchesLocked(record) {
        const active = await this.readActive(record.providerInstanceId);
        if (active?.leaseId === record.leaseId) {
            await rm(this.activePath(record.providerInstanceId), { force: true });
        }
    }
    async ensureDirs() {
        await mkdir(this.activeDir(), { recursive: true, mode: 0o700 });
        await mkdir(this.leaseRecordDir(), { recursive: true, mode: 0o700 });
        await mkdir(this.lockDir(), { recursive: true, mode: 0o700 });
    }
    now() {
        return this.options.now?.() ?? new Date();
    }
    activeDir() {
        return join(this.options.rootDir, "leases", "active");
    }
    leaseRecordDir() {
        return join(this.options.rootDir, "leases", "records");
    }
    lockDir() {
        return join(this.options.rootDir, "leases", "locks");
    }
    activePath(providerInstanceId) {
        return join(this.activeDir(), `${hashText(providerInstanceId)}.json`);
    }
    leaseRecordPath(leaseId) {
        return join(this.leaseRecordDir(), `${hashText(leaseId)}.json`);
    }
    lockPath(providerInstanceId) {
        return join(this.lockDir(), `${hashText(providerInstanceId)}.lock`);
    }
    async withProviderLock(providerInstanceId, operation) {
        await this.ensureDirs();
        const lockId = `local-file-lock:${randomBytes(16).toString("hex")}`;
        const lockPath = this.lockPath(providerInstanceId);
        const deadline = Date.now() +
            (this.options.lockAcquireTimeoutMs ?? defaultLockAcquireTimeoutMs);
        await this.acquireProviderLock({
            providerInstanceId,
            lockId,
            lockPath,
            deadline,
        });
        try {
            return await operation();
        }
        finally {
            await this.releaseProviderLock({
                providerInstanceId,
                lockId,
                lockPath,
            });
        }
    }
    async acquireProviderLock(input) {
        const pollMs = this.options.lockPollMs ?? defaultLockPollMs;
        while (true) {
            const now = this.now();
            const record = {
                storageVersion: "local-file-lease-lock-v1",
                lockId: input.lockId,
                providerInstanceIdHash: hashText(input.providerInstanceId),
                pid: process.pid,
                acquiredAt: now.toISOString(),
                expiresAt: new Date(now.getTime() + (this.options.lockTtlMs ?? defaultLockTtlMs)).toISOString(),
            };
            try {
                await writeFile(input.lockPath, `${JSON.stringify(record, null, 2)}\n`, {
                    flag: "wx",
                    mode: 0o600,
                });
                return;
            }
            catch (error) {
                if (!isAlreadyExistsError(error))
                    throw error;
            }
            const existing = await this.readLockRecord(input.lockPath);
            if (!existing) {
                if (Date.now() >= input.deadline) {
                    throw new Error("local_file_lease_lock_timeout");
                }
                await delay(pollMs);
                continue;
            }
            if (isLockExpired(existing, this.now())) {
                if (input.guardedStaleRemoval === false) {
                    await this.removeLockIfMatches({
                        lockId: existing.lockId,
                        lockPath: input.lockPath,
                    });
                }
                else {
                    await this.removeLockIfMatchesGuarded({
                        providerInstanceId: input.providerInstanceId,
                        lockId: existing.lockId,
                        lockPath: input.lockPath,
                        deadline: input.deadline,
                    });
                }
                continue;
            }
            if (Date.now() >= input.deadline) {
                throw new Error("local_file_lease_lock_timeout");
            }
            await delay(pollMs);
        }
    }
    async releaseProviderLock(input) {
        if (input.guarded === false) {
            await this.removeLockIfMatches(input);
            return;
        }
        await this.removeLockIfMatchesGuarded({
            providerInstanceId: input.providerInstanceId,
            lockId: input.lockId,
            lockPath: input.lockPath,
            deadline: Date.now() +
                (this.options.lockAcquireTimeoutMs ?? defaultLockAcquireTimeoutMs),
        });
    }
    async removeLockIfMatchesGuarded(input) {
        const removalLockId = `local-file-lock-cleanup:${randomBytes(16).toString("hex")}`;
        const removalLockPath = this.lockRemovalGuardPath(input.lockPath, input.lockId);
        const removalProviderInstanceId = `${input.providerInstanceId}:lock-cleanup:${input.lockId}`;
        await this.acquireProviderLock({
            providerInstanceId: removalProviderInstanceId,
            lockId: removalLockId,
            lockPath: removalLockPath,
            deadline: input.deadline,
            guardedStaleRemoval: false,
        });
        try {
            const candidate = await this.readLockRecord(input.lockPath);
            if (candidate?.lockId !== input.lockId)
                return;
            await this.removeLockIfMatches(input);
        }
        finally {
            await this.releaseProviderLock({
                providerInstanceId: removalProviderInstanceId,
                lockId: removalLockId,
                lockPath: removalLockPath,
                guarded: false,
            });
        }
    }
    async removeLockIfMatches(input) {
        const candidate = await this.readLockRecord(input.lockPath);
        if (candidate?.lockId !== input.lockId)
            return;
        const tombstonePath = `${input.lockPath}.${process.pid}.${randomBytes(6).toString("hex")}.removing`;
        try {
            await rename(input.lockPath, tombstonePath);
        }
        catch (error) {
            if (isMissingFileError(error))
                return;
            throw error;
        }
        const existing = await this.readLockRecord(tombstonePath);
        if (existing?.lockId === input.lockId) {
            await rm(tombstonePath, { force: true });
            return;
        }
        try {
            await rename(tombstonePath, input.lockPath);
        }
        catch (error) {
            await rm(tombstonePath, { force: true }).catch(() => { });
            if (!isAlreadyExistsError(error)) {
                throw error;
            }
        }
    }
    lockRemovalGuardPath(lockPath, lockId) {
        return `${lockPath}.${hashText(lockId)}.cleanup.lock`;
    }
    async readLockRecord(path) {
        try {
            const parsed = JSON.parse(await readFile(path, "utf8"));
            if (parsed.storageVersion !== "local-file-lease-lock-v1" ||
                typeof parsed.lockId !== "string" ||
                typeof parsed.providerInstanceIdHash !== "string" ||
                typeof parsed.pid !== "number" ||
                typeof parsed.acquiredAt !== "string" ||
                typeof parsed.expiresAt !== "string") {
                return null;
            }
            return {
                storageVersion: "local-file-lease-lock-v1",
                lockId: parsed.lockId,
                providerInstanceIdHash: parsed.providerInstanceIdHash,
                pid: parsed.pid,
                acquiredAt: parsed.acquiredAt,
                expiresAt: parsed.expiresAt,
            };
        }
        catch (error) {
            if (isMissingFileError(error))
                return null;
            return null;
        }
    }
}
function makeLeaseRecord(input) {
    const leaseId = [
        "local-file-lease",
        hashText([
            input.providerInstanceId,
            input.runId,
            String(input.attempt),
            input.restoredGenerationHash,
            randomBytes(16).toString("hex"),
        ].join("\0")),
    ].join(":");
    return {
        storageVersion,
        leaseId,
        providerInstanceId: input.providerInstanceId,
        runId: input.runId,
        attempt: input.attempt,
        restoredGenerationHash: input.restoredGenerationHash,
        state: "active",
        acquiredAt: input.now.toISOString(),
        expiresAt: input.expiresAt.toISOString(),
    };
}
function parseLeaseRecord(value) {
    const parsed = JSON.parse(value);
    if (parsed.storageVersion !== storageVersion ||
        typeof parsed.leaseId !== "string" ||
        typeof parsed.providerInstanceId !== "string" ||
        typeof parsed.runId !== "string" ||
        typeof parsed.attempt !== "number" ||
        typeof parsed.restoredGenerationHash !== "string" ||
        !isLeaseState(parsed.state) ||
        typeof parsed.acquiredAt !== "string" ||
        typeof parsed.expiresAt !== "string") {
        throw new Error("local_file_lease_invalid_record");
    }
    return {
        storageVersion,
        leaseId: parsed.leaseId,
        providerInstanceId: parsed.providerInstanceId,
        runId: parsed.runId,
        attempt: parsed.attempt,
        restoredGenerationHash: parsed.restoredGenerationHash,
        state: parsed.state,
        acquiredAt: parsed.acquiredAt,
        expiresAt: parsed.expiresAt,
        ...(typeof parsed.finalizedAt === "string"
            ? { finalizedAt: parsed.finalizedAt }
            : {}),
        ...(typeof parsed.writebackStartedAt === "string"
            ? { writebackStartedAt: parsed.writebackStartedAt }
            : {}),
        ...(typeof parsed.committedAt === "string"
            ? { committedAt: parsed.committedAt }
            : {}),
        ...(typeof parsed.releasedAt === "string"
            ? { releasedAt: parsed.releasedAt }
            : {}),
        ...(typeof parsed.releaseReason === "string"
            ? { releaseReason: parsed.releaseReason }
            : {}),
        ...(typeof parsed.keyId === "string" ? { keyId: parsed.keyId } : {}),
        ...(typeof parsed.nextGenerationHash === "string"
            ? { nextGenerationHash: parsed.nextGenerationHash }
            : {}),
        ...(typeof parsed.idempotencyKey === "string"
            ? { idempotencyKey: parsed.idempotencyKey }
            : {}),
    };
}
function isLeaseState(value) {
    return (value === "active" ||
        value === "finalized" ||
        value === "writeback_started" ||
        value === "committed" ||
        value === "released");
}
function isExpired(record, now) {
    return new Date(record.expiresAt).getTime() <= now.getTime();
}
function isLockExpired(record, now) {
    return new Date(record.expiresAt).getTime() <= now.getTime();
}
function hashText(value) {
    return createHash("sha256").update(value).digest("hex");
}
function isMissingFileError(error) {
    return (error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT");
}
function isAlreadyExistsError(error) {
    return (error instanceof Error &&
        "code" in error &&
        error.code === "EEXIST");
}
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
//# sourceMappingURL=local-file-lease-store.js.map