/// <reference types="node" />
import type { CodexGoalJobManifest } from "../codex-goal-jobs.js";
import { type CodexGoalLaunchInput, type CodexGoalStatus } from "../codex-goal-ops.js";
export type DirectCodexGoalStopBrief = {
    readonly workerAlive: boolean;
    readonly workerSupervisorKind?: unknown;
    readonly workerAliveReason?: unknown;
    readonly silentStale: boolean;
    readonly heartbeatOnlyNoOutput: boolean;
};
export declare function stopDirectCodexGoalRun<TBrief extends DirectCodexGoalStopBrief>(input: {
    readonly manifest: CodexGoalJobManifest;
    readonly launch: CodexGoalLaunchInput;
    readonly status: CodexGoalStatus;
    readonly brief: TBrief;
    readonly confirmStop: boolean;
}): Promise<Readonly<Record<string, unknown>>>;
//# sourceMappingURL=codex-goal-direct-run-stop-use-case.d.ts.map