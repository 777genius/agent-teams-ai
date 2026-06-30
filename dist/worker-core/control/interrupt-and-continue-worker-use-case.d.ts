import type { ActiveAttemptInterruptResult, ActiveAttemptRegistry, WorkerControlActor, WorkerControlCaller, WorkerControlPriority, WorkerControlSignal, WorkerControlTarget } from "./types.js";
import { WorkerControlService } from "./worker-control-service.js";
export type InterruptAndContinueWorkerInput = {
    readonly target: WorkerControlTarget;
    readonly message: string;
    readonly caller?: WorkerControlCaller;
    readonly createdBy?: WorkerControlActor;
    readonly priority?: WorkerControlPriority;
    readonly idempotencyKey?: string;
    readonly expiresAt?: Date;
};
export type InterruptAndContinueWorkerResult = {
    readonly status: "interrupted";
    readonly signal: WorkerControlSignal;
    readonly interrupt: Extract<ActiveAttemptInterruptResult, {
        status: "interrupted";
    }>;
    readonly safeMessage: string;
} | {
    readonly status: "accepted_as_next_safe_point";
    readonly signal: WorkerControlSignal;
    readonly safeMessage: string;
};
export declare class InterruptAndContinueWorkerUseCase {
    private readonly options;
    constructor(options: {
        readonly control: WorkerControlService;
        readonly activeAttemptRegistry?: ActiveAttemptRegistry;
    });
    execute(input: InterruptAndContinueWorkerInput): Promise<InterruptAndContinueWorkerResult>;
}
//# sourceMappingURL=interrupt-and-continue-worker-use-case.d.ts.map