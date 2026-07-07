import type { WorkerCapacitySnapshot } from "../../types";
import type {
  WorkerAccountLimitSignal,
  WorkerRuntimeDemand,
} from "../domain";

export type WorkerAccountCapacityStore = {
  read(input: {
    readonly accountId: string;
    readonly demand?: WorkerRuntimeDemand;
    readonly now?: Date;
  }): WorkerCapacitySnapshot | null;
  observe(input: WorkerAccountLimitSignal): void;
  clear(input: { readonly accountId: string }): void;
};
