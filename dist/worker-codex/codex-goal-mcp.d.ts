#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type ActiveAttemptRegistry } from "@vioxen/subscription-runtime/worker-core";
import { collectCodexGoalStatus, listCodexGoalAccountStatuses, type CodexGoalLaunchInput } from "./codex-goal-ops.js";
export type CodexGoalMcpServerOptions = {
    readonly activeAttemptRegistry?: ActiveAttemptRegistry;
};
export declare function createCodexGoalMcpServer(options?: CodexGoalMcpServerOptions): McpServer;
export declare function buildCodexGoalBrief(input: {
    readonly jobId: string;
    readonly launch: CodexGoalLaunchInput;
    readonly status: Awaited<ReturnType<typeof collectCodexGoalStatus>>;
    readonly accounts: Awaited<ReturnType<typeof listCodexGoalAccountStatuses>>;
    readonly staleAfterMs: number;
    readonly tailLines: number;
}): Promise<{
    text: string;
    lastProgressAt: string | undefined;
    lastProgressAgeMs: number | undefined;
    staleAfterMs: number;
    isStale: boolean;
    silentStale: boolean;
    logExists: boolean | undefined;
    logByteLength: number | undefined;
    progressPath: string | undefined;
    progressExists: boolean | undefined;
    progressStatus: string | undefined;
    progressUpdatedAt: string | undefined;
    progressHeartbeatAgeMs: number | undefined;
    progressPid: number | undefined;
    progressResultStatus: string | undefined;
    progressResultReason: string | undefined;
    progressAttemptCount: number | undefined;
    progressCurrentAccount: string | undefined;
    currentAccount: string | undefined;
    lastFailureReason: string | undefined;
    changedFiles: readonly string[];
    safeToContinue: boolean;
    hasAvailableAccount: boolean;
    configuredAccounts: string[];
    dedupedAccounts: string[];
    availableDedupedAccounts: string[];
    needsHumanRelogin: boolean;
    invalidAccounts: string[];
    duplicateAccounts: readonly Readonly<Record<string, unknown>>[];
    lifecycleMarkers: readonly Readonly<Record<string, unknown>>[];
    lifecycleMarkerTypes: string[];
    capacityBlockedAccounts: {
        name: string;
        availability: string | undefined;
        reason: string | undefined;
        cooldownUntil: string | undefined;
    }[];
    recentCommands: readonly string[];
    nextBestTool: unknown;
    nextBestReason: unknown;
    nextBestCommand: string;
    recentLogTail: string;
}>;
export declare function dedupeCodexGoalAccountSlots(slots: Awaited<ReturnType<typeof listCodexGoalAccountStatuses>>): import("./codex-goal-ops.js").CodexGoalAccountSlotStatus[];
export declare function availableCodexGoalAccountSlots(slots: Awaited<ReturnType<typeof listCodexGoalAccountStatuses>>): import("./codex-goal-ops.js").CodexGoalAccountSlotStatus[];
export declare function visibleCodexGoalAccountPoolSlots(poolName: string, slots: Awaited<ReturnType<typeof listCodexGoalAccountStatuses>>): import("./codex-goal-ops.js").CodexGoalAccountSlotStatus[];
//# sourceMappingURL=codex-goal-mcp.d.ts.map