/// <reference types="node" />
import type { WorkerControlDecision, WorkerControlSignal } from "@vioxen/subscription-runtime/worker-core";
import { type CodexGoalLaunchInput, type CodexGoalStatus } from "../codex-goal-ops.js";
export declare function codexGoalControlDeliveryDiagnostic(input: {
    readonly launch: CodexGoalLaunchInput;
    readonly decision: WorkerControlDecision;
    readonly signal: WorkerControlSignal;
    readonly staleAfterMs?: number;
}): Promise<Readonly<Record<string, unknown>>>;
export declare function buildCodexGoalControlDeliveryDiagnostic(input: {
    readonly status: CodexGoalStatus;
    readonly decision: WorkerControlDecision;
    readonly signal: WorkerControlSignal;
    readonly staleAfterMs: number;
}): Readonly<Record<string, unknown>>;
//# sourceMappingURL=codex-goal-control-delivery-diagnostic.d.ts.map