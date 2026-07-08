/// <reference types="node" />
import type { RunObservationLiveness, RunObservationStatus } from "@vioxen/subscription-runtime/worker-core";
import type { CodexGoalStatus } from "../codex-goal-ops.js";
export declare function codexGoalOrphanRunStatus(input: {
    readonly status: CodexGoalStatus;
    readonly workerAlive: boolean;
}): RunObservationStatus;
export declare function codexGoalOrphanLiveness(input: {
    readonly workerAlive: boolean;
    readonly progressStale: boolean;
    readonly logStale: boolean;
}): RunObservationLiveness;
export declare function codexGoalOrphanManualReviewReasons(input: {
    readonly heartbeatOnlyNoOutput: boolean;
}): readonly string[];
//# sourceMappingURL=codex-goal-orphan-observation-policy.d.ts.map