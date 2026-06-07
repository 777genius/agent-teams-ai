import type { FinalizedLease, LeaseAcquireResult, LeaseStoreCapabilities, LeaseStorePort, WritebackCommitResult } from "@vioxen/subscription-runtime/core";
export declare const localFileLeaseStoreCapabilities: LeaseStoreCapabilities;
export type LocalFileLeaseStoreOptions = {
    readonly rootDir: string;
    readonly now?: () => Date;
    readonly lockTtlMs?: number;
    readonly lockAcquireTimeoutMs?: number;
    readonly lockPollMs?: number;
};
export declare class LocalFileLeaseStore implements LeaseStorePort {
    private readonly options;
    readonly leaseStoreId: string;
    readonly capabilities: LeaseStoreCapabilities;
    constructor(options: LocalFileLeaseStoreOptions);
    acquire(input: {
        readonly providerInstanceId: string;
        readonly runId: string;
        readonly attempt: number;
        readonly ttlMs: number;
        readonly restoredGenerationHash: string;
    }): Promise<LeaseAcquireResult>;
    finalize(input: {
        readonly leaseId: string;
        readonly restoredGenerationHash: string;
    }): Promise<FinalizedLease>;
    markWritebackStarted(input: {
        readonly leaseId: string;
        readonly keyId?: string;
    }): Promise<void>;
    markWritebackCommitted(input: {
        readonly leaseId: string;
        readonly nextGenerationHash: string;
        readonly idempotencyKey: string;
    }): Promise<WritebackCommitResult>;
    release(input: {
        readonly leaseId: string;
        readonly reason: string;
    }): Promise<void>;
    private persistLeaseTransitionLocked;
    private requireLeaseRecord;
    private readActive;
    private readLeaseRecord;
    private readRecord;
    private writeActiveRecord;
    private writeLeaseRecord;
    private writeRecord;
    private removeActiveIfMatchesLocked;
    private ensureDirs;
    private now;
    private activeDir;
    private leaseRecordDir;
    private lockDir;
    private activePath;
    private leaseRecordPath;
    private lockPath;
    private withProviderLock;
    private acquireProviderLock;
    private releaseProviderLock;
    private removeLockIfMatchesGuarded;
    private removeLockIfMatches;
    private lockRemovalGuardPath;
    private readLockRecord;
}
//# sourceMappingURL=local-file-lease-store.d.ts.map