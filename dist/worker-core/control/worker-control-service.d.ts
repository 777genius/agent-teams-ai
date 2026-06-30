import type { ConsumeWorkerControlContinuationInput, EnqueueWorkerControlSignalInput, ListWorkerControlSignalsQuery, SupersedeWorkerControlSignalInput, WorkerControlAuthorizationPolicy, WorkerControlContinuationBatch, WorkerControlDecision, WorkerControlDecisionInput, WorkerControlDeliveryReceipt, WorkerControlInboxStore, WorkerControlReconcileInput, WorkerControlReconciliationReport, WorkerControlSignal, WorkerControlSignalView, WorkerControlTarget } from "./types.js";
export type WorkerControlServiceOptions = {
    readonly store: WorkerControlInboxStore;
    readonly authorizationPolicy?: WorkerControlAuthorizationPolicy;
    readonly clock?: {
        now(): Date;
    };
    readonly idFactory?: () => string;
};
export declare class WorkerControlService {
    private readonly options;
    private readonly clock;
    private readonly idFactory;
    private readonly authorizationPolicy;
    constructor(options: WorkerControlServiceOptions);
    enqueueSignal(input: EnqueueWorkerControlSignalInput): Promise<WorkerControlSignal>;
    listSignals(query?: ListWorkerControlSignalsQuery): Promise<readonly WorkerControlSignalView[]>;
    getDecision(input: WorkerControlDecisionInput): Promise<WorkerControlDecision>;
    reconcile(input: WorkerControlReconcileInput): Promise<WorkerControlReconciliationReport>;
    markSuperseded(input: SupersedeWorkerControlSignalInput): Promise<WorkerControlDeliveryReceipt>;
    consumeForContinuation(input: ConsumeWorkerControlContinuationInput): Promise<WorkerControlContinuationBatch>;
    private signalViews;
    private signalViewFor;
    private findSignalOrThrow;
    private assertSignalCanBeSuperseded;
    private authorize;
    private repairAcceptedDeliveryClaims;
    private appendReceipt;
    private tryClaimDelivery;
    private deliveryReceipt;
}
export declare function normalizeWorkerControlTarget(target: WorkerControlTarget): WorkerControlTarget;
export declare function workerControlTargetMatches(query: WorkerControlTarget, target: WorkerControlTarget): boolean;
//# sourceMappingURL=worker-control-service.d.ts.map