/// <reference types="node" />
import { type JobLifecycleMcpArgs, type JobOverviewMcpArgs, type JobWatchMcpArgs } from "./codex-goal-mcp-inputs.js";
type JsonObject = Readonly<Record<string, unknown>>;
type ContinueStoredJob = (args: JobLifecycleMcpArgs, options: {
    readonly mode: "continue" | "recover";
    readonly confirmKey: "confirmContinue" | "confirmRecover";
}) => Promise<JsonObject>;
export type CodexGoalMcpOverviewDeps = {
    readonly continueStoredJob: ContinueStoredJob;
};
export declare function buildCodexGoalOverviewView(args: JobOverviewMcpArgs): Promise<JsonObject>;
export declare function reconcilePreviewCodexGoalJobsView(args: JobWatchMcpArgs, deps: CodexGoalMcpOverviewDeps): Promise<JsonObject>;
export {};
//# sourceMappingURL=codex-goal-mcp-overview.d.ts.map