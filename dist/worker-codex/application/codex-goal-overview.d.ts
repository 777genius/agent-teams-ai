/// <reference types="node" />
import { type CodexGoalJobLifecycleInput, type CodexGoalJobOverviewInput, type CodexGoalJobWatchInput } from "./codex-goal-use-case-inputs.js";
type JsonObject = Readonly<Record<string, unknown>>;
type ContinueStoredJob = (args: CodexGoalJobLifecycleInput, options: {
    readonly mode: "continue" | "recover";
    readonly confirmKey: "confirmContinue" | "confirmRecover";
}) => Promise<JsonObject>;
export type CodexGoalOverviewDeps = {
    readonly continueStoredJob: ContinueStoredJob;
};
export declare function buildCodexGoalOverviewView(args: CodexGoalJobOverviewInput): Promise<JsonObject>;
export declare function reconcilePreviewCodexGoalJobsView(args: CodexGoalJobWatchInput, deps: CodexGoalOverviewDeps): Promise<JsonObject>;
export {};
//# sourceMappingURL=codex-goal-overview.d.ts.map