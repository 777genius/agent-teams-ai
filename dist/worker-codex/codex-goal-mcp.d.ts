#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { collectCodexGoalStatus, listCodexGoalAccountStatuses, type CodexGoalLaunchInput } from "./codex-goal-ops.js";
export declare function createCodexGoalMcpServer(): McpServer;
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
    isStale: boolean;
    currentAccount: string | undefined;
    lastFailureReason: string | undefined;
    changedFiles: readonly string[];
    safeToContinue: boolean;
    needsHumanRelogin: boolean;
    invalidAccounts: string[];
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