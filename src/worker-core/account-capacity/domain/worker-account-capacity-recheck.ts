import type { WorkerCapacitySnapshot } from "../../types";
import type { WorkerRuntimeDemand } from "./worker-account-capacity";

export enum WorkerAccountCapacityPhase {
  Blocking = "blocking",
  RecheckDue = "recheck_due",
}

export enum WorkerAccountCapacityRecheckMode {
  DueOnly = "due_only",
  Refresh = "refresh",
}

export enum WorkerAccountCapacityClaimStatus {
  Claimed = "claimed",
  Busy = "busy",
  NotDue = "not_due",
  Missing = "missing",
  Conflict = "conflict",
}

export enum WorkerAccountCapacityResolveStatus {
  Applied = "applied",
  StaleClaim = "stale_claim",
  Missing = "missing",
  Conflict = "conflict",
}

export enum WorkerAccountCapacityResolutionType {
  Available = "available",
  Limited = "limited",
  Retry = "retry",
}

export type WorkerAccountCapacityState = {
  readonly recordId: string;
  readonly revision: string;
  readonly accountId: string;
  readonly demand: WorkerRuntimeDemand | null;
  readonly capacity: WorkerCapacitySnapshot;
  readonly phase: WorkerAccountCapacityPhase;
};

export type WorkerAccountCapacityRecheckClaim = {
  readonly claimId: string;
  readonly recordId: string;
  readonly baseRevision: string;
  readonly accountId: string;
  readonly demand: WorkerRuntimeDemand | null;
  readonly ownerId: string;
  readonly claimedAt: Date;
  readonly expiresAt: Date;
  readonly previous: WorkerCapacitySnapshot;
};

export type WorkerAccountCapacityClaimResult =
  | {
      readonly status: WorkerAccountCapacityClaimStatus.Claimed;
      readonly claim: WorkerAccountCapacityRecheckClaim;
    }
  | {
      readonly status: WorkerAccountCapacityClaimStatus.Busy;
      readonly retryAt: Date;
    }
  | {
      readonly status: WorkerAccountCapacityClaimStatus.NotDue;
      readonly state: WorkerAccountCapacityState;
    }
  | {
      readonly status:
        | WorkerAccountCapacityClaimStatus.Missing
        | WorkerAccountCapacityClaimStatus.Conflict;
    };

export type WorkerAccountCapacityRecheckResolution =
  | { readonly type: WorkerAccountCapacityResolutionType.Available }
  | {
      readonly type: WorkerAccountCapacityResolutionType.Limited;
      readonly capacity: WorkerCapacitySnapshot;
    }
  | {
      readonly type: WorkerAccountCapacityResolutionType.Retry;
      readonly retryAt: Date;
      readonly reason: string;
    };

export type WorkerAccountCapacityResolveResult = {
  readonly status: WorkerAccountCapacityResolveStatus;
  readonly state?: WorkerAccountCapacityState;
};

export type WorkerAccountCapacityRechecker = {
  recheck(input: {
    readonly accountId: string;
    readonly demand: WorkerRuntimeDemand | null;
    readonly previous: WorkerCapacitySnapshot;
    readonly now: Date;
  }): Promise<WorkerCapacitySnapshot>;
};
