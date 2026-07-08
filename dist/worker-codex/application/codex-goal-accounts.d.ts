/// <reference types="node" />
import { listCodexGoalAccountStatuses } from "../codex-goal-ops.js";
type JsonObject = Readonly<Record<string, unknown>>;
export type CodexAccountPoolArgs = {
    readonly authRootDir?: string;
    readonly pool?: string;
    readonly poolRootDir?: string;
};
type CodexGoalAccountSlots = Awaited<ReturnType<typeof listCodexGoalAccountStatuses>>;
type CodexGoalAccountSlot = CodexGoalAccountSlots[number];
export declare function codexAccountStatusPayload(input: {
    readonly authRootDir: string;
    readonly stateRootDir?: string;
    readonly accounts?: readonly string[];
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
export declare function codexAccountReloginInstructions(input: {
    readonly authRootDir: string;
    readonly account: string;
    readonly afterLoginInstruction: string;
}): readonly string[];
export declare function duplicateAccountGroups(slots: CodexGoalAccountSlots): readonly JsonObject[];
export declare function accountOperatorLabel(slot: CodexGoalAccountSlot): string;
export declare function dedupeCodexGoalAccountSlots(slots: CodexGoalAccountSlots): import("..").CodexGoalAccountSlotStatus[];
export declare function availableCodexGoalAccountSlots(slots: CodexGoalAccountSlots): import("..").CodexGoalAccountSlotStatus[];
export declare function visibleCodexGoalAccountPoolSlots(poolName: string, slots: CodexGoalAccountSlots): import("..").CodexGoalAccountSlotStatus[];
export declare function accountPoolRootFromArgs(args: CodexAccountPoolArgs): string;
export declare function accountAuthRootFromArgs(args: CodexAccountPoolArgs): string;
export declare function listAccountPools(poolRootDir: string, stateRootDir?: string): Promise<readonly JsonObject[]>;
export {};
//# sourceMappingURL=codex-goal-accounts.d.ts.map