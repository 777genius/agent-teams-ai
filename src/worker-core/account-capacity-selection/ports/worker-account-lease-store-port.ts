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

export interface WorkerAccountLeaseStore {
  acquire(input: {
    readonly accountId: string;
    readonly demand?: WorkerRuntimeDemand;
    readonly ownerId: string;
    readonly ttlMs: number;
    readonly now: Date;
  }): Promise<WorkerAccountLeaseAcquireResult>;

  release(input: {
    readonly leaseId: string;
    readonly ownerId: string;
    readonly reason: string;
    readonly now: Date;
  }): Promise<void>;
}
