import type { WorkerControlDeliveryReceipt, WorkerControlInboxStore, WorkerControlSignal, WorkerControlTarget } from "@vioxen/subscription-runtime/worker-core";
export type LocalFileWorkerControlInboxStoreOptions = {
    readonly rootDir: string;
};
export declare class LocalFileWorkerControlInboxStore implements WorkerControlInboxStore {
    private readonly options;
    constructor(options: LocalFileWorkerControlInboxStoreOptions);
    appendSignal(signal: WorkerControlSignal): Promise<WorkerControlSignal>;
    listSignals(input?: {
        readonly target?: WorkerControlTarget;
        readonly signalIds?: readonly string[];
    }): Promise<readonly WorkerControlSignal[]>;
    appendReceipt(receipt: WorkerControlDeliveryReceipt): Promise<WorkerControlDeliveryReceipt>;
    tryClaimDelivery(receipt: WorkerControlDeliveryReceipt): Promise<WorkerControlDeliveryReceipt | null>;
    releaseDeliveryClaim(input: {
        readonly target: WorkerControlTarget;
        readonly signalId: string;
        readonly deliveryAttemptId?: string;
    }): Promise<boolean>;
    listReceipts(input?: {
        readonly target?: WorkerControlTarget;
        readonly signalIds?: readonly string[];
    }): Promise<readonly WorkerControlDeliveryReceipt[]>;
    private signalsPath;
    private receiptsPath;
    private claimPath;
    private claimDir;
    private jobDir;
    private readJobRecords;
    private readClaimReceipts;
    private allClaimDirs;
    private allRecordPaths;
}
//# sourceMappingURL=local-worker-control-inbox-store.d.ts.map