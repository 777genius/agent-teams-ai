import type { ActiveAttemptInterruptResult, ActiveAttemptLease, ActiveAttemptRecord, ActiveAttemptRegistry, RuntimeInterruptReason, WorkerControlTarget } from "./types.js";
type RegisteredActiveAttempt = ActiveAttemptRecord & {
    readonly abortController: AbortController;
};
export declare class InMemoryActiveAttemptRegistry implements ActiveAttemptRegistry {
    private readonly attempts;
    register(input: RegisteredActiveAttempt): ActiveAttemptLease;
    get(target: WorkerControlTarget): ActiveAttemptRecord | null;
    interrupt(target: WorkerControlTarget, reason: RuntimeInterruptReason): ActiveAttemptInterruptResult;
    private find;
}
export {};
//# sourceMappingURL=active-attempt-registry.d.ts.map