import type { WorkerAccountCapacityStore, WorkerCapacitySnapshot } from "@vioxen/subscription-runtime/worker-core";
import type { ProviderAccountCapacityReaderPort, ProviderAccountDiagnosticSignal, ProviderAccountInventoryItem } from "./types.js";
export type WorkerAccountCapacityReaderOptions = {
    readonly store: WorkerAccountCapacityStore;
};
export declare function createWorkerAccountCapacityReader<Account extends ProviderAccountInventoryItem = ProviderAccountInventoryItem>(options: WorkerAccountCapacityReaderOptions): ProviderAccountCapacityReaderPort<Account>;
export declare function workerCapacityToDiagnosticSignal(capacity: WorkerCapacitySnapshot): ProviderAccountDiagnosticSignal | null;
//# sourceMappingURL=worker-capacity-reader.d.ts.map