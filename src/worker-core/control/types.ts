export type WorkerControlIntent =
  | "guidance"
  | "pause_requested"
  | "stop_requested"
  | "cancel_requested"
  | "resume_requested"
  | "repair_requested"
  | "policy_update"
  | "operator_note";

export type WorkerControlDeliveryMode =
  | "record_only"
  | "next_safe_point"
  | "pause_then_continue"
  | "interrupt_then_continue"
  | "idle_turn_if_supported"
  | "live_if_supported";

export type WorkerControlActor =
  | "user"
  | "operator"
  | "orchestrator"
  | "runtime"
  | "agent";

export type WorkerControlCaller = {
  readonly kind: WorkerControlActor;
  readonly id?: string;
};

export type WorkerControlAuthorizationOperation = "enqueue" | "supersede";

export type WorkerControlAuthorizationInput = {
  readonly caller: WorkerControlCaller;
  readonly operation: WorkerControlAuthorizationOperation;
  readonly target: WorkerControlTarget;
  readonly intent: WorkerControlIntent;
  readonly deliveryMode: WorkerControlDeliveryMode;
  readonly signalId?: string;
};

export type WorkerControlAuthorizationDecision = {
  readonly allowed: boolean;
  readonly reason?: string;
};

export interface WorkerControlAuthorizationPolicy {
  authorizeWorkerControl(
    input: WorkerControlAuthorizationInput,
  ): Promise<WorkerControlAuthorizationDecision> | WorkerControlAuthorizationDecision;
}

export type WorkerControlPriority = "low" | "normal" | "high";

export type WorkerControlTarget = {
  readonly jobId: string;
  readonly taskId?: string;
  readonly workerId?: string;
  readonly attemptId?: string;
  readonly providerSessionId?: string;
  readonly workspaceId?: string;
};

export type RuntimeInterruptReason = {
  readonly code: "runtime_controlled_interrupt";
  readonly safeMessage: string;
  readonly signalId?: string;
  readonly requestedBy?: string;
};

export type ActiveAttemptRecord = {
  readonly taskId: string;
  readonly attemptNumber: number;
  readonly provider: string;
  readonly workspacePath: string;
  readonly target: WorkerControlTarget;
  readonly startedAt: Date;
};

export type ActiveAttemptInterruptResult =
  | {
      readonly status: "interrupted";
      readonly attempt: ActiveAttemptRecord;
    }
  | {
      readonly status: "not_found";
      readonly safeMessage: string;
    };

export interface ActiveAttemptLease {
  readonly attempt: ActiveAttemptRecord;
  release(): void;
}

export interface ActiveAttemptRegistry {
  register(input: ActiveAttemptRecord & {
    readonly abortController: AbortController;
  }): ActiveAttemptLease;
  get(target: WorkerControlTarget): ActiveAttemptRecord | null;
  interrupt(
    target: WorkerControlTarget,
    reason: RuntimeInterruptReason,
  ): Promise<ActiveAttemptInterruptResult> | ActiveAttemptInterruptResult;
}

export type WorkerControlSignal = {
  readonly schemaVersion: 1;
  readonly signalId: string;
  readonly idempotencyKey: string;
  readonly target: WorkerControlTarget;
  readonly intent: WorkerControlIntent;
  readonly deliveryMode: WorkerControlDeliveryMode;
  readonly body: string;
  readonly createdAt: Date;
  readonly createdBy: WorkerControlActor;
  readonly priority: WorkerControlPriority;
  readonly expiresAt?: Date;
  readonly supersedesSignalIds: readonly string[];
  readonly metadata: Readonly<Record<string, string>>;
};

export type WorkerControlDeliveryState =
  | "pending"
  | "accepted"
  | "interrupt_requested"
  | "interrupting"
  | "interrupted"
  | "delivered"
  | "continued"
  | "acknowledged"
  | "superseded"
  | "expired"
  | "rejected"
  | "failed";

export type WorkerControlFailure = {
  readonly code: string;
  readonly message: string;
};

export type WorkerControlDeliveryReceipt = {
  readonly schemaVersion: 1;
  readonly receiptId: string;
  readonly signalId: string;
  readonly target: WorkerControlTarget;
  readonly state: Exclude<WorkerControlDeliveryState, "pending">;
  readonly createdAt: Date;
  readonly deliveryAttemptId?: string;
  readonly deliveredAt?: Date;
  readonly appliedAt?: Date;
  readonly rejectedReason?: string;
  readonly failure?: WorkerControlFailure;
  readonly metadata: Readonly<Record<string, string>>;
};

export type WorkerControlSignalView = {
  readonly signal: WorkerControlSignal;
  readonly state: WorkerControlDeliveryState;
  readonly latestReceipt?: WorkerControlDeliveryReceipt;
  readonly expired: boolean;
  readonly deliverable: boolean;
  readonly blockedReason?: string;
};

export type WorkerControlCapability = {
  readonly supportsRecordOnly: true;
  readonly supportsNextSafePoint: boolean;
  readonly supportsPauseThenContinue: boolean;
  readonly supportsInterruptThenContinue: boolean;
  readonly supportsIdleTurnInput: boolean;
  readonly supportsLiveInput: boolean;
  readonly canDetectActiveTurn: boolean;
  readonly canAcknowledgeDelivery: boolean;
};

export type WorkerControlDecision = {
  readonly target: WorkerControlTarget;
  readonly safeToContinue: boolean;
  readonly pendingSignals: readonly WorkerControlSignalView[];
  readonly deliverableSignals: readonly WorkerControlSignalView[];
  readonly blockedSignals: readonly WorkerControlSignalView[];
  readonly recordOnlySignals: readonly WorkerControlSignalView[];
  readonly warnings: readonly string[];
};

export type WorkerControlReconciliationReport = {
  readonly target: WorkerControlTarget;
  readonly signalCount: number;
  readonly pendingCount: number;
  readonly acceptedCount: number;
  readonly deliverableCount: number;
  readonly blockedCount: number;
  readonly expiredCount: number;
  readonly supersededCount: number;
  readonly deliveredCount: number;
  readonly acknowledgedCount: number;
  readonly failedCount: number;
  readonly repairedCount: number;
  readonly repairedSignalIds: readonly string[];
  readonly warnings: readonly string[];
};

export type WorkerControlContinuationBatch = {
  readonly target: WorkerControlTarget;
  readonly deliveryAttemptId: string;
  readonly signals: readonly WorkerControlSignal[];
  readonly signalIds: readonly string[];
  readonly message?: string;
};

export type EnqueueWorkerControlSignalInput = {
  readonly target: WorkerControlTarget;
  readonly intent: WorkerControlIntent;
  readonly deliveryMode?: WorkerControlDeliveryMode;
  readonly body: string;
  readonly createdBy?: WorkerControlActor;
  readonly caller?: WorkerControlCaller;
  readonly priority?: WorkerControlPriority;
  readonly idempotencyKey?: string;
  readonly signalId?: string;
  readonly createdAt?: Date;
  readonly expiresAt?: Date;
  readonly supersedesSignalIds?: readonly string[];
  readonly metadata?: Readonly<Record<string, string>>;
};

export type ListWorkerControlSignalsQuery = {
  readonly target?: WorkerControlTarget;
  readonly signalIds?: readonly string[];
  readonly states?: readonly WorkerControlDeliveryState[];
  readonly includeExpired?: boolean;
  readonly includeBodies?: boolean;
  readonly now?: Date;
};

export type WorkerControlDecisionInput = {
  readonly target: WorkerControlTarget;
  readonly capabilities?: WorkerControlCapability;
  readonly now?: Date;
};

export type WorkerControlReconcileInput = {
  readonly target: WorkerControlTarget;
  readonly capabilities?: WorkerControlCapability;
  readonly now?: Date;
  readonly repair?: boolean;
  readonly acceptedStaleAfterMs?: number;
};

export type SupersedeWorkerControlSignalInput = {
  readonly target: WorkerControlTarget;
  readonly signalId: string;
  readonly supersededBySignalId?: string;
  readonly reason?: string;
  readonly now?: Date;
  readonly caller?: WorkerControlCaller;
};

export type ConsumeWorkerControlContinuationInput = {
  readonly target: WorkerControlTarget;
  readonly deliveryAttemptId: string;
  readonly capabilities?: WorkerControlCapability;
  readonly deferDeliveryConfirmation?: boolean;
  readonly now?: Date;
};

export interface WorkerControlInboxStore {
  appendSignal(signal: WorkerControlSignal): Promise<WorkerControlSignal>;
  listSignals(
    query?: Pick<ListWorkerControlSignalsQuery, "target" | "signalIds">,
  ): Promise<readonly WorkerControlSignal[]>;
  tryClaimDelivery?(
    receipt: WorkerControlDeliveryReceipt,
  ): Promise<WorkerControlDeliveryReceipt | null>;
  releaseDeliveryClaim?(input: {
    readonly target: WorkerControlTarget;
    readonly signalId: string;
    readonly deliveryAttemptId?: string;
  }): Promise<boolean>;
  appendReceipt(
    receipt: WorkerControlDeliveryReceipt,
  ): Promise<WorkerControlDeliveryReceipt>;
  appendReceipts?(
    receipts: readonly WorkerControlDeliveryReceipt[],
  ): Promise<readonly WorkerControlDeliveryReceipt[]>;
  listReceipts(input?: {
    readonly target?: WorkerControlTarget;
    readonly signalIds?: readonly string[];
  }): Promise<readonly WorkerControlDeliveryReceipt[]>;
}

export interface WorkerControlContinuationSource {
  readonly supportsDeferredDeliveryConfirmation?: boolean;
  consumeForContinuation(
    input: ConsumeWorkerControlContinuationInput,
  ): Promise<WorkerControlContinuationBatch>;
  confirmContinuationDelivery?(input: {
    readonly batch: WorkerControlContinuationBatch;
    readonly now?: Date;
  }): Promise<void>;
  releaseContinuationDelivery?(
    input: {
      readonly batch: WorkerControlContinuationBatch;
    },
  ): Promise<void>;
}
