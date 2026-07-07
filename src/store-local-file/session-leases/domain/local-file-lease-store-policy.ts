import type { LeaseStoreCapabilities } from "@vioxen/subscription-runtime/core";

export const localFileLeaseStoreStorageVersion = "local-file-lease-store-v1";
export const localFileLeaseLockStorageVersion = "local-file-lease-lock-v1";

export const localFileLeaseStoreCapabilities: LeaseStoreCapabilities = {
  leaseStoreId: "local-file-lease-store",
  supportsTtl: true,
  supportsFinalize: true,
  supportsWritebackCommit: true,
};

export const localFileLeaseDefaultLockTtlMs = 30_000;
export const localFileLeaseDefaultLockAcquireTimeoutMs = 5_000;
export const localFileLeaseDefaultLockPollMs = 25;
