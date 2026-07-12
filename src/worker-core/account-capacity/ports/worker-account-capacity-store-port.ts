import type { WorkerCapacitySnapshot } from "../../types";
import type {
  WorkerAccountCapacityClaimResult,
  WorkerAccountCapacityRecheckClaim,
  WorkerAccountCapacityRecheckMode,
  WorkerAccountCapacityRecheckResolution,
  WorkerAccountCapacityResolveResult,
  WorkerAccountCapacityState,
  WorkerAccountLimitSignal,
  WorkerRuntimeDemand,
} from "../domain";

export type WorkerAccountCapacityStore = {
  read(input: {
    readonly accountId: string;
    readonly demand?: WorkerRuntimeDemand;
    readonly now?: Date;
  }): WorkerCapacitySnapshot | null;
  readState(input: {
    readonly accountId: string;
    readonly demand?: WorkerRuntimeDemand;
    readonly now: Date;
  }): WorkerAccountCapacityState | null;
  observe(input: WorkerAccountLimitSignal): WorkerAccountCapacityState | null;
  tryClaimRecheck(input: {
    readonly state: WorkerAccountCapacityState;
    readonly ownerId: string;
    readonly now: Date;
    readonly ttlMs: number;
    readonly mode: WorkerAccountCapacityRecheckMode;
  }): WorkerAccountCapacityClaimResult;
  resolveRecheck(input: {
    readonly claim: WorkerAccountCapacityRecheckClaim;
    readonly observedAt: Date;
    readonly resolution: WorkerAccountCapacityRecheckResolution;
  }): WorkerAccountCapacityResolveResult;
  releaseRecheck(input: {
    readonly claim: WorkerAccountCapacityRecheckClaim;
  }): void;
  clear(input: { readonly accountId: string }): void;
};
