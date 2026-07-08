/// <reference types="node" />
import { WorkerControlService, type WorkerControlTarget } from "@vioxen/subscription-runtime/worker-core";
import type { CodexGoalJobManifest } from "../codex-goal-jobs.js";
import type { CodexGoalLaunchInput } from "../codex-goal-ops.js";
export declare function codexGoalWorkerControlService(launch: CodexGoalLaunchInput): WorkerControlService;
export declare function codexGoalWorkerControlTarget(input: {
    readonly manifest: CodexGoalJobManifest;
    readonly launch: CodexGoalLaunchInput;
}): WorkerControlTarget;
export declare function codexGoalStateRootDir(launch: CodexGoalLaunchInput): string;
export declare function codexGoalAccountStatusPayload(launch: CodexGoalLaunchInput, options?: {
    readonly liveCheck?: boolean;
    readonly codexBinaryPath?: string;
    readonly liveCheckTimeoutMs?: number;
}): Promise<{
    count: number;
    available: number;
    hasAvailableAccount: boolean;
    summary: {
        configured: number;
        ready: number;
        missing: number;
        invalid: number;
        deduped: number;
        availableDeduped: number;
        capacityBlocked: number;
        duplicateGroups: number;
    };
    accounts: readonly import("..").CodexGoalAccountSlotStatus[];
    slots: readonly import("..").CodexGoalAccountSlotStatus[];
    duplicates: readonly Readonly<Record<string, unknown>>[];
    dedupedAccountNames: string[];
    availableDedupedAccountNames: string[];
    dedupedAccountLabels: string[];
    availableDedupedAccountLabels: string[];
    dedupeRecommendation: string;
    stateRootDir?: string;
    ok: boolean;
    authRootDir: string;
    capacityAware: boolean;
    liveCheck: boolean;
}>;
//# sourceMappingURL=codex-goal-worker-control.d.ts.map