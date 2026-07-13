import type { WorkerRuntimeDemand } from "../../account-capacity";
import type { WorkerAccountLease } from "../domain";

export type WorkerAccountLeaseAcquireResult =
  | {
      readonly status: "granted";
      readonly lease: WorkerAccountLease;
    }
  | {
      readonly status: "denied";
      readonly reason: "leased";
      readonly currentLeaseExpiresAt?: Date;
    };

export type WorkerAccountLeaseRenewResult =
  | {
      readonly status: "renewed";
      readonly lease: WorkerAccountLease;
    }
  | {
      readonly status: "lost";
      readonly reason: "lease_expired" | "lease_not_current";
    };

export interface WorkerAccountLeaseStore {
  acquire(input: {
    readonly accountId: string;
    readonly demand?: WorkerRuntimeDemand;
    readonly ownerId: string;
    readonly ttlMs: number;
    readonly now: Date;
  }): Promise<WorkerAccountLeaseAcquireResult>;

  renew(input: {
    readonly leaseId: string;
    readonly ownerId: string;
    readonly ttlMs: number;
    readonly now: Date;
  }): Promise<WorkerAccountLeaseRenewResult>;

  release(input: {
    readonly leaseId: string;
    readonly ownerId: string;
    readonly reason: string;
    readonly now: Date;
  }): Promise<void>;
}
